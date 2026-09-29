import test from 'node:test';
import assert from 'node:assert/strict';
import { DEEP_CODING_AGENT_INSTRUCTIONS } from './deep-coding-agent.mjs';

test('planning and proposal requests are explicitly non-executing', () => {
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /PLANNING \/ PROPOSAL \/ INSPECTION REQUESTS are non-executing requests/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /inspect and propose how you would implement/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /MUST end at the plan\/review boundary/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Do not edit files, run write-capable commands, start workers, start swarms, apply transactions/i);
});

test('substantial implementation requests require explicit review before execution', () => {
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /SUBSTANTIAL CHANGE REQUESTS are two-stage requests/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /enter awaiting_user_review, present the plan, and STOP/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Implementation begins only after the user explicitly approves the plan/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /AFTER APPROVAL, resume the SAME engineering workflow\/session/i);
});

test('universal interaction contract applies to every ForgeLink task category', () => {
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /FORGELINK UNIVERSAL INTERACTION CONTRACT/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /EVERY ForgeLink-assisted task, not only coding or engineering/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /BEFORE EVERY ForgeLink tool call or logical parallel batch/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /IMMEDIATELY AFTER EVERY ForgeLink tool result or logical batch/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /NEVER issue back-to-back ForgeLink tool calls/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /ONE FORGELINK CALL PER VISIBLE BRIDGE/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /authorization is consumed/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /STOP the execution turn instead of calling another ForgeLink tool/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /High, long, adaptive, or extended reasoning modes/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /use forgelink_read_batch so ChatGPT makes one MCP call/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Host-generated connector labels, progress chips, or app-response rows are transport\/UI telemetry/i);
});

test('communication contract remains separate from private reasoning', () => {
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Do not expose private chain-of-thought/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /concise engineering reasoning, decisions, evidence, and next actions/i);
});

test('read-only ForgeLink work stays chat-first unless an artifact is explicitly requested', () => {
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Read-only inspection, diagnostics, inventory, research, search, Windows\/system observation, and analysis are chat-first by default/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /do not create or open a presentation artifact merely because the task is large/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /only when the user explicitly requests a report\/artifact/i);
});

test('professional visible progress and canonical artifact lifecycle are mandatory', () => {
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /PROFESSIONAL VISIBLE PROGRESS FORMAT/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Pre-tool: at least one concise sentence/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Post-tool: at least one concise sentence/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /canonical primary artifact/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /primaryArtifactId/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /SAME canonical artifact/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /presentation_artifact_open/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /collapsed-by-default inline presentation/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Open app in tab/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Copy/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Download PDF/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /recoverable ForgeLink transaction/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /transaction_commit/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /automatically render/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /code_change_review.*reopen|reopen.*code_change_review/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /FINAL rich-tool step/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /stored before\/after snapshots/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /must never count unrelated pre-existing dirty or untracked files/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /walkthrough artifact and the final code-change review as separate surfaces/i);
});

test('coding completion requires a substantive adaptive walkthrough with visuals', () => {
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /MANDATORY WALKTHROUGH GATE/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /every coding task that changed source, configuration, tests, build logic/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /thin bullet list is not a walkthrough/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /section names, ordering, grouping, and depth MUST be chosen dynamically/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /architecture or execution-flow visualization/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /real screenshots\/images or image evidence when available/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Never fabricate screenshots or decorative evidence/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /implementation plan follows the same adaptive rule/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /completion requires the walkthrough artifact to be present, validated, and presented/i);
});

test('Windows system work respects dedicated tools and local owner gates', () => {
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /dedicated windows_\* tools/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /windows_realtime_state/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /windows_installed_apps/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /windows_app_control/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /System Control Off\/Read\/Full policy/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /never attempt to raise it remotely/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /graceful rather than force-killing/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Use Full Terminal for an actual owner-approved Windows change or force termination/i);
});

test('4-stage invariant lifecycle and plan dumping prohibition are enforced', () => {
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /CODEX, ANTIGRAVITY & CLAUDE CODE 4-STAGE INVARIANT LIFECYCLE/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /ABSOLUTE PROHIBITION ON DUMPING IMPLEMENTATION PLANS IN CHAT TEXT/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /strictly forbidden from outputting multi-step implementation plans/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /DYNAMIC & NON-HARDCODED SPECIFICATION/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /MANDATORY STAGE 1 TURN STOP/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Stage 2: ATOMIC CODE EXECUTION/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Stage 3: VERIFICATION \+ DYNAMIC IMPLEMENTATION WALKTHROUGH ARTIFACT/i);
  assert.match(DEEP_CODING_AGENT_INSTRUCTIONS, /Stage 4: MANDATORY COMMIT \+ INTERACTIVE CODE DIFF REVIEW CARD/i);
});

