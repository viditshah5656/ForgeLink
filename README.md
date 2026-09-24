# Local Files MCP for ChatGPT

A private, Windows-first MCP server that lets ChatGPT work with coding folders you explicitly select. It uses an OpenAI Secure MCP Tunnel, so your MCP server stays on your computer—there is no changing public URL and no inbound firewall port.

> The repository contains **no credentials**, folder paths, logs, local binaries, or tunnel IDs. Setup stores each machine's runtime API key encrypted with Windows DPAPI and excludes it from Git.

## Quick start — new PC

Requirements: Windows 10/11, Node.js 20+, Git, an OpenAI Platform account with a tunnel and a runtime API key.

```powershell
git clone https://github.com/YOUR_GITHUB_USERNAME/local-files-mcp.git
cd local-files-mcp
.\setup.ps1
```

The local browser wizard opens at `http://127.0.0.1:24023` and walks through everything:

1. Creates or locates your OpenAI tunnel.
2. Creates a runtime API key with **Tunnels Read + Use**.
3. Lets you browse this PC and select one or more coding folders.
4. Chooses execution access: **Off**, **Guarded** (Git/tests/build scripts only), or **Full** PowerShell.
5. Downloads the current official `tunnel-client`, verifies its SHA-256 checksum, encrypts your key for your Windows account, and starts the service.

The setup wizard is localhost-only and the API key is never printed, returned by an API, logged, or committed.

## Connect ChatGPT Web

With `start-mcp.ps1` running:

1. In ChatGPT, enable Developer mode if your account/workspace requires it.
2. Open **Plugins** and click **+**.
3. Name it `Local Files`.
4. Choose **Tunnel** for Connection.
5. Select your tunnel or paste the `tunnel_…` ID shown by the wizard.
6. Choose **No authentication**.
7. Create the plugin, then use it in a new chat.

Secure MCP Tunnel is an outbound-only bridge; it needs a tunnel ID, a runtime API key, and local access to the MCP server. See the [official Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Daily use

```powershell
.\start-mcp.ps1
```

Keep the resulting PowerShell window open. Use the local dashboard at [http://127.0.0.1:24025/dashboard/](http://127.0.0.1:24025/dashboard/) to inspect status, add folders, view logs, and control terminal access.

## Agentic coding workflow

When you enable the Local Files plugin in a ChatGPT chat, it now supports a disciplined coding loop:

1. `inspect_workspace` identifies the project, its scripts, and Git state.
2. `search_text`, `directory_tree`, and file reads locate the relevant implementation.
3. File tools make only the requested edit inside folders you allowed.
4. `get_git_diff` checks the actual change afterward.
5. `run_project_task` runs a bounded Git, Node, npm, Python, or .NET verification command.

Use a prompt such as: “Inspect this project, explain your plan, make the smallest safe change, then show the Git diff and run the relevant test.”

## Security model

- Filesystem tools are confined to folders you add in the local UI.
- The dashboard and MCP listener bind to `127.0.0.1` only.
- The tunnel makes outbound HTTPS connections to OpenAI; it does not create a public listener.
- The runtime key is protected by Windows DPAPI for the current Windows account.
- Execution is off by default. **Guarded** mode permits only an allowlisted set of project tasks (`git status`, `git diff`, tests, and named npm scripts). **Full** mode permits arbitrary PowerShell and has your Windows user permissions, so it is intentionally broader than the folder list.
- Every terminal mode change and execution is recorded locally in `agent-audit.jsonl`. Full command contents are not stored; only a SHA-256 fingerprint, working folder, and exit code are recorded.
- Git ignores `.env`, `access-config.json`, encrypted keys, tunnel profiles, logs, downloaded binaries, and local screenshots.

Run the pre-push safety audit at any time:

```powershell
.\scripts\security-audit.ps1
```

## Updating ChatGPT metadata

Refresh the ChatGPT plugin only when MCP tools change. Adding/removing folders takes effect immediately and does not need a plugin refresh.

## License

MIT. See [LICENSE](LICENSE).
