import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EngineeringProtocol, EngineeringRuntime, ENGINEERING_PHASES } from './engineering-protocol.mjs';

const WALKTHROUGH = 'The implementation follows the existing engineering protocol from planning through execution, verification, artifact generation, and final walkthrough. The architecture keeps the canonical artifact linked to the workflow while milestone state and verification evidence remain durable. The control flow moves from approved execution into verification, then records required artifacts before presenting the completed result. The walkthrough explains the important integration boundary, how the result is used, what was verified, and which limitations remain so another engineer can understand the completed work without reconstructing it from tool logs.';
const OPERATION = { operationId: 'op-1', paths: ['/project/src/main.js'], reviewId: '0123456789abcdef', fileCount: 1, addedLines: 3, removedLines: 1 };

function presentFinalReview(protocol) {
  protocol.recordOperation(OPERATION);
  protocol.recordReviewPresentation(OPERATION.operationId, OPERATION.reviewId);
}

function create() {
  return new EngineeringProtocol({
    title: 'Test feature',
    requiredArtifacts: [
      { key: 'plan', description: 'Implementation plan' },
      { key: 'walkthrough', description: 'Walkthrough' },
    ],
  });
}

function toArtifacts(protocol) {
  protocol.definePlan([{ key: 'one', title: 'One' }]);
  protocol.linkPrimaryArtifact('artifact_test_primary');
  protocol.defineGoal({ objective: 'x', acceptanceCriteria: ['y'], milestones: [{ key: 'm', title: 'M' }] });
  protocol.requestReview();
  protocol.approveReview();
  protocol.beginExecution();
  protocol.progress('Done', { milestoneKey: 'm', status: 'completed' });
  protocol.beginVerification();
  protocol.recordVerification('Verification gate', true, 'Verification passed.');
  protocol.beginArtifacts();
}

test('enforces plan -> goal -> execution -> verification -> artifacts -> walkthrough', () => {
  const protocol = create();
  assert.equal(protocol.phase, 'understanding');
  assert.throws(() => protocol.beginExecution(), /Define the goal/);
  protocol.explain('I understand the request.');
  protocol.definePlan([{ key: 'inspect', title: 'Inspect repository' }]);
  protocol.linkPrimaryArtifact('artifact_test_primary');
  protocol.defineGoal({
    objective: 'Implement the feature',
    acceptanceCriteria: ['Feature works', 'Tests pass'],
    milestones: [{ key: 'implementation', title: 'Implement feature' }],
  });
  protocol.requestReview();
  assert.equal(protocol.phase, 'awaiting_user_review');
  assert.throws(() => protocol.beginExecution(), /User review approval is required/);
  protocol.approveReview({ approvedBy: 'user' });
  protocol.beginExecution();
  protocol.progress('Implementation complete.', { milestoneKey: 'implementation', status: 'completed' });
  protocol.beginVerification();
  protocol.recordVerification('Unit tests', true, '145 tests passed');
  protocol.beginArtifacts();
  protocol.recordArtifact({ key: 'plan', title: 'Implementation Plan' });
  protocol.recordArtifact({ key: 'walkthrough', title: 'Walkthrough' });
  protocol.beginWalkthrough(WALKTHROUGH);
  assert.throws(() => protocol.complete(), /committed implementation operation/);
  protocol.recordOperation(OPERATION);
  assert.throws(() => protocol.complete(), /must be presented/);
  protocol.recordReviewPresentation(OPERATION.operationId, OPERATION.reviewId);
  const result = protocol.complete();
  assert.equal(result.type, 'completed');
  assert.equal(protocol.snapshot().phase, 'completed');
  assert.equal(protocol.snapshot().progress, 100);
  assert.equal(protocol.snapshot().primaryArtifactId, 'artifact_test_primary');
  assert.equal(protocol.snapshot().walkthrough, WALKTHROUGH);
  assert.deepEqual(ENGINEERING_PHASES, [
    'understanding', 'planning', 'goal', 'awaiting_user_review', 'execution', 'verification', 'artifacts', 'walkthrough', 'completed',
  ]);
});

test('cannot skip or reverse phases', () => {
  const protocol = create();
  assert.throws(() => protocol.defineGoal({
    objective: 'x',
    acceptanceCriteria: ['y'],
  }), /cannot skip/);
  protocol.definePlan([{ key: 'one', title: 'One' }]);
  protocol.defineGoal({ objective: 'x', acceptanceCriteria: ['y'], milestones: [{ key: 'm', title: 'M' }] });
  assert.throws(() => protocol.beginVerification(), /cannot skip/);
  assert.equal(protocol.phase, 'goal');
  protocol.requestReview();
  assert.throws(() => protocol.beginVerification(), /cannot skip/);
  protocol.approveReview();
  protocol.beginExecution();
  assert.throws(() => protocol.definePlan([{ key: 'two', title: 'Two' }]), /cannot move backward/);
});

