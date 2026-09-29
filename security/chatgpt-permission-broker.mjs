import crypto from 'node:crypto';
import fs from 'node:fs';

const REQUEST_TTL_MS = 15 * 60_000;
const REQUEST_WINDOW_MS = 10 * 60_000;
const RESOLVED_RETENTION_MS = 24 * 60 * 60_000;

function secretHash(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

export class ChatGptPermissionBroker {
  constructor({ now = () => Date.now(), maxRequests = 5, filePath = null } = {}) {
    this.now = now;
    this.maxRequests = maxRequests;
    this.filePath = filePath;
    this.requests = new Map();
    this.requestTimes = [];
    if (filePath && fs.existsSync(filePath)) {
      const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (stored?.version !== 1 || !Array.isArray(stored.requests) || !Array.isArray(stored.requestTimes)) {
        throw new Error('Invalid persisted ChatGPT permission request journal');
      }
      for (const record of stored.requests.slice(-200)) {
        if (!record?.id || typeof record.challengeHash !== 'string') continue;
        const challengeHash = Buffer.from(record.challengeHash, 'base64');
        if (challengeHash.length !== 32) continue;
        this.requests.set(record.id, {
          ...record,
          challengeHash,
          // The backend may have applied a grant before crashing. Never replay
          // an interrupted decision without an explicit new owner request.
          status: record.status === 'resolving' ? 'recovery_required' : record.status,
        });
      }
      this.requestTimes = stored.requestTimes.filter(Number.isFinite);
    }
  }

  persist() {
    if (!this.filePath) return;
    const snapshot = {
      version: 1,
      requests: [...this.requests.values()].map((request) => ({ ...request, challengeHash: request.challengeHash.toString('base64') })),
      requestTimes: this.requestTimes,
    };
    const temp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(snapshot));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.renameSync(temp, this.filePath); }
    catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  }

  prune() {
    const now = this.now();
    let changed = false;
    this.requestTimes = this.requestTimes.filter((at) => now - at < REQUEST_WINDOW_MS);
    for (const [id, request] of this.requests) {
      if (request.status === 'pending' && request.expiresAt <= now) { request.status = 'expired'; changed = true; }
      if (request.status !== 'pending' && now - request.createdAt > RESOLVED_RETENTION_MS) { this.requests.delete(id); changed = true; }
    }
    if (changed) this.persist();
  }

  publicRequest(request) {
    if (!request) return { status: 'not_found_or_expired' };
    const { id, kind, scope, level, persistent, reason, risk, status, createdAt, expiresAt, grant, duration, durationMs, durationLabel } = request;
    return {
      requestId: id, kind, scope, level, persistent, reason, risk, status,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      ...(duration ? { duration } : {}),
      ...(durationMs ? { durationMs } : (grant?.durationMs ? { durationMs: grant.durationMs } : {})),
      ...(durationLabel ? { durationLabel } : (grant?.durationLabel ? { durationLabel: grant.durationLabel } : {})),
      ...(grant ? { grant } : {}),
    };
  }

  create({ kind, scope, level, persistent = false, reason = '', risk = 'normal', principal = 'local', duration, durationMs, durationLabel }) {
    this.prune();
    if (this.requestTimes.length >= this.maxRequests) throw new Error('Too many permission requests. Wait ten minutes before trying again.');
    if ([...this.requests.values()].some((request) => request.status === 'pending')) {
      throw new Error('Another ChatGPT permission request is pending. Resolve it before requesting another capability.');
    }
    const id = crypto.randomUUID();
    const challenge = crypto.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const ttl = Number(durationMs) && Number(durationMs) > 0 ? Number(durationMs) : REQUEST_TTL_MS;
    const request = {
      id, kind, scope, level, persistent, reason: String(reason).trim().slice(0, 240), risk,
      principal, status: 'pending', createdAt, expiresAt: createdAt + ttl,
      ...(duration ? { duration } : {}),
      ...(durationMs ? { durationMs } : {}),
      ...(durationLabel ? { durationLabel } : {}),
      challengeHash: secretHash(challenge),
    };
    this.requests.set(id, request);
    this.requestTimes.push(createdAt);
    this.persist();
    return { request: this.publicRequest(request), challenge };
  }

  status(id, principal = 'local') {
    this.prune();
    const request = this.requests.get(id);
    if (request && request.principal !== principal) return { status: 'not_found_or_expired' };
    return this.publicRequest(request);
  }

  list(principal = 'local') {
    this.prune();
    return [...this.requests.values()]
      .filter((request) => request.principal === principal && request.status === 'pending')
      .map((request) => this.publicRequest(request));
  }

  async resolve({ id, challenge, decision, acknowledgedRisk = false, principal = 'local', apply, duration }) {
    this.prune();
    const request = this.requests.get(id);
    if (!request || request.principal !== principal || request.status !== 'pending') {
      throw new Error('Permission request is unavailable, expired, or already resolved.');
    }
    const supplied = secretHash(challenge);
    if (!crypto.timingSafeEqual(request.challengeHash, supplied)) throw new Error('Permission card challenge is invalid.');
    if (decision !== 'allow' && decision !== 'deny') throw new Error('Decision must be allow or deny.');
    if (decision === 'allow' && request.risk !== 'normal' && acknowledgedRisk !== true) {
      throw new Error('This high-impact request requires the second risk acknowledgment in the ChatGPT card.');
    }
    request.status = 'resolving';
    this.persist();
    try {
      if (decision === 'deny') {
        request.status = 'denied';
      } else {
        if (typeof apply !== 'function') throw new Error('Permission application is unavailable.');
        const durationValue = duration || request.duration || undefined;
        request.grant = await apply({ ...request, duration: durationValue, challengeHash: undefined });
        request.status = 'approved';
        if (durationValue) {
          request.duration = durationValue;
        }
        if (request.grant?.durationMs) request.durationMs = request.grant.durationMs;
        if (request.grant?.durationLabel) request.durationLabel = request.grant.durationLabel;
      }
      this.persist();
      return this.publicRequest(request);
    } catch (error) {
      request.status = request.grant ? 'recovery_required' : 'pending';
      this.persist();
      throw error;
    }
  }
}
