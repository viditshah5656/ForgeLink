import crypto from 'node:crypto';

const MAX_EVENTS = 2000;
const MAX_SUBSCRIPTIONS = 32;
const SUBSCRIPTION_TTL_MS = 15 * 60_000;

function matchesType(type, filters) {
  return filters.length === 0 || filters.some((filter) =>
    filter.endsWith('.*') ? type.startsWith(filter.slice(0, -1)) : type === filter);
}

export class EventBus {
  constructor({ maxEvents = MAX_EVENTS, maxSubscriptions = MAX_SUBSCRIPTIONS } = {}) {
    this.maxEvents = maxEvents;
    this.maxSubscriptions = maxSubscriptions;
    this.events = [];
    this.subscriptions = new Map();
    this.listeners = new Set();
    this.nextId = 1;
  }

  publish({ type, path, fromPath, jobId, sessionId, watchId, snapshotId, operationId, lockId, changeKind, deadlockId, cycleAgentIds, resolution }) {
    if (typeof type !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(type)) throw new Error('Invalid event type');
    const event = {
      id: this.nextId++, at: new Date().toISOString(), type,
      ...(path ? { path } : {}),
      ...(fromPath ? { fromPath } : {}),
      ...(jobId ? { jobId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(watchId ? { watchId } : {}),
      ...(snapshotId ? { snapshotId } : {}),
      ...(operationId ? { operationId } : {}),
      ...(lockId ? { lockId } : {}),
      ...(changeKind ? { changeKind } : {}),
      ...(deadlockId ? { deadlockId } : {}),
      ...(Array.isArray(cycleAgentIds) ? { cycleAgentIds: [...cycleAgentIds] } : {}),
      ...(resolution ? { resolution } : {}),
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
    return event;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  history({ afterId = 0, limit = 100, types = [], visible = () => true } = {}) {
    const oldestId = this.events[0]?.id ?? this.nextId;
    const filtered = this.events.filter((event) => event.id > afterId && matchesType(event.type, types) && visible(event));
    const events = afterId === 0 ? filtered.slice(-limit) : filtered.slice(0, limit);
    return { events, latestId: this.nextId - 1, oldestId, truncatedBeforeId: afterId > 0 && afterId < oldestId - 1 };
  }

  subscribe({ afterId = this.nextId - 1, types = [] } = {}) {
    this.sweep();
    if (this.subscriptions.size >= this.maxSubscriptions) throw new Error(`At most ${this.maxSubscriptions} event subscriptions may be active`);
    const subscription = {
      id: crypto.randomUUID(), afterId, types: [...types],
      createdAt: new Date().toISOString(), lastActivity: Date.now(),
    };
    this.subscriptions.set(subscription.id, subscription);
    return this.summary(subscription);
  }

  summary(subscription) {
    return {
      subscriptionId: subscription.id,
      afterId: subscription.afterId,
      types: [...subscription.types],
      createdAt: subscription.createdAt,
      lastActivity: new Date(subscription.lastActivity).toISOString(),
    };
  }

  list() {
    this.sweep();
    return { subscriptions: [...this.subscriptions.values()].map((item) => this.summary(item)), latestId: this.nextId - 1 };
  }

  unsubscribe(id) {
    const subscription = this.subscriptions.get(id);
    subscription?.cancelWait?.();
    return { subscriptionId: id, unsubscribed: this.subscriptions.delete(id) };
  }

  get(id) {
    this.sweep();
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw new Error('Event subscription not found or expired');
    subscription.lastActivity = Date.now();
    return subscription;
  }

  collect(subscription, limit, visible) {
    const oldestId = this.events[0]?.id ?? this.nextId;
    const truncatedBeforeId = subscription.afterId < oldestId - 1;
    const events = [];
    for (const event of this.events) {
      if (event.id <= subscription.afterId) continue;
      subscription.afterId = event.id;
      if (matchesType(event.type, subscription.types) && visible(event)) events.push(event);
      if (events.length >= limit) break;
    }
    return { subscriptionId: subscription.id, events, cursor: subscription.afterId, truncatedBeforeId };
  }

  async next(id, { timeoutMs = 10000, limit = 50, visible = () => true } = {}) {
    const subscription = this.get(id);
    if (subscription.cancelWait) throw new Error('An events_next call is already waiting on this subscription');
    const immediate = this.collect(subscription, limit, visible);
    if (immediate.events.length || timeoutMs <= 0) return immediate;
    return await new Promise((resolve) => {
      let timer;
      const finish = (result) => {
        clearTimeout(timer);
        this.listeners.delete(onEvent);
        subscription.cancelWait = null;
        resolve(result);
      };
      subscription.cancelWait = () => finish({ ...this.collect(subscription, limit, visible), unsubscribed: true });
      const onEvent = () => {
        const result = this.collect(subscription, limit, visible);
        if (result.events.length) finish(result);
      };
      this.listeners.add(onEvent);
      timer = setTimeout(() => finish(this.collect(subscription, limit, visible)), timeoutMs);
    });
  }

  sweep() {
    const now = Date.now();
    for (const [id, subscription] of this.subscriptions) {
      if (now - subscription.lastActivity > SUBSCRIPTION_TTL_MS) {
        subscription.cancelWait?.();
        this.subscriptions.delete(id);
      }
    }
  }
}
