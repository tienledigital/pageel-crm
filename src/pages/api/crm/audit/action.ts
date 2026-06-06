import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDb } from '@/lib/db';
import { invoices, orders, payments } from '@/lib/db/schema';
import { verifySessionCookie, getSessionSecret } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { eq } from 'drizzle-orm';

export const POST: APIRoute = async (context) => {
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

    // 2. Parse payload body
    let body;
    try {
      body = await context.request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { action, targetId, targetIds } = body;
    const ids = targetIds || (targetId ? [targetId] : []);
    if (!action || ids.length === 0) {
      return new Response(JSON.stringify({ error: 'Bad Request: Missing action or targetIds' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const db = getDb(env);

    // Định nghĩa hàm thực thi hành động để chạy tương thích giữa D1 và better-sqlite3
    const executeAction = async (tx: any) => {
      for (const id of ids) {
        if (action === 'unlink_orphan') {
          const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id));
          if (inv) {
            await tx.update(invoices).set({ paymentId: null, status: 'pending' }).where(eq(invoices.id, id));
          } else {
            const [ord] = await tx.select().from(orders).where(eq(orders.id, id));
            if (ord) {
              await tx.update(orders).set({ paymentId: null, status: 'pending' }).where(eq(orders.id, id));
            }
          }
        } 
        
        else if (action === 'delete_invoice') {
          await tx.update(payments).set({ invoiceId: null }).where(eq(payments.invoiceId, id));
          await tx.update(invoices).set({ paymentId: null }).where(eq(invoices.id, id));
          await tx.delete(invoices).where(eq(invoices.id, id));
        } 
        
        else if (action === 'delete_order') {
          await tx.update(payments).set({ orderId: null }).where(eq(payments.orderId, id));
          await tx.update(orders).set({ paymentId: null }).where(eq(orders.id, id));
          await tx.delete(orders).where(eq(orders.id, id));
        } 
        
        else if (action === 'delete_payment_and_links') {
          await tx.update(invoices).set({ paymentId: null }).where(eq(invoices.paymentId, id));
          await tx.update(orders).set({ paymentId: null }).where(eq(orders.paymentId, id));
          await tx.delete(payments).where(eq(payments.id, id));
        } 
        
        else {
          throw new Error(`Invalid action: ${action}`);
        }
      }
    };

    // better-sqlite3 dùng trong test không hỗ trợ async transaction qua db.transaction(),
    // do đó ta phân biệt bằng isD1 để thực thi tương thích.
    const isD1 = !(db as any).session?.client?.transaction;
    if (isD1) {
      await db.transaction(async (tx: any) => {
        await executeAction(tx);
      });
    } else {
      await executeAction(db);
    }

    // 4. Ghi log Audit để theo dõi lịch sử chỉnh sửa
    const ipAddress = context.clientAddress || 
                      context.request.headers.get('cf-connecting-ip') || 
                      context.request.headers.get('x-real-ip') || 
                      null;

    await logAudit(db, {
      userId: user.id,
      username: user.username,
      action: `audit.${action}`,
      target: ids.join(','),
      detail: { 
        metadata: { 
          status: 'success',
          action,
          targetIds: ids
        } 
      },
      ipAddress
    });

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
