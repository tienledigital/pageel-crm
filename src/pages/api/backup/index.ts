import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { exportDatabaseToJson, pushBackupToGit } from '@/lib/backup/githubClient';
import { syncLogs } from '@/lib/db/schema';
import { logDebug } from '@/lib/debug-logger';

export async function POST(context: any) {
  // 1. Verify authentication & authorization
  const user = context.locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (user.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden - Admin access required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const db = getDb(env);

  // 2. Read configuration from env (Cloudflare bindings fallback to process.env)
  const token = env.GITHUB_BACKUP_TOKEN || process.env.GITHUB_BACKUP_TOKEN;
  const owner = env.GITHUB_BACKUP_OWNER || process.env.GITHUB_BACKUP_OWNER;
  const repo = env.GITHUB_BACKUP_REPO || process.env.GITHUB_BACKUP_REPO;
  const branch = env.GITHUB_BACKUP_BRANCH || process.env.GITHUB_BACKUP_BRANCH || 'main';

  if (!token || !owner || !repo) {
    return new Response(
      JSON.stringify({ error: 'Missing GitHub backup configuration (Token, Owner, or Repo)' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    // 3. Export data and push to GitHub
    const jsonStr = await exportDatabaseToJson(db);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = `backups/backup-${timestamp}.json`;
    const commitMessage = `backup: automatic database backup at ${new Date().toISOString()}`;

    const commitSha = await pushBackupToGit({
      token,
      owner,
      repo,
      branch,
      filePath,
      content: jsonStr,
      commitMessage,
    });

    // 4. Log success in sync_logs
    await db.insert(syncLogs).values({
      id: crypto.randomUUID(),
      action: 'github_backup',
      status: 'success',
      message: `Backup pushed successfully. Commit: ${commitSha}`,
      runAt: Date.now(),
    });

    return new Response(JSON.stringify({ success: true, commitSha }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    const safeErrorMessage = sanitizeError(error);
    console.error('[Backup Error]:', safeErrorMessage);

    // Log to debug logs table
    await logDebug(db, {
      level: 'error',
      endpoint: '/api/backup',
      method: 'POST',
      statusCode: 500,
      message: safeErrorMessage,
      stack: error.stack
    });

    // 5. Log failure in sync_logs
    await db.insert(syncLogs).values({
      id: crypto.randomUUID(),
      action: 'github_backup',
      status: 'failed',
      message: safeErrorMessage,
      runAt: Date.now(),
    });

    return new Response(JSON.stringify({ success: false, error: safeErrorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function sanitizeError(error: any): string {
  if (!error) return 'Unknown error';
  let message = error.message || String(error);
  
  // Redact GitHub Classic PAT (ghp_...) and Fine-grained PAT (github_pat_...)
  message = message.replace(/ghp_[a-zA-Z0-9]{36}/g, 'ghp_***');
  message = message.replace(/github_pat_[a-zA-Z0-9_]{82}/g, 'github_pat_***');
  
  // Redact potential Bearer / Basic tokens in URLs or error details
  message = message.replace(/Authorization:\s*Bearer\s+[a-zA-Z0-9_.-]+/gi, 'Authorization: Bearer ***');
  message = message.replace(/Authorization:\s*Basic\s+[a-zA-Z0-9_./+-]+/gi, 'Authorization: Basic ***');
  
  return message;
}
