// @para-doc [tax-reporting-spec.md#excel-generation-algorithm]
import type { APIContext } from 'astro';
import { getDb } from '@/lib/db';
import { payments, customers, invoices } from '@/lib/db/schema';
import { eq, and, gte, lte, isNotNull } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import JSZip from 'jszip';
import { generateS1a, exportYearlyS1aZip, type ExportPayment } from '@/lib/reports/excelGenerator';
import { TEMPLATE_BASE64 } from '@/lib/reports/excelTemplateBase64';

// Lazy Singleton Cache for Excel template in RAM
let cachedTemplateBuffer: ArrayBuffer | null = null;
const getTemplateBuffer = (): ArrayBuffer => {
  if (!cachedTemplateBuffer) {
    const buffer = Buffer.from(TEMPLATE_BASE64, 'base64');
    cachedTemplateBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }
  return cachedTemplateBuffer;
};

// @para-doc [tax-reporting-spec.md#zip]
export const GET = async (context: APIContext): Promise<Response> => {
  try {
    // 1. Verify user session and permissions
    const user = context.locals.user;
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized: No session' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (user.role !== 'admin' && user.role !== 'accountant') {
      return new Response(JSON.stringify({ error: 'Forbidden: Insufficient permissions' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Parse query parameters
    const url = new URL(context.request.url);
    const yearParam = url.searchParams.get('year');
    const monthParam = url.searchParams.get('month');
    const quarterParam = url.searchParams.get('quarter');

    if (!yearParam) {
      return new Response(JSON.stringify({ error: 'Missing year parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const year = parseInt(yearParam);
    if (isNaN(year)) {
      return new Response(JSON.stringify({ error: 'Invalid year parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Load template file
    let templateBuffer: ArrayBuffer;
    try {
      templateBuffer = getTemplateBuffer();
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'Failed to load template', ...(import.meta.env.DEV && { details: e.message }) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4. Fetch payments from DB
    const db = getDb(env);
    let startTime = 0;
    let endTime = 0;
    let month: number | null = null;
    let quarter: number | null = null;

    if (monthParam) {
      month = parseInt(monthParam);
      if (isNaN(month) || month < 1 || month > 12) {
        return new Response(JSON.stringify({ error: 'Invalid month parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      startTime = new Date(Date.UTC(year, month - 1, 1)).getTime();
      endTime = new Date(Date.UTC(year, month, 1)).getTime() - 1;
    } else if (quarterParam) {
      quarter = parseInt(quarterParam);
      if (isNaN(quarter) || quarter < 1 || quarter > 4) {
        return new Response(JSON.stringify({ error: 'Invalid quarter parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const startMonth = (quarter - 1) * 3;
      startTime = new Date(Date.UTC(year, startMonth, 1)).getTime();
      endTime = new Date(Date.UTC(year, startMonth + 3, 1)).getTime() - 1;
    } else {
      startTime = new Date(Date.UTC(year, 0, 1)).getTime();
      endTime = new Date(Date.UTC(year + 1, 0, 1)).getTime() - 1;
    }

    const rows = await db
      .select({
        payment: payments,
        customer: customers,
        invoice: invoices,
      })
      .from(payments)
      .leftJoin(customers, eq(payments.customerId, customers.id))
      .leftJoin(invoices, eq(payments.invoiceId, invoices.id))
      .where(
        and(
          eq(payments.type, 'in'), // Only incoming payments for S1a
          isNotNull(payments.customerId), // Must have customer/client matched/set
          gte(payments.paidAt, startTime),
          lte(payments.paidAt, endTime)
        )
      )
      .orderBy(payments.paidAt);

    const exportPayments: ExportPayment[] = rows.map((row: any) => ({
      paidAt: row.payment.paidAt,
      amount: row.payment.amount,
      type: row.payment.type,
      content: row.payment.content || '',
      customer: row.customer ? {
        id: row.customer.id,
        fullName: row.customer.fullName,
      } : null,
      invoice: row.invoice ? {
        id: row.invoice.id,
        invoiceNumber: row.invoice.invoiceNumber,
        content: row.invoice.content,
      } : null,
    }));

    // 5. Generate and return response
    const headers = new Headers();

    if (month !== null) {
      const monthStr = month.toString().padStart(2, '0');
      const filename = `S1a-HKD_Thang_${monthStr}_${year}.xlsx`;
      const xlsxBuffer = await generateS1a(templateBuffer, exportPayments);
      
      headers.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      headers.set('Content-Disposition', `attachment; filename="${filename}"`);
      return new Response(xlsxBuffer, { status: 200, headers });
    }

    if (quarter !== null) {
      const quarterStr = quarter.toString().padStart(2, '0');
      const filename = `S1a-HKD_Quy_${quarterStr}_${year}.zip`;
      
      const zip = new JSZip();
      const startMonth = (quarter - 1) * 3 + 1;
      for (let m = startMonth; m < startMonth + 3; m++) {
        const monthPayments = exportPayments.filter(p => {
          // Compare using Date UTC month (0-indexed)
          const date = new Date(p.paidAt);
          return date.getUTCMonth() + 1 === m;
        });

        const xlsxBuffer = await generateS1a(templateBuffer, monthPayments);
        const mStr = m.toString().padStart(2, '0');
        zip.file(`S1a-HKD_Thang_${mStr}_${year}.xlsx`, xlsxBuffer);
      }

      const zipArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
      headers.set('Content-Type', 'application/zip');
      headers.set('Content-Disposition', `attachment; filename="${filename}"`);
      return new Response(zipArrayBuffer, { status: 200, headers });
    }

    // Yearly export (All 12 months in ZIP)
    const filename = `S1a-HKD_Nam_${year}.zip`;
    const zipBlob = await exportYearlyS1aZip(exportPayments, year, templateBuffer);
    const zipArrayBuffer = await zipBlob.arrayBuffer();

    headers.set('Content-Type', 'application/zip');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    return new Response(zipArrayBuffer, { status: 200, headers });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
