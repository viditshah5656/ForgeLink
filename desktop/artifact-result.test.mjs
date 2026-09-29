import assert from 'node:assert/strict';
import testFn from 'node:test';
import { artifactReceipt, artifactReceiptResult } from './artifact-result.mjs';

const marker = 'PRIVATE_ARTIFACT_BODY_MUST_NOT_REACH_CHAT';
const artifact = {
  id: 'artifact_transport_test',
  state: 'current',
  revisions: 7,
  updatedAt: '2026-09-28T12:00:00.000Z',
  document: {
    type: 'research-report',
    presentationMode: 'natural-document',
    title: 'Transport isolation test',
    content: marker,
    evidence: [{ id: 'e1', claim: marker, certainty: 'verified' }],
  },
};

testFn('artifact receipt contains identity but never document body or sidecars', () => {
  const receipt = artifactReceipt(artifact);
  assert.deepEqual(receipt, {
    id: 'artifact_transport_test',
    state: 'current',
    title: 'Transport isolation test',
    type: 'research-report',
    presentationMode: 'natural-document',
    revisions: 7,
    updatedAt: '2026-09-28T12:00:00.000Z',
  });
  assert.equal(JSON.stringify(receipt).includes(marker), false);
});

testFn('rich artifact open keeps the full artifact app-only in result metadata', () => {
  const result = artifactReceiptResult(artifact, {
    presentation: {
      mode: 'rich-document-required',
      fallback: 'minimal-reference-only',
      instruction: 'Render in the ForgeLink artifact app.',
    },
    appArtifact: true,
  });

  assert.equal(JSON.stringify(result.structuredContent).includes(marker), false);
  assert.equal(result.content.some((part) => String(part.text || '').includes(marker)), false);
  assert.equal(result._meta['forgelink/artifact'].document.content, marker);
  assert.equal(result.structuredContent.artifact.id, artifact.id);
});

testFn('plain artifact mutations return only compact model-visible receipts', () => {
  const result = artifactReceiptResult(artifact);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(result.structuredContent.artifact.title, artifact.document.title);
  assert.equal(result._meta, undefined);
});
