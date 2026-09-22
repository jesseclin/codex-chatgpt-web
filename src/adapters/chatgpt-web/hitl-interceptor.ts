import { parseExecRequest, parsePatchRequest } from "../../hitl/protocol";
import { runApprovedCommand, runApprovedPatch, type RawExecRequest, type RawPatchRequest } from "../../hitl/exec";
import type { ApprovalDecision, ApprovalGateway, ExecProposal } from "../../hitl/approval";

export interface HitlExecGate {
  /** `abortSignal` is the owning turn's signal. A turn that is already gone (Codex cancelled
   * mid-approval) must never spawn its approved command, so the gate finalizes instead of
   * resuming both before prompting and again after the approval decision settles. */
  check(finalText: string, abortSignal?: AbortSignal): Promise<
    | { action: "finalize" }
    | { action: "resume"; followUpText: string }
  >;
}

export interface HitlExecGateDeps {
  approvalGateway: ApprovalGateway;
  workspaceCwd: string;
  /** Injected for testability; defaults to the real src/hitl/exec.ts implementation. */
  runCommand?: (gateway: ApprovalGateway, request: RawExecRequest, workspaceCwd: string) => Promise<string>;
  /** Injected for testability; defaults to the real src/hitl/exec.ts patch implementation. */
  runPatch?: (gateway: ApprovalGateway, request: RawPatchRequest, workspaceCwd: string) => Promise<string>;
}

/** Marks that open a protocol block the gate handles itself (and Codex must never see). */
const BLOCK_OPENERS = ["[EXEC_REQUEST", "[APPLY_PATCH"] as const;

export function createHitlExecGate(deps: HitlExecGateDeps): HitlExecGate {
  const runCommand = deps.runCommand ?? runApprovedCommand;
  const runPatch = deps.runPatch ?? runApprovedPatch;
  return {
    async check(finalText, abortSignal) {
      const execRequest = parseExecRequest(finalText);
      const patchRequest = parsePatchRequest(finalText);
      // Only the first block is honored when a reply somehow holds both kinds.
      const patchFirst = patchRequest !== undefined
        && (execRequest === undefined || finalText.indexOf("[APPLY_PATCH]") < finalText.indexOf("[EXEC_REQUEST]"));
      const request = patchFirst ? patchRequest : execRequest;
      if (!request) return { action: "finalize" };
      // The turn is already gone: nothing to resume into, and nothing may be spawned on its behalf.
      if (abortSignal?.aborted) return { action: "finalize" };
      // A TTY approval prompt blocks for as long as the operator takes, so the turn can be
      // cancelled while it is open. Re-checking the signal *after* the decision settles but
      // before `runApprovedCommand` reaches `spawn` is what actually prevents a command from
      // running for a dead turn; reporting it as a rejection is the one decision that makes
      // `runApprovedCommand` return without spawning anything.
      const gateway: ApprovalGateway = abortSignal
        ? {
          request: async proposal => {
            const decision = await deps.approvalGateway.request(proposal, abortSignal);
            return abortSignal.aborted ? { action: "reject" } : decision;
          },
        }
        : deps.approvalGateway;
      const followUpText = patchFirst
        ? await runPatch(gateway, request as RawPatchRequest, deps.workspaceCwd)
        : await runCommand(gateway, request as RawExecRequest, deps.workspaceCwd);
      if (abortSignal?.aborted) return { action: "finalize" };
      return { action: "resume", followUpText };
    },
  };
}

/** A plan executed one un-delegated action at a time, this many actions in a row, is
 * indistinguishable from a model that was supposed to dispatch subagent/sub-task work but never
 * did -- the exact pattern that ran a Codex plan unattended for 2h11m (see the session-log
 * investigation this constant comes from). */
const NON_DELEGATED_STREAK_WARNING_THRESHOLD = 5;

/** Matches the one delegation convention the HITL transport documents (`DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS`
 * in src/hitl/protocol.ts): an EXEC_REQUEST whose command shells out to a non-interactive `codex exec`
 * sub-task. An APPLY_PATCH is never a delegation -- it always edits files inline. */
const CODEX_EXEC_DELEGATION = /\bcodex\s+exec\b/;

function isDelegatedSubTask(proposal: ExecProposal): boolean {
  return proposal.kind !== "patch" && CODEX_EXEC_DELEGATION.test(proposal.command);
}

function nonDelegatedStreakWarning(streak: number): string {
  return `${streak} actions in a row with no delegated \`codex exec\` sub-task -- this looks like `
    + "inline self-execution of a larger plan rather than subagent-driven work. Approve to continue, "
    + "or reject/adjust now -- this is also a good point to switch model.";
}

/**
 * Serializes every HITL approval prompt for one adapter onto the daemon's single stdin.
 *
 * Up to `MAX_CHATGPT_BROWSER_TABS` browser turns can run at once, and each one that hits an
 * `[EXEC_REQUEST]` wants the terminal. `TtyApprovalGateway` opens a `readline.Interface` on
 * stdin for the duration of a prompt, and two concurrent interfaces on one stream corrupt each
 * other and can permanently hang the next prompt (see src/hitl/approval.ts). This queue keeps at
 * most one prompt live at a time and stamps each proposal with its turn's `traceId`, so an
 * operator approving concurrent turns can tell them apart.
 */
export class HitlApprovalQueue {
  private tail: Promise<unknown> = Promise.resolve();
  /** Consecutive proposals (across every turn this queue has ever seen -- this instance lives for
   * the whole daemon session) that were not a delegated `codex exec` sub-task. Reset by one. */
  private nonDelegatedStreak = 0;

