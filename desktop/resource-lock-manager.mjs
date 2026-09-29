import crypto from 'node:crypto';
import path from 'node:path';

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export class ResourceLockManager {
  constructor({ maxLocks = 128 } = {}) {
    this.maxLocks = maxLocks;
    this.locks = new Map();
  }

  sweep() {
    const now = Date.now();
    for (const [id, lock] of this.locks) if (lock.expiresAtMs <= now) this.locks.delete(id);
  }

  assertAvailable(resource, owner = null) {
    this.sweep();
    for (const lock of this.locks.values()) {
      if (lock.owner === owner && owner !== null) continue;
      if (overlaps(lock.resource, resource) || overlaps(resource, lock.resource)) {
        throw new Error(`Resource is locked by ${lock.owner} until ${new Date(lock.expiresAtMs).toISOString()}`);
      }
    }
  }

  acquire({ resource, owner, operationId = null, leaseSeconds = 300 }) {
    this.assertAvailable(resource);
    if (this.locks.size >= this.maxLocks) throw new Error('Resource lock limit reached');
    const now = Date.now();
    const lock = { id: crypto.randomUUID(), resource, owner, operationId, acquiredAt: new Date(now).toISOString(), expiresAtMs: now + leaseSeconds * 1000 };
    this.locks.set(lock.id, lock);
    return this.summary(lock);
  }

  summary(lock) {
    return { lockId: lock.id, resource: lock.resource, owner: lock.owner, operationId: lock.operationId, acquiredAt: lock.acquiredAt, expiresAt: new Date(lock.expiresAtMs).toISOString() };
  }

  get(id) {
    this.sweep();
    const lock = this.locks.get(id);
    if (!lock) throw new Error('Resource lock not found or expired');
    return this.summary(lock);
  }

  list() {
    this.sweep();
    return [...this.locks.values()].map((lock) => this.summary(lock));
  }

  release(id) {
    return { lockId: id, released: this.locks.delete(id) };
  }

  async withLease(resources, owner, action) {
    const unique = [...new Set(resources)].sort();
    for (const resource of unique) this.assertAvailable(resource);
    if (this.locks.size + unique.length > this.maxLocks) throw new Error('Resource lock limit reached');
    const locks = [];
    try {
      const now = Date.now();
      for (const resource of unique) {
        const lock = { id: crypto.randomUUID(), resource, owner, operationId: owner, acquiredAt: new Date(now).toISOString(), expiresAtMs: now + 600_000 };
        this.locks.set(lock.id, lock);
        locks.push(this.summary(lock));
      }
      return await action();
    } finally {
      for (const lock of locks) this.release(lock.lockId);
    }
  }
}
