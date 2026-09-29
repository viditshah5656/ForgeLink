import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  analyzeTerminalCommand,
  decodePowerShellEncodedCommand,
  extractScriptReferences,
  ToolSafetyPolicy,
  UI_AUTOMATION_MODE,
  TERMINAL_SEMANTIC_MODE,
} from "./tool-safety-policy.mjs";

const blockedSeeds = [
  'powershell -Command "[System.Windows.Forms.SendKeys]::SendWait(\'3\')"',
  'Add-Type -Name U -Namespace X -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);\'',
  'mouse_event(2,0,0,0,0)',
  'SetForegroundWindow($h)',
  'BringWindowToTop($h)',
  '$ws=New-Object -ComObject WScript.Shell; $ws.AppActivate("Edge")',
  'Add-Type -AssemblyName UIAutomationClient',
  '[System.Windows.Automation.InvokePattern]::Pattern',
  'python -c "import pyautogui; pyautogui.click(10,10)"',
  'python -c "from pynput.keyboard import Controller"',
  'node -e "require(\'robotjs\').keyTap(\'3\')"',
  'node -e "require(\'@nut-tree/nut-js\')"',
  'AutoHotkey.exe script.ahk',
  'Set-Clipboard "danger"',
  'clip.exe < secret.txt',
  'Start-Process chrome.exe "https://chatgpt.com/settings"',
  'cmd /c start "" https://chatgpt.com/settings/plugins',
  'explorer.exe https://example.com',
  'rundll32.exe url.dll,FileProtocolHandler https://example.com',
  'ms-settings:display',
  'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
  'chrome.exe https://example.com',
  'msedge.exe --app=https://example.com',
  'firefox.exe https://example.com',
  'curl https://chatgpt.com/settings/plugins',
  'del access-config.json',
  'del safety-state.json',
  'echo {} > agent-audit.jsonl',
  'iex $payload',
  'Invoke-Expression $payload',
  '[Convert]::FromBase64String($x)',
];

const safeSeeds = [
  'git status --short',
  'git diff --stat',
  'npm test',
  'npm run build',
  'node --check server.mjs',
  'python -m pytest',
  'Get-ChildItem .',
  'Get-Content README.md -Head 10',
  'Select-String -Path server.mjs -Pattern "registerTool"',
  'node -e "console.log(2+2)"',
  'powershell -NoProfile -Command "Get-Date"',
  'cmd /d /s /c echo hello',
  'npm run lint',
  'git log -1 --oneline',
  'python -m compileall .',
  'Get-Process | Select-Object -First 5 Name,Id',
  'Get-NetTCPConnection -State Listen | Select-Object -First 5',
  'node scripts/check.mjs',
  'python scripts/check.py',
  'Get-FileHash package.json -Algorithm SHA256',
];

test("policy constants are fail-closed", () => {
  assert.equal(UI_AUTOMATION_MODE, "off");
  assert.equal(TERMINAL_SEMANTIC_MODE, "full_headless");
});

test("adversarial command corpus blocks UI/browser/policy escapes and permits headless work", () => {
  const variants = [];
  for (const seed of blockedSeeds) {
    variants.push(seed, seed.toUpperCase(), "  " + seed + "  ");
  }
  assert.ok(variants.length >= 90);
  for (const command of variants) {
    const result = analyzeTerminalCommand(command);
    assert.equal(result.allowed, false, command);
    assert.ok(result.matches.length >= 1, command);
  }

  const safeVariants = [];
  for (const seed of safeSeeds) {
    safeVariants.push(seed, seed + " ", "  " + seed);
  }
  assert.ok(safeVariants.length >= 60);
  for (const command of safeVariants) {
    const result = analyzeTerminalCommand(command);
    assert.equal(result.allowed, true, command + " -> " + JSON.stringify(result.matches));
  }
});

test("PowerShell EncodedCommand is denied and decodes transparently for diagnostics", () => {
  const payload = '[System.Windows.Forms.SendKeys]::SendWait("3")';
  const encoded = Buffer.from(payload, "utf16le").toString("base64");
  const command = "powershell.exe -EncodedCommand " + encoded;
  assert.equal(decodePowerShellEncodedCommand(command), payload);
  const result = analyzeTerminalCommand(command);
  assert.equal(result.allowed, false);
  assert.ok(result.matches.some((item) => item.ruleId === "OBFUSCATED_ENCODED_COMMAND"));
  assert.ok(result.matches.some((item) => item.ruleId === "UI_SENDKEYS"));
});

