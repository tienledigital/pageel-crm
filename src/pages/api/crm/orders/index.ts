// @para-doc [api-contracts.md#14-api-quan-ly-don-hang-tu-dong-orders-api]
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { orders, staff, payments } from '@/lib/db/schema';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { desc, eq } from 'drizzle-orm';
import { createPaidOrder, createPendingOrder, syncCustomerServices } from '@/lib/services/serviceManager';

// @para-doc [api-contracts.md#141-lay-danh-sach-don-hang-tu-dong]
export const GET: APIRoute = async (context) => {
  try {
    // 1. Verify user session and permissions
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

    const db = getDb(env);

    // 2. Fetch orders list
    const result = await db.select()
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .all();

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// @para-doc [api-contracts.md#145-tao-don-hang-moi]
// @para-doc [#csa-api-post-orders]
export const POST: APIRoute = async (context) => {
  try {
    // 1. Verify user session and permissions
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

    if (user.role !== 'admin' && user.role !== 'accountant') {
      return new Response(JSON.stringify({ error: 'Forbidden: Insufficient permissions' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Parse request body
    const body = await context.request.json().catch(() => ({}));
    const { customerId, serviceId, amount, content, paidAt, startDateFromPayment, paymentMethod, isPending, months } = body;

    const db = getDb(env);

    // 4. Retrieve current staff member associated with the user
    const currentStaff = await db.select().from(staff).where(eq(staff.userId, user.id)).get();
    const staffId = currentStaff?.id || null;

    let result;
    if (isPending) {
      // Validation for pending order
      if (!customerId || !serviceId) {
        return new Response(JSON.stringify({ error: 'Bad Request: Missing customerId or serviceId' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      result = await createPendingOrder(db, {
        customerId,
        serviceId,
        months: months ? Number(months) : 1,
        staffId,
      });
    } else {
      // Validation for paid order
      if (!customerId || !serviceId || amount === undefined || !content || paidAt === undefined || !paymentMethod) {
        return new Response(JSON.stringify({ error: 'Bad Request: Missing required parameters' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      result = await createPaidOrder(db, {
        customerId,
        serviceId,
        amount: Number(amount),
        content,
        paidAt: Number(paidAt),
        startDateFromPayment: Boolean(startDateFromPayment),
        paymentMethod,
        staffId,
        months: months ? Number(months) : 1,
      });
    }

    return new Response(JSON.stringify({ success: true, orderId: result.orderId, orderNumber: result.orderNumber }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// @para-doc [api-contracts.md#143-cap-nhat-thong-tin-don-hang-edit-order]
export const PUT: APIRoute = async (context) => {
  try {
    // 1. Verify user session and permissions
    const sessionCookie = context.cookies.get('session')?.value;
    const secret = getSessionSecret();
    
    if (!sessionCookie) {
      return new Response(JSON.stringify({ error: 'Unauthorized: No session cookie' }), {
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

    // 2. Parse request body
    const body = await context.request.json().catch(() => ({}));
    const { orderId, serviceId, amount, startDate, expiredAt, months } = body;

    // 3. Validation
    if (!orderId || !serviceId || amount === undefined || !startDate || !expiredAt) {
      return new Response(JSON.stringify({ error: 'Bad Request: Missing required parameters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let monthsNum = undefined;
    if (months !== undefined) {
      monthsNum = parseInt(months, 10);
      if (isNaN(monthsNum) || monthsNum <= 0 || monthsNum > 120) {
        return new Response(JSON.stringify({ error: 'Bad Request: Invalid months parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const db = getDb(env);

    // Get order to find customerId
    const existingOrder = await db.select().from(orders).where(eq(orders.id, orderId)).get();
    if (!existingOrder) {
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Block changes to paid orders
    if (existingOrder.status === 'paid') {
      return new Response(JSON.stringify({ error: 'Bad Request: Cannot modify financial parameters of a paid order' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4. Update order details
    const updateData: any = {
      serviceId,
      amount: Number(amount),
      startDate: Number(startDate),
      expiredAt: Number(expiredAt),
      updatedAt: Date.now(),
    };
    if (monthsNum !== undefined) {
      updateData.months = monthsNum;
    }

    await db
      .update(orders)
      .set(updateData)
      .where(eq(orders.id, orderId));

    // 5. Run recalculation engine
    if (existingOrder.customerId) {
      await syncCustomerServices(db, existingOrder.customerId);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// @para-doc [api-contracts.md#144-xoa-don-hang-delete-order]
export const DELETE: APIRoute = async (context) => {
  try {
    // 1. Verify user session and permissions
    const sessionCookie = context.cookies.get('session')?.value;
    const secret = getSessionSecret();

    if (!sessionCookie) {
      return new Response(JSON.stringify({ error: 'Unauthorized: No session cookie' }), {
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

    // 2. Parse request query params
    const id = context.url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ error: 'Bad Request: Order ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getDb(env);

    // Get order to check existence
    const existingOrder = await db.select().from(orders).where(eq(orders.id, id)).get();
    if (!existingOrder) {
      return new Response(JSON.stringify({ error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Unlink payments associated with this order
    await db
      .update(payments)
      .set({
        orderId: null,
        customerId: null,
        category: 'non_revenue',
      })
      .where(eq(payments.orderId, id));

    // 4. Delete the order
    await db.delete(orders).where(eq(orders.id, id));

    // 5. Run recalculation engine for customer services
    if (existingOrder.customerId) {
      await syncCustomerServices(db, existingOrder.customerId);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Internal Server Error', ...(import.meta.env.DEV && { details: err.message }) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

