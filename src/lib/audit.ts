import { auditLogs } from '@/lib/db/schema';

export interface AuditLogPayload {
  userId?: string | null;
  username?: string | null;
  action: string;
  target?: string | null;
  detail?: {
    oldValue?: any;
    newValue?: any;
    metadata?: any;
  } | null;
  ipAddress?: string | null;
}

/**
 * Redacts sensitive fields (passwords, secrets, tokens) recursively in JSON objects
 */
function redactSensitive(data: any): any {
  if (!data) return data;
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map(item => redactSensitive(item));
  }

  const redacted: any = {};
  const sensitiveKeysRegex = /password|token|secret|key|currentPassword|newPassword/i;

  for (const k of Object.keys(data)) {
    const val = data[k];
    if (sensitiveKeysRegex.test(k)) {
      redacted[k] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      redacted[k] = redactSensitive(val);
    } else {
      redacted[k] = val;
    }
  }
  return redacted;
}

/**
 * Inserts a new audit log record into the database
 */
export async function logAudit(
  db: any,
  payload: AuditLogPayload
): Promise<void> {
  try {
    const id = crypto.randomUUID();
    const sanitizedDetail = payload.detail ? redactSensitive(payload.detail) : null;
    const detailString = sanitizedDetail ? JSON.stringify(sanitizedDetail) : null;

    await db.insert(auditLogs).values({
      id,
      userId: payload.userId || null,
      username: payload.username || null,
      action: payload.action,
      target: payload.target || null,
      detail: detailString,
      ipAddress: payload.ipAddress || null,
      createdAt: Date.now()
    });
  } catch (err: any) {
    // Fail-safe: log to console to prevent blocking the main process if DB log fails
    console.error('[logAudit Failed]:', err.message);
  }
}
