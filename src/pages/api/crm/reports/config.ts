// @para-doc [api-contracts.md#4-api-luu-tru-cau-hinh-he-thong-system-configuration-api]
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { config as configTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';

const DEFAULT_CONFIG = {
  orgName: 'HỘ KINH DOANH',
  mst: '',
  address: '',
  businessLocation: '',
  reportingPeriod: '',
  serviceTemplate: '{customerId} - {customerName} - {serviceName}',
  orderTemplate: 'ORDER {orderNumber} - {orderContent}',
  dateFormat: 'DD/MM/YYYY'
};

// @para-doc [api-contracts.md#4-api-luu-tru-cau-hinh-he-thong-system-configuration-api]
// @para-doc [tax-reporting-spec.md#53-api-cau-hinh-bao-cao-doanh-thu-s1a-hkd-get-post-apicrmreportsconfig]
export const GET = async (context: APIContext): Promise<Response> => {
  try {
    const user = context.locals.user;
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (user.role !== 'admin' && user.role !== 'accountant') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);
    const existing = await db.select().from(configTable).where(eq(configTable.key, 'report_config_s1a')).limit(1);
    
    let parsedConfig = DEFAULT_CONFIG;
    if (existing.length > 0) {
      try {
        parsedConfig = { ...DEFAULT_CONFIG, ...JSON.parse(existing[0].value) };
      } catch (e) {
        // Fallback to default config on parse error
      }
    }

    return new Response(JSON.stringify({ success: true, config: parsedConfig }), {
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

// @para-doc [api-contracts.md#4-api-luu-tru-cau-hinh-he-thong-system-configuration-api]
// @para-doc [tax-reporting-spec.md#53-api-cau-hinh-bao-cao-doanh-thu-s1a-hkd-get-post-apicrmreportsconfig]
export const POST = async (context: APIContext): Promise<Response> => {
  try {
    const user = context.locals.user;
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (user.role !== 'admin' && user.role !== 'accountant') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await context.request.json();
    const db = getDb(env);

    // Get old value for audit logging
    let oldValue: string | null = null;
    const existing = await db.select().from(configTable).where(eq(configTable.key, 'report_config_s1a')).limit(1);
    if (existing.length > 0) {
      oldValue = existing[0].value;
      await db.update(configTable)
        .set({
          value: JSON.stringify(body),
          updatedAt: Date.now()
        })
        .where(eq(configTable.key, 'report_config_s1a'));
    } else {
      await db.insert(configTable)
        .values({
          key: 'report_config_s1a',
          value: JSON.stringify(body),
          updatedAt: Date.now()
        });
    }

    // Log audit
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    try {
      await logAudit(db, {
        userId: user.id,
        username: user.username,
        action: 'config.update',
        target: 'report_config_s1a',
        detail: { oldValue, newValue: JSON.stringify(body) },
        ipAddress
      });
    } catch (auditError) {
      // Don't fail the request if audit logging fails
    }

    return new Response(JSON.stringify({ success: true }), {
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