test("script references are extracted without executing them", () => {
  assert.deepEqual(
    extractScriptReferences('powershell -File "scripts/test ui.ps1"; node scripts/check.mjs'),
    ["scripts/test ui.ps1", "scripts/check.mjs"],
  );
});

test("circuit breaker trips after repeated denied high-risk actions and persists", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "forgelink-safety-"));
  let now = Date.now();
  try {
    const policy = new ToolSafetyPolicy({ dataDir: dir, now: () => now });
    await policy.initialize();
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(
        () => policy.assertTerminalCommand('[System.Windows.Forms.SendKeys]::SendWait("3")', { tool: "run_terminal_command" }),
        /UI_SENDKEYS|SAFETY_TRIPPED/,
      );
      now += 100;
    }
    assert.equal(policy.status().tripped, true);

    const reloaded = new ToolSafetyPolicy({ dataDir: dir, now: () => now });
    await reloaded.initialize();
    assert.equal(reloaded.status().tripped, true);
    await assert.rejects(() => reloaded.assertTerminalCommand("git status"), /SAFETY_TRIPPED/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("remote UI mutation is hard-disabled even when system control is otherwise full", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "forgelink-ui-safety-"));
  try {
    const policy = new ToolSafetyPolicy({ dataDir: dir });
    await policy.initialize();
    await assert.rejects(
      () => policy.assertMutationAllowed({ tool: "windows_app_control", target: "notepad", ui: true }),
      /UI_AUTOMATION_DISABLED/,
    );
    assert.equal(policy.status().tripped, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("identical high-risk state-changing actions are loop-limited", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "forgelink-loop-safety-"));
  let now = Date.now();
  try {
    const policy = new ToolSafetyPolicy({ dataDir: dir, now: () => now });
    await policy.initialize();
    await policy.assertMutationAllowed({ tool: "test_mutation", target: "same" });
    now += 100;
    await policy.assertMutationAllowed({ tool: "test_mutation", target: "same" });
    now += 100;
    await assert.rejects(() => policy.assertMutationAllowed({ tool: "test_mutation", target: "same" }), /LOOP_DETECTED/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("safety events remain redacted and never contain raw commands", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "forgelink-event-safety-"));
  try {
    const policy = new ToolSafetyPolicy({ dataDir: dir });
    await policy.initialize();
    await assert.rejects(
      () => policy.assertTerminalCommand('Start-Process chrome.exe "https://chatgpt.com/settings/plugins"', { tool: "run_terminal_command" }),
    );
    const serialized = JSON.stringify(policy.recentEvents(20));
    assert.equal(serialized.includes("Start-Process chrome.exe"), false);
    assert.equal(serialized.includes("chatgpt.com/settings"), false);
    assert.equal(serialized.includes("commandHash"), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("supports toggling headless automation mode while keeping UI mutation fail-closed", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "forgelink-automation-safety-"));
  try {
    const policy = new ToolSafetyPolicy({ dataDir: dir });
    await policy.initialize();
    assert.equal(policy.status().automationMode, "headless");
    assert.equal(policy.status().headlessAutomation, true);
    assert.equal(policy.status().uiAutomationMode, "off");

    // UI mutation is strictly blocked in headless mode
    await assert.rejects(() => policy.assertMutationAllowed({ tool: "windows_app_launch", ui: true }), /UI_AUTOMATION_DISABLED/);

    // Switch to off mode
    const offStatus = await policy.setAutomationMode("off");
    assert.equal(offStatus.automationMode, "off");
    assert.equal(offStatus.headlessAutomation, false);
    assert.equal(offStatus.uiAutomationMode, "off");

    // UI mutation remains blocked in off mode
    await assert.rejects(() => policy.assertMutationAllowed({ tool: "windows_app_launch", ui: true }), /UI_AUTOMATION_DISABLED/);

    // Switch back to headless mode
    const headlessStatus = await policy.setAutomationMode("headless");
    assert.equal(headlessStatus.automationMode, "headless");
    assert.equal(headlessStatus.headlessAutomation, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