test('continuous explanations, decisions and failures are observable', () => {
  const events = [];
  const protocol = new EngineeringProtocol({ title: 'Observable', onUpdate: (event) => events.push(event) });
  protocol.explain('Understanding the request.');
  protocol.definePlan([{ key: 'one', title: 'One' }]);
  protocol.defineGoal({ objective: 'x', acceptanceCriteria: ['y'], milestones: [{ key: 'm', title: 'M' }] });
  protocol.requestReview('Plan ready for review.');
  assert.ok(events.some((event) => event.type === 'explanation' && event.kind === 'review.requested'));
  protocol.approveReview({ approvedBy: 'user', note: 'Looks good.' });
  protocol.beginExecution();
  protocol.recordDecision('Use existing scheduler', 'Avoid duplicating orchestration state.', ['Replace scheduler']);
  protocol.progress('Found an integration point.', { milestoneKey: 'm' });
  protocol.recordFailure('First test failed.', 'Adjusted the integration boundary.');
  assert.ok(events.some((event) => event.type === 'explanation'));
  assert.ok(events.some((event) => event.type === 'decision.recorded'));
  assert.ok(events.some((event) => event.type === 'failure.recorded'));
  assert.ok(events.some((event) => event.type === 'execution.progress'));
});

test('completion gate requires every milestone and required artifact', () => {
  const missingArtifacts = create();
  toArtifacts(missingArtifacts);
  assert.throws(() => missingArtifacts.complete(), /Walkthrough must be completed/);
  missingArtifacts.beginWalkthrough(WALKTHROUGH);
  assert.throws(() => missingArtifacts.complete(), /Required artifacts missing/);

  const missingSecondArtifact = create();
  toArtifacts(missingSecondArtifact);
  missingSecondArtifact.recordArtifact({ key: 'plan', title: 'Plan' });
  missingSecondArtifact.beginWalkthrough(WALKTHROUGH);
  assert.throws(() => missingSecondArtifact.complete(), /Required artifacts missing/);

  const complete = create();
  toArtifacts(complete);
  complete.recordArtifact({ key: 'plan', title: 'Plan' });
  complete.recordArtifact({ key: 'walkthrough', title: 'Walkthrough' });
  complete.beginWalkthrough(WALKTHROUGH);
  presentFinalReview(complete);
  assert.equal(complete.complete().type, 'completed');
});

test('review presentation must match the committed operation and follow the walkthrough', () => {
  const protocol = create();
  toArtifacts(protocol);
  protocol.recordOperation(OPERATION);
  assert.throws(() => protocol.recordReviewPresentation(OPERATION.operationId, OPERATION.reviewId), /after the walkthrough/);
  protocol.recordArtifact({ key: 'plan', title: 'Plan' });
  protocol.recordArtifact({ key: 'walkthrough', title: 'Walkthrough' });
  protocol.beginWalkthrough(WALKTHROUGH);
  assert.throws(() => protocol.recordReviewPresentation(OPERATION.operationId, 'different'), /No matching/);
  protocol.recordReviewPresentation(OPERATION.operationId, OPERATION.reviewId);
  assert.equal(protocol.invalidateReviewPresentation(OPERATION.operationId), true);
  assert.throws(() => protocol.complete(), /must be presented/);
  protocol.recordReviewPresentation(OPERATION.operationId, OPERATION.reviewId);
  assert.equal(protocol.recordOperation(OPERATION).operationId, OPERATION.operationId);
  assert.throws(() => protocol.recordOperation({ ...OPERATION, addedLines: 9 }), /changed after/);
  assert.equal(protocol.complete().type, 'completed');
});

test('observer failures cannot corrupt protocol state and snapshots are isolated', () => {
  const protocol = new EngineeringProtocol({ title: 'Isolation', onUpdate: () => { throw new Error('observer'); } });
  protocol.explain('safe');
  const snapshot = protocol.snapshot();
  snapshot.plan.push({ key: 'fake' });
  assert.equal(protocol.snapshot().plan.length, 0);
});

