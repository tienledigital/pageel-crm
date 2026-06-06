import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { invoices, orders, payments } from '@/lib/db/schema';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { eq, and, isNotNull, isNull, ne } from 'drizzle-orm';

export const GET: APIRoute = async (context) => {
  try {
    // 1. Xác thực session và kiểm tra quyền admin/accountant
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

    const db = getDb(env);

    // -------------------------------------------------------------
    // 1. Đối soát Hóa đơn (Invoices)
    // -------------------------------------------------------------

    // 1.1 Hóa đơn có paymentId mồ côi (trỏ đến thanh toán không tồn tại)
    const invoiceOrphans = await db.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerId: invoices.customerId,
      amount: invoices.amount,
      status: invoices.status,
      paymentId: invoices.paymentId,
    })
    .from(invoices)
    .leftJoin(payments, eq(invoices.paymentId, payments.id))
    .where(and(isNotNull(invoices.paymentId), isNull(payments.id)));

    // 1.2 Hóa đơn status = 'paid' nhưng paymentId là NULL
    const invoicePaidNullPayment = await db.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerId: invoices.customerId,
      amount: invoices.amount,
      status: invoices.status,
    })
    .from(invoices)
    .where(and(eq(invoices.status, 'paid'), isNull(invoices.paymentId)));

    // 1.3 Hóa đơn paid nhưng lệch tiền với Giao dịch liên kết
    const invoiceMismatchedAmount = await db.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      amount: invoices.amount,
      paymentId: invoices.paymentId,
      paymentAmount: payments.amount,
      transactionId: payments.transactionId,
    })
    .from(invoices)
    .innerJoin(payments, eq(invoices.paymentId, payments.id))
    .where(and(ne(invoices.amount, payments.amount), eq(invoices.status, 'paid')));


    // -------------------------------------------------------------
    // 2. Đối soát Đơn hàng (Orders)
    // -------------------------------------------------------------

    // 2.1 Đơn hàng có paymentId mồ côi
    const orderOrphans = await db.select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      amount: orders.amount,
      status: orders.status,
      paymentId: orders.paymentId,
    })
    .from(orders)
    .leftJoin(payments, eq(orders.paymentId, payments.id))
    .where(and(isNotNull(orders.paymentId), isNull(payments.id)));

    // 2.2 Đơn hàng status = 'paid' nhưng paymentId là NULL
    const orderPaidNullPayment = await db.select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
      amount: orders.amount,
      status: orders.status,
    })
    .from(orders)
    .where(and(eq(orders.status, 'paid'), isNull(orders.paymentId)));

    // 2.3 Đơn hàng paid nhưng lệch tiền với Giao dịch liên kết
    const orderMismatchedAmount = await db.select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      amount: orders.amount,
      paymentId: orders.paymentId,
      paymentAmount: payments.amount,
      transactionId: payments.transactionId,
    })
    .from(orders)
    .innerJoin(payments, eq(orders.paymentId, payments.id))
    .where(and(ne(orders.amount, payments.amount), eq(orders.status, 'paid')));


    // -------------------------------------------------------------
    // 3. Đối soát chéo 3 bên (Payments - Invoices - Orders)
    // -------------------------------------------------------------
    const mismatchedLinks: any[] = [];
    const mismatchedCustomers: any[] = [];

    const allPayments = await db.select().from(payments);

    for (const p of allPayments) {
      let isLinkMismatched = false;
      let orderLinkedPaymentId = null;
      let invoiceLinkedPaymentId = null;

      // 3.1 Đối soát liên kết Đơn hàng
      if (p.orderId) {
        const [o] = await db.select().from(orders).where(eq(orders.id, p.orderId));
        if (!o || o.paymentId !== p.id) {
          isLinkMismatched = true;
          orderLinkedPaymentId = o ? o.paymentId : null;
        }

        // 3.2 Đối soát lệch Khách hàng
        if (o && o.customerId !== p.customerId) {
          mismatchedCustomers.push({
            paymentId: p.id,
            transactionId: p.transactionId,
            payCust: p.customerId,
            orderId: o.id,
            ordCust: o.customerId
          });
        }
      }

      // 3.3 Đối soát liên kết Hóa đơn
      if (p.invoiceId) {
        const [i] = await db.select().from(invoices).where(eq(invoices.id, p.invoiceId));
        if (!i || i.paymentId !== p.id) {
          isLinkMismatched = true;
          invoiceLinkedPaymentId = i ? i.paymentId : null;
        }

        // 3.4 Đối soát lệch Khách hàng Hóa đơn
        if (i && i.customerId !== p.customerId) {
          // Tránh đẩy trùng nếu đã kiểm tra chéo
          const exists = mismatchedCustomers.some(c => c.paymentId === p.id);
          if (!exists) {
            mismatchedCustomers.push({
              paymentId: p.id,
              transactionId: p.transactionId,
              payCust: p.customerId,
              invoiceId: i.id,
              invCust: i.customerId
            });
          }
        }
      }

      if (isLinkMismatched) {
        mismatchedLinks.push({
          paymentId: p.id,
          transactionId: p.transactionId,
          orderId: p.orderId,
          orderLinkedPaymentId,
          invoiceId: p.invoiceId,
          invoiceLinkedPaymentId
        });
      }
    }

    return new Response(JSON.stringify({
      invoices: {
        orphans: invoiceOrphans,
        paidNullPayment: invoicePaidNullPayment,
        mismatchedAmount: invoiceMismatchedAmount
      },
      orders: {
        orphans: orderOrphans,
        paidNullPayment: orderPaidNullPayment,
        mismatchedAmount: orderMismatchedAmount
      },
      threeWay: {
        mismatchedLinks,
        mismatchedCustomers
      }
    }), {
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
