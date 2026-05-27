import type { APIContext } from 'astro';

export async function POST(context: APIContext): Promise<Response> {
  return new Response(JSON.stringify({ error: 'Not implemented' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}
