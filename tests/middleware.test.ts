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

    expect(response).toBe(nextResponse);
    expect(nextCalled).toHaveBeenCalled();
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

    expect(response).toBe(nextResponse);
    expect(nextCalled).toHaveBeenCalled();
    expect(mockContext.locals.user).toBeDefined();
    expect(mockContext.locals.user.username).toBe(validPayload.username);
  });
});
