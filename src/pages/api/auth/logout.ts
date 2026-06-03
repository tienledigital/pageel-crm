// @para-doc [auth-spec.md#32-dang-xuat-post-apiauthlogout]
import type { APIRoute } from 'astro';

// @para-doc [auth-spec.md#32-dang-xuat-post-apiauthlogout]
export const POST: APIRoute = async (context) => {
  context.cookies.delete('session', {
    path: '/',
  });

  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
