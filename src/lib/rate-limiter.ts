// @para-doc [auth-spec.md#42-gioi-han-tan-suat-dang-nhap-bang-kv-kv-based-rate-limiting]
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

// @para-doc [auth-spec.md#42-gioi-han-tan-suat-dang-nhap-bang-kv-kv-based-rate-limiting]
// @para-doc [infrastructure.md#23-cloudflare-kv-gioi-han-tan-suat-dang-nhap]
export async function checkRateLimit(
  kv: any,
  ip: string,
  endpoint: string,
  maxAttempts: number = 5,
  windowSeconds: number = 900
): Promise<RateLimitResult> {
  if (!kv) {
    // Fail-open: If KV namespace is not bound or missing, skip rate limiting
    return { allowed: true, remaining: maxAttempts };
  }

  const key = `rl:${ip}:${endpoint}`;

  try {
    const recordStr = await kv.get(key);
    const now = Math.floor(Date.now() / 1000);

    if (recordStr) {
      const record = JSON.parse(recordStr) as { count: number; firstAttempt: number };
      
      // If window has expired, reset the window
      if (now - record.firstAttempt > windowSeconds) {
        const newRecord = { count: 1, firstAttempt: now };
        await kv.put(key, JSON.stringify(newRecord), { expirationTtl: windowSeconds });
        return { allowed: true, remaining: maxAttempts - 1 };
      }

      // If count exceeds maxAttempts, block the request
      if (record.count >= maxAttempts) {
        const retryAfter = windowSeconds - (now - record.firstAttempt);
        return { 
          allowed: false, 
          remaining: 0, 
          retryAfterSeconds: retryAfter > 0 ? retryAfter : 1 
        };
      }

      // Otherwise increment count
      const updatedRecord = { count: record.count + 1, firstAttempt: record.firstAttempt };
      // Expire KV key exactly at the end of the sliding window
      const remainingTime = windowSeconds - (now - record.firstAttempt);
      await kv.put(key, JSON.stringify(updatedRecord), { 
        expirationTtl: remainingTime > 60 ? remainingTime : 60 
      });
      
      return { allowed: true, remaining: maxAttempts - updatedRecord.count };
    } else {
      // First attempt
      const newRecord = { count: 1, firstAttempt: now };
      await kv.put(key, JSON.stringify(newRecord), { expirationTtl: windowSeconds });
      return { allowed: true, remaining: maxAttempts - 1 };
    }
  } catch (err) {
    // Fail-closed on KV errors — block requests when rate limiter is unavailable
    // to prevent brute-force attacks when KV is down
    console.error('[Rate Limiter Error] KV operation failed, blocking request:', err);
    return { allowed: false, remaining: 0, retryAfterSeconds: 60 };
  }
}
