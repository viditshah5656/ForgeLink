import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export const SAFETY_POLICY_VERSION = 1;
export const UI_AUTOMATION_MODE = "off";
export const TERMINAL_SEMANTIC_MODE = "full_headless";

const HIGH_RISK_WINDOW_MS = 5 * 60_000;
const REPEAT_WINDOW_MS = 30_000;
const DENIAL_WINDOW_MS = 60_000;
const MAX_HIGH_RISK_ACTIONS = 10;
const MAX_IDENTICAL_ACTIONS = 2;
const MAX_DENIALS_BEFORE_TRIP = 5;
const MAX_EVENT_HISTORY = 200;

const FORBIDDEN_TERMINAL_RULES = [
  ["UI_SENDKEYS", /\b(?:sendkeys?|keybd_event|sendinput)\b|system\.windows\.forms\.sendkeys/i, "Synthetic keyboard input is disabled. Use a headless ForgeLink tool instead."],
  ["UI_MOUSE", /\b(?:mouse_event|setcursorpos|setcursorposition|click\s*\(|moveTo\s*\()\b|\bpyautogui\b|\bpynput\b|\brobotjs\b|@nut-tree|\bnut\.js\b/i, "Synthetic mouse input is disabled."],
  ["UI_FOCUS", /\b(?:setforegroundwindow|bringwindowtotop|appactivate|switchto.*window|activatewindow)\b/i, "Foreground-window manipulation is disabled."],
  ["UI_AUTOMATION", /uiautomation(?:client|types)?|\binvokepattern\b|selectionitempattern|windowpattern|automationelement|automationpeer/i, "Raw UI Automation is disabled."],
  ["UI_AUTOMATION_FRAMEWORK", /\b(?:autohotkey|autoit|xdotool|ydotool)\b|osascript[\s\S]{0,300}\b(?:keystroke|click)\b/i, "External UI automation frameworks are disabled."],
  ["CLIPBOARD_INJECTION", /\b(?:set-clipboard|get-clipboard|clip\.exe|pbcopy|pbpaste|xclip|xsel)\b|clipboard\.set/i, "Clipboard manipulation from remote terminal commands is disabled."],
  ["GENERIC_GUI_LAUNCH", /\bstart-process\b|(?:^|[;&|]\s*)start\s+(?:"[^"]*"\s+)?(?:https?:|[a-z]:\\|[\w.-]+\.exe)|\b(?:explorer|control|rundll32)\.exe\b/i, "Generic GUI launching is disabled. Use a dedicated ForgeLink tool."],
  ["WINDOWS_URI", /\b(?:ms-settings|shell:appsfolder|control\s+panel|fileprotocolhandler)\b/i, "Windows UI destinations cannot be opened from Full Terminal."],
  ["BROWSER_PROCESS", /\b(?:chrome|msedge|firefox|brave|opera)(?:\.exe)?\b[\s\S]{0,500}(?:https?:\/\/|--app=)/i, "Browser launching/navigation from Full Terminal is disabled."],
  ["CHATGPT_SENSITIVE_NAV", /https?:\/\/(?:[^\s/]+\.)?chatgpt\.com\/(?:settings|auth|account|payments|security|developer|admin|plugins?|apps?)(?:[\/?#\s]|$)/i, "Automated ChatGPT account/settings/plugin navigation is blocked."],
  ["CREDENTIAL_DESTINATION", /(?:password|credential|oauth|token|secret)[-_ ]?(?:manager|settings|store|page)/i, "Credential-adjacent UI navigation is blocked."],
  ["POLICY_FILE_MUTATION", /(?:\b(?:del|erase|rm|remove-item|set-content|add-content|out-file|move-item|rename-item|copy-item|writefile(?:sync)?|appendfile(?:sync)?|unlink(?:sync)?|rm(?:sync)?|rename(?:sync)?|truncate|write_text|write_bytes)\b[\s\S]{0,500}(?:access-config\.json|safety-state\.json|safety-events\.jsonl|agent-audit\.jsonl|tool-safety-policy\.mjs|server\.mjs|windows-system-control\.mjs|access-policy\.mjs|terminal-manager\.mjs|job-manager\.mjs|subagent-process-tools\.mjs)|(?:>|>>)\s*["']?(?:[^"'\r\n;&|]*[\\/])?(?:access-config\.json|safety-state\.json|safety-events\.jsonl|agent-audit\.jsonl|tool-safety-policy\.mjs|server\.mjs|windows-system-control\.mjs|access-policy\.mjs|terminal-manager\.mjs|job-manager\.mjs|subagent-process-tools\.mjs)|\bopen\s*\(\s*["'][^"']*(?:access-config\.json|safety-state\.json|safety-events\.jsonl|agent-audit\.jsonl|tool-safety-policy\.mjs|server\.mjs|windows-system-control\.mjs|access-policy\.mjs|terminal-manager\.mjs|job-manager\.mjs|subagent-process-tools\.mjs)["']\s*,\s*["'][wax+])/i, "ForgeLink security, policy, audit, and enforcement files cannot be modified through Full Terminal."],
  ["DYNAMIC_EXECUTION", /\b(?:invoke-expression|iex)\b|frombase64string|downloadstring\s*\(/i, "Dynamic/obfuscated command execution is disabled in Full Headless mode."],
  ["WIN32_INPUT_API", /(?:user32\.dll|\buser32\b)[\s\S]{0,500}(?:mouse_event|sendinput|keybd_event|setcursorpos|setforegroundwindow|bringwindowtotop)/i, "Win32 input/focus APIs are disabled."],
];

const SCRIPT_EXTENSIONS = new Set([".ps1", ".psm1", ".bat", ".cmd", ".js", ".mjs", ".cjs", ".py", ".ahk"]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function cleanEvent(event) {
  const allowed = ["at", "type", "tool", "risk", "ruleId", "reason", "signature", "tripped", "targetHash", "safeAlternative"];
  return Object.fromEntries(allowed.flatMap((key) => event[key] == null ? [] : [[key, event[key]]]));
}

export function decodePowerShellEncodedCommand(command) {
  const match = String(command || "").match(/-(?:enc|encodedcommand)\s+["']?([A-Za-z0-9+/=]{8,})["']?/i);
  if (!match) return null;
  try {
    const raw = Buffer.from(match[1], "base64");
    const utf16 = raw.toString("utf16le").replace(/\0/g, "");
    return utf16.trim();
  } catch {
    return "";
  }
}

export function extractScriptReferences(command) {
  const text = String(command || "");
  const found = new Set();
  const quoted = /["']([^"'\r\n]+\.(?:ps1|psm1|bat|cmd|js|mjs|cjs|py|ahk))["']/ig;
  const bare = /(?:^|\s)([^\s"';&|<>]+\.(?:ps1|psm1|bat|cmd|js|mjs|cjs|py|ahk))(?=\s|$)/ig;
  for (const regex of [quoted, bare]) {
    let match;
    while ((match = regex.exec(text))) found.add(match[1]);
  }
  return [...found].slice(0, 12);
}

export function analyzeTerminalCommand(command, options = {}) {
  const source = String(command ?? "");
  const normalized = source.normalize("NFKC");
  const matches = [];
  const encoded = /-(?:enc|encodedcommand)\b/i.test(normalized);
  if (encoded) {
    matches.push({
      ruleId: "OBFUSCATED_ENCODED_COMMAND",
      reason: "PowerShell EncodedCommand is disabled in Full Headless mode.",
      safeAlternative: "Run a transparent command or use a dedicated ForgeLink tool.",
    });
    const decoded = decodePowerShellEncodedCommand(normalized);
    if (decoded) {
      for (const item of analyzeTerminalCommand(decoded, { ...options, nested: true }).matches) {
        if (!matches.some((existing) => existing.ruleId === item.ruleId)) matches.push(item);
      }
    }
  }
  for (const [ruleId, regex, safeAlternative] of FORBIDDEN_TERMINAL_RULES) {
    if (regex.test(normalized)) {
      matches.push({ ruleId, reason: `Blocked by ForgeLink Full Headless policy: ${ruleId}.`, safeAlternative });
    }
  }
  const controlChars = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(source);
  if (controlChars) {
    matches.push({
      ruleId: "TERMINAL_CONTROL_CHARACTERS",
      reason: "Raw terminal control characters are disabled for remote input.",
      safeAlternative: "Submit one complete printable command with enter=true.",
    });
  }
  return {
    allowed: matches.length === 0,
    risk: matches.length ? "critical" : "headless",
    matches,
    commandHash: sha256(source),
    scriptReferences: extractScriptReferences(source),
  };
}

export class ToolSafetyPolicy {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error("dataDir is required");
    this.dataDir = path.resolve(options.dataDir);
    this.stateFile = path.join(this.dataDir, "safety-state.json");
    this.eventsFile = path.join(this.dataDir, "safety-events.jsonl");
    this.audit = typeof options.audit === "function" ? options.audit : async () => {};
    this.onTrip = typeof options.onTrip === "function" ? options.onTrip : async () => {};
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.automationMode = options.automationMode === "off" ? "off" : "headless";
    this.tripped = false;
    this.trippedAt = null;
    this.tripReason = null;
    this.recent = [];
    this.events = [];
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const stored = JSON.parse(await fsp.readFile(this.stateFile, "utf8"));
      if (stored?.tripped === true) {
        this.tripped = true;
        this.trippedAt = stored.trippedAt || null;
        this.tripReason = stored.tripReason || "Persisted safety trip";
      }
      if (stored?.automationMode) {
        this.automationMode = stored.automationMode === "off" ? "off" : "headless";
      }
    } catch (error) {
      if (error?.code !== "ENOENT") await this.audit("safety.state.read_failed", { code: String(error?.code || "unknown") });
    }
    try {
      const accessFile = path.join(this.dataDir, "access-config.json");
      const accessData = JSON.parse(await fsp.readFile(accessFile, "utf8"));
      if (accessData?.automationMode) {
        this.automationMode = accessData.automationMode === "off" ? "off" : "headless";
      }
    } catch {}
    try {
      const text = await fsp.readFile(this.eventsFile, "utf8");
      this.events = text.split(/\r?\n/).filter(Boolean).slice(-MAX_EVENT_HISTORY).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch {}
  }

  async persistState() {
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    const payload = {
      version: SAFETY_POLICY_VERSION,
      tripped: this.tripped,
      trippedAt: this.trippedAt,
      tripReason: this.tripReason,
      automationMode: this.automationMode,
    };
    await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, this.stateFile);
  }

  async appendEvent(event) {
    const item = cleanEvent({ at: new Date(this.now()).toISOString(), ...event });
    this.events.push(item);
    this.events = this.events.slice(-MAX_EVENT_HISTORY);
    try {
      await fsp.appendFile(this.eventsFile, `${JSON.stringify(item)}\n`, { mode: 0o600 });
    } catch (error) {
      await this.audit("safety.event.write_failed", { code: String(error?.code || "unknown") });
    }
    await this.audit(`safety.${item.type || "event"}`, {
      tool: item.tool,
      risk: item.risk,
      ruleId: item.ruleId,
      tripped: item.tripped === true,
      targetHash: item.targetHash,
    });
    return item;
  }

  prune() {
    const now = this.now();
    this.recent = this.recent.filter((item) => now - item.at <= HIGH_RISK_WINDOW_MS);
  }

  status() {
    this.prune();
    const mode = this.automationMode === "off" ? "off" : "headless";
    return {
      version: SAFETY_POLICY_VERSION,
      policy: "headless-first",
      automationMode: mode,
      headlessAutomation: mode === "headless",
      uiAutomationMode: UI_AUTOMATION_MODE,
      terminalSemanticMode: TERMINAL_SEMANTIC_MODE,
      tripped: this.tripped,
      trippedAt: this.trippedAt,
      tripReason: this.tripReason,
      recentHighRiskActions: this.recent.filter((item) => item.kind === "action").length,
      recentDenials: this.recent.filter((item) => item.kind === "denial" && this.now() - item.at <= DENIAL_WINDOW_MS).length,
      limits: {
        highRiskActionsPer5Minutes: MAX_HIGH_RISK_ACTIONS,
        identicalActionsPer30Seconds: MAX_IDENTICAL_ACTIONS,
        denialsBeforeTripPer60Seconds: MAX_DENIALS_BEFORE_TRIP,
      },
    };
  }

  async setAutomationMode(mode) {
    this.automationMode = mode === "off" ? "off" : "headless";
    try {
      const accessFile = path.join(this.dataDir, "access-config.json");
      let access = {};
      try { access = JSON.parse(await fsp.readFile(accessFile, "utf8")); } catch {}
      access.automationMode = this.automationMode;
      await fsp.writeFile(accessFile, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
    } catch {}
    await this.audit("safety.automation_mode.set", { automationMode: this.automationMode });
    return this.status();
  }

  recentEvents(limit = 25) {
    return this.events.slice(-Math.max(1, Math.min(100, Number(limit) || 25)));
  }

  async trip(reason, details = {}) {
    if (!this.tripped) {
      this.tripped = true;
      this.trippedAt = new Date(this.now()).toISOString();
      this.tripReason = String(reason || "Safety circuit breaker");
      await this.persistState();
    }
    await this.appendEvent({ type: "trip", risk: "critical", reason: this.tripReason, tripped: true, ...details });
    try { await this.onTrip({ reason: this.tripReason, details }); }
    catch (error) { await this.audit("safety.trip.cleanup_failed", { code: String(error?.code || "unknown") }); }
    return this.status();
  }

  async noteDenial({ tool, risk = "high", ruleId, reason, safeAlternative, target = "" }) {
    const at = this.now();
    const targetHash = target ? sha256(target) : undefined;
    const signature = sha256(`${tool}|denial|${ruleId || ""}|${targetHash || ""}`);
    this.recent.push({ at, kind: "denial", signature, tool, targetHash });
    this.prune();
    await this.appendEvent({ type: "denied", tool, risk, ruleId, reason, safeAlternative, signature, targetHash, tripped: this.tripped });
    const denials = this.recent.filter((item) => item.kind === "denial" && at - item.at <= DENIAL_WINDOW_MS);
    if (denials.length >= MAX_DENIALS_BEFORE_TRIP) await this.trip("Repeated denied high-risk actions", { tool, ruleId });
  }

  async assertRemoteMutationEnabled(tool = "mutation") {
    await this.initialize();
    if (!this.tripped) return { allowed: true };
    const error = new Error(`SAFETY_TRIPPED: Remote mutation is disabled. ${this.tripReason || "Local owner reset is required."}`);
    error.code = "SAFETY_TRIPPED";
    error.tool = tool;
    throw error;
  }

  async assertMutationAllowed({ tool, target = "", risk = "high", ui = false }) {
    await this.assertRemoteMutationEnabled(tool);
    if (this.tripped) {
      const error = new Error(`SAFETY_TRIPPED: Remote mutation is disabled. ${this.tripReason || "Local owner reset is required."}`);
      error.code = "SAFETY_TRIPPED";
      throw error;
    }
    if (ui) {
      await this.noteDenial({
        tool, risk: "critical", ruleId: "UI_AUTOMATION_DISABLED",
        reason: "Remote UI mutation is disabled by ForgeLink safety policy.",
        safeAlternative: "Use headless tools or perform the UI action locally.",
        target,
      });
      const error = new Error("UI_AUTOMATION_DISABLED: Remote app launch/focus/close/settings-open actions are disabled. Use headless tools or perform the action locally.");
      error.code = "UI_AUTOMATION_DISABLED";
      throw error;
    }
    const at = this.now();
    this.prune();
    const targetHash = target ? sha256(target) : "";
    const signature = sha256(`${tool}|${targetHash}`);
    const identical = this.recent.filter((item) => item.kind === "action" && item.signature === signature && at - item.at <= REPEAT_WINDOW_MS);
    if (identical.length >= MAX_IDENTICAL_ACTIONS) {
      await this.noteDenial({ tool, risk, ruleId: "LOOP_DETECTED", reason: "Repeated identical state-changing action blocked.", target });
      const error = new Error("LOOP_DETECTED: Repeated identical state-changing action blocked.");
      error.code = "LOOP_DETECTED";
      throw error;
    }
    const actions = this.recent.filter((item) => item.kind === "action" && at - item.at <= HIGH_RISK_WINDOW_MS);
    if (actions.length >= MAX_HIGH_RISK_ACTIONS) {
      await this.trip("High-risk action rate limit exceeded", { tool });
      const error = new Error("SAFETY_TRIPPED: High-risk action rate limit exceeded.");
      error.code = "SAFETY_TRIPPED";
      throw error;
    }
    this.recent.push({ at, kind: "action", signature, tool, targetHash });
    await this.appendEvent({ type: "allowed", tool, risk, signature, targetHash, tripped: false });
    return { allowed: true, signature };
  }

  async assertTerminalCommand(command, context = {}) {
    await this.initialize();
    if (this.tripped) {
      const error = new Error(`SAFETY_TRIPPED: Full Headless terminal mutation is disabled. ${this.tripReason || "Local owner reset is required."}`);
      error.code = "SAFETY_TRIPPED";
      throw error;
    }
    const analysis = analyzeTerminalCommand(command, context);
    if (!analysis.allowed) {
      const primary = analysis.matches[0];
      await this.noteDenial({
        tool: context.tool || "run_terminal_command",
        risk: "critical",
        ruleId: primary.ruleId,
        reason: primary.reason,
        safeAlternative: primary.safeAlternative,
        target: analysis.commandHash,
      });
      const error = new Error(`${primary.ruleId}: ${primary.safeAlternative}`);
      error.code = primary.ruleId;
      error.analysis = { ruleIds: analysis.matches.map((item) => item.ruleId), commandHash: analysis.commandHash };
      throw error;
    }
    return analysis;
  }
}
