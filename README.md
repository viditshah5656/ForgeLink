# Local Files MCP for ChatGPT

A private Windows and macOS desktop app that lets ChatGPT work with coding folders you explicitly select. It uses an OpenAI Secure MCP Tunnel, so your MCP server stays on your computer—there is no changing public URL and no inbound firewall port.

> The repository contains **no credentials**, folder paths, logs, local binaries, or tunnel IDs. The desktop app encrypts each machine's runtime API key with Windows DPAPI or macOS Keychain and keeps it outside Git.

## Desktop app - easiest setup

Local Files now includes a full Electron + Vite desktop application for Windows and macOS. The installer carries its own runtime and a checksum-verified official OpenAI tunnel client, so an end user does not need Node.js, npm, PowerShell, or Terminal.

The five-screen setup asks the user to:

1. Pick the folders ChatGPT may access with the native folder picker.
2. Create an OpenAI Secure MCP Tunnel and runtime API key using direct links in the app.
3. Choose Files only, guarded project tasks, or full terminal access.
4. Click **Save securely & connect**.
5. Open ChatGPT settings and select the tunnel shown by the app.

Runtime keys are encrypted with Windows DPAPI or macOS Keychain through Electron `safeStorage`. Configuration, encrypted secrets, OAuth state, logs, and downloaded runtime files live in the operating system's per-user application-data folder, not in the repository.

### Run the desktop app from source

```powershell
npm install
node scripts/prepare-tunnel-client.mjs
npm start
```

### Build an installer

```powershell
npm run make
```

Windows produces a no-admin Squirrel `Setup.exe`. macOS produces a DMG and ZIP. Installer builds must run on their target operating system; the included GitHub Actions workflow builds both whenever a `v*` tag is pushed or the workflow is started manually. Production distribution should add platform code-signing and Apple notarization credentials to avoid operating-system trust warnings.

Desktop-only checks can be run with:

```powershell
npm run lint:desktop
npm run verify:desktop
```

## Command-line setup - developers and servers

The commands below remain available for developers and headless machines. Most users should use the desktop app above.

### Legacy browser wizard

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

## Permanent public URL (Cloudflare Named Tunnel)

`trycloudflare.com` quick tunnels are intentionally temporary: their URL changes at restart. For a fixed URL that works with ChatGPT's **Server URL** connection mode, use a Cloudflare **Named Tunnel** and a hostname in a domain you control.

1. In Cloudflare Zero Trust, create a remotely managed tunnel.
2. Add a public hostname such as `mcp.example.com`, routed to `http://127.0.0.1:24024`.
3. Copy the tunnel token from the tunnel's connector installation command (the long value after `--token`).
4. On the local PC, start it without placing the token in shell history:

```powershell
cd local-files-mcp
$token = Read-Host 'Paste Cloudflare tunnel token' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  .\start-cloudflare-named-tunnel.ps1 -Hostname mcp.example.com -TunnelToken $plain
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
```

In ChatGPT create a plugin with **Server URL** `https://mcp.example.com/mcp` and **OAuth** authentication. The runner starts the local MCP with that HTTPS origin, so OAuth discovery, issuer, and callback URLs match the fixed hostname.

The hostname remains fixed across restarts and clones. Each PC needs its own running connector and may use its own Cloudflare tunnel/token; never commit or share a token. Cloudflare documents that a remotely managed tunnel is run with its tunnel token, so treat that token like a password. [Cloudflare tunnel token documentation](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)

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

Version 3 adds Codex-style local workspace primitives: ranged reads, image inspection, binary writes, guarded exact edits, appends, checksums, safe file/folder copies, explicit recursive deletion, Git history/branch inspection, staging, unstaging, local commits, and longer build/test runs for Node, Python, Rust, Go, and .NET projects. Full PowerShell remains available only when **Full** mode is enabled locally.

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
