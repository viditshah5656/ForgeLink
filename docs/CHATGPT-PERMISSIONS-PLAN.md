# ChatGPT-first permission system for ForgeLink

Status: implementation plan and rollout record based on the 2026-09-27 source tree. This document distinguishes the initial observations, implemented contract, and remaining host-side verification. It does not grant any permission.

## Intended experience

ForgeLink should let ChatGPT recognize a missing capability while working on a user's task, explain the exact need in the conversation, and open a ForgeLink approval card in ChatGPT Web. The human chooses Allow or Deny in that card. ForgeLink verifies the decision and applies only the displayed scope. ChatGPT then reads the resulting status and continues the same task; it never treats the original user request, its own reasoning, or a prose message as an approval.

The request can originate from the user's explicit instruction or from ChatGPT's discovery that a legitimate step needs more access. A request includes a short task-specific reason, not the conversation transcript. The model can request; the human approves. Declining leaves the existing policy in force and returns a useful alternative to ChatGPT.

The word "permission" covers several independent controls. An approval for a folder does not enable terminal execution. An approval for Windows observation does not grant file access. A Full Terminal approval does not disable the safety policy or create operating-system privileges.

## What exists today

- `server.mjs` enforces permanent read/write and read-only roots, 15-minute temporary folder grants, terminal modes `off/safe/full`, and Windows Control modes `off/read/full`. The active `request_path_access` tool creates an inline ChatGPT card request. The older native request queue remains for compatibility with local callers. The local dashboard can change folder and mode settings.
- `desktop/main.mjs` polls pending folder requests and displays native Electron dialogs, including a second warning for drive roots and broad system locations. It also has code to consume an approved protected-source maintenance request.
- At the start of this work, `desktop/artifact-ui-client.js` rendered a ChatGPT card for one-time folder access and protected maintenance, but its referenced tools were absent from `server.mjs`. The new `permissionRequest` card and `resolve_chat_permission` tool form the active path; the older UI code remains for compatibility with cached viewers.
- `scripts/security-upgrade/` contains an older unapplied patch for one-time folder capabilities. Its config migration would remove standing drive-root grants and downgrade Full Terminal to Guarded. The upgrade script now fails with a clear superseded message on this source tree rather than applying that migration.
- This installation's `access-config.json` currently records `C:\` read/write, another workspace root, Full Terminal, and Full Windows Control. Adding a request UI alone would not prompt for already-granted authority; the ChatGPT status view must disclose standing grants.

## Product contract by capability

| Capability | What the card must show | Default grant | Additional check | Enforcement |
| --- | --- | --- | --- | --- |
| Folder read | Canonical directory, read access, task reason, expiry | 15-minute lease | Broad roots need a second explicit step | Resolved-path confinement on every read |
| Folder write | Canonical directory, read/write, task reason, expiry | 15-minute lease | Broad roots need a second explicit step | Resolved-path confinement and protected-path policy on every write |
| Drive or system root | Drive/system location, breadth, read/write, expiry, OS-rights caveat | 15-minute lease | Explicit broad-scope acknowledgment; persistent grant is a separate choice | Same filesystem checks; Windows ACL still applies |
| Guarded Terminal | Named project task class and approved working folder | 15-minute lease | Explain that scripts can have side effects | Guarded allowlist plus current folder grant |
| Full Terminal | Arbitrary headless command authority, working folder, duration, ability to reach beyond folder roots | Short lease, at most 15 minutes | Explicit high-impact acknowledgment | Full Headless safety policy, audit, circuit breaker, expiry and job cancellation |
| Windows Read | Screenshots and bounded device/app observation | 15-minute lease | Screenshot disclosure | Windows Control policy per call |
| Windows Full | Windows Read plus exact app/Settings actions | 15-minute lease | Explicit high-impact acknowledgment | Exact-target checks and current safety policy |
| Protected-source maintenance | Files/code covered, restart effect, expiry | 15-minute window only | Explicit high-impact acknowledgment | Desktop enforcer restarts with expiring maintenance state; backend rechecks expiry |
| Revocation | Exact active grant or lease being revoked | Immediate | None | Stop related jobs/sessions/watches and remove access before reporting success |

Persistent folder or mode grants should only be offered when the user explicitly requests lasting access. The card must display that the grant survives restart and show where to revoke it. An approval must never silently promote a 15-minute request into a persistent root.

The existing local emergency stop and safety-trip reset are recovery controls, not routine permissions. ChatGPT can show their state and explain recovery, but a model-accessible permission request must not reset a tripped circuit breaker. Operating-system UAC is also separate: a ChatGPT card cannot mint an administrator token or override Windows/TrustedInstaller access checks.

## Protocol and UI sequence

