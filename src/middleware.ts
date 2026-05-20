import type { APIContext, MiddlewareNext } from 'astro';
import { env } from 'cloudflare:workers';
import { verifySessionCookie } from './lib/auth';

// Public routes that do not require authentication
const PUBLIC_ROUTES = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/webhook/sepay',
];

export const onRequest = async (context: APIContext, next: MiddlewareNext) => {
  const { pathname } = context.url;

  // 1. Check whitelist public routes and static files (containing dot like .css, .js, .png...)
  const isPublic = PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'));
  const isStatic = pathname.includes('.') && !pathname.startsWith('/api/');

  if (isPublic || isStatic) {
    return next();
  }

  // 2. Check Authentication for remaining routes (dashboard, other APIs...)
  const sessionCookie = context.cookies.get('session')?.value;
  const secret = env?.SESSION_SECRET || import.meta.env.SESSION_SECRET || 'fallback-secret-key-must-be-at-least-32-chars-long';

  if (sessionCookie) {
    const decoded = await verifySessionCookie(sessionCookie, secret);
    if (decoded) {
      // Inject user payload into locals for downstream components reuse
      context.locals.user = decoded;
      return next();
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
