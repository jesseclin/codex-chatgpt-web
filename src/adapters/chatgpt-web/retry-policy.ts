import { ChatGptWebAdapterError } from "./adapter-error";

/** Maximum number of automatic browser-turn retries after the initial send. */
export const MAX_CHATGPT_WEB_TURN_RETRIES = 3;
const RETRY_BUDGET_TTL_MS = 30 * 60_000;

/** Bounded exponential backoff: doubles per retry, capped so a stuck browser can't be hammered. */
export const RETRY_BACKOFF_BASE_MS = 2_000;
export const RETRY_BACKOFF_MAX_MS = 16_000;

export function computeRetryBackoffMs(retries: number): number {
  return Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, retries - 1));
}

export type RetryBackoffSleep = (ms: number) => Promise<void>;

const defaultSleep: RetryBackoffSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

interface RetryBudgetEntry {
  retries: number;
  updatedAt: number;
  lastError: {
    message: string;
    status: number;
    errorType: string;
    code: string;
  };
}

function exhaustedError(entry: RetryBudgetEntry): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `${entry.lastError.message} ChatGPT remained unavailable after several attempts.`,
    {
      status: entry.lastError.status,
      errorType: entry.lastError.errorType,
      code: entry.lastError.code,
      retryable: false,
    },
  );
}

/**
 * Tracks only retryable ChatGPT browser failures across adapter instances. The HTTP bridge creates
 * one adapter per request, so this process-local budget must live outside createChatGptWebAdapter.
 */
export class ChatGptWebTurnRetryPolicy {
  private readonly entries = new Map<string, RetryBudgetEntry>();

  constructor(
    private readonly ttlMs = RETRY_BUDGET_TTL_MS,
    private sleep: RetryBackoffSleep = defaultSleep,
  ) {}

  async recordRetryableFailure(
    key: string,
    error: ChatGptWebAdapterError,
    now = Date.now(),
  ): Promise<ChatGptWebAdapterError> {
    this.prune(now);
    const previous = this.entries.get(key);
    const entry: RetryBudgetEntry = {
      retries: (previous?.retries ?? 0) + 1,
      updatedAt: now,
      lastError: {
        message: error.message,
        status: error.status,
        errorType: error.errorType,
        code: error.code,
      },
    };
    this.entries.set(key, entry);
    if (entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES) return exhaustedError(entry);
    // Bounded backoff before handing the retryable failure back: throttles how fast a client
    // that retries immediately on `retryable: true` can hammer a browser turn that just stalled.
    await this.sleep(computeRetryBackoffMs(entry.retries));
    return error;
  }

  /** Test-only seam: skip real delays without touching the retry budget itself. */
  setSleepForTesting(sleep: RetryBackoffSleep): void {
    this.sleep = sleep;
  }

  exhaustedError(key: string, now = Date.now()): ChatGptWebAdapterError | undefined {
    this.prune(now);
    const entry = this.entries.get(key);
    return entry && entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry) : undefined;
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt >= this.ttlMs) this.entries.delete(key);
    }
  }
}

export const chatGptWebTurnRetryPolicy = new ChatGptWebTurnRetryPolicy();
