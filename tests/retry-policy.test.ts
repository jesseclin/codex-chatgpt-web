import { describe, expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  ChatGptWebTurnRetryPolicy,
  computeRetryBackoffMs,
  MAX_CHATGPT_WEB_TURN_RETRIES,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
} from "../src/adapters/chatgpt-web/retry-policy";

function retryableError(message = "stream disconnected"): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 502,
    errorType: "server_error",
    code: "chatgpt_submitted_turn_failed",
    retryable: true,
  });
}

describe("computeRetryBackoffMs", () => {
  test("doubles from the base delay on each successive retry", () => {
    expect(computeRetryBackoffMs(1)).toBe(RETRY_BACKOFF_BASE_MS);
    expect(computeRetryBackoffMs(2)).toBe(RETRY_BACKOFF_BASE_MS * 2);
    expect(computeRetryBackoffMs(3)).toBe(RETRY_BACKOFF_BASE_MS * 4);
  });

  test("never exceeds the bounded maximum", () => {
    expect(computeRetryBackoffMs(10)).toBe(RETRY_BACKOFF_MAX_MS);
  });
});

describe("ChatGptWebTurnRetryPolicy backoff", () => {
  test("waits with bounded, increasing backoff before returning each retryable failure", async () => {
    const waited: number[] = [];
    const policy = new ChatGptWebTurnRetryPolicy(30 * 60_000, ms => {
      waited.push(ms);
      return Promise.resolve();
    });

    const first = await policy.recordRetryableFailure("k", retryableError());
    const second = await policy.recordRetryableFailure("k", retryableError());
    const third = await policy.recordRetryableFailure("k", retryableError());

    expect(first.retryable).toBeTrue();
    expect(second.retryable).toBeTrue();
    expect(third.retryable).toBeTrue();
    expect(waited).toEqual([RETRY_BACKOFF_BASE_MS, RETRY_BACKOFF_BASE_MS * 2, RETRY_BACKOFF_BASE_MS * 4]);
  });

  test("does not wait once the retry budget is exhausted", async () => {
    const waited: number[] = [];
    const policy = new ChatGptWebTurnRetryPolicy(30 * 60_000, ms => {
      waited.push(ms);
      return Promise.resolve();
    });

    for (let attempt = 0; attempt < MAX_CHATGPT_WEB_TURN_RETRIES; attempt += 1) {
      await policy.recordRetryableFailure("k", retryableError());
    }
    waited.length = 0;

    const exhausted = await policy.recordRetryableFailure("k", retryableError());

    expect(exhausted.retryable).toBeFalse();
    expect(exhausted.message).toContain("ChatGPT remained unavailable after several attempts.");
    expect(waited).toEqual([]);
  });

  test("clear resets the backoff schedule for a key", async () => {
    const waited: number[] = [];
    const policy = new ChatGptWebTurnRetryPolicy(30 * 60_000, ms => {
      waited.push(ms);
      return Promise.resolve();
    });

    await policy.recordRetryableFailure("k", retryableError());
    await policy.recordRetryableFailure("k", retryableError());
    policy.clear("k");
    waited.length = 0;

    await policy.recordRetryableFailure("k", retryableError());

    expect(waited).toEqual([RETRY_BACKOFF_BASE_MS]);
  });
});
