import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";
import { createHitlEmitFilter, createHitlExecGate } from "../src/adapters/chatgpt-web/hitl-interceptor";
import { TtyApprovalGateway, type ApprovalGateway, type ApprovalDecision, type ExecProposal } from "../src/hitl/approval";
import { runApprovedPatch } from "../src/hitl/exec";
import {
  DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS,
  EXEC_REJECTED_TEXT,
  parseExecRequest,
  parsePatchRequest,
  patchTargetPaths,
} from "../src/hitl/protocol";

const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/a.txt",
  "@@",
  " keep",
  "-old",
  "+new",
  "*** End Patch",
].join("\n");

const block = (patch: string, extra = "cwd: .\nreason: fix a") =>
  `[APPLY_PATCH]\n${extra}\n\`\`\`\n${patch}\n\`\`\`\n[/APPLY_PATCH]`;

class FixedGateway implements ApprovalGateway {
  seen: ExecProposal[] = [];
  constructor(private readonly decide: (proposal: ExecProposal) => ApprovalDecision) {}
  async request(proposal: ExecProposal): Promise<ApprovalDecision> {
    this.seen.push(proposal);
    return this.decide(proposal);
  }
}

test("parsePatchRequest keeps a multi-line patch verbatim, including context and +/- lines", () => {
  expect(parsePatchRequest(block(PATCH))).toEqual({ patch: PATCH, cwd: ".", reason: "fix a" });
});

test("parsePatchRequest also accepts a patch that is not inside a code fence", () => {
  const text = `[APPLY_PATCH]\ncwd: doc\n${PATCH}\n[/APPLY_PATCH]`;
  expect(parsePatchRequest(text)).toEqual({ patch: PATCH, cwd: "doc" });
});

test("parsePatchRequest ignores a block without a complete patch envelope", () => {
  expect(parsePatchRequest("[APPLY_PATCH]\ncwd: .\n[/APPLY_PATCH]")).toBeUndefined();
  expect(parsePatchRequest(block("*** Begin Patch\n*** Add File: x\n+y"))).toBeUndefined();
  expect(parsePatchRequest(`[APPLY_PATCH]\n${PATCH}`)).toBeUndefined();
  expect(parsePatchRequest("plain text")).toBeUndefined();
});

test("an EXEC_REQUEST block is not mistaken for a patch request and vice versa", () => {
  expect(parsePatchRequest("[EXEC_REQUEST]\ncommand: ls\n[/EXEC_REQUEST]")).toBeUndefined();
  expect(parseExecRequest(block(PATCH))).toBeUndefined();
});

test("patchTargetPaths lists every file the patch adds, updates, deletes or moves to", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: new.txt",
    "+x",
    "*** Update File: src/a.txt",
    "*** Move to: src/b.txt",
    "@@",
    "-a",
    "+b",
    "*** Delete File: gone.txt",
    "*** End Patch",
  ].join("\n");
  expect(patchTargetPaths(patch)).toEqual(["new.txt", "src/a.txt", "src/b.txt", "gone.txt"]);
});

test("the protocol instructions teach the APPLY_PATCH block with balanced markers", () => {
  const text = DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS;
  expect(text).toContain("[APPLY_PATCH]");
  expect(text).toContain("*** Begin Patch");
  expect(text.split("[APPLY_PATCH]").length).toBe(text.split("[/APPLY_PATCH]").length);
  // The model must not shell out to a nonexistent apply_patch binary via EXEC_REQUEST.
  expect(text).toMatch(/not (?:available|a shell command)[^\n]*apply_patch|apply_patch[^\n]*(?:not (?:available|a shell command)|never)/i);
});

