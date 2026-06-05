import { describe, it, expect, beforeAll } from 'vitest';
import { createSessionCookie } from '@/lib/auth';
import { GET as downloadQRHandler } from '@/pages/api/crm/qrcode/download';

describe('QR Code Download Proxy API Endpoint', () => {
  const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
  let adminToken: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    adminToken = await createSessionCookie({
      id: 'usr-admin-qr',
      username: 'adminqr',
      role: 'admin',
      createdAt: Date.now(),
    }, SESSION_SECRET);
  });

  function createMockContext(urlQuery?: string, token?: string) {
    const cookiesMap = new Map();
    if (token) {
      cookiesMap.set('session', { value: token });
    }
    const request = new Request(`http://localhost/api/crm/qrcode/download${urlQuery ? `?url=${encodeURIComponent(urlQuery)}` : ''}`, {
      method: 'GET',
    });
    return {
      request,
      url: new URL(request.url),
      cookies: cookiesMap,
      locals: {
        runtime: { env: { SESSION_SECRET } },
      },
    } as any;
  }

  it('should return 401 Unauthorized if user session cookie is missing', async () => {
    const context = createMockContext('https://img.vietqr.io/image/mock-qr.png');
    const response = await downloadQRHandler(context);
    expect(response.status).toBe(401);
  });

  it('should return 400 Bad Request if url query parameter is missing', async () => {
    const context = createMockContext(undefined, adminToken);
    const response = await downloadQRHandler(context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Missing url parameter');
  });

  it('should return 400 Bad Request (SSRF block) if url does not belong to img.vietqr.io', async () => {
    const context = createMockContext('https://malicious-domain.com/image.png', adminToken);
    const response = await downloadQRHandler(context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid domain. Only img.vietqr.io is allowed.');
  });

  it('should return 400 Bad Request (SSRF block) even if URL contains vietqr.io in subdomain/path but isn\'t img.vietqr.io', async () => {
    const context = createMockContext('https://img.vietqr.io.malicious.com/image.png', adminToken);
    const response = await downloadQRHandler(context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid domain. Only img.vietqr.io is allowed.');
  });
});
