import assert from 'node:assert/strict';
import testFn from 'node:test';
import { createArtifactDocument, validateArtifactDocument, ArtifactPresentationRuntime } from './artifact-presentation.mjs';

testFn('creates and validates a semantic technical artifact', () => {
  const artifact = createArtifactDocument({
    type: 'technical-report',
    title: 'Architecture Audit',
    metadata: { project: 'MeeraAI', basis: 'Current working tree' },
    summary: 'Evidence-backed audit.',
    sections: [{ id: 'summary', title: 'Executive Summary', blocks: [{ type: 'paragraph', text: 'Observed architecture.', certainty: 'observed', evidenceIds: ['e1'] }] }],
    evidence: [{ id: 'e1', claim: 'server.mjs contains the relevant integration', certainty: 'verified', path: 'server.mjs', lines: '100-120' }],
    verification: [{ id: 'v1', check: 'Syntax check', passed: true, evidence: 'exit code 0' }],
    limitations: ['Live macOS runtime was not tested.'],
  });
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(validateArtifactDocument(artifact).valid, true);
});

testFn('rejects unsupported verified claims and secret material', () => {
  assert.throws(() => createArtifactDocument({
    type: 'technical-report', title: 'Bad',
    sections: [{ title: 'Evidence', blocks: [{ type: 'paragraph', text: 'It passed.', certainty: 'verified' }] }],
    evidence: [],
  }), /validation failed/);
  const result = validateArtifactDocument({
    schemaVersion: 1, type: 'generic-document', title: 'secret', metadata: {},
    sections: [{ title: 'x', blocks: [{ type: 'paragraph', text: 'api_key=ABCDEFGHIJKLMNOPQRST' }] }],
    evidence: [], verification: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => /secret/i.test(item)));
});

testFn('completed implementation artifacts require deep walkthroughs and visual engineering evidence without fixed section titles', () => {
  assert.throws(() => createArtifactDocument({
    type: 'implementation-plan',
    title: 'Completed but shallow',
    metadata: { phase: 'completed' },
    sections: [{ title: 'Anything', blocks: [{ type: 'paragraph', text: 'Implemented.' }] }],
    evidence: [],
    verification: [],
    walkthrough: 'Done.',
  }), /substantive walkthrough|visual block/i);

  const walkthrough = 'The implementation updates the actual owning layers and preserves the existing runtime boundary while adding the requested behavior. The architecture explanation describes how the frontend, bridge, backend, and verification path interact, including where state is created and consumed. The execution flow shows the user action entering the feature, moving through the integration boundary, and returning a verified result. The changed files are explained alongside the operational behavior, verification evidence, recovery decisions, and remaining limitations so the user can understand and maintain the work after completion.';
  const artifact = createArtifactDocument({
    type: 'implementation-plan',
    title: 'Adaptive completed implementation',
    metadata: { implementationState: 'verified' },
    sections: [
      { title: 'System Movement', blocks: [
        { type: 'paragraph', text: 'The owning components and boundaries are explained here.' },
        { type: 'code', language: 'mermaid', text: 'flowchart LR\nA[Input] --> B[Bridge]\nB --> C[Verified output]' },
      ] },
      { title: 'Proof', blocks: [{ type: 'paragraph', text: 'Verification and limitations are described without relying on hardcoded walkthrough headings.' }] },
    ],
    evidence: [],
    verification: [],
    walkthrough,
  });
  assert.equal(validateArtifactDocument(artifact).valid, true);
});

testFn('keeps freeform markdown canonical instead of reparsing it into hardcoded sections', () => {
  const content = `# MeeraAI — Architecture & Security Audit

Executive summary describing the findings and architecture of MeeraAI platform.

## System Architecture

\`\`\`mermaid
flowchart TD
  Desktop[Electron + React] --> API[FastAPI Meera.py]
  API --> LocalModels[GGUF / Llama Engine]
\`\`\`

## Key Dimensions

| Dimension | Observed State | Status |
| --- | --- | --- |
| Desktop Build | Healthy | Pass |
| Voice Integration | Degraded | Action Required |

> Architecture highlights confirm modular decoupling of speech pipelines.

## Implementation Details

- Consolidated single trust model for MCP endpoints
- Decoupled voice supervisor from stateful Electron session
`;

  const artifact = createArtifactDocument({
    type: 'technical-report',
    content,
    evidence: [{ id: 'e1', claim: 'Desktop build is healthy.', certainty: 'verified', source: 'test' }],
    verification: [{ id: 'v1', check: 'Desktop build', passed: true, evidence: 'Build passed.' }],
  });

  assert.equal(artifact.title, 'MeeraAI — Architecture & Security Audit');
  assert.equal(artifact.presentationMode, 'natural-document');
  assert.equal(artifact.content, content.trim());
  assert.deepEqual(artifact.sections, []);
  assert.equal(artifact.evidence.length, 1);
  assert.equal(artifact.verification.length, 1);
  assert.equal(validateArtifactDocument(artifact).valid, true);
});

testFn('supports private local image assets referenced from natural markdown', () => {
  const artifact = createArtifactDocument({
    type: 'research-report',
    title: 'Visual report',
    content: '# Visual report\n\n![Project logo](asset:project-logo)',
    assets: [{
      id: 'project-logo',
      type: 'image',
      alt: 'Project logo',
      title: 'Project branding',
      placement: 'hero',
      source: { kind: 'approved-local-file', path: 'C:\\Project\\logo.png' },
    }],
  });
  assert.equal(artifact.assets.length, 1);
  assert.equal(artifact.assets[0].id, 'project-logo');
  assert.equal(artifact.assets[0].role, 'logo', 'legacy hero assets should automatically become compact logos');
  assert.equal(validateArtifactDocument(artifact).valid, true);

  const screenshot = createArtifactDocument({
    type: 'research-report',
    title: 'Screenshot report',
    content: '# Screenshot report\n\n![App screen](asset:app-screen)',
    assets: [{
      id: 'app-screen',
      type: 'image',
      role: 'screenshot',
      alt: 'Application screenshot',
      source: { kind: 'approved-local-file', path: 'C:\\Project\\screen.png' },
    }],
  });
  assert.equal(screenshot.assets[0].role, 'screenshot');

  assert.throws(() => createArtifactDocument({
    type: 'research-report',
    title: 'Broken visual report',
    content: '# Broken\n\n![Missing](asset:missing-image)',
    assets: [],
  }), /missing artifact asset/i);
});

testFn('persists artifacts and marks source-dependent artifacts stale', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = await mkdtemp(join(tmpdir(), 'forgelink-artifacts-'));
  try {
    const runtime = new ArtifactPresentationRuntime({ dataDir });
    const created = await runtime.create({
      type: 'implementation-plan', title: 'Plan', sourceFingerprint: 'abc',
      sections: [{ title: 'Plan', blocks: [{ type: 'paragraph', text: 'Implement it.' }] }],
      evidence: [], verification: [],
    });
    assert.equal(runtime.get(created.id).state, 'current');
    await runtime.markStaleByFingerprint('xyz');
    assert.equal(runtime.get(created.id).state, 'stale');
    const restored = new ArtifactPresentationRuntime({ dataDir });
    await restored.ready;
    assert.equal(restored.get(created.id).state, 'stale');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

