import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatGptPermissionBroker } from './chatgpt-permission-broker.mjs';

test('request decision survives restart and cannot be applied twice', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forgelink-permission-'));
  try {
    const filePath = path.join(directory, 'requests.json');
    const first = new ChatGptPermissionBroker({ filePath });
    const { request, challenge } = first.create({ kind: 'terminal', scope: 'computer', level: 'safe', principal: 'owner' });
    let applied = 0;
    const reloaded = new ChatGptPermissionBroker({ filePath });
    assert.equal(reloaded.status(request.requestId, 'owner').status, 'pending');
    await reloaded.resolve({ id: request.requestId, challenge, decision: 'allow', principal: 'owner', apply: async () => { applied++; return { mode: 'safe' }; } });
    const again = new ChatGptPermissionBroker({ filePath });
    assert.equal(again.status(request.requestId, 'owner').status, 'approved');
    await assert.rejects(again.resolve({ id: request.requestId, challenge, decision: 'allow', principal: 'owner', apply: async () => { applied++; } }), /already resolved/);
    assert.equal(applied, 1);
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes(challenge), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('interrupted permission application fails closed after restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forgelink-permission-'));
  try {
    const filePath = path.join(directory, 'requests.json');
    const broker = new ChatGptPermissionBroker({ filePath });
    const { request, challenge } = broker.create({ kind: 'folder', scope: 'folder', level: 'read', principal: 'owner' });
    broker.requests.get(request.requestId).status = 'resolving';
    broker.persist();
    const reloaded = new ChatGptPermissionBroker({ filePath });
    assert.equal(reloaded.status(request.requestId, 'owner').status, 'recovery_required');
    await assert.rejects(reloaded.resolve({ id: request.requestId, challenge, decision: 'allow', principal: 'owner', apply: async () => ({}) }), /already resolved/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('approval requires widget challenge, principal and risk acknowledgment', async () => {
  let now = 1000;
  const broker = new ChatGptPermissionBroker({ now: () => now });
  const { request, challenge } = broker.create({ kind: 'folder', scope: 'C:\\', level: 'read_write', risk: 'high', principal: 'owner' });
  assert.equal(JSON.stringify(request).includes(challenge), false);
  await assert.rejects(broker.resolve({ id: request.requestId, challenge, decision: 'allow', principal: 'other', apply: async () => ({}) }));
  await assert.rejects(broker.resolve({ id: request.requestId, challenge: 'wrong', decision: 'allow', principal: 'owner', apply: async () => ({}) }));
  await assert.rejects(broker.resolve({ id: request.requestId, challenge, decision: 'allow', principal: 'owner', apply: async () => ({}) }), /risk acknowledgment/);
  const result = await broker.resolve({ id: request.requestId, challenge, decision: 'allow', acknowledgedRisk: true, principal: 'owner', apply: async () => ({ root: 'C:\\', access: 'read_write' }) });
  assert.equal(result.status, 'approved');
  await assert.rejects(broker.resolve({ id: request.requestId, challenge, decision: 'allow', acknowledgedRisk: true, principal: 'owner', apply: async () => ({}) }), /already resolved/);
  now += 1;
});

test('expiry, denial and concurrent decisions fail closed', async () => {
  let now = 0;
  const broker = new ChatGptPermissionBroker({ now: () => now });
  const first = broker.create({ kind: 'terminal', scope: 'computer', level: 'full' });
  assert.throws(() => broker.create({ kind: 'windows', scope: 'computer', level: 'read' }), /pending/);
  const denied = await broker.resolve({ id: first.request.requestId, challenge: first.challenge, decision: 'deny' });
  assert.equal(denied.status, 'denied');
  const second = broker.create({ kind: 'windows', scope: 'computer', level: 'read' });
  assert.equal(Date.parse(second.request.expiresAt) - Date.parse(second.request.createdAt), 15 * 60_000);
  now = 900001;
  await assert.rejects(broker.resolve({ id: second.request.requestId, challenge: second.challenge, decision: 'allow', apply: async () => ({}) }), /expired/);
  const third = broker.create({ kind: 'terminal', scope: 'computer', level: 'safe' });
  let calls = 0;
  const decide = () => broker.resolve({ id: third.request.requestId, challenge: third.challenge, decision: 'allow', apply: async () => { calls += 1; await Promise.resolve(); return { mode: 'safe' }; } });
  const [a, b] = await Promise.allSettled([decide(), decide()]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(calls, 1);
});

test('broker and resolver support custom durations with accurate TTL expiry', async () => {
  const durationCases = [
    { key: '15m', ms: 15 * 60_000 },
    { key: '30m', ms: 30 * 60_000 },
    { key: '1h', ms: 60 * 60_000 },
    { key: '5h', ms: 5 * 3600_000 },
    { key: '15h', ms: 15 * 3600_000 },
    { key: '1day', ms: 24 * 3600_000 },
  ];

  for (const { key, ms } of durationCases) {
    let now = 100_000;
    const broker = new ChatGptPermissionBroker({ now: () => now });
    const { request, challenge } = broker.create({
      kind: 'maintenance',
      scope: 'Protected ForgeLink source',
      level: 'write',
      risk: 'high',
      principal: 'owner',
      duration: key,
      durationMs: ms,
    });

    assert.equal(request.duration, key);
    assert.equal(request.durationMs, ms);
    assert.equal(Date.parse(request.expiresAt) - Date.parse(request.createdAt), ms);

    const resolved = await broker.resolve({
      id: request.requestId,
      challenge,
      decision: 'allow',
      acknowledgedRisk: true,
      principal: 'owner',
      apply: async (req) => ({ status: 'awaiting_desktop_enforcer', duration: req.duration, durationMs: req.durationMs }),
    });

    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.grant?.duration, key);
    assert.equal(resolved.grant?.durationMs, ms);
  }

  // Duration-aware expiry
  let time = 0;
  const expiryBroker = new ChatGptPermissionBroker({ now: () => time });
  const hourReq = expiryBroker.create({
    kind: 'maintenance',
    scope: 'Protected ForgeLink source',
    level: 'write',
    risk: 'high',
    principal: 'owner',
    duration: '1h',
    durationMs: 3600_000,
  });

  // Advance past 15 min - should NOT expire
  time = 16 * 60_000;
  assert.equal(expiryBroker.status(hourReq.request.requestId, 'owner').status, 'pending');

  // Advance past 1 hour - MUST expire
  time = 3600_000 + 1;
  await assert.rejects(
    expiryBroker.resolve({
      id: hourReq.request.requestId,
      challenge: hourReq.challenge,
      decision: 'allow',
      acknowledgedRisk: true,
      principal: 'owner',
      apply: async () => ({}),
    }),
    /expired/
  );
});