test("an approved patch is handed to the patch command as one argument and its result is wrapped", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-patch-"));
  try {
    const fake = join(workspace, "fake-apply.ts");
    writeFileSync(fake, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));",
      "console.log('Success. Updated the following files:\\nM src/a.txt');",
    ].join("\n"));
    const gateway = new FixedGateway(p => ({ action: "run", command: p.command }));
    const result = await runApprovedPatch(
      gateway,
      { patch: PATCH, cwd: ".", reason: "fix a" },
      workspace,
      { applyPatchCommand: [process.execPath, fake, "--codex-run-as-apply-patch"] },
    );
    expect(result).toBe("[EXEC_RESULT]\nexit_code: 0\noutput:\nSuccess. Updated the following files:\nM src/a.txt\n[/EXEC_RESULT]");
    expect(JSON.parse(readFileSync(join(workspace, "args.json"), "utf8"))).toEqual(["--codex-run-as-apply-patch", PATCH]);
    // The operator is shown the whole patch, flagged as a patch.
    expect(gateway.seen[0]).toMatchObject({ command: PATCH, kind: "patch", cwd: workspace, reason: "fix a" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a rejected patch is never applied", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-patch-"));
  try {
    const marker = join(workspace, "ran.txt");
    const fake = join(workspace, "fake-apply.ts");
    writeFileSync(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, "x");`);
    const result = await runApprovedPatch(
      new FixedGateway(() => ({ action: "reject" })),
      { patch: PATCH },
      workspace,
      { applyPatchCommand: [process.execPath, fake] },
    );
    expect(result).toBe(EXEC_REJECTED_TEXT);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a patch that touches a path outside the workspace is blocked before approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-patch-"));
  try {
    const gateway = new FixedGateway(p => ({ action: "run", command: p.command }));
    for (const target of ["../escape.txt", resolve(workspace, "..", "abs.txt"), "src/../../up.txt"]) {
      const patch = `*** Begin Patch\n*** Add File: ${target}\n+x\n*** End Patch`;
      const result = await runApprovedPatch(gateway, { patch }, workspace, { applyPatchCommand: [process.execPath, "-e", "process.exit(9)"] });
      expect(result).toContain("outside the workspace");
      expect(result).toContain(target);
    }
    expect(gateway.seen).toEqual([]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an operator-edited patch is re-checked against the workspace before it runs", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-patch-"));
  try {
    const edited = "*** Begin Patch\n*** Add File: ../evil.txt\n+x\n*** End Patch";
    const result = await runApprovedPatch(
      new FixedGateway(() => ({ action: "run", command: edited })),
      { patch: PATCH },
      workspace,
      { applyPatchCommand: [process.execPath, "-e", "process.exit(9)"] },
    );
    expect(result).toContain("outside the workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a failing patch command reports its exit code and output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-patch-"));
  try {
    const result = await runApprovedPatch(
      new FixedGateway(p => ({ action: "run", command: p.command })),
      { patch: PATCH },
      workspace,
      { applyPatchCommand: [process.execPath, "-e", "process.stderr.write('Invalid patch'); process.exit(1)"] },
    );
    expect(result).toBe("[EXEC_RESULT]\nexit_code: 1\noutput:\nInvalid patch\n[/EXEC_RESULT]");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a missing patch command is reported to the model instead of throwing", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-patch-"));
  try {
    const result = await runApprovedPatch(
      new FixedGateway(p => ({ action: "run", command: p.command })),
      { patch: PATCH },
      workspace,
      { applyPatchCommand: [join(workspace, "no-such-binary")] },
    );
    expect(result).toContain("exit_code: 1");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("createHitlExecGate resumes with the patch result for an APPLY_PATCH block", async () => {
  const gate = createHitlExecGate({
    approvalGateway: { request: async p => ({ action: "run", command: p.command }) },
    workspaceCwd: "/workspace",
    runPatch: async (_gateway, request, workspaceCwd) => {
      expect(request.patch).toBe(PATCH);
      expect(workspaceCwd).toBe("/workspace");
      return "[EXEC_RESULT]\nexit_code: 0\noutput:\nok\n[/EXEC_RESULT]";
    },
  });
  expect(await gate.check(block(PATCH))).toEqual({
    action: "resume",
    followUpText: "[EXEC_RESULT]\nexit_code: 0\noutput:\nok\n[/EXEC_RESULT]",
  });
});

test("createHitlExecGate never applies a patch for a turn that was cancelled during approval", async () => {
  const controller = new AbortController();
  let applied = false;
  const gate = createHitlExecGate({
    approvalGateway: {
      request: async (p, signal) => {
        controller.abort();
        expect(signal?.aborted).toBe(true);
        return { action: "run", command: p.command };
      },
    },
    workspaceCwd: resolve("/workspace"),
    runPatch: async (gateway, request) => {
      const decision = await gateway.request({ command: request.patch, cwd: "/workspace", kind: "patch" });
      applied = decision.action === "run";
      return "x";
    },
  });
  expect(await gate.check(block(PATCH), controller.signal)).toEqual({ action: "finalize" });
  expect(applied).toBe(false);
});

test("createHitlEmitFilter withholds a completed APPLY_PATCH block from the Codex transcript", () => {
  const out: Array<{ type: string; text?: string }> = [];
  const emit = createHitlEmitFilter<{ type: string; text?: string }>(event => out.push(event));
  const text = block(PATCH);
  for (let i = 0; i < text.length; i += 7) emit({ type: "text_delta", text: text.slice(i, i + 7) });
  expect(out).toEqual([]);
});

test("createHitlEmitFilter still flushes a bracketed reply that is not an APPLY_PATCH block", () => {
  const out: Array<{ type: string; text?: string }> = [];
  const emit = createHitlEmitFilter<{ type: string; text?: string }>(event => out.push(event));
  emit({ type: "text_delta", text: "[APPLY" });
  emit({ type: "text_delta", text: "_LATER] see you" });
  emit({ type: "text_delta", text: " soon" });
  expect(out.map(event => event.text).join("")).toBe("[APPLY_LATER] see you soon");
});

test("Turndown-escaped APPLY_PATCH markers are restored and the fenced patch stays verbatim", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: a_b.md",
    "@@",
    "-# old_title *x*",
    "+# new_title \\*y\\*",
    "*** End Patch",
  ].join("\n");
  const html = [
    "<p>[APPLY_PATCH]<br>cwd: .<br>reason: rename_title</p>",
    `<pre><code>${patch.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre>`,
    "<p>[/APPLY_PATCH]</p>",
  ].join("");
  const markdown = chatGptHtmlToMarkdown(html);
  expect(markdown).not.toContain("\\[APPLY");
  expect(parsePatchRequest(markdown)).toEqual({ patch, cwd: ".", reason: "rename_title" });
});

test("the terminal prompt shows the whole patch and offers no command editing", async () => {
  const written: string[] = [];
  const output = { write: (chunk: string) => { written.push(chunk); return true; } } as unknown as NodeJS.WritableStream;
  const { PassThrough } = await import("node:stream");
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request({ command: PATCH, cwd: "/workspace", reason: "fix a", kind: "patch" });
  input.write("y\n");
  expect(await decision).toEqual({ action: "run", command: PATCH });
  const shown = written.join("");
  expect(shown).toContain("*** Begin Patch");
  expect(shown).toContain("+new");
  expect(shown).not.toContain("[c] Edit command");
});
