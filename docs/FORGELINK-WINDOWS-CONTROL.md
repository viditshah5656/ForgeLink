# ForgeLink Windows Control

ForgeLink's Windows Control layer gives ChatGPT deep, bounded visibility into a Windows machine while preserving a separate local owner boundary for commands that change the machine.

## Permission model

- **Off** — Windows-specific observation is disabled. `windows_control_status` remains available so the model can explain the current policy.
- **Read** — enables screenshots and bounded Windows observation.
- **Full** — enables everything in Read plus deliberate opening of exact Windows Settings / classic Control Panel destinations.
- **Full Terminal** remains a separate owner-controlled policy. Actual system-changing commands use that existing execution path rather than gaining a second hidden mutation channel through Windows tools.

The model can request Read or Full through `request_windows_control_access`. ForgeLink displays an inline permission card in ChatGPT Web; only the owner's card decision changes the mode. Temporary approvals expire after 15 minutes. The local Control Center can still set or revoke the saved baseline. `permission_status` distinguishes a temporary lease from the saved setting.

## MCP tool surface

| Tool | Purpose | Policy |
| --- | --- | --- |
| `windows_control_status` | Policy, Windows/runtime status, supported capability map | Always available |
| `windows_overview` | Bounded whole-system operational snapshot | Read / Full |
| `windows_screenshot` | Desktop, display, or explicit region capture returned as PNG | Read / Full |
| `windows_desktop_state` | Foreground app plus bounded visible app-window state | Read / Full |
| `windows_browser_tabs` | Supported browser tab titles and selected state; no URLs | Read / Full |
| `windows_installed_apps` | Installed-app inventory plus exact Start-menu launchable IDs | Read / Full |
| `windows_app_control` | Launch, focus, or gracefully close one exact app target | Full |
| `windows_realtime_state` | Combined current app/window plus browser-tab snapshot | Read / Full |
| `windows_settings` | Search Windows Settings / Control Panel; open exact destination | List: Read / Full; Open: Full |
| `windows_registry` | Read/list/bounded-search noncredential Registry locations | Read / Full |
| `windows_services` | Service state, startup mode, PID, executable metadata | Read / Full |
| `windows_processes` | PID hierarchy, executable name/path, creation time | Read / Full |
| `windows_scheduled_tasks` | Task names, state, actions, triggers | Read / Full |
| `windows_startup` | Current-user Run entries and Startup folder | Read / Full |
| `windows_event_logs` | Bounded System/Application Event Viewer data | Read / Full |
| `windows_network` | Adapters, IP configuration, DNS, default routes, WinHTTP proxy | Read / Full |
| `windows_power` | Active power scheme and battery state | Read / Full |
| `windows_devices` | Plug-and-Play device status and bounded filtering | Read / Full |
| `windows_system_file_info` | Metadata or SHA-256/SHA-512 for an explicit Windows/program file | Read / Full |

## Screenshot behavior

`windows_screenshot` returns MCP image content directly. It does not need an approved workspace path and does not persist the screenshot after the tool response. Capture dimensions are bounded and oversized output is rejected. Region capture requires explicit width and height.

## Realtime desktop and app control

`windows_desktop_state` reports the current foreground app and bounded visible app main windows with PID, process identity/path, title, response state, start time, and memory. `windows_browser_tabs` uses Windows UI Automation to expose supported browser tab titles and selected state, but intentionally omits URLs and address-bar contents. `windows_installed_apps` returns Start-menu launchable app IDs plus bounded desktop-install and AppX metadata; uninstall commands are not returned.

`windows_app_control` requires **Full** System Control. Launch accepts only an exact app ID or exact app name obtained from `windows_installed_apps`; it does not accept arbitrary command-line arguments. Focus and close require a fresh exact PID plus the expected process name to guard against PID reuse. Close additionally requires `confirmClose=true` and calls the application's normal close path; ForgeLink does not force-kill from this tool. If a force termination is genuinely required, that remains behind the separate owner-enabled Full Terminal gate.

`windows_realtime_state` combines desktop/app state and browser-tab state into one bounded snapshot for prompts such as “what is open right now?” or “which browser tabs and apps are active?”.

## Registry boundary

`windows_registry` is inspection-only. It understands HKLM/HKCU/HKCR/HKU/HKCC aliases, bounds search depth/results, and blocks locations associated with SAM, SECURITY, LSA authentication data, Windows credentials, DPAPI Protect data, and Vault data.

## Event log boundary

Only **System** and **Application** event logs are exposed. The Windows Security event log is intentionally not part of the MCP surface.

## System-file boundary

`windows_system_file_info` is limited to Windows, Program Files, Program Files (x86), and ProgramData. It returns metadata or hashes only. It does not return arbitrary file contents. Credential/identity stores and private-key formats are blocked.

## Automation model

ForgeLink automation now has complementary layers:

1. Windows tools provide screenshots, foreground/open-app state, browser-tab titles, installed-app inventory, and bounded live system observations.
2. `watch_create` + event subscriptions react to approved workspace changes.
3. background jobs supervise long-running project/terminal work.
4. engineering workflows persist plans, milestones, verification, artifacts, and walkthroughs.
5. ChatGPT scheduled/conditional automations can provide recurring monitoring or reminders.
6. when a Windows change genuinely needs Full Headless Terminal, the assistant requests it in ChatGPT, the owner approves the exact mode in the ForgeLink card, and the assistant re-checks the affected subsystem after execution.

This observe → decide → owner-gated action → verify pattern gives ChatGPT significantly more operational power without silently escalating the MCP tunnel.

## Explicit non-goals

Windows Control does not expose credential dumping, browser/session-secret extraction, Windows Security log harvesting, UAC bypass, automatic privilege escalation, endpoint-protection disabling, authentication-database access, private-key collection, generic protected-file dumping, or unrestricted system-binary replacement.

## Verification expectations

Production changes to this layer should keep the following green:

- `desktop/windows-system-control.test.mjs`
- shared permission/config normalization tests
- renderer production build
- full `npm test` suite
- root `deep-coding-agent.test.mjs` contract test
- live `verify-local.mjs ... --no-auth` Secure MCP Tunnel verifier

After any backend-affecting change, use the controlled ForgeLink restart and verify the new generation before claiming the Windows layer is live.
