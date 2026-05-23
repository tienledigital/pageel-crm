import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { config } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { verifySessionCookie } from '@/lib/auth';
import { applyRulesToExistingPayments } from '@/lib/reconciliation';

export const GET: APIRoute = async (context) => {
  try {
    const db = getDb(env);
    const rulesRecord = await db.select().from(config).where(eq(config.key, 'payment_classification_rules')).limit(1);
    const rules = rulesRecord.length > 0 ? JSON.parse(rulesRecord[0].value) : [];

    return new Response(JSON.stringify({ success: true, rules }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', details: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async (context) => {
  try {
    // 1. Verify user session and permissions
    const sessionCookie = context.cookies.get('session')?.value;
    const secret = env?.SESSION_SECRET || import.meta.env.SESSION_SECRET || 'fallback-secret-key-must-be-at-least-32-chars-long';
    
    if (!sessionCookie) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const user = await verifySessionCookie(sessionCookie, secret);
    if (!user || (user.role !== 'admin' && user.role !== 'accountant')) {
      return new Response(JSON.stringify({ error: 'Forbidden: Insufficient permissions' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await context.request.json();
    const { rules } = body;

    if (!Array.isArray(rules)) {
      return new Response(JSON.stringify({ error: 'Rules must be an array' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate rules
    for (const rule of rules) {
      const isKeyword = !rule.matchType || rule.matchType === 'keyword';
      if (isKeyword && !rule.pattern) {
        return new Response(JSON.stringify({ error: 'Rule pattern is required for keyword match' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const db = getDb(env);

    // Upsert key in config table
    const existing = await db.select().from(config).where(eq(config.key, 'payment_classification_rules')).limit(1);
    if (existing.length > 0) {
      await db.update(config)
        .set({
          value: JSON.stringify(rules),
          updatedAt: Date.now()
        })
        .where(eq(config.key, 'payment_classification_rules'));
    } else {
      await db.insert(config)
        .values({
          key: 'payment_classification_rules',
          value: JSON.stringify(rules),
          updatedAt: Date.now()
        });
    }

    // Apply the saved rules retrospectively to existing unlinked/unclassified payments
    const updatedCount = await applyRulesToExistingPayments(db, rules);

    return new Response(JSON.stringify({ success: true, updatedCount }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', details: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
