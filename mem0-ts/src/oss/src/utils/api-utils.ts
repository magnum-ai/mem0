import { createClient } from "redis";
import { once } from "lodash";

const getRedisClient = once(async () => {
  // Create Redis client
  const redisClient = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });

  try {
    await redisClient.connect();
  } catch (err) {
    console.error("Redis connection error:", err);
  }

  return redisClient;
});

/**
 * Get the wait time for the call
 * @param key
 * @param distanceMs
 */
async function getWaitTime(key: string, distanceMs: number): Promise<number> {
  const script = `
     local current = redis.call('get', KEYS[1])
     local time = redis.call('time')
     local now = time[1] * 1000 + math.floor(time[2] / 1000)
    if current == false or tonumber(current) + tonumber(ARGV[1]) < now then
        redis.call('set', KEYS[1], now)
        return 0
     else
       redis.call('set', KEYS[1], tonumber(current) + tonumber(ARGV[1]))
       return tonumber(current) + tonumber(ARGV[1]) - now
     end
  `;

  try {
    const redisClient = await getRedisClient();
    const result = await redisClient.eval(script, {
      keys: [key],
      arguments: [distanceMs.toString()],
    });

    return parseInt(result as string, 10) || 0;
  } catch (error) {
    console.error("Redis eval error:", error);
    return 0;
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until rate limit reset
 * @param key
 * @param distanceMs
 */
export async function sleepUntilRateReset(
  key: string,
  distanceMs: number,
): Promise<void> {
  const waitTime = await getWaitTime(key, distanceMs);
  if (waitTime) {
    await sleep(waitTime);
  }
}
export interface RetryOptions {
  maxRetries?: number;
  delay?: number;
  backoff?: "linear" | "exponential";
}

export class RetryError extends Error {
  constructor(
    message: string,
    public readonly lastError: Error,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = "RetryError";
  }
}

/**
 * Retry utility for async operations with exponential backoff
 * Optimized for LLM API calls and JSON parsing issues
 */
export async function retryAsync<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxRetries = 3, delay = 1000, backoff = "exponential" } = options;

  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) {
        throw new RetryError(
          `Operation failed after ${attempt + 1} attempts: ${lastError.message}`,
          lastError,
          attempt + 1,
        );
      }

      // Check if error is retryable
      if (!isRetryableError(error)) {
        throw lastError;
      }

      const waitTime =
        backoff === "exponential"
          ? delay * Math.pow(2, attempt)
          : delay * (attempt + 1);

      console.warn(
        `Retry attempt ${attempt + 1}/${maxRetries} after ${waitTime}ms: ${lastError.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  throw lastError!;
}

/**
 * Check if an error should trigger a retry
 * Consolidated handling for JSON parsing and LLM-specific issues
 */
function isRetryableError(error: any): boolean {
  const message = (error?.message || "").toLowerCase();

  // Combined array of all retryable error patterns
  const retryablePatterns = [
    "invalid json response",
    "unexpected end of json",
    "unexpected token",
    "json parse",
    "rate limit",
    "server error",
    "service unavailable",
    "gateway timeout",
    "bad gateway",
    "timeout",
    "network",
    "connection",
  ];

  return retryablePatterns.some((pattern) => message.includes(pattern));
}

/**
 * Specialized retry for LLM API calls with sensible defaults
 * Handles JSON parsing issues like "invalid json response body" and "Unexpected end of JSON input"
 */
export async function retryLLM<T>(operation: () => Promise<T>): Promise<T> {
  return retryAsync(operation, {
    maxRetries: 5,
    delay: 500,
    backoff: "exponential",
  });
}
