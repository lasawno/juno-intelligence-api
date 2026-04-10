/**
 * GitHub API Rate Limit Manager — Juno Intelligence Core side
 *
 * Tracks X-RateLimit-* headers from every GitHub response,
 * enforces exponential backoff on 429/403, and queues requests
 * when remaining quota drops below the safety threshold.
 *
 * Token strategy:
 *   GITHUB_TOKEN_JUNOTALK — dedicated token for JunoTalk lightweight reads
 *   GITHUB_TOKEN            — shared fallback (used only if above is unset)
 *
 * The Intelligence Core uses its own separate token to keep
 * quotas completely independent.
 */

const SAFETY_THRESHOLD = 10;
const MAX_BACKOFF_MS = 32_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_QUEUE_SIZE = 50;

interface RateLimitState {
  remaining: number;
  limit: number;
  resetAt: number;
  lastUpdated: number;
}

interface QueuedRequest {
  fn: () => Promise<Response>;
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
}

const state: RateLimitState = {
  remaining: 60,
  limit: 60,
  resetAt: 0,
  lastUpdated: 0,
};

const queue: QueuedRequest[] = [];
let draining = false;

export function getCoreToken(): string {
  return (
    process.env.GITHUB_TOKEN_CORE ||
    process.env.GITHUB_TOKEN ||
    ""
  );
}

function updateStateFromHeaders(headers: Headers): void {
  const remaining = headers.get("x-ratelimit-remaining");
  const limit = headers.get("x-ratelimit-limit");
  const reset = headers.get("x-ratelimit-reset");

  if (remaining !== null) state.remaining = parseInt(remaining, 10);
  if (limit !== null) state.limit = parseInt(limit, 10);
  if (reset !== null) state.resetAt = parseInt(reset, 10) * 1000;
  state.lastUpdated = Date.now();
}

function msUntilReset(): number {
  const ms = state.resetAt - Date.now();
  return ms > 0 ? ms : 0;
}

async function backoff(attempt: number): Promise<void> {
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = Math.random() * 500;
  await new Promise((r) => setTimeout(r, delay + jitter));
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;

  while (queue.length > 0) {
    if (state.remaining <= SAFETY_THRESHOLD && state.resetAt > Date.now()) {
      const wait = msUntilReset() + 500;
      console.warn(
        `[CoreRateLimiter] Quota low (${state.remaining} remaining). Pausing queue for ${Math.round(wait / 1000)}s.`
      );
      await new Promise((r) => setTimeout(r, wait));
    }

    const item = queue.shift();
    if (!item) break;

    try {
      const resp = await item.fn();
      item.resolve(resp);
    } catch (err) {
      item.reject(err);
    }
  }

  draining = false;
}

/**
 * Wraps a GitHub fetch call with rate limit awareness.
 * Automatically tracks headers, backs off on 429/403, and queues
 * when quota is low.
 */
export async function githubFetch(
  url: string,
  init: RequestInit = {},
  maxAttempts = 4
): Promise<Response> {
  const token = getCoreToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    ...(init.headers as Record<string, string> || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const doFetch = () =>
    fetch(url, { ...init, headers });

  if (state.remaining <= SAFETY_THRESHOLD && state.resetAt > Date.now()) {
    return new Promise<Response>((resolve, reject) => {
      if (queue.length >= MAX_QUEUE_SIZE) {
        return reject(new Error("GitHub request queue full — rate limit exhausted"));
      }
      queue.push({ fn: doFetch, resolve, reject });
      drainQueue();
    });
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await doFetch();
      updateStateFromHeaders(resp.headers);

      if (resp.status === 429 || resp.status === 403) {
        const retryAfter = resp.headers.get("retry-after");
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : msUntilReset() || BASE_BACKOFF_MS * 2 ** attempt;

        console.warn(
          `[CoreRateLimiter] ${resp.status} on attempt ${attempt + 1}. Waiting ${Math.round(waitMs / 1000)}s.`
        );
        await new Promise((r) => setTimeout(r, waitMs + 500));
        continue;
      }

      return resp;
    } catch (err) {
      lastError = err;
      await backoff(attempt);
    }
  }

  throw lastError ?? new Error("GitHub fetch failed after max attempts");
}

export function getRateLimitStatus() {
  return {
    remaining: state.remaining,
    limit: state.limit,
    resetAt: state.resetAt,
    resetIn: `${Math.round(msUntilReset() / 1000)}s`,
    queueDepth: queue.length,
    token: getCoreToken() ? "GITHUB_TOKEN_CORE" : "GITHUB_TOKEN (shared fallback)",
  };
}
