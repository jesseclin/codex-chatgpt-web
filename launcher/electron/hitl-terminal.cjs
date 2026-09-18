const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const HITL_TERMINAL_TITLE = "codex-chatgpt-web HITL";

// Every value lands inside a double-quoted token of a .cmd script, where `"` ends the token,
// `%` expands variables, and a line break starts a new command. Refuse rather than escape.
function assertBatchSafe(value, label) {
  if (typeof value !== "string" || !value || /["%\r\n\0]/.test(value)) {
    throw new Error(`${label} contains characters that cannot be passed to a Windows terminal safely`);
  }
  return value;
}

function validateHitlWorkspace(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Choose a HITL workspace folder first");
  const resolved = path.resolve(value.trim());
  assertBatchSafe(resolved, "HITL workspace folder");
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`HITL workspace folder does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`HITL workspace is not a folder: ${resolved}`);
  return resolved;
}

// CommandLineToArgvW-style consumers (bun.exe, node.exe) close a quoted token on the first
// unescaped `"`; a backslash run immediately before that `"` escapes it only when the run is odd,
// so an odd trailing run (e.g. a drive root like "D:\") must be doubled or the closing quote is
// swallowed and the token absorbs everything up to the next real closing quote.
function quoteArgvToken(value) {
  const trailingBackslashes = /\\+$/.exec(value);
  if (!trailingBackslashes) return `"${value}"`;
  return `"${value}${"\\".repeat(trailingBackslashes[0].length)}"`;
}

/** `invocation` is a runtime-command.cjs invocation whose args already end in the serve arguments. */
function hitlTerminalScript(invocation) {
  const quoted = [invocation.executable, ...invocation.args]
    .map((part, index) => quoteArgvToken(assertBatchSafe(part, index === 0 ? "Runtime executable" : "Runtime argument")))
    .join(" ");
  return [
    "@echo off",
    "chcp 65001 >nul",
    `title ${HITL_TERMINAL_TITLE}`,
    `cd /d "${assertBatchSafe(invocation.cwd, "Runtime directory")}"`,
    quoted,
    "echo.",
    "echo [codex-chatgpt-web] HITL server exited with code %ERRORLEVEL%.",
    "pause",
    "",
  ].join("\r\n");
}

// Single-quoting is the only safe POSIX shell escape: everything inside '...' is literal except
// a literal single quote itself, which must close the quote, emit an escaped quote, and reopen it.
function quoteShellToken(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** `invocation` is a runtime-command.cjs invocation whose args already end in the serve arguments.
 * `envOverrides` is embedded as `export` lines rather than relied on from the spawned process's own
 * environment: macOS's "do script" hands the command to Terminal.app over Apple Events, which opens
 * an unrelated login shell that never inherits osascript's environment. */
function hitlTerminalShellScript(invocation, envOverrides = {}) {
  const quoted = [invocation.executable, ...invocation.args].map(quoteShellToken).join(" ");
  const exports = Object.entries(envOverrides).map(([key, value]) => `export ${key}=${quoteShellToken(value)}`);
  return [
    "#!/bin/sh",
    ...exports,
    `cd ${quoteShellToken(invocation.cwd)} || exit 1`,
    quoted,
    "status=$?",
    "echo",
    `echo "[codex-chatgpt-web] HITL server exited with code $status."`,
    'printf "Press Enter to close..."',
    "read -r _",
    "",
  ].join("\n");
}

// Checked in this order on Linux; each entry names its own exec-argument convention (gnome-terminal
// uses "--" to mark the exec form, the rest accept "-e <command>").
const LINUX_TERMINAL_CANDIDATES = [
  { cmd: "x-terminal-emulator", args: script => ["-e", script] },
  { cmd: "gnome-terminal", args: script => ["--", script] },
  { cmd: "konsole", args: script => ["-e", script] },
  { cmd: "xfce4-terminal", args: script => ["-e", script] },
  { cmd: "mate-terminal", args: script => ["-e", script] },
  { cmd: "tilix", args: script => ["-e", script] },
  { cmd: "terminator", args: script => ["-x", script] },
  { cmd: "alacritty", args: script => ["-e", script] },
  { cmd: "kitty", args: script => [script] },
  { cmd: "xterm", args: script => ["-e", script] },
];

function commandExists(cmd, { path: pathEnv = process.env.PATH, exists = fs.existsSync } = {}) {
  const dirs = (pathEnv || "").split(path.delimiter).filter(Boolean);
  return dirs.some(dir => exists(path.join(dir, cmd)));
}

function findLinuxTerminalEmulator({ exists = commandExists } = {}) {
  return LINUX_TERMINAL_CANDIDATES.find(candidate => exists(candidate.cmd)) ?? null;
}

/** Opens a new console window so the daemon gets a real TTY: HITL refuses to activate without one,
 * and the operator can approve from that terminal as well as from the launcher popup. */
function launchHitlTerminal({
  invocation,
  scriptPath,
  environment,
  envOverrides = {},
  platform = process.platform,
  spawnProcess = spawn,
  writeFile = writePrivateFileAtomic,
  findEmulator = findLinuxTerminalEmulator,
}) {
  if (platform === "win32") {
    assertBatchSafe(scriptPath, "HITL script path");
    writeFile(scriptPath, hitlTerminalScript(invocation));
    const child = spawnProcess(
      "cmd.exe",
      ["/d", "/c", "start", `"${HITL_TERMINAL_TITLE}"`, "cmd.exe", "/d", "/c", `"${scriptPath}"`],
      {
        detached: true,
        env: environment,
        stdio: "ignore",
        windowsHide: false,
        windowsVerbatimArguments: true,
      },
    );
    child.unref?.();
    return child;
  }
  if (platform === "darwin") {
    writeFile(scriptPath, hitlTerminalShellScript(invocation, envOverrides), { mode: 0o700 });
    const child = spawnProcess(
      "osascript",
      [
        "-e",
        `tell application "Terminal" to do script "${scriptPath.replace(/[\\"]/g, "\\$&")}"`,
        "-e",
        'tell application "Terminal" to activate',
      ],
      { detached: true, env: environment, stdio: "ignore" },
    );
    child.unref?.();
    return child;
  }
  if (platform === "linux") {
    const emulator = findEmulator();
    if (!emulator) throw new Error("No terminal emulator found; install one such as gnome-terminal or xterm to use HITL");
    writeFile(scriptPath, hitlTerminalShellScript(invocation, envOverrides), { mode: 0o700 });
    const child = spawnProcess(emulator.cmd, emulator.args(scriptPath), {
      detached: true,
      env: environment,
      stdio: "ignore",
    });
    child.unref?.();
    return child;
  }
  throw new Error("Starting HITL from the launcher is currently supported on Windows, macOS, and Linux only");
}

/** The command a user pastes into their own terminal; the CLI wrapper name matches the installers. */
function hitlCommandLine(workspace, autoApprove) {
  const folder = typeof workspace === "string" ? workspace.trim() : "";
  const quoted = !folder ? "<project folder>" : /[\s&()^]/.test(folder) ? quoteArgvToken(folder) : folder;
  return `codex-chatgpt-web serve --hitl --workspace ${quoted}${autoApprove ? " --hitl-auto-approve" : ""}`;
}

module.exports = {
  HITL_TERMINAL_TITLE,
  findLinuxTerminalEmulator,
  hitlCommandLine,
  hitlTerminalScript,
  hitlTerminalShellScript,
  launchHitlTerminal,
  validateHitlWorkspace,
};