1. A tool's out-of-scope error or `permission_status` identifies the missing capability. A structured `permission_required` error with a suggested smallest scope is a later improvement; the current tools still return ordinary errors. ChatGPT should request only the capability needed for the task.
2. ChatGPT calls `request_path_access`, `request_terminal_access`, `request_windows_control_access`, or `request_security_maintenance`. Request tools only create pending requests. They cannot change access.
3. The tool returns a model-readable summary and advertises the dedicated `ui://forgelink/permission-approval-v1.html` MCP Apps resource. Its model-visible result contains no approval secret. ChatGPT explains why the card appeared. Request tools have `readOnlyHint: false` because they create pending state and `destructiveHint: false` because they do not grant access. The app-only resolver is marked destructive because it can apply a grant.
4. The ForgeLink card displays scope, operation, duration, risk, and Allow/Deny controls. High-impact requests require a second explicit interaction. A hidden, random, short-lived approval challenge is delivered only in widget metadata.
5. The card calls an app-visible resolution tool with the request ID, challenge, chosen scope and decision. The server checks the authenticated connection, pending state, expiry, challenge, scope ceiling, and replay state before applying anything. App-only tool visibility is usability metadata, not an authorization check by itself.
6. The backend records an audit event and returns an applied grant ID. The card sends a follow-up message through the MCP Apps bridge; ChatGPT independently calls `permission_request_status` before retrying the original operation. For protected maintenance it checks `permission_status.maintenance.active` after the local enforcer's restart.
7. Deny, expiry, malformed input, or missing widget capability leaves access unchanged. A restart drops pending requests and temporary grants. The card and chat should show the outcome. ChatGPT should continue within existing access or ask for a narrower alternative.

The preferred surface is an inline MCP Apps card, with a host-controlled modal only where ChatGPT provides a supported API. Accurate `readOnlyHint`, `destructiveHint`, and `openWorldHint` values allow ChatGPT to apply its own confirmation preferences, but annotations are hints and cannot be ForgeLink's sole authorization mechanism. ChatGPT may let users configure app approval frequency; ForgeLink must still enforce its own grant contract.

## Server-side data model

A pending request should contain `id`, `kind`, canonical scope, requested level, maximum duration, task reason, risk class, creation/expiry time, request owner/connection identity when available, and a hash of a random widget-only challenge. The server stores no chat transcript or chain-of-thought. Request IDs and challenges are single-use and expire after about three minutes. Decisions are serialized so two Allow calls cannot issue two grants.

An active grant contains a grant ID, source request ID, exact capability and scope, access level, expiry, creating principal, and revocation state. Temporary folder and mode leases are held in memory so restart returns to the saved local baseline. A timer expires each mode lease, and each MCP tool call rechecks expiry before executing. Saving unrelated dashboard settings must never persist a temporary lease accidentally.

The current broker binds to the authenticated OAuth client ID when available, or to the private local connection identity. A later OAuth rollout should bind to a verified owner subject as well. Anonymous `--no-auth` exists only for isolated local tests and does not establish a remote owner identity. The backend revalidates canonical paths and policy at execution time, including real symlink targets for protected writes.

The backend must not interpret a model-authored sentence such as "the user approved" as an approval. The same applies to `app.sendMessage`: it resumes the conversation, while the server's resolved request and grant remain the authority. MCP does not give this server cryptographic proof of a human click in ChatGPT; the design relies on the trusted host UI, a widget-only challenge, authenticated transport, and backend validation. The product must describe that honestly.

## Tool and policy layout

- Read tools: `permission_status` and `permission_request_status` (`check_path_access_request` remains a folder-only compatibility alias); the inventory includes active grants and pending requests.
- Model-callable request tools: one for folders, one for Guarded/Full Terminal, one for Windows Read/Full, one for protected maintenance. Descriptions must say when each applies, what it cannot unlock, and whether it may be persistent.
- App-only decision tool: resolves one pending request. It requires the hidden challenge; tool visibility alone never authorizes it.
- Model-callable revoke tool: can only lower authority. It identifies one exact grant or mode lease; it never resets the safety breaker.
- Existing operation tools: continue checking the actual backend policy on every call. A pending request never changes their result.

The dashboard and desktop control center remain status and revocation surfaces. The ChatGPT `permission_status` tool distinguishes saved baseline from temporary leases. Local UI may still deliberately set a persistent baseline. A later cleanup should consolidate duplicate local and ChatGPT policy mutation code into shared validation functions.

## High-risk boundaries

