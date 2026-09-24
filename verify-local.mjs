import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(fs.readFileSync(path.join(here, ".env"), "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const base = process.argv[2] || "http://localhost:24024";
const resource = `${base}/mcp`;
const result = {};

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

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

const initialized = await mcp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-verifier", version: "1.0.0" } });
result.mcpInitialize = { status: initialized.response.status, server: initialized.body?.result?.serverInfo?.name };
const discovery = await mcp(5, "server/discover");
const supportedVersions = discovery.body?.result?.supportedVersions;
const listChanged = discovery.body?.result?.capabilities?.tools?.listChanged;
if (discovery.response.status !== 200 || !supportedVersions?.includes("2026-07-28") || listChanged !== true) {
  throw new Error(`Connector discovery contract mismatch: ${JSON.stringify(discovery.body)}`);
}
result.connectorDiscovery = { status: discovery.response.status, supportedVersions, listChanged };

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "local-modern-verifier", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const modernTools = await json(`${base}/mcp`, {
  method: "POST",
  headers: { authorization: `Bearer ${tokens.body.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "modern-tools-list", method: "tools/list", params: { _meta: modernMeta } }),
});
if (modernTools.response.status !== 200 || modernTools.body?.result?.resultType !== "complete" || !Array.isArray(modernTools.body?.result?.tools)) {
  throw new Error(`Modern tools/list compatibility failed: ${JSON.stringify(modernTools.body)}`);
}
result.modernToolsList = { status: modernTools.response.status, resultType: modernTools.body.result.resultType, count: modernTools.body.result.tools.length };
const modernCall = await json(`${base}/mcp`, {
  method: "POST",
  headers: { authorization: `Bearer ${tokens.body.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "list_allowed_directories" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "modern-tools-call", method: "tools/call", params: { name: "list_allowed_directories", arguments: {}, _meta: modernMeta } }),
});
if (modernCall.response.status !== 200 || modernCall.body?.result?.resultType !== "complete" || modernCall.body?.result?.isError === true) {
  throw new Error(`Modern tools/call compatibility failed: ${JSON.stringify(modernCall.body)}`);
}
result.modernToolsCall = { status: modernCall.response.status, resultType: modernCall.body.result.resultType };
const tools = await mcp(2, "tools/list");
result.tools = { status: tools.response.status, count: tools.body?.result?.tools?.length, names: tools.body?.result?.tools?.map((tool) => tool.name) };
const allowed = await mcp(3, "tools/call", { name: "list_allowed_directories", arguments: {} });
result.allowedRoot = allowed.body?.result?.structuredContent?.content;
const denied = await mcp(4, "tools/call", { name: "read_text_file", arguments: { path: "C:\\Windows\\win.ini" } });
result.outsideRootDenied = denied.body?.result?.isError === true && JSON.stringify(denied.body).includes("outside the allowed root");

const unauthenticated = await fetch(`${base}/mcp`, { headers: { accept: "application/json, text/event-stream" } });
result.unauthenticatedMcp = { status: unauthenticated.status, challenge: unauthenticated.headers.get("www-authenticate") };
await unauthenticated.body?.cancel();
console.log(JSON.stringify(result, null, 2));
