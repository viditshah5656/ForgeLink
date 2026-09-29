import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(fs.readFileSync(path.join(here, ".env"), "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const base = process.argv[2] || "http://localhost:24024";
const resource = `${base}/mcp`;
const result = {};
const serverInfoHasForgeLinkBranding = (info) =>
  info?.name === "local-coding-files" &&
  info?.title === "ForgeLink" &&
  Array.isArray(info?.icons) &&
  info.icons.some((icon) => icon?.mimeType === "image/png" && String(icon?.src || "").startsWith("data:image/png;base64,"));
const modernServerInfoOk = (value) => serverInfoHasForgeLinkBranding(value?._meta?.["io.modelcontextprotocol/serverInfo"]);
const modernCacheEnvelopeOk = (value) => value?.resultType === "complete" && value?.ttlMs === 0 && value?.cacheScope === "private" && modernServerInfoOk(value);

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

if (process.argv.includes("--no-auth")) {
  for (const endpoint of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]) {
    const response = await fetch(`${base}${endpoint}`);
    if (response.status !== 404) throw new Error(`No-auth mode must not advertise OAuth at ${endpoint} (got ${response.status})`);
  }
  const toolsResponse = await json(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const listedTools = toolsResponse.body?.result?.tools || [];
  if (toolsResponse.response.status !== 200 || !listedTools.length || listedTools.some((tool) => tool.securitySchemes?.length !== 1 || tool.securitySchemes[0].type !== "noauth" || tool._meta?.securitySchemes)) {
    throw new Error(`No-auth tool descriptors are inconsistent: ${JSON.stringify(toolsResponse.body)}`);
  }
  const toolsByName = new Map(listedTools.map((tool) => [tool.name, tool]));
  const ordinaryTool = toolsByName.get("list_allowed_directories");
  if (!ordinaryTool?.description?.includes("FORGELINK UNIVERSAL INTERACTION RULE") || !ordinaryTool?.description?.includes("ONE FORGELINK CALL PER VISIBLE BRIDGE") || ordinaryTool?._meta?.["openai/toolInvocation/invoking"] || ordinaryTool?._meta?.["openai/toolInvocation/invoked"] || ordinaryTool?._meta?.ui || ordinaryTool?._meta?.["openai/outputTemplate"]) {
    throw new Error(`Ordinary ForgeLink tools must stay plain MCP descriptors with the universal interaction reminder: ${JSON.stringify(ordinaryTool)}`);
  }
  const readBatchTool = toolsByName.get("forgelink_read_batch");
  if (!readBatchTool || readBatchTool.annotations?.readOnlyHint !== true || !readBatchTool.description?.includes("ONE MCP call") || readBatchTool?._meta?.ui || readBatchTool?._meta?.["openai/outputTemplate"] || readBatchTool?._meta?.["openai/toolInvocation/invoking"] || readBatchTool?._meta?.["openai/toolInvocation/invoked"]) {
    throw new Error(`forgelink_read_batch must stay a plain read-only MCP tool: ${JSON.stringify(readBatchTool)}`);
  }
  const requiredRuntimeTools = ["subagent_batch", "swarm_plan", "swarm_spawn", "agent_message_list", "swarm_blackboard_read", "swarm_blackboard_write", "swarm_wait_graph"];
  const requiredWindowsTools = ["windows_control_status","windows_overview","windows_screenshot","windows_desktop_state","windows_browser_tabs","windows_installed_apps","windows_app_control","windows_realtime_state","windows_settings","windows_registry","windows_services","windows_processes","windows_scheduled_tasks","windows_startup","windows_event_logs","windows_network","windows_power","windows_devices","windows_system_file_info"];
  if (requiredRuntimeTools.some((name) => !toolsByName.has(name))) throw new Error(`Native runtime MCP tools are missing: ${requiredRuntimeTools.filter((name) => !toolsByName.has(name)).join(", ")}`);
  if (requiredWindowsTools.some((name) => !toolsByName.has(name))) throw new Error(`Windows Control MCP tools are missing: ${requiredWindowsTools.filter((name) => !toolsByName.has(name)).join(", ")}`);
  if (!toolsByName.has("job_recovery_status")) throw new Error("Process recovery status MCP tool is missing");
  const directProcessGrant = toolsByName.get("subagent_batch")?.inputSchema?.properties?.agents?.items?.properties?.processAccess?.type;
  const swarmProcessGrant = toolsByName.get("swarm_plan")?.inputSchema?.properties?.tasks?.items?.properties?.processAccess?.type;
  if (directProcessGrant !== "boolean" || swarmProcessGrant !== "boolean") throw new Error("Native agent processAccess must be exposed as an explicit boolean grant");
  const modernNoAuthMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "local-modern-no-auth-verifier", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
  };
  const modernDiscovery = await json(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "modern-no-auth-discover", method: "server/discover", params: { _meta: modernNoAuthMeta } }),
  });
  const noAuthUiExtension = modernDiscovery.body?.result?.capabilities?.extensions?.["io.modelcontextprotocol/ui"];
  if (modernDiscovery.response.status !== 200 || !modernCacheEnvelopeOk(modernDiscovery.body?.result) || modernDiscovery.body?.result?.capabilities?.resources?.listChanged !== true || noAuthUiExtension) {
    throw new Error(`No-auth modern discovery must not advertise MCP Apps UI server-wide: ${JSON.stringify(modernDiscovery.body)}`);
  }
  const modernToolsResponse = await json(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "modern-no-auth-tools", method: "tools/list", params: { _meta: modernNoAuthMeta } }),
  });
  const noAuthArtifactTool = modernToolsResponse.body?.result?.tools?.find((tool) => tool.name === "presentation_artifact_create");
  const noAuthArtifactGetTool = modernToolsResponse.body?.result?.tools?.find((tool) => tool.name === "presentation_artifact_get");
  const noAuthArtifactOpenTool = modernToolsResponse.body?.result?.tools?.find((tool) => tool.name === "presentation_artifact_open");
  const noAuthArtifactUri = noAuthArtifactOpenTool?._meta?.ui?.resourceUri;
  const noAuthEngineeringStart = modernToolsResponse.body?.result?.tools?.find((tool) => tool.name === "engineering_start");
  const noAuthEngineeringWorkflowStart = modernToolsResponse.body?.result?.tools?.find((tool) => tool.name === "engineering_workflow_start");
  if (modernToolsResponse.response.status !== 200 || !modernCacheEnvelopeOk(modernToolsResponse.body?.result) || !noAuthArtifactUri?.endsWith("/presentation-artifact-v18.html") || noAuthArtifactOpenTool?._meta?.["openai/outputTemplate"] !== noAuthArtifactUri || noAuthArtifactTool?._meta?.ui || noAuthArtifactTool?._meta?.["openai/outputTemplate"] || noAuthArtifactGetTool?._meta?.ui || noAuthArtifactGetTool?._meta?.["openai/outputTemplate"]) {
    throw new Error(`No-auth presentation artifact descriptors are missing the v13 rich-open UI template: ${JSON.stringify({ create:noAuthArtifactTool, open:noAuthArtifactOpenTool, get:noAuthArtifactGetTool })}`);
  }
  for (const descriptor of [noAuthEngineeringStart, noAuthEngineeringWorkflowStart]) {
    if (!descriptor?.inputSchema?.required?.includes("primaryArtifactId")) throw new Error(`No-auth engineering start tool does not require primaryArtifactId: ${JSON.stringify(descriptor)}`);
  }
  const modernResourceResponse = await json(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "resources/read" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "modern-no-auth-resource", method: "resources/read", params: { uri: noAuthArtifactUri, _meta: modernNoAuthMeta } }),
  });
  const noAuthResource = modernResourceResponse.body?.result?.contents?.[0];
  if (modernResourceResponse.response.status !== 200 || !modernCacheEnvelopeOk(modernResourceResponse.body?.result) || noAuthResource?.uri !== noAuthArtifactUri || noAuthResource?.mimeType !== "text/html;profile=mcp-app" || typeof noAuthResource?.text !== "string" || !noAuthResource.text.toLowerCase().includes("<!doctype html>") || !noAuthResource.text.includes("Download PDF") || !noAuthResource.text.includes("Open app in tab") || !noAuthResource.text.includes(">Copy<") || !noAuthResource.text.includes("View full artifact") || !noAuthResource.text.includes("flex-wrap: nowrap") || !noAuthResource.text.includes(".artifact-app.is-collapsed .hero-subtitle")) {
    throw new Error(`No-auth modern artifact resources/read failed: ${JSON.stringify(modernResourceResponse.body)}`);
  }
  const initResponse = await json(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-verifier", version: "1.0.0" } } }),
  });
  const noAuthInstructions = initResponse.body?.result?.instructions;
  const noAuthInstructionFragments = ["FORGELINK UNIVERSAL INTERACTION CONTRACT", "Whenever ANY ForgeLink MCP tool is involved", "ONE FORGELINK CALL PER VISIBLE BRIDGE", "authorization is consumed", "STOP the execution turn rather than calling another ForgeLink tool", "Never issue back-to-back ForgeLink tool calls", "VISIBLE PROGRESS FORMAT", "CANONICAL ARTIFACT LIFECYCLE", "primaryArtifactId", "presentation_artifact_update", "presentation_artifact_open", "Open app in tab", "Copy", "Download PDF", "system_control_status", "request_windows_control_access", "Full Terminal"];
  if (initResponse.response.status !== 200 || typeof noAuthInstructions !== "string" || noAuthInstructionFragments.some((fragment) => !noAuthInstructions.toLowerCase().includes(fragment.toLowerCase()))) {
    throw new Error(`No-auth MCP initialization failed the interactive/artifact contract; missing: ${noAuthInstructionFragments.filter((fragment) => !noAuthInstructions?.toLowerCase().includes(fragment.toLowerCase())).join(", ")}`);
  }
  console.log(JSON.stringify({ mode: "no-auth", oauthDiscovery: "disabled", toolCount: listedTools.length, nativeRuntimeTools: requiredRuntimeTools.length,
    processRecoveryTools: 1, windowsControlTools: requiredWindowsTools.length, processAccessGrant: "explicit boolean on direct and durable swarm tasks", securitySchemes: "noauth", initialize: "ok", artifactUi: "v18", artifactOpenTool: true, pdfExport: true, primaryArtifactRequired: true }, null, 2));
} else {

const protectedMeta = await json(`${base}/.well-known/oauth-protected-resource`);
result.protectedResource = { status: protectedMeta.response.status, resource: protectedMeta.body.resource };
const authMeta = await json(`${base}/.well-known/oauth-authorization-server`);
result.authorizationServer = { status: authMeta.response.status, pkce: authMeta.body.code_challenge_methods_supported, registration: Boolean(authMeta.body.registration_endpoint) };

const registration = await json(`${base}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Local verification", redirect_uris: ["http://127.0.0.1:49152/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
});
if (registration.response.status !== 201) throw new Error(`Registration failed: ${JSON.stringify(registration.body)}`);

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const authorize = new URL(`${base}/authorize`);
authorize.search = new URLSearchParams({ response_type: "code", client_id: registration.body.client_id, redirect_uri: "http://127.0.0.1:49152/callback", code_challenge: challenge, code_challenge_method: "S256", scope: "files:read files:write", state: "verification-state", resource }).toString();
const loginPage = await fetch(authorize);
const html = await loginPage.text();
const pending = html.match(/name="pending" value="([^"]+)"/)?.[1];
if (!pending) throw new Error("Authorization login page did not contain a pending request");

const approval = await fetch(`${base}/approve`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ pending, password: env.OAUTH_LOGIN_PASSWORD, decision: "allow" }) });
const callback = new URL(approval.headers.get("location"));
const code = callback.searchParams.get("code");
if (!code || callback.searchParams.get("state") !== "verification-state") throw new Error("Authorization approval did not return a valid code/state");

const tokens = await json(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.body.client_id, code, code_verifier: verifier, redirect_uri: "http://127.0.0.1:49152/callback", resource }) });
if (tokens.response.status !== 200 || !tokens.body.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(tokens.body)}`);

async function mcp(id, method, params = {}) {
  return json(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.body.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
}

const initialized = await mcp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }, clientInfo: { name: "local-verifier", version: "1.0.0" } });
const mcpInstructions = initialized.body?.result?.instructions;
const requiredInstructionFragments = ["FORGELINK UNIVERSAL INTERACTION CONTRACT", "Whenever ANY ForgeLink MCP tool is involved", "ONE FORGELINK CALL PER VISIBLE BRIDGE", "authorization is consumed", "STOP the execution turn rather than calling another ForgeLink tool", "Never issue back-to-back ForgeLink tool calls", "implement the outcome", "inspect_workspace", "get_git_status", "get_git_diff", "FORGELINK DEFAULT ENGINEERING MODE", "every task involving ForgeLink", "DEEP CODING AGENT CONTRACT", "ENGINEERING COMMUNICATION PROTOCOL", "DEFINE GOAL", "ARTIFACT CONTRACT", "ARTIFACT-FIRST PRESENTATION CONTRACT", "presentation_artifact_create", "presentation_artifact_validate", "rich-document-required", "WALKTHROUGH", "EVIDENCE AND CERTAINTY", "COMPLETION GATE", "MANDATORY TOOL INTERACTION LOOP", "BEFORE EVERY TOOL CALL OR LOGICAL PARALLEL TOOL BATCH", "IMMEDIATELY AFTER EVERY TOOL CALL OR LOGICAL PARALLEL TOOL BATCH", "next-action bridge", "Stay interactive with the user while working", "Explain next action", "Interpret result", "milestone checkpoint", "PROFESSIONAL VISIBLE PROGRESS FORMAT", "Pre-tool", "Post-tool", "CANONICAL ARTIFACT LIFECYCLE", "primaryArtifactId", "presentation_artifact_update", "Download PDF"];
if (initialized.response.status !== 200 || typeof mcpInstructions !== "string" || requiredInstructionFragments.some((fragment) => !mcpInstructions.toLowerCase().includes(fragment.toLowerCase()))) {
  throw new Error(`MCP initialize did not return the agentic coding workflow: ${JSON.stringify(initialized.body)}`);
}
const legacyUiExtension = initialized.body?.result?.capabilities?.extensions?.["io.modelcontextprotocol/ui"];
if (legacyUiExtension) {
  throw new Error(`Legacy initialize must not advertise MCP Apps UI server-wide: ${JSON.stringify(initialized.body?.result?.capabilities)}`);
}
if (!serverInfoHasForgeLinkBranding(initialized.body?.result?.serverInfo)) {
  throw new Error(`MCP initialize is missing ForgeLink title/icon branding: ${JSON.stringify(initialized.body?.result?.serverInfo)}`);
}
result.mcpInitialize = { status: initialized.response.status, server: initialized.body?.result?.serverInfo?.name, title: initialized.body?.result?.serverInfo?.title, hasIcon: true, instructionsLength: mcpInstructions.length, uiExtension: null };
const discovery = await mcp(5, "server/discover");
const supportedVersions = discovery.body?.result?.supportedVersions;
const listChanged = discovery.body?.result?.capabilities?.tools?.listChanged;
const resourcesListChanged = discovery.body?.result?.capabilities?.resources?.listChanged;
const discoveredUiExtension = discovery.body?.result?.capabilities?.extensions?.["io.modelcontextprotocol/ui"];
if (discovery.response.status !== 200 || !supportedVersions?.includes("2026-07-28") || listChanged !== true || resourcesListChanged !== true || discoveredUiExtension || discovery.body?.result?.instructions !== mcpInstructions) {
  throw new Error(`Connector discovery contract mismatch: ${JSON.stringify(discovery.body)}`);
}
result.connectorDiscovery = { status: discovery.response.status, supportedVersions, listChanged, resourcesListChanged, uiExtension: null, instructionsMatch: true };

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "local-modern-verifier", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
};
const modernTools = await json(`${base}/mcp`, {
  method: "POST",
  headers: { authorization: `Bearer ${tokens.body.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "modern-tools-list", method: "tools/list", params: { _meta: modernMeta } }),
});
if (modernTools.response.status !== 200 || !modernCacheEnvelopeOk(modernTools.body?.result) || !Array.isArray(modernTools.body?.result?.tools)) {
  throw new Error(`Modern tools/list compatibility failed: ${JSON.stringify(modernTools.body)}`);
}
const artifactCreateDescriptor = modernTools.body.result.tools.find((tool) => tool.name === "presentation_artifact_create");
const artifactOpenDescriptor = modernTools.body.result.tools.find((tool) => tool.name === "presentation_artifact_open");
const ordinaryModernDescriptor = modernTools.body.result.tools.find((tool) => tool.name === "list_allowed_directories");
if (!ordinaryModernDescriptor?.description?.includes("FORGELINK UNIVERSAL INTERACTION RULE") || !ordinaryModernDescriptor?.description?.includes("ONE FORGELINK CALL PER VISIBLE BRIDGE") || ordinaryModernDescriptor?._meta?.["openai/toolInvocation/invoking"] || ordinaryModernDescriptor?._meta?.["openai/toolInvocation/invoked"] || ordinaryModernDescriptor?._meta?.ui || ordinaryModernDescriptor?._meta?.["openai/outputTemplate"]) {
  throw new Error(`Modern ordinary tools must not advertise MCP App invocation/UI metadata: ${JSON.stringify(ordinaryModernDescriptor)}`);
}
const artifactResourceUri = artifactOpenDescriptor?._meta?.ui?.resourceUri;
if (!artifactResourceUri?.startsWith("ui://") || artifactOpenDescriptor?._meta?.["openai/outputTemplate"] !== artifactResourceUri || artifactCreateDescriptor?._meta?.ui || artifactCreateDescriptor?._meta?.["openai/outputTemplate"]) {
  throw new Error(`Presentation artifact open tool is not linked to the current UI template: ${JSON.stringify(artifactCreateDescriptor)}`);
}
const engineeringStartDescriptor = modernTools.body.result.tools.find((tool) => tool.name === "engineering_start");
const engineeringWorkflowStartDescriptor = modernTools.body.result.tools.find((tool) => tool.name === "engineering_workflow_start");
for (const descriptor of [engineeringStartDescriptor, engineeringWorkflowStartDescriptor]) {
  if (!descriptor?.inputSchema?.required?.includes("primaryArtifactId")) {
    throw new Error(`Engineering start tool does not require primaryArtifactId: ${JSON.stringify(descriptor)}`);
  }
}
if (!artifactResourceUri.endsWith("/presentation-artifact-v18.html")) throw new Error(`Artifact UI is not on v18: ${artifactResourceUri}`);
result.modernToolsList = { status: modernTools.response.status, resultType: modernTools.body.result.resultType, count: modernTools.body.result.tools.length, artifactResourceUri, primaryArtifactRequired: true };
const modernResource = await json(`${base}/mcp`, {
  method: "POST",
  headers: { authorization: `Bearer ${tokens.body.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "resources/read" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "modern-resource-read", method: "resources/read", params: { uri: artifactResourceUri, _meta: modernMeta } }),
});
const resourceContent = modernResource.body?.result?.contents?.[0];
if (modernResource.response.status !== 200 || !modernCacheEnvelopeOk(modernResource.body?.result) || resourceContent?.uri !== artifactResourceUri || resourceContent?.mimeType !== "text/html;profile=mcp-app" || typeof resourceContent?.text !== "string" || !resourceContent.text.toLowerCase().includes("<!doctype html>") || !resourceContent.text.includes("Download PDF") || !resourceContent.text.includes("Open app in tab") || !resourceContent.text.includes(">Copy<") || !resourceContent.text.includes("View full artifact") || !resourceContent.text.includes("flex-wrap: nowrap") || !resourceContent.text.includes(".artifact-app.is-collapsed .hero-subtitle")) {
  throw new Error(`Modern artifact resources/read compatibility failed: ${JSON.stringify(modernResource.body)}`);
}
result.modernArtifactResource = { status: modernResource.response.status, resultType: modernResource.body.result.resultType, uri: resourceContent.uri, mimeType: resourceContent.mimeType, htmlChars: resourceContent.text.length, pdfExport: true };
const modernCall = await json(`${base}/mcp`, {
  method: "POST",
  headers: { authorization: `Bearer ${tokens.body.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "list_allowed_directories" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "modern-tools-call", method: "tools/call", params: { name: "list_allowed_directories", arguments: {}, _meta: modernMeta } }),
});
if (modernCall.response.status !== 200 || modernCall.body?.result?.resultType !== "complete" || !modernServerInfoOk(modernCall.body?.result) || modernCall.body?.result?.isError === true) {
  throw new Error(`Modern tools/call compatibility failed: ${JSON.stringify(modernCall.body)}`);
}
result.modernToolsCall = { status: modernCall.response.status, resultType: modernCall.body.result.resultType };
const interactionCheckpointPrefix = "FORGELINK INTERACTION CHECKPOINT — OUTER CALL COMPLETE.";
const modernCallCheckpointCount = (modernCall.body?.result?.content || []).filter((part) => part?.type === "text" && String(part.text || "").includes(interactionCheckpointPrefix)).length;
const modernCallCheckpointMeta = modernCall.body?.result?._meta?.["forgelink/interactionCheckpoint"];
if (modernCallCheckpointCount !== 1 || modernCallCheckpointMeta?.requiresVisibleAssistantBridge !== true || modernCallCheckpointMeta?.nextForgeLinkCallBlockedUntilVisibleBridge !== true) throw new Error(`Direct interaction checkpoint failed: ${JSON.stringify(modernCall.body)}`);
const modernBatchCall = await json(`${base}/mcp`, {
  method: "POST",
  headers: { authorization: `Bearer ${tokens.body.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "forgelink_read_batch" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "modern-read-batch-call", method: "tools/call", params: { name: "forgelink_read_batch", arguments: { calls: [{ id: "roots", tool: "list_allowed_directories", arguments: {} }, { id: "device", tool: "device_status", arguments: {} }], concurrency: 2, stopOnError: true }, _meta: modernMeta } }),
});
const modernBatchCheckpointCount = (modernBatchCall.body?.result?.content || []).filter((part) => part?.type === "text" && String(part.text || "").includes(interactionCheckpointPrefix)).length;
const modernBatchCheckpointMeta = modernBatchCall.body?.result?._meta?.["forgelink/interactionCheckpoint"];
const modernBatchPayloadText = modernBatchCall.body?.result?.content?.find((part) => part?.type === "text" && !String(part.text || "").includes(interactionCheckpointPrefix))?.text || "";
let modernBatchPayload = null;
try { modernBatchPayload = JSON.parse(modernBatchPayloadText); } catch {}
if (modernBatchCall.response.status !== 200 || modernBatchCall.body?.result?.resultType !== "complete" || modernBatchCall.body?.result?.isError === true || modernBatchCheckpointCount !== 1 || modernBatchCheckpointMeta?.requiresVisibleAssistantBridge !== true || !modernBatchPayload || modernBatchPayload.mode !== "single-mcp-read-batch" || JSON.stringify(modernBatchPayload).includes(interactionCheckpointPrefix)) throw new Error(`Read batch interaction checkpoint isolation failed: ${JSON.stringify(modernBatchCall.body)}`);
result.modernToolsCall.interactionCheckpoint = true;
result.modernToolsCall.batchCheckpointIsolated = true;
const tools = await mcp(2, "tools/list");
result.tools = { status: tools.response.status, count: tools.body?.result?.tools?.length, names: tools.body?.result?.tools?.map((tool) => tool.name) };
const codingTools = new Map((tools.body?.result?.tools || []).map((tool) => [tool.name, tool.description || ""]));
for (const name of ["inspect_workspace", "search_text", "get_git_status", "get_git_diff", "run_project_task", "backend_status", "restart_backend"]) {
  if ((codingTools.get(name) || "").length < 80) throw new Error(`Coding tool guidance is missing or too short for ${name}`);
}
for (const name of ["presentation_artifact_create", "presentation_artifact_open", "presentation_artifact_get", "presentation_artifact_update", "presentation_artifact_validate", "presentation_artifact_list", "presentation_artifact_supersede"]) {
  if ((codingTools.get(name) || "").length < 80) throw new Error(`Presentation artifact guidance is missing or too short for ${name}`);
}
result.codingToolGuidance = { verified: true, tools: ["inspect_workspace", "search_text", "get_git_status", "get_git_diff", "run_project_task", "backend_status", "restart_backend", "presentation_artifact_create", "presentation_artifact_open", "presentation_artifact_get", "presentation_artifact_update", "presentation_artifact_validate", "presentation_artifact_list", "presentation_artifact_supersede"] };
const allowed = await mcp(3, "tools/call", { name: "list_allowed_directories", arguments: {} });
result.allowedRoot = allowed.body?.result?.content?.[0]?.text;
const denied = await mcp(4, "tools/call", { name: "read_text_file", arguments: { path: "C:\\Windows\\win.ini" } });
result.outsideRootDenied = denied.body?.result?.isError === true && JSON.stringify(denied.body).includes("outside the allowed root");

const unauthenticated = await fetch(`${base}/mcp`, { headers: { accept: "application/json, text/event-stream" } });
result.unauthenticatedMcp = { status: unauthenticated.status, challenge: unauthenticated.headers.get("www-authenticate") };
await unauthenticated.body?.cancel();
console.log(JSON.stringify(result, null, 2));
}
