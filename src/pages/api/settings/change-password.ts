import type { APIRoute } from 'astro';

export const POST: APIRoute = async () => {
  return new Response(JSON.stringify({ error: 'Not Implemented' }), {
    status: 501,
    headers: { 'Content-Type': 'application/json' }
  });
};
