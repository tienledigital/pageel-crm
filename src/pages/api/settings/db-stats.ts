// @para-doc [administration-guide.md#5-bao-tri-co-so-du-lieu--giai-phong-dung-luong-database-maintenance]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { count } from 'drizzle-orm';
import {
  users,
  customers,
  staff,
  orders,
  payments,
  config,
  syncLogs,
  auditLogs,
  debugLogs,
  services,
  customerServices
} from '@/lib/db/schema';

// @para-doc [administration-guide.md#5-bao-tri-co-so-du-lieu--giai-phong-dung-luong-database-maintenance]
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

    const db = getDb(env);

    // Defined static mapping of schema tables to perform safe and unified row counts
    const tablesMap = [
      { name: 'users', schema: users },
      { name: 'customers', schema: customers },
      { name: 'staff', schema: staff },
      { name: 'orders', schema: orders },
      { name: 'payments', schema: payments },
      { name: 'config', schema: config },
      { name: 'sync_logs', schema: syncLogs },
      { name: 'audit_logs', schema: auditLogs },
      { name: 'debug_logs', schema: debugLogs },
      { name: 'services', schema: services },
      { name: 'customer_services', schema: customerServices }
    ];

    const tablesStats = [];
    let totalRows = 0;

    for (const item of tablesMap) {
      const [res] = await db.select({ value: count() }).from(item.schema);
      const rowCount = res?.value || 0;
      tablesStats.push({ name: item.name, count: rowCount });
      totalRows += rowCount;
    }

    return new Response(JSON.stringify({
      tables: tablesStats,
      totalRows
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
