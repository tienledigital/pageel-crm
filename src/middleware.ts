import type { APIContext, MiddlewareNext } from 'astro';
import { env } from 'cloudflare:workers';
import { verifySessionCookie } from './lib/auth';

// Các route không yêu cầu đăng nhập
const PUBLIC_ROUTES = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/webhook/sepay',
];

export const onRequest = async (context: APIContext, next: MiddlewareNext) => {
  const { pathname } = context.url;

  // 1. Kiểm tra whitelist public routes và các static files (chứa dấu chấm như .css, .js, .png...)
  const isPublic = PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'));
  const isStatic = pathname.includes('.') && !pathname.startsWith('/api/');

  if (isPublic || isStatic) {
    return next();
  }

  // 2. Kiểm tra Authentication cho các route còn lại (dashboard, các api khác...)
  const sessionCookie = context.cookies.get('session')?.value;
  const secret = env?.SESSION_SECRET || import.meta.env.SESSION_SECRET || 'fallback-secret-key-must-be-at-least-32-chars-long';

  if (sessionCookie) {
    const decoded = await verifySessionCookie(sessionCookie, secret);
    if (decoded) {
      // Inject user payload vào locals để các components phía sau tái sử dụng
      context.locals.user = decoded;
      return next();
    }
  }

  // 3. Nếu không được xác thực, phân loại để redirect hoặc trả về 401
  if (pathname.startsWith('/api/')) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return context.redirect('/login');
};
