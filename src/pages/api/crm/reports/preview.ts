// @para-doc [tax-reporting-spec.md#52-api-xem-truoc-so-lieu-doanh-thu-s1a-hkd-get-apicrmreportspreview]
import type { APIContext } from 'astro';
import { getDb } from '@/lib/db';
import { payments, customers, orders, services, config as configTable } from '@/lib/db/schema';
import { eq, and, gte, lte, isNotNull } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getPaymentDescription } from '@/lib/reports/excelGenerator';

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

// @para-doc [tax-reporting-spec.md#52-api-xem-truoc-so-lieu-doanh-thu-s1a-hkd-get-apicrmreportspreview]
export const GET = async (context: APIContext): Promise<Response> => {
  try {
    // 1. Verify user session and permissions
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

    // 3. Fetch configuration from DB
    const db = getDb(env);
    const configRow = await db.select().from(configTable).where(eq(configTable.key, 'report_config_s1a')).limit(1);
    
    let activeConfig = DEFAULT_CONFIG;
    if (configRow.length > 0) {
      try {
        activeConfig = { ...DEFAULT_CONFIG, ...JSON.parse(configRow[0].value) };
      } catch (e) {
        // Fallback to defaults
      }
    }

    // 4. Determine start/end times
    let startTime = 0;
    let endTime = 0;
    let month: number | null = null;
    let quarter: number | null = null;
    let startMonth: number | null = null;
    let endMonth: number | null = null;

    const startMonthParam = url.searchParams.get('startMonth');
    const endMonthParam = url.searchParams.get('endMonth');

    if (startMonthParam && endMonthParam) {
      startMonth = parseInt(startMonthParam);
      endMonth = parseInt(endMonthParam);
      if (isNaN(startMonth) || startMonth < 1 || startMonth > 12 || isNaN(endMonth) || endMonth < 1 || endMonth > 12 || startMonth > endMonth) {
        return new Response(JSON.stringify({ error: 'Invalid month range' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      startTime = new Date(Date.UTC(year, startMonth - 1, 1)).getTime();
      endTime = new Date(Date.UTC(year, endMonth, 1)).getTime() - 1;
    } else if (monthParam) {
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
      const startMonthVal = (quarter - 1) * 3;
      startTime = new Date(Date.UTC(year, startMonthVal, 1)).getTime();
      endTime = new Date(Date.UTC(year, startMonthVal + 3, 1)).getTime() - 1;
    } else {
      startTime = new Date(Date.UTC(year, 0, 1)).getTime();
      endTime = new Date(Date.UTC(year + 1, 0, 1)).getTime() - 1;
    }

    // 5. Query payments
    const rows = await db
      .select({
        payment: payments,
        customer: customers,
        order: orders,
        service: services,
      })
      .from(payments)
      .leftJoin(customers, eq(payments.customerId, customers.id))
      .leftJoin(orders, eq(payments.orderId, orders.id))
      .leftJoin(services, eq(orders.serviceId, services.id))
      .where(
        and(
          eq(payments.type, 'in'),
          isNotNull(payments.customerId),
          gte(payments.paidAt, startTime),
          lte(payments.paidAt, endTime)
        )
      )
      .orderBy(payments.paidAt);

    const previewPayments = rows.map((row: any) => {
      const paymentData = {
        id: row.payment.id,
        paidAt: row.payment.paidAt,
        amount: row.payment.amount,
        type: row.payment.type,
        content: row.payment.content || '',
        customer: row.customer ? {
          id: row.customer.id,
          fullName: row.customer.fullName,
        } : null,
        order: row.order ? {
          id: row.order.id,
          orderNumber: row.order.orderNumber,
          content: row.order.content,
          taxInvoiceNumber: row.order.taxInvoiceNumber,
          taxInvoiceDate: row.order.taxInvoiceDate,
        } : null,
        serviceName: row.service ? row.service.name : null,
        serviceDescription: row.service ? row.service.description : null,
      };

      return {
        ...paymentData,
        description: getPaymentDescription(paymentData, activeConfig)
      };
    });

    const totalAmount = previewPayments.reduce((sum: number, p: any) => sum + p.amount, 0);

    return new Response(
      JSON.stringify({
        success: true,
        year,
        month,
        quarter,
        startMonth,
        endMonth,
        totalCount: previewPayments.length,
        totalAmount,
        payments: previewPayments,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', details: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
