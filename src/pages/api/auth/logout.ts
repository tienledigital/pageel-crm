// @para-doc [#csa-auth-logout]
import type { APIRoute } from 'astro';

// @para-doc [#csa-auth-logout]
export const POST: APIRoute = async (context) => {
  context.cookies.delete('session', {
    path: '/',
  });

  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
