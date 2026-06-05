// @para-doc [plan-v0.10.0#phase-7-security-hardening]
// Security hardening tests — Phase 7 TDD
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSessionCookie,
  verifySessionCookie,
  type SessionPayload,
} from '../src/lib/auth';

// ============================================================
// 7.2 Session TTL Expiry Tests
// ============================================================
describe('Session TTL Expiry (S2)', () => {
  const SECRET = 'test-secret-key-for-session-ttl';
  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

  it('should reject session cookie older than 7 days', async () => {
    // Create a session with createdAt = 8 days ago
    const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
    const payload: SessionPayload = {
      id: 'user-1',
      username: 'admin',
      role: 'admin',
      createdAt: eightDaysAgo,
    };
    const cookie = await createSessionCookie(payload, SECRET);
    const result = await verifySessionCookie(cookie, SECRET);
    
    // Should be rejected — session expired
    expect(result).toBeNull();
  });

  it('should accept session cookie within 7 days', async () => {
    // Create a session with createdAt = 1 day ago
    const oneDayAgo = Date.now() - (1 * 24 * 60 * 60 * 1000);
    const payload: SessionPayload = {
      id: 'user-2',
      username: 'admin',
      role: 'admin',
      createdAt: oneDayAgo,
    };
    const cookie = await createSessionCookie(payload, SECRET);
    const result = await verifySessionCookie(cookie, SECRET);

    // Should be accepted — within TTL
    expect(result).not.toBeNull();
    expect(result!.username).toBe('admin');
  });

  it('should accept session cookie created just now', async () => {
    const payload: SessionPayload = {
      id: 'user-3',
      username: 'saler1',
      role: 'saler',
      createdAt: Date.now(),
    };
    const cookie = await createSessionCookie(payload, SECRET);
    const result = await verifySessionCookie(cookie, SECRET);

    expect(result).not.toBeNull();
    expect(result!.role).toBe('saler');
  });

  it('should reject session cookie at exactly 7 days + 1ms', async () => {
    const expiredAt = Date.now() - SESSION_TTL_MS - 1;
    const payload: SessionPayload = {
      id: 'user-4',
      username: 'test',
      role: 'accountant',
      createdAt: expiredAt,
    };
    const cookie = await createSessionCookie(payload, SECRET);
    const result = await verifySessionCookie(cookie, SECRET);

    expect(result).toBeNull();
  });
});

// ============================================================
// 7.1 CSRF Protection Tests
// ============================================================
describe('CSRF Origin Validation (S1)', () => {
  // Import the CSRF validation function (will be created)
  // We test the pure logic function separately from middleware
  let validateOrigin: (
    origin: string | null,
    host: string,
    pathname: string
  ) => boolean;

  beforeEach(async () => {
    // Dynamically import to get the latest version
    const mod = await import('@/lib/csrf');
    validateOrigin = mod.validateOrigin;
  });

  it('should reject POST from different origin', () => {
    const result = validateOrigin('https://evil.com', 'mycrm.example.com', '/api/crm/customers');
    expect(result).toBe(false);
  });

  it('should accept POST from same origin', () => {
    const result = validateOrigin('https://mycrm.example.com', 'mycrm.example.com', '/api/crm/customers');
    expect(result).toBe(true);
  });

  it('should accept POST with no origin header (same-origin form submit)', () => {
    // Browsers omit Origin header for same-origin navigational requests
    const result = validateOrigin(null, 'mycrm.example.com', '/api/crm/customers');
    expect(result).toBe(true);
  });

  it('should whitelist webhook endpoints regardless of origin', () => {
    const result = validateOrigin('https://api.sepay.vn', 'mycrm.example.com', '/api/webhook/sepay');
    expect(result).toBe(true);
  });

  it('should reject POST from localhost to production host', () => {
    const result = validateOrigin('http://localhost:4321', 'mycrm.example.com', '/api/crm/orders');
    expect(result).toBe(false);
  });
});

// ============================================================
// 7.3 SSRF Mitigation Tests
// ============================================================
describe('SSRF URL Validation for Restore (S3)', () => {
  let validateRestoreUrl: (url: string) => boolean;

  beforeEach(async () => {
    const mod = await import('@/lib/url-validator');
    validateRestoreUrl = mod.validateRestoreUrl;
  });

  it('should reject internal metadata URL', () => {
    expect(validateRestoreUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
  });

  it('should reject localhost URL', () => {
    expect(validateRestoreUrl('http://localhost:8787/internal')).toBe(false);
  });

  it('should reject private IP range', () => {
    expect(validateRestoreUrl('http://10.0.0.1/secrets')).toBe(false);
    expect(validateRestoreUrl('http://192.168.1.1/admin')).toBe(false);
  });

  it('should accept github.com URL', () => {
    expect(validateRestoreUrl('https://api.github.com/repos/user/repo/contents/backups/backup.json')).toBe(true);
  });

  it('should accept raw.githubusercontent.com URL', () => {
    expect(validateRestoreUrl('https://raw.githubusercontent.com/user/repo/main/backup.json')).toBe(true);
  });

  it('should reject non-HTTPS github URL', () => {
    expect(validateRestoreUrl('http://api.github.com/repos/user/repo')).toBe(false);
  });

  it('should reject arbitrary external URL', () => {
    expect(validateRestoreUrl('https://attacker.com/malicious')).toBe(false);
  });

  it('should reject FTP scheme', () => {
    expect(validateRestoreUrl('ftp://github.com/file')).toBe(false);
  });
});
