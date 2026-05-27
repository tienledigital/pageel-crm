import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';

export const GET: APIRoute = async (context) => {
  try {
    const sessionCookie = context.cookies.get('session')?.value;
    const sessionSecret = getSessionSecret();

    if (!sessionCookie) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = await verifySessionCookie(sessionCookie, sessionSecret);
    if (!user || user.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden: Admin access required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const sepayWebhookSecret = env.SEPAY_WEBHOOK_SECRET || import.meta.env.SEPAY_WEBHOOK_SECRET;
    const sepayApiToken = env.SEPAY_API_TOKEN || import.meta.env.SEPAY_API_TOKEN;
    const githubBackupToken = env.GITHUB_BACKUP_TOKEN || import.meta.env.GITHUB_BACKUP_TOKEN;
    const githubBackupOwner = env.GITHUB_BACKUP_OWNER || import.meta.env.GITHUB_BACKUP_OWNER;
    const githubBackupRepo = env.GITHUB_BACKUP_REPO || import.meta.env.GITHUB_BACKUP_REPO;
    const githubBackupBranch = env.GITHUB_BACKUP_BRANCH || import.meta.env.GITHUB_BACKUP_BRANCH;

    return new Response(JSON.stringify({
      sepay: {
        webhookSecret: !!(sepayWebhookSecret && sepayWebhookSecret.trim() !== ''),
        apiToken: !!(sepayApiToken && sepayApiToken.trim() !== '')
      },
      github: {
        token: !!(githubBackupToken && githubBackupToken.trim() !== ''),
        owner: !!(githubBackupOwner && githubBackupOwner.trim() !== ''),
        repo: !!(githubBackupRepo && githubBackupRepo.trim() !== ''),
        branch: !!(githubBackupBranch && githubBackupBranch.trim() !== '')
      },
      session: {
        secret: (() => { try { const s = getSessionSecret(); return !!(s && s.trim() !== ''); } catch { return false; } })()
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
