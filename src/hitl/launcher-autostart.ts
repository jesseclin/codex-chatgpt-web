import { spawn } from "node:child_process";
import { findInstalledLauncherExecutable } from "../dev-chat/profile";
import {
  readLauncherBrowserHostDescriptor,
  waitForLauncherDescriptor,
  type LauncherBrowserHostDescriptor,
} from "../launcher-browser-host";

export interface LauncherAutostartDeps {
  readDescriptor: (path: string) => LauncherBrowserHostDescriptor;
  findExecutable: () => string;
  startLauncher: (executable: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: LauncherAutostartDeps = {
  readDescriptor: readLauncherBrowserHostDescriptor,
  findExecutable: () => findInstalledLauncherExecutable(),
  startLauncher: executable => {
    // Inherited from Electron hosts (e.g. a VS Code terminal or extension); it would make the
    // launcher run as plain Node and exit immediately.
    const { ELECTRON_RUN_AS_NODE: _electronAsNode, ...env } = process.env;
    const child = spawn(executable, [], { detached: true, env, stdio: "ignore", windowsHide: false });
    child.unref();
  },
  sleep: ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  now: () => Date.now(),
};

/**
 * A foreground `serve --hitl` owns the Responses port, so nothing else starts the launcher that
 * hosts its ChatGPT browser. Without it every turn fails before reaching ChatGPT, which Codex shows
 * as "Selected model is at capacity". Call this only after the server has bound its port, so a
 * launcher that still tries to supervise its own daemon finds the port taken instead of racing it.
 */
export async function ensureLauncherBrowserHost(
  descriptorPath: string,
  options: { timeoutMs?: number } = {},
  deps: LauncherAutostartDeps = defaultDeps,
): Promise<"running" | "started"> {
  try {
    const descriptor = deps.readDescriptor(descriptorPath);
    if (descriptor.profile === "production") return "running";
  } catch {
    // Absent or stale: start the launcher, which rewrites its own descriptor once ready.
  }
  deps.startLauncher(deps.findExecutable());
  await waitForLauncherDescriptor(
    descriptorPath,
    "production",
    { timeoutMs: options.timeoutMs ?? 60_000, pollIntervalMs: 250, label: "Launcher" },
    deps,
  );
  return "started";
}
