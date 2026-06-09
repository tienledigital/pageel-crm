// @para-doc [spec.md#automated-revenue-reconciliation]
import type { APIRoute } from 'astro';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';

// @para-doc [spec.md#automated-revenue-reconciliation]
export const GET: APIRoute = async (context) => {
  try {
    // 1. Verify user session
    const sessionCookie = context.cookies.get('session')?.value;
    const secret = getSessionSecret();
    
    if (!sessionCookie) {
      return new Response(JSON.stringify({ error: 'Unauthorized: No session cookie' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const user = await verifySessionCookie(sessionCookie, secret);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Forbidden: Invalid session' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Parse and validate the URL query parameter
    const urlParam = context.url.searchParams.get('url');
    if (!urlParam) {
      return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. SSRF Protection: Ensure domain is img.vietqr.io
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlParam);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid URL format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (parsedUrl.hostname !== 'img.vietqr.io') {
      return new Response(JSON.stringify({ error: 'Invalid domain. Only img.vietqr.io is allowed.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4. Fetch the image from VietQR and stream back to client
    const targetResponse = await fetch(urlParam);
    if (!targetResponse.ok) {
      return new Response(JSON.stringify({ error: 'Failed to fetch image from VietQR' }), {
        status: targetResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const contentType = targetResponse.headers.get('content-type') || 'image/png';
    const imageBuffer = await targetResponse.arrayBuffer();

    return new Response(imageBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'attachment; filename="qrcode.png"',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