- A whole-drive grant includes every ordinary file reachable by the backend's Windows token. It still does not bypass NTFS ACLs, UAC, TrustedInstaller, or explicit ForgeLink protected-path rules.
- Full Terminal is broader than filesystem roots. It remains subject to Full Headless command restrictions, safety-trip state, output redaction, job limits, and audit. An approval card must not disable those checks.
- Windows Control Full does not imply arbitrary GUI automation or unrestricted system mutations. Existing exact-app checks and disabled synthetic input stay enforced.
- ForgeLink file tools keep credentials, OAuth tokens, runtime access configuration, and audit/safety state remote read-only even when a parent drive is approved. Protected source additionally needs maintenance. Full Terminal is a broader operating-system capability; a command process can reach files according to its Windows token, so its card must say this clearly and the command safety layer must be reviewed separately.
- Approval cannot be inferred from an MCP `destructiveHint` popup, an OAuth connection consent screen, or a prior unrelated approval. Those are distinct events with different scopes.
- The current standing `C:\`, Full Terminal, and Windows Full settings need a visible inventory. They should not be silently migrated, revoked, or reapproved by a source deployment.

## Implementation order

1. **Baseline and migration safety.** Snapshot current tool inventory and policy. Keep existing config untouched. Reconcile the unapplied one-time access patch with this design; split source migration from its policy-changing config migration. Remove any UI copy that advertises tools absent from the server.
2. **Shared permission core.** Implement a tested request/grant state machine, canonical scope validation, hidden challenge, expiry, replay protection, audit, and revocation. Add request identity plumbing at the MCP HTTP boundary.
3. **Folder permissions.** Connect the ChatGPT card to registered backend tools. Grant an exact directory for 15 minutes by default; allow persistent grants only when explicitly requested. Include drive roots and sensitive locations with explicit second-step approval. Retain the older native prompt code for local compatibility until a dedicated migration removes it.
4. **Terminal and Windows modes.** Add temporary lease requests/cards, make every operation check effective mode and lease expiry, cancel jobs/sessions at expiry, and keep persistent baseline changes explicit. Reuse shared policy functions for dashboard and desktop UI.
5. **Protected maintenance.** Register the generic maintenance request/resolve/status tools, implement the authenticated desktop handoff endpoint, and verify the enforcer's restart/automatic expiry path. Never treat a card click as a direct file-write bypass. The isolated test verifies handoff; the live desktop restart and expiry remain to be verified.
6. **ChatGPT guidance.** Replace the current "go to the desktop UI" advice with precise request/status/retry instructions. Tell the model to request only the smallest scope and to treat Deny as final for that request. Expose a readable permission inventory before potentially privileged work.
7. **Verification and release.** Run unit/state-machine tests, integration tests against MCP `tools/list` and `tools/call`, desktop build, and a live ChatGPT Web test for Allow, Deny, expiry, stale card, replay, reconnect, and a drive-root request. Refresh the connection when tool metadata or UI URI changes.

## Acceptance tests

1. A user asks ChatGPT to read an unapproved file. ChatGPT requests its exact containing folder; the card shows the canonical path, read access and expiry. Deny changes nothing. Allow grants only that directory for 15 minutes by default.
2. ChatGPT asks for `C:\` read/write after its standing grant is intentionally removed in a test profile. The card requires the broad-scope step. Approval cannot grant Full Terminal and cannot write ForgeLink credentials/configuration.
3. ChatGPT requests Guarded Terminal, then Full Terminal. Each card says what changes; the latter requires high-impact acknowledgment. Expiry closes sessions and cancels applicable jobs, and restart restores the saved baseline.
4. A Windows screenshot requires Windows Read. Exact app control requires Windows Full. Folder approval alone satisfies neither.
5. Protected maintenance approval is visible in ChatGPT, activates through the local enforcer, lasts no more than 15 minutes, and leaves protected source read-only afterward.
6. A model call to a resolver without the hidden challenge fails. Reused, expired, cross-request, cross-scope and broadened decisions fail. Two concurrent Allow calls yield at most one grant.
7. App UI unavailable, desktop app offline, auth invalid, safety tripped, or backend restart all fail closed with understandable status. No card claims success until the backend confirms the grant.
8. The ChatGPT status view lists standing grants and temporary leases accurately. Revoking a root or mode immediately invalidates dependent activity.

## Verification record and release gate

- The broker tests pass for hidden challenge validation, principal binding, risk acknowledgment, expiry, denial, replay and concurrent decisions.
- The isolated source and bundled MCP integration tests pass for folder read/write, permanent read-only persistence, drive-root denial without risk acknowledgment, Windows Read lease/revocation, and the authenticated protected-maintenance handoff. They also inspect the permission tool descriptors, output schemas, app-only resolver visibility, and dedicated UI resource.
- The renderer build, backend bundle, project test suite and safety suite pass. The source backend tool inventory reports the inline UI resource and permission tools.
- A live ChatGPT Web card render, the host's delivery of widget-only result metadata, the desktop maintenance restart/expiry, and end-to-end connection refresh are release gates still requiring a connected ChatGPT Web surface. The current automation environment exposed no browser surface for that check.
- A raw MCP client receives the entire tool result, including `_meta`, and can therefore replay the challenge it receives. The widget challenge is a model-versus-app separation inside a trusted ChatGPT host, not cryptographic proof of a human click to an arbitrary MCP client. Remote production deployment must restrict the MCP endpoint and OAuth clients accordingly; do not claim otherwise.

## Source references

- OpenAI [tool annotations and elicitation](https://developers.openai.com/plugins/build/mcp-server): annotations influence host confirmation but do not replace server authorization.
- OpenAI [MCP Apps UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui): inline cards and the MCP Apps bridge support in-conversation approval experiences.
- OpenAI [authentication guidance](https://developers.openai.com/plugins/build/auth): ChatGPT supplies OAuth tokens; ForgeLink must validate tokens and scopes on each call.
- OpenAI [plugin security guidance](https://developers.openai.com/plugins/guides/security-privacy): require explicit consent, validation, and confirmation for consequential actions.
