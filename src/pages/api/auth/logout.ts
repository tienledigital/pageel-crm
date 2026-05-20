import type { APIRoute } from 'astro';

export const POST: APIRoute = async (context) => {
  context.cookies.delete('session', {
    path: '/',
  });

  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
