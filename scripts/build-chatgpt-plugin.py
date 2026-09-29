import json
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ZIP = ROOT / "ForgeLink-plugin-1.0.1.zip"
LOGO = ROOT / "chatgpt-logo.png"
OUTPUT_ZIP = ROOT / "ForgeLink-plugin-1.1.1.zip"
VERSION = "1.1.1"

def require(condition, message):
    if not condition:
        raise SystemExit(message)

require(SOURCE_ZIP.is_file(), f"Missing source package: {SOURCE_ZIP}")
require(LOGO.is_file(), f"Missing logo: {LOGO}")

logo = LOGO.read_bytes()
require(logo[:8] == bytes.fromhex("89504e470d0a1a0a"), "chatgpt-logo.png is not a valid PNG")
width, height = struct.unpack(">II", logo[16:24])
require(width == height, f"chatgpt-logo.png must be square, got {width}x{height}")
require(48 <= width <= 4096, f"chatgpt-logo.png dimensions out of range: {width}x{height}")
require(len(logo) <= 128 * 1024, f"chatgpt-logo.png exceeds 128 KiB: {len(logo)} bytes")

with zipfile.ZipFile(SOURCE_ZIP, "r") as zin:
    names = set(zin.namelist())
    require(".app.json" in names, "Source package is missing .app.json")
    app_json = zin.read(".app.json")
    app_manifest = json.loads(app_json.decode("utf-8"))
    legacy = {}
    if ".codex-plugin/plugin.json" in names:
        legacy = json.loads(zin.read(".codex-plugin/plugin.json").decode("utf-8"))

interface = dict(legacy.get("interface") or {})
interface.update({
    "displayName": "ForgeLink",
    "shortDescription": "Private local computer bridge for ChatGPT",
    "longDescription": "ForgeLink by Vidit Shah provides controlled local files, engineering workflows, system diagnostics, and MCP Apps integration.",
    "developerName": "Vidit Shah",
    "logo": "./assets/logo.png",
    "composerIcon": "./assets/logo.png",
})

portable = {
    "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    "name": "forgelink",
    "version": VERSION,
    "description": "Private local computer bridge for ChatGPT",
    "author": {"name": "Vidit Shah"},
    "license": "MIT",
    "keywords": ["mcp", "local-files", "engineering", "automation"],
    "extensions": {
        "com.openai": {
            "apps": "./.app.json",
            "interface": interface,
        }
    },
}

legacy["version"] = VERSION
legacy["interface"] = interface
legacy.setdefault("apps", "./.app.json")

portable_bytes = (json.dumps(portable, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
legacy_bytes = (json.dumps(legacy, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

with zipfile.ZipFile(OUTPUT_ZIP, "w", compression=zipfile.ZIP_DEFLATED) as zout:
    zout.writestr("plugin.json", portable_bytes)
    zout.writestr(".app.json", app_json)
    zout.writestr(".codex-plugin/plugin.json", legacy_bytes)
    zout.writestr("assets/logo.png", logo)

with zipfile.ZipFile(OUTPUT_ZIP, "r") as check:
    entries = check.namelist()
    root_manifest = json.loads(check.read("plugin.json").decode("utf-8"))
    compat_manifest = json.loads(check.read(".codex-plugin/plugin.json").decode("utf-8"))
    embedded_logo = check.read("assets/logo.png")
    embedded_app = json.loads(check.read(".app.json").decode("utf-8"))

require(entries == ["plugin.json", ".app.json", ".codex-plugin/plugin.json", "assets/logo.png"], f"Unexpected package entries: {entries}")
require(root_manifest["extensions"]["com.openai"]["apps"] == "./.app.json", "Root manifest does not declare .app.json")
require(root_manifest["extensions"]["com.openai"]["interface"]["logo"] == "./assets/logo.png", "Root logo path is wrong")
require(root_manifest["extensions"]["com.openai"]["interface"]["composerIcon"] == "./assets/logo.png", "Root composer icon path is wrong")
require(compat_manifest["interface"]["logo"] == "./assets/logo.png", "Compatibility logo path is wrong")
require(compat_manifest["interface"]["composerIcon"] == "./assets/logo.png", "Compatibility composer icon path is wrong")
require(embedded_logo == logo, "Embedded logo bytes do not match logo.png")
require(isinstance(embedded_app, (dict, list)), ".app.json is not valid JSON")

print(json.dumps({
    "ok": True,
    "output": str(OUTPUT_ZIP),
    "version": VERSION,
    "logo": "./assets/logo.png",
    "composerIcon": "./assets/logo.png",
    "logoDimensions": f"{width}x{height}",
    "logoBytes": len(logo),
    "zipBytes": OUTPUT_ZIP.stat().st_size,
    "entries": entries,
}, indent=2))
