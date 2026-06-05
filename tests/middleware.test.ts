import { describe, it, expect, vi } from 'vitest';
import { onRequest } from '@/middleware';
import { createSessionCookie } from '@/lib/auth';

const SESSION_SECRET = 'test-secret-key-must-be-long-enough-32-chars';
process.env.SESSION_SECRET = SESSION_SECRET;

describe('Astro Middleware - Authentication & RBAC', () => {
  const validPayload = {
    id: 'user-uuid-1111',
    username: 'testadmin',
    role: 'admin',
    createdAt: Date.now()
  };

  it('should redirect unauthorized request to /login when accessing /dashboard', async () => {
    let redirectUrl = '';
    const mockContext: any = {
      url: new URL('http://localhost/dashboard'),
      request: new Request('http://localhost/dashboard'),
      cookies: {
        get: () => null
      },
      locals: { runtime: { env: { SESSION_SECRET } } },
      redirect: (url: string) => {
        redirectUrl = url;
        return new Response(null, { status: 302 });
      }
    };

    const nextCalled = vi.fn();
    const response = await onRequest(mockContext, nextCalled);

    expect(response.status).toBe(302);
    expect(redirectUrl).toBe('/login');
    expect(nextCalled).not.toHaveBeenCalled();
  });

  it('should return 401 for unauthorized API request to /api/customers', async () => {
    const mockContext: any = {
      url: new URL('http://localhost/api/customers'),
      request: new Request('http://localhost/api/customers'),
      cookies: {
        get: () => null
      },
      locals: { runtime: { env: { SESSION_SECRET } } }
    };

    const nextCalled = vi.fn();
    const response = await onRequest(mockContext, nextCalled);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
    expect(nextCalled).not.toHaveBeenCalled();
  });

  it('should pass through to next() when accessing public endpoints', async () => {
    const mockContext: any = {
      url: new URL('http://localhost/api/auth/login'),
      request: new Request('http://localhost/api/auth/login'),
      cookies: {
        get: () => null
      },
      locals: { runtime: { env: { SESSION_SECRET } } }
    };

    const nextResponse = new Response('ok');
    const nextCalled = vi.fn().mockResolvedValue(nextResponse);

    const response = await onRequest(mockContext, nextCalled);

    expect(response.status).toBe(200);
    expect(nextCalled).toHaveBeenCalled();
    // Security headers should be injected
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('should allow access and inject user payload to locals when session is valid', async () => {
    const cookieValue = await createSessionCookie(validPayload, SESSION_SECRET);

    const mockContext: any = {
      url: new URL('http://localhost/dashboard'),
      request: new Request('http://localhost/dashboard'),
      cookies: {
        get: (name: string) => {
          if (name === 'session') return { value: cookieValue };
          return null;
        }
      },
      locals: { runtime: { env: { SESSION_SECRET } } }
    };

    const nextResponse = new Response('ok');
    const nextCalled = vi.fn().mockResolvedValue(nextResponse);

    const response = await onRequest(mockContext, nextCalled);

    expect(response.status).toBe(200);
    expect(nextCalled).toHaveBeenCalled();
    expect(mockContext.locals.user).toBeDefined();
    expect(mockContext.locals.user.username).toBe(validPayload.username);
    // Security headers should be injected
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  describe('Role-based Access Control (RBAC) Gates', () => {
    it('should redirect Saler trying to access /crm/customers to /crm/qr-tool', async () => {
      const salerPayload = { id: 'usr-saler', username: 'saler', role: 'saler', createdAt: Date.now() };
      const cookieValue = await createSessionCookie(salerPayload, SESSION_SECRET);
      let redirectUrl = '';

      const mockContext: any = {
        url: new URL('http://localhost/crm/customers'),
        request: new Request('http://localhost/crm/customers'),
        cookies: {
          get: (name: string) => name === 'session' ? { value: cookieValue } : null
        },
        locals: { runtime: { env: { SESSION_SECRET } } },
        redirect: (url: string) => {
          redirectUrl = url;
          return new Response(null, { status: 302 });
        }
      };

      const nextCalled = vi.fn();
      const response = await onRequest(mockContext, nextCalled);

      expect(response.status).toBe(302);
      expect(redirectUrl).toBe('/crm/qr-tool');
      expect(nextCalled).not.toHaveBeenCalled();
    });

    it('should allow Saler to access /crm/qr-tool', async () => {
      const salerPayload = { id: 'usr-saler', username: 'saler', role: 'saler', createdAt: Date.now() };
      const cookieValue = await createSessionCookie(salerPayload, SESSION_SECRET);

      const mockContext: any = {
        url: new URL('http://localhost/crm/qr-tool'),
        request: new Request('http://localhost/crm/qr-tool'),
        cookies: {
          get: (name: string) => name === 'session' ? { value: cookieValue } : null
        },
        locals: { runtime: { env: { SESSION_SECRET } } }
      };

      const nextResponse = new Response('ok');
      const nextCalled = vi.fn().mockResolvedValue(nextResponse);
      const response = await onRequest(mockContext, nextCalled);

      expect(response.status).toBe(200);
      expect(nextCalled).toHaveBeenCalled();
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('should return 403 for Saler trying to access non-customer CRM APIs', async () => {
      const salerPayload = { id: 'usr-saler', username: 'saler', role: 'saler', createdAt: Date.now() };
      const cookieValue = await createSessionCookie(salerPayload, SESSION_SECRET);

      const mockContext: any = {
        url: new URL('http://localhost/api/crm/invoices'),
        request: new Request('http://localhost/api/crm/invoices'),
        cookies: {
          get: (name: string) => name === 'session' ? { value: cookieValue } : null
        },
        locals: { runtime: { env: { SESSION_SECRET } } }
      };

      const nextCalled = vi.fn();
      const response = await onRequest(mockContext, nextCalled);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe('Forbidden');
      expect(nextCalled).not.toHaveBeenCalled();
    });

    it('should allow Saler to access GET or PUT /api/crm/customers API', async () => {
      const salerPayload = { id: 'usr-saler', username: 'saler', role: 'saler', createdAt: Date.now() };
      const cookieValue = await createSessionCookie(salerPayload, SESSION_SECRET);

      const mockContext: any = {
        url: new URL('http://localhost/api/crm/customers/1005'),
        request: new Request('http://localhost/api/crm/customers/1005', { method: 'PUT' }),
        cookies: {
          get: (name: string) => name === 'session' ? { value: cookieValue } : null
        },
        locals: { runtime: { env: { SESSION_SECRET } } }
      };

      const nextResponse = new Response('ok');
      const nextCalled = vi.fn().mockResolvedValue(nextResponse);
      const response = await onRequest(mockContext, nextCalled);

      expect(response.status).toBe(200);
      expect(nextCalled).toHaveBeenCalled();
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('should redirect Accountant trying to access /crm/settings to /crm/customers', async () => {
      const accountantPayload = { id: 'usr-acc', username: 'accountant', role: 'accountant', createdAt: Date.now() };
      const cookieValue = await createSessionCookie(accountantPayload, SESSION_SECRET);
      let redirectUrl = '';

      const mockContext: any = {
        url: new URL('http://localhost/crm/settings'),
        request: new Request('http://localhost/crm/settings'),
        cookies: {
          get: (name: string) => name === 'session' ? { value: cookieValue } : null
        },
        locals: { runtime: { env: { SESSION_SECRET } } },
        redirect: (url: string) => {
          redirectUrl = url;
          return new Response(null, { status: 302 });
        }
      };

      const nextCalled = vi.fn();
      const response = await onRequest(mockContext, nextCalled);

      expect(response.status).toBe(302);
      expect(redirectUrl).toBe('/crm/customers');
      expect(nextCalled).not.toHaveBeenCalled();
    });

    it('should return 403 for Accountant trying to access /api/crm/settings', async () => {
      const accountantPayload = { id: 'usr-acc', username: 'accountant', role: 'accountant', createdAt: Date.now() };
      const cookieValue = await createSessionCookie(accountantPayload, SESSION_SECRET);

      const mockContext: any = {
        url: new URL('http://localhost/api/crm/settings'),
        request: new Request('http://localhost/api/crm/settings'),
        cookies: {
          get: (name: string) => name === 'session' ? { value: cookieValue } : null
        },
        locals: { runtime: { env: { SESSION_SECRET } } }
      };

      const nextCalled = vi.fn();
      const response = await onRequest(mockContext, nextCalled);

      expect(response.status).toBe(403);
      expect(nextCalled).not.toHaveBeenCalled();
    });

    it('should allow Admin to access /crm/settings and settings APIs', async () => {
      const adminPayload = { id: 'usr-admin', username: 'admin', role: 'admin', createdAt: Date.now() };
      const cookieValue = await createSessionCookie(adminPayload, SESSION_SECRET);

      const mockContext: any = {
        url: new URL('http://localhost/crm/settings'),
        request: new Request('http://localhost/crm/settings'),
        cookies: {
          get: (name: string) => name === 'session' ? { value: cookieValue } : null
        },
        locals: { runtime: { env: { SESSION_SECRET } } }
      };

      const nextResponse = new Response('ok');
      const nextCalled = vi.fn().mockResolvedValue(nextResponse);
      const response = await onRequest(mockContext, nextCalled);

      expect(response.status).toBe(200);
      expect(nextCalled).toHaveBeenCalled();
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });
  });
});
