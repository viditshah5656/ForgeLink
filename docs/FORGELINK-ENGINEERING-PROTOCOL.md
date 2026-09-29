# ForgeLink Engineering Protocol — Implementation Plan

## Objective

Make substantial ChatGPT/ForgeLink engineering work follow a mandatory, observable lifecycle:

UNDERSTAND -> INSPECT -> CREATE PRIMARY PLAN ARTIFACT -> START WORKFLOW WITH primaryArtifactId -> REVIEW/APPROVE -> IMPLEMENT + UPDATE SAME ARTIFACT -> VERIFY + UPDATE SAME ARTIFACT -> WALKTHROUGH IN SAME ARTIFACT -> VALIDATE -> COMPLETE

The model must communicate meaningful engineering progress throughout the task instead of remaining silent and producing only a final summary. Every tool call or logical parallel batch is surrounded by a concise pre-tool explanation and post-tool interpretation, with between-step bridges and milestone checkpoints so the user always understands what is happening and why.

## Design

### 1. EngineeringProtocol

desktop/engineering-protocol.mjs owns protocol state, phase transitions, milestones, acceptance criteria, decisions, failures, verification records, artifacts, progress, and completion gating.

It deliberately does not execute tools. Execution remains owned by the existing task graph, worker scheduler, swarm/runtime, terminal, filesystem, and artifact systems.

### 2. Existing scheduler remains separate

desktop/agent-orchestrator.mjs remains responsible for bounded parallel work-unit scheduling, cancellation, timeouts, fairness, and worker lifecycle.

The engineering protocol is governance above execution, not a replacement scheduler.

### 3. MCP instruction contract

deep-coding-agent.mjs is the runtime instruction source already injected into MCP initialization/discovery by server.mjs.

The contract now requires:
- user-visible understanding before substantial execution
- explicit plan
- explicit goal
- acceptance criteria
- milestone progress
- meaningful explanations during execution
- decision and failure communication
- verification
- one canonical implementation-plan artifact for every substantial workflow
- the same artifact updated throughout implementation and verification
- implementation walkthrough stored in that same artifact
- client-side Download PDF export with print fallback
- evidence-based completion

### 4. Completion gate

A substantial task cannot be marked complete by the protocol until:
- a plan exists
- a goal exists
- acceptance criteria exist
- all milestones are completed
- a canonical primaryArtifactId exists
- the canonical artifact is a valid implementation-plan
- the canonical artifact has been revised during implementation
- the canonical artifact contains passing verification evidence
- the canonical artifact contains the final walkthrough
- the walkthrough phase has been reached
- the protocol transitions to completed

## Communication rules

Communication is meaningful, not raw telemetry.

Mandatory visible rhythm:
- before every tool call or logical batch: one concise sentence stating the action and why it is next
- after every tool result: interpret success/failure, evidence learned, what changed, and what happens next
- between tool steps: bridge the previous evidence to the next action
- at milestones: report completed milestone, current phase, next milestone, and blockers
- keep the interaction engaging through concrete discoveries and decisions rather than filler

Good:
- explain why a subsystem is being inspected
- explain discoveries that change the plan
- explain significant technical decisions
- report failures and recovery
- report milestone progress
- explain verification results

Avoid:
- one message for every file read
- noisy command-by-command narration
- silent long-running execution followed by a generic final answer

## Verification strategy

Every implementation change follows:

EDIT -> VERIFY -> INSPECT FAILURE -> FIX -> VERIFY AGAIN

Relevant project checks are preferred:
- unit/regression tests
- syntax checks
- lint
- renderer build
- backend bundle
- MCP initialization
- live contract verification
- runtime smoke tests where applicable

Unverified behavior must never be reported as verified.

## Current implementation status

Implemented:
- EngineeringProtocol state machine
- phase ordering and anti-skip/anti-reversal validation
- explicit goal and acceptance criteria
- milestone tracking
- continuous explanation events
- decision records
- failure/recovery records
- verification records
- canonical primary artifact identity persisted across restarts
- implementation-plan validation at engineering workflow start
- same-artifact revision/verification/walkthrough validation at completion
- artifact requirements
- walkthrough persistence and completion gate
- self-contained PDF export in the MCP Apps artifact viewer
- isolated snapshots
- observer-failure isolation
- runtime MCP instruction contract
- verifier checks for required instruction fragments

## Verification evidence

- Engineering protocol tests: passing
- Full project test suite: 158/158 passing
- Desktop syntax/lint: passing
- Renderer build: passing
- Backend bundle: passing
- Live MCP initialization: HTTP 200
- Live MCP instruction contract: all required protocol markers present
- Backend successor generation verified after controlled restart

## Next architectural phases

### Phase 2 — Runtime integration

Connect protocol state to the existing task/swam/job systems so protocol milestones can be represented by actual execution state rather than only model-reported state.

### Phase 3 — User-facing progress

Expose protocol phase, milestone, explanations, decisions, failures, verification, and artifact state through the ForgeLink dashboard/event stream.

### Phase 4 — Artifact orchestration — implemented

Substantial engineering workflows now begin with a real implementation-plan artifact. Its ID is persisted as primaryArtifactId, and the same artifact is updated through implementation, verification, and final walkthrough. Completion validates that the artifact was revised, contains passing verification evidence, contains the walkthrough, and remains schema-valid. The rich MCP Apps viewer provides Download PDF export.

### Phase 5 — Completion enforcement

Make the coordinator use objective evidence from tasks, tests, artifacts, and runtime checks before allowing a task to report completion.

### Phase 6 — Persistence and recovery

Persist protocol state and resume it safely after backend/desktop restarts.

### Phase 7 — Multi-worker coordination

Map protocol milestones to task-graph/swarm dependencies so multiple workers can execute in parallel while the coordinator maintains one coherent user-visible engineering narrative.

## Non-goals

This protocol does not:
- attempt to access hidden model reasoning
- override ChatGPT product/UI controls
- replace the worker scheduler
- replace the task graph
- replace filesystem or terminal authorization
- silently make destructive decisions

It provides an explicit, testable engineering-governance layer around the capabilities ForgeLink already exposes.