  constructor(private readonly gateway: ApprovalGateway) {}

  /** An `ApprovalGateway` view bound to one turn; every prompt it raises waits its turn. */
  forTurn(traceId: string): ApprovalGateway {
    return { request: (proposal, signal) => this.enqueue({ ...proposal, traceId }, signal) };
  }

  /** Reasons come from the model and are shown to the operator verbatim, so a streak warning is
   * prepended (not appended) to stay visible even if the terminal/popup truncates a long reason. */
  private annotateStreak(proposal: ExecProposal): ExecProposal {
    if (isDelegatedSubTask(proposal)) {
      this.nonDelegatedStreak = 0;
      return proposal;
    }
    this.nonDelegatedStreak += 1;
    if (this.nonDelegatedStreak < NON_DELEGATED_STREAK_WARNING_THRESHOLD) return proposal;
    const warning = nonDelegatedStreakWarning(this.nonDelegatedStreak);
    return { ...proposal, reason: proposal.reason ? `${warning}\n\n${proposal.reason}` : warning };
  }

  private enqueue(proposal: ExecProposal, signal?: AbortSignal): Promise<ApprovalDecision> {
    const annotated = this.annotateStreak(proposal);
    // Chain off settlement (not success) so one failed prompt cannot wedge the queue forever.
    const decision = this.tail.then(
      () => this.gateway.request(annotated, signal),
      () => this.gateway.request(annotated, signal),
    );
    this.tail = decision.then(() => undefined, () => undefined);
    return decision;
  }
}

/**
 * Withholds the raw `[EXEC_REQUEST]...[/EXEC_REQUEST]` (or `[APPLY_PATCH]...[/APPLY_PATCH]`) protocol block from
 * reaching Codex's transcript. Buffers `text_delta` text since the last
 * flush; flushes verbatim once the buffered text can no longer be a prefix
 * of `[EXEC_REQUEST]`, or drops it once it completes a well-formed block
 * (parseExecRequest succeeds) — the exec gate handles the block itself via
 * `check()`, so Codex never needs to see it.
 *
 * This maps onto the PRD's PASSTHROUGH/BUFFERING/PENDING_APPROVAL streaming
 * state machine: the fast path below is PASSTHROUGH, buffering a candidate
 * `[EXEC_REQUEST` prefix is BUFFERING, and PENDING_APPROVAL happens one level
 * up in `createHitlExecGate.check()`, once a complete block has been parsed
 * out of the (already DOM-settled) final text. The implementation is built
 * around adapter `text_delta` events and a completion-fenced DOM snapshot
 * rather than a raw outbound SSE interceptor, because ChatGPT Web has no
 * server-side SSE stream to hook — the "stream" here is scraped from the
 * page, not proxied.
 */
export function createHitlEmitFilter<TEvent extends { type: string; text?: string }>(
  realEmit: (event: TEvent) => void,
): (event: TEvent) => void {
  // Buffer the actual candidate `text_delta` events (not just their concatenated text) so a
  // flush can replay them verbatim -- including `phase` and any other fields the caller attached
  // -- instead of synthesizing a bare `{ type: "text_delta", text }` that silently drops them.
  // Dropping `phase` matters beyond cosmetics: bridge.ts closes/reopens transcript output items
  // on a phase change, so a flushed-but-rephrased event fragments the transcript.
  let bufferedEvents: TEvent[] = [];
  let buffered = "";

  const flushBuffered = (): void => {
    for (const bufferedEvent of bufferedEvents) realEmit(bufferedEvent);
    bufferedEvents = [];
    buffered = "";
  };

  return (event: TEvent) => {
    if (event.type !== "text_delta" || typeof event.text !== "string") {
      // Non-text event: flush buffered and pass through
      flushBuffered();
      realEmit(event);
      return;
    }

    const candidate = buffered + event.text;

    // Check if we have a complete, well-formed protocol block
    if (parseExecRequest(candidate) || parsePatchRequest(candidate)) {
      // Drop it entirely
      bufferedEvents = [];
      buffered = "";
      return;
    }

    // Check if we're in the middle of building a protocol block (has opening tag)
    if (BLOCK_OPENERS.some(opener => candidate.includes(opener))) {
      // Buffer to wait for closing tag
      bufferedEvents.push(event);
      buffered = candidate;
      return;
    }

    // Fast path: no brackets and no buffered content
    if (!buffered && !candidate.includes("[")) {
      realEmit(event);
      return;
    }

    // If buffered text is a strict prefix of "[EXEC_REQUEST", keep building
    if (buffered && BLOCK_OPENERS.some(opener => opener.startsWith(buffered))) {
      bufferedEvents.push(event);
      buffered = candidate;
      return;
    }

    // At this point, candidate doesn't contain [EXEC_REQUEST and either:
    // - buffered is non-empty and not a prefix of "[EXEC_REQUEST", or
    // - buffered is empty but candidate contains "["
    // In both cases, we need to emit the buffered content (if any) without duplication

    // Flush any buffered content first (it's not part of a protocol block); replaying the
    // original buffered events preserves each one's own `phase`/other fields verbatim.
    flushBuffered();

    // Now check if the new event text alone is a potential prefix of "[EXEC_REQUEST"
    if (BLOCK_OPENERS.some(opener => opener.startsWith(event.text!))) {
      // Could be starting a protocol block, buffer it
      bufferedEvents = [event];
      buffered = event.text;
    } else {
      // Not a prefix, emit the new event directly
      realEmit(event);
    }
  };
}