test('runtime persists protocol state and restores it across instances', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = await mkdtemp(join(tmpdir(), 'forgelink-engineering-'));
  try {
    const runtime = new EngineeringRuntime({ dataDir });
    const started = await runtime.start({
      title: 'Persistent task',
      description: 'runtime integration',
      requiredArtifacts: [{ key: 'walkthrough', description: 'Walkthrough' }],
      primaryArtifactId: 'artifact_persistent_primary',
      root: dataDir,
    });
    await runtime.plan(started.id, [{ key: 'inspect', title: 'Inspect' }]);
    await runtime.goal(started.id, {
      objective: 'Implement integration',
      acceptanceCriteria: ['Runtime survives restart'],
      milestones: [{ key: 'm1', title: 'Integration' }],
    });
    await runtime.requestReview(started.id);
    const restoredBeforeApproval = new EngineeringRuntime({ dataDir });
    await restoredBeforeApproval.ready;
    assert.equal(restoredBeforeApproval.status(started.id).phase, 'awaiting_user_review');
    await restoredBeforeApproval.approveReview(started.id, { approvedBy: 'user' });
    await restoredBeforeApproval.beginExecution(started.id);
    await restoredBeforeApproval.progress(started.id, 'Integrated', { milestoneKey: 'm1', status: 'completed' });
    const restored = new EngineeringRuntime({ dataDir });
    await restored.ready;
    const snapshot = restored.status(started.id);
    assert.equal(snapshot.title, 'Persistent task');
    assert.equal(snapshot.phase, 'execution');
    assert.equal(snapshot.progress, 100);
    assert.equal(snapshot.links.root, dataDir);
    assert.equal(snapshot.primaryArtifactId, 'artifact_persistent_primary');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('runtime authorizes mutations only through the most specific approved owning workflow', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = await mkdtemp(join(tmpdir(), 'forgelink-engineering-auth-'));
  const outerRoot = join(dataDir, 'outer');
  const nestedRoot = join(outerRoot, 'nested');
  try {
    await mkdir(join(nestedRoot, 'src'), { recursive: true });
    const runtime = new EngineeringRuntime({ dataDir });
    const outer = await runtime.start({ title: 'Outer approved workflow', primaryArtifactId: 'artifact_outer', root: outerRoot });
    await runtime.plan(outer.id, [{ key: 'edit', title: 'Edit' }]);
    await runtime.goal(outer.id, { objective: 'Outer change', acceptanceCriteria: ['Works'], milestones: [{ key: 'm', title: 'Mutation' }] });
    await runtime.requestReview(outer.id);
    await runtime.approveReview(outer.id, { approvedBy: 'user' });

    const nested = await runtime.start({ title: 'Nested pending workflow', primaryArtifactId: 'artifact_nested', root: nestedRoot });
    await runtime.plan(nested.id, [{ key: 'edit', title: 'Edit nested' }]);
    await runtime.goal(nested.id, { objective: 'Nested change', acceptanceCriteria: ['Works'], milestones: [{ key: 'm', title: 'Mutation' }] });
    await runtime.requestReview(nested.id);

    const target = join(nestedRoot, 'src', 'index.js');
    await assert.rejects(runtime.authorizeMutation({ targets: [target], operation: 'write_file' }), /ENGINEERING_APPROVAL_REQUIRED/);
    await runtime.approveReview(nested.id, { approvedBy: 'user' });
    const authorized = await runtime.authorizeMutation({ targets: [target], operation: 'write_file' });
    assert.equal(authorized.id, nested.id);
    assert.equal(authorized.review.status, 'approved');
    await assert.rejects(runtime.authorizeMutation({ targets: [join(dataDir, 'outside.js')], operation: 'write_file' }), /ENGINEERING_WORKFLOW_REQUIRED/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('runtime reassigns an operation to its authoritative active workflow owner', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = await mkdtemp(join(tmpdir(), 'forgelink-engineering-owner-'));
  const root = join(dataDir, 'project');
  const makeExecutable = async (runtime, title, artifact) => {
    const started = await runtime.start({ title, primaryArtifactId: artifact, root });
    await runtime.plan(started.id, [{ key: 'edit', title: 'Edit' }]);
    await runtime.goal(started.id, { objective: title, acceptanceCriteria: ['Works'], milestones: [{ key: 'm', title: 'Mutation' }] });
    await runtime.requestReview(started.id);
    await runtime.approveReview(started.id, { approvedBy: 'user' });
    await runtime.beginExecution(started.id);
    return started;
  };
  try {
    await mkdir(root, { recursive: true });
    const runtime = new EngineeringRuntime({ dataDir });
    const wrong = await makeExecutable(runtime, 'Wrong workflow', 'artifact_wrong');
    const owner = await makeExecutable(runtime, 'Authoritative workflow', 'artifact_owner');
    await runtime.recordOperation(wrong.id, OPERATION);
    assert.equal(runtime.status(wrong.id).operations.length, 1);
    await runtime.recordOwnedOperation(owner.id, OPERATION);
    assert.equal(runtime.status(wrong.id).operations.length, 0);
    assert.equal(runtime.status(owner.id).operations.length, 1);
    assert.equal(runtime.status(owner.id).operations[0].operationId, OPERATION.operationId);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('runtime emits protocol events without allowing observer failure to break persistence', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = await mkdtemp(join(tmpdir(), 'forgelink-engineering-events-'));
  const events = [];
  try {
    const runtime = new EngineeringRuntime({ dataDir, onEvent: (event) => { events.push(event); throw new Error('observer'); } });
    const started = await runtime.start({ title: 'Events' });
    await runtime.explain(started.id, 'Inspection complete.');
    assert.ok(events.some((event) => event.type === 'explanation'));
    const second = new EngineeringRuntime({ dataDir });
    await second.ready;
    assert.equal(second.status(started.id).title, 'Events');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

