# LLM subagent execution architecture

ForgeLink provides the execution substrate: MCP transport, scoped tools, private workspace snapshots, scheduling, resource reservations, task dependencies, communication, artifacts, checkpoints, cancellation, review, and guarded integration. The LLM host provides reasoning and decides what work to perform.

## ChatGPT Web native subagents

For a connection with no OpenAI Platform API key, run `start-mcp.ps1 -QuickPublic` and, if your ChatGPT plan permits custom MCP, add the printed temporary `/mcp` HTTPS URL to ChatGPT as a Server URL connection. ForgeLink OAuth protects this route. The default Secure MCP Tunnel route requires a separate runtime key; the quick public URL changes after each restart. OpenAI's [current custom MCP availability](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) does not list the Free plan. Native ChatGPT subagent availability and usage also depend on the account.

Eligible ChatGPT Work accounts can run [native subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) in the web chat. Ask the parent ChatGPT conversation directly to spawn agents for independent tasks. ChatGPT hosts their separate model contexts and handles spawning, messages, waiting, and synthesis. Its subagents inherit the tools available to the parent chat. ForgeLink supplies the connected MCP tools, approved folders, private workspaces, and review gate; it does not run or pay for a separate model API. ChatGPT account eligibility and usage limits still apply.

The workable handoff is:

1. In ChatGPT Work on the web, connect ForgeLink and explicitly ask ChatGPT to spawn subagents. Choose the parent model and intelligence level in ChatGPT if those controls are available to your account.
2. The parent calls `subagent_batch` to prepare one scoped assignment per child. The submit result gives each worker ID a distinct `capabilityToken`. After a worker is ready, call `subagent_worker_native_spawn_packet` with that ID and token to obtain the child prompt, scope, and tool metadata. `subagent_worker_assignments` lists ready assignments but does not expose their tokens. A durable `swarm_create`/`swarm_plan`/`swarm_start` graph can be used when dependencies, messages, and artifacts matter; its worker handoff follows the existing swarm flow.
3. The parent gives each native subagent only its own spawn packet through ChatGPT's native spawn action. The child passes both `workerId` and `capabilityToken` to `subagent_worker_tool`, `subagent_worker_checkpoint`, `subagent_worker_heartbeat`, and `subagent_worker_finish`. A child can call `subagent_worker_spawn_child` with its token to create a narrower read-only assignment for a nested native child, then pass that child's own spawn packet through ChatGPT's native spawn action. Write children are unavailable while an active parent holds the overlapping write scope. A child can use connected ForgeLink tools if ChatGPT exposes them in that subagent thread. Keep tokens in native task handoffs and out of logs, artifacts, and final reports.
4. ChatGPT waits for the native child results and synthesizes them. The parent inspects ForgeLink status and diffs, then uses `subagent_batch` review/apply/discard or `swarm_review`/`swarm_integrate` for selected write changes.

`subagent_batch` by itself prepares up to 15 ForgeLink workspace and tool assignments. Its scheduler slots are **not** ChatGPT subagents. The actual independent contexts exist only if ChatGPT's native collaboration action spawns them. The [MCP server contract](https://developers.openai.com/plugins/concepts/mcp-server) describes discovery and invocation of server tools; it does not give the server a documented call to spawn ChatGPT threads or select their model or reasoning level. ForgeLink cannot inspect the native agent tree or authenticate which ChatGPT thread made an MCP call. The token is a bearer capability for one direct worker's scoped calls, not proof of which native agent holds it. Native children inherit the parent chat's other available tools, so this MCP handoff does not remove or independently sandbox those tools for each child.

`agent_providers_list` describes ForgeLink's `ChatGPTWebHost` MCP adapter as `independentContexts: false`, `reasoningControl: unsupported_by_host`, and `reasoningConfiguration: not_exposed`. These fields describe what **ForgeLink can create and observe through MCP**. They do not negate native ChatGPT Work subagents that ChatGPT itself creates. ForgeLink accepts the host's default model and reasoning behavior; explicit model or effort requests in `subagent_batch` fail because this MCP tool cannot enforce them. Use ChatGPT's own composer and native agent controls where available.

## Independent host bridge contract

`desktop/llm-subagent-host.mjs` defines the capability contract. When a host actually supports independent contexts, it implements `createSubagent`, `waitForSubagent`, and `cancelSubagent`. ForgeLink passes one task, a bounded routed context, one workspace, and callbacks for only that worker's tools, heartbeat, and checkpoint. The host must return a unique independent context ID and attest any requested model or reasoning configuration. ForgeLink rejects missing or conflicting attestation. Coordinator MCP tools cannot invoke a host-managed worker's tool callbacks or submit its result.

The `createSubagent` bridge remains available for future independent hosts. Its automated test double verifies the contract and concurrency without pretending to be a production ChatGPT Web bridge. ChatGPT Work's native subagent workflow is controlled by ChatGPT itself, outside this MCP bridge.

## Worker lifecycle

1. The coordinator creates a task or durable swarm plan with explicit read and write paths.
2. ForgeLink validates dependencies, write-scope disjointness, approved roots, and resource budgets.
3. ForgeLink creates a private snapshot and scoped tool layer for each scheduled worker.
4. The LLM host works from only the assigned task, routed dependencies, and permitted tools.
5. Workers exchange bounded messages, granted blackboard keys, and artifacts. The task graph routes declared dependency artifacts and explicit input references.
6. A completed write worker keeps its private diff. `swarm_review` issues a token for the current diff. `swarm_integrate` applies selected paths only after the token, path grants, and source baseline pass validation.

The task graph supports dynamic planning, child tasks, retries, priority, pause, cancellation, and resource waits. Cancellation aborts the worker and its owned processes. The private workspace is a file isolation boundary; a process granted terminal access still has the backend user's operating-system permissions.

## Checkpoints and recovery

Each prepared worker gets an initial on-disk resume packet. `subagent_worker_checkpoint` stores structured progress, and `subagent_worker_resume_packet` reads it after a backend restart. Packets include objective, role, scopes, state, files changed, artifacts, tests, blockers, and remaining work. Credential-like strings are redacted. Hidden model reasoning and full conversations are never stored.

After a backend restart, the durable swarm manager returns interrupted tasks to pending. A resume packet helps a new LLM context reconstruct the work, but it does not restore an in-memory worker session or authorize unattended source integration. Interrupted write tasks must recreate an integratable workspace; the review gate remains in force.

`swarm_checkpoint` reads a compact deterministic view of the persisted task graph, artifact references and hashes, message references, blackboard revisions, wait edges, and integration state. The coordinator can use it to decide which tasks to retry or reassign.

## MCP and host limits

The server uses the installed `@modelcontextprotocol/sdk` streamable HTTP transport and normal MCP tool schemas. Tool descriptions expose what the MCP handoff does and report host limits. ForgeLink enforces file and tool scopes in the worker tool layer. In the default coordinator handoff, the one ChatGPT conversation can see all its assignments; MCP does not provide ForgeLink with a distinct authenticated ChatGPT subagent identity for each assignment. Independent host adapters keep worker tool callbacks private to their own contexts.

No separate OpenAI API key is required for the ChatGPT Work native handoff. Availability and usage depend on the connected ChatGPT account and workspace. If the host does not offer native subagents or does not pass ForgeLink tools to a child, the same assignments remain usable in the single coordinator chat, but that execution is not an independent LLM subagent workflow.
