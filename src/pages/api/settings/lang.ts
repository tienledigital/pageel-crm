// @para-doc [spec.md#i18n]
import type { APIContext } from 'astro';

// @para-doc [spec.md#i18n]
export async function POST(context: APIContext): Promise<Response> {
  // 1. Check authentication (reusing context.locals.user injected by middleware)
  const user = context.locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Parse body
  let body: any;
  try {
    body = await context.request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { lang } = body;

  // 3. Validate language
  if (lang !== 'vi' && lang !== 'en') {
    return new Response(JSON.stringify({ error: 'Invalid language' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 4. Set Cookie lang
  context.cookies.set('lang', lang, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1 year
    httpOnly: false,            // Allow client-side script access if needed
    sameSite: 'lax',
  });

  return new Response(JSON.stringify({ success: true, lang }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
