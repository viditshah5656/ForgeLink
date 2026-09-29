function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function artifactReceipt(artifact) {
  const document = artifact?.document || {};
  return {
    id: clean(artifact?.id),
    state: clean(artifact?.state) || 'current',
    title: clean(document.title) || 'ForgeLink Artifact',
    type: clean(document.type) || 'generic-document',
    presentationMode: clean(document.presentationMode) || (clean(document.content || document.markdown) ? 'natural-document' : 'structured-dashboard'),
    revisions: Number.isInteger(artifact?.revisions) && artifact.revisions > 0 ? artifact.revisions : 1,
    updatedAt: clean(artifact?.updatedAt || artifact?.createdAt) || null,
  };
}

export function artifactReceiptResult(artifact, { presentation = null, appArtifact = false } = {}) {
  const structuredContent = {
    artifact: artifactReceipt(artifact),
    ...(presentation ? { presentation } : {}),
  };
  const result = {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
  };
  if (appArtifact) result._meta = { 'forgelink/artifact': artifact };
  return result;
}
