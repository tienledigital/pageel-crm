import type { APIContext, MiddlewareNext } from 'astro';
import { env } from 'cloudflare:workers';
import { verifySessionCookie, getSessionSecret } from './lib/auth';

// Public routes that do not require authentication
const PUBLIC_ROUTES = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/webhook/sepay',
];

export const onRequest = async (context: APIContext, next: MiddlewareNext) => {
  const { pathname } = context.url;

  // 0. Detect and set language in locals (session cookie or Accept-Language fallback)
  let lang = context.cookies.get('lang')?.value || 'vi';
  if (lang !== 'vi' && lang !== 'en') {
    lang = 'vi';
  }
  context.locals.lang = lang as 'vi' | 'en';

  // 1. Check whitelist public routes and static files (containing dot like .css, .js, .png...)
  const isPublic = PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'));
  const isStatic = pathname.includes('.') && !pathname.startsWith('/api/');

  if (isPublic || isStatic) {
    return next();
  }

  // 2. Check Authentication for remaining routes (dashboard, other APIs...)
  const sessionCookie = context.cookies.get('session')?.value;
  const secret = getSessionSecret();

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
