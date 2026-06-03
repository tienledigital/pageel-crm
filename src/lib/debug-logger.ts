// @para-doc [administration-guide.md#system-logs]
import { debugLogs } from '@/lib/db/schema';

// @para-doc [administration-guide.md#system-logs]
export interface DebugLogPayload {
  level?: 'error' | 'warn' | 'info' | 'debug';
  endpoint?: string | null;
  method?: string | null;
  statusCode?: number | null;
  message: string;
  stack?: string | null;
  requestBody?: any;
}

/**
 * Sanitizes request payload by removing sensitive credentials recursively
 */
// @para-doc [administration-guide.md#debug-logs]
function sanitizeRequestBody(body: any): any {
  if (!body) return body;
  if (typeof body !== 'object') return body;

  if (Array.isArray(body)) {
    return body.map(item => sanitizeRequestBody(item));
  }

  const sanitized: any = {};
  const sensitiveKeys = /password|token|secret|key|currentPassword|newPassword/i;

  for (const k of Object.keys(body)) {
    const val = body[k];
    if (sensitiveKeys.test(k)) {
      sanitized[k] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      sanitized[k] = sanitizeRequestBody(val);
    } else {
      sanitized[k] = val;
    }
  }
  return sanitized;
}

/**
 * Scrubs tokens, keys, and authorization headers from error messages and stack traces
 */
// @para-doc [administration-guide.md#debug-logs]
function scrubSensitiveText(text: string | null | undefined): string | null {
  if (!text) return null;

  let cleaned = text;

  // Mask Auth headers (e.g. Bearer xyz)
  cleaned = cleaned.replace(/(bearer\s+)[a-zA-Z0-9_\-\.\:\+]+/ig, '$1[REDACTED]');
  cleaned = cleaned.replace(/(authorization\s*:\s*)[a-zA-Z0-9_\-\.\:\+]+/ig, '$1[REDACTED]');

  // Mask URL query params like ?token=xyz or &key=abc
  cleaned = cleaned.replace(/([\?&](?:token|password|secret|key|api_key|sepay_token|github_token)=)[^&\s]+/ig, '$1[REDACTED]');

  return cleaned;
}

/**
 * Logs a debugging event or exception to the database
 */
// @para-doc [administration-guide.md#debug-logs]
export async function logDebug(
  db: any,
  payload: DebugLogPayload
): Promise<void> {
  try {
    const id = crypto.randomUUID();
    const sanitizedBody = payload.requestBody ? sanitizeRequestBody(payload.requestBody) : null;
    const bodyString = sanitizedBody ? JSON.stringify(sanitizedBody) : null;

    const message = scrubSensitiveText(payload.message) || 'Unknown Error';
    const stack = scrubSensitiveText(payload.stack);

    await db.insert(debugLogs).values({
      id,
      level: payload.level || 'error',
      endpoint: payload.endpoint || null,
      method: payload.method || null,
      statusCode: payload.statusCode || null,
      message,
      stack,
      requestBody: bodyString,
      createdAt: Date.now()
    });
  } catch (err: any) {
    // Fail-safe: print to stderr to avoid blocking main execution
    console.error('[logDebug Failed]:', err.message);
  }
}
