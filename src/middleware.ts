// @para-doc [auth-spec.md#session-cookie]
import type { APIContext, MiddlewareNext } from 'astro';
import { env } from 'cloudflare:workers';
import { verifySessionCookie, getSessionSecret } from './lib/auth';
import { validateOrigin } from './lib/csrf';

// Mutation methods that require CSRF validation
const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Public routes that do not require authentication
const PUBLIC_ROUTES = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/webhook/sepay',
];

// @para-doc [auth-spec.md#quy-trinh-ky-va-xac-thuc-hmac-signature-flow]
export const onRequest = async (context: APIContext, next: MiddlewareNext) => {
  const { pathname } = context.url;

  // 0. Detect and set language in locals (session cookie or Accept-Language fallback)
  let lang = context.cookies.get('lang')?.value || 'vi';
  if (lang !== 'vi' && lang !== 'en') {
    lang = 'vi';
  }
  context.locals.lang = lang as 'vi' | 'en';

  // 0.5 CSRF Protection — validate Origin header for mutation requests
  if (MUTATION_METHODS.includes(context.request.method)) {
    const origin = context.request.headers.get('Origin');
    const host = context.url.host;
    if (!validateOrigin(origin, host, pathname)) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: CSRF validation failed' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // 1. Check whitelist public routes and static files (containing dot like .css, .js, .png...)
  const isPublic = PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'));
  const isStatic = pathname.includes('.') && !pathname.startsWith('/api/');

  if (isPublic || isStatic) {
    return addSecurityHeaders(await next());
  }

  // 2. Check Authentication for remaining routes (dashboard, other APIs...)
  const sessionCookie = context.cookies.get('session')?.value;
  const secret = getSessionSecret();

  if (sessionCookie) {
    const decoded = await verifySessionCookie(sessionCookie, secret);
    if (decoded) {
      // Inject user payload into locals for downstream components reuse
      context.locals.user = decoded;

      const role = decoded.role;
      // Saler restrictions
      if (role === 'saler') {
        if ((pathname.startsWith('/crm/') && pathname !== '/crm/qr-tool') || pathname === '/dashboard') {
          return context.redirect('/crm/qr-tool');
        }
        if (pathname.startsWith('/api/crm/') && !pathname.startsWith('/api/crm/customers')) {
          return new Response(
            JSON.stringify({ error: 'Forbidden' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      // Accountant restrictions
      if (role === 'accountant') {
        if (pathname === '/crm/settings' || pathname.startsWith('/crm/settings/')) {
          return context.redirect('/crm/customers');
        }
        if (pathname.startsWith('/api/crm/settings')) {
          return new Response(
            JSON.stringify({ error: 'Forbidden' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      return addSecurityHeaders(await next());
    }
  }

  // 3. If not authenticated, redirect to login or return 401 for APIs
  if (pathname.startsWith('/api/')) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return context.redirect('/login');
};

// Security response headers — applied to all successful responses
// Mutate headers directly to avoid miniflare ReadableStream piping issues
// (creating new Response(response.body) causes "Promise will never complete" in Workers dev)
function addSecurityHeaders(response: Response): Response {
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'"
  );
  // HSTS only in production
  if (import.meta.env.PROD) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return response;
}

