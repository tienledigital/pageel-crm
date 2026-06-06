import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '@/lib/db';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { eq, sql } from 'drizzle-orm';
import { customers, staff, payments, invoices, orders, users, auditLogs } from '@/lib/db/schema';
import { createSessionCookie } from '@/lib/auth';
// Import các handler tương lai để test
import { GET as checkAuditHandler } from '../src/pages/api/crm/audit/check';
import { POST as runActionHandler } from '../src/pages/api/crm/audit/action'; // relative import to resolve IDE cache issues

describe('Database Reconciliation (Audit) APIs Integration Tests', () => {
  const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
  let adminToken: string;
  let accountantToken: string;
  let salerToken: string;

  const TEST_CUSTOMER = {
    id: 'CUST-AUDIT-1',
    fullName: 'Audit Test Customer',
    phone: '0988888888',
  };

  beforeAll(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    
    // Tạo session tokens cho các role khác nhau
    adminToken = await createSessionCookie({
      id: 'usr-admin-audit',
      username: 'adminaudit',
      role: 'admin',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    accountantToken = await createSessionCookie({
      id: 'usr-accountant-audit',
      username: 'accountantaudit',
      role: 'accountant',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    salerToken = await createSessionCookie({
      id: 'usr-saler-audit',
      username: 'saleraudit',
      role: 'saler',
      createdAt: Date.now(),
    }, SESSION_SECRET);

    // Chạy migrations và thiết lập database in-memory
    const db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
    
    // Seed dữ liệu nền cơ bản
    await db.insert(customers).values(TEST_CUSTOMER);
    await db.insert(users).values([
      {
        id: 'usr-admin-audit',
        username: 'adminaudit',
        passwordHash: 'hash',
        role: 'admin',
      },
      {
        id: 'usr-accountant-audit',
        username: 'accountantaudit',
        passwordHash: 'hash',
        role: 'accountant',
      }
    ]);
  });

  function createMockContext(method: 'GET' | 'POST', body?: any, token?: string) {
    const cookiesMap = new Map();
    if (token) {
      cookiesMap.set('session', { value: token });
    }
    const request = new Request('http://localhost/api/crm/audit', {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' },
    });
    return {
      request,
      url: new URL(request.url),
      cookies: cookiesMap,
      locals: {
        runtime: { env: { SESSION_SECRET } },
      },
    } as any;
  }

  describe('GET: /api/crm/audit/check (Quét đối soát)', () => {
    it('nên trả về 401 Unauthorized nếu thiếu session cookie', async () => {
      const context = createMockContext('GET');
      const response = await checkAuditHandler(context);
      expect(response.status).toBe(401);
    });

    it('nên trả về 403 Forbidden nếu role là saler', async () => {
      const context = createMockContext('GET', undefined, salerToken);
      const response = await checkAuditHandler(context);
      expect(response.status).toBe(403);
    });

    it('nên trả về 200 và phân loại đúng các dữ liệu sai lệch', async () => {
      const db = getDb();

      // Tắt foreign keys để chèn dữ liệu seed chéo mà không lỗi
      await db.run(sql`PRAGMA foreign_keys = OFF`);
      await db.delete(invoices);
      await db.delete(orders);
      await db.delete(payments);

      // 1. Seed hóa đơn mồ côi (paymentId không tồn tại thực tế)
      await db.insert(invoices).values({
        id: 'INV-ORPHAN-1',
        invoiceNumber: 'PO-ORPHAN-01',
        customerId: TEST_CUSTOMER.id,
        amount: 100000,
        content: 'Orphaned invoice test',
        status: 'paid',
        paymentId: 'NON-EXISTENT-PAYMENT-ID',
      });

      // 2. Seed hóa đơn paid nhưng paymentId bị NULL
      await db.insert(invoices).values({
        id: 'INV-PAID-NULL-1',
        invoiceNumber: 'PO-PAID-NULL-01',
        customerId: TEST_CUSTOMER.id,
        amount: 200000,
        content: 'Paid invoice without paymentId',
        status: 'paid',
        paymentId: null,
      });

      // 3. Seed lệch số tiền giữa hóa đơn và giao dịch liên kết
      await db.insert(invoices).values({
        id: 'INV-AMT-MISMATCH-1',
        invoiceNumber: 'PO-AMT-MISMATCH-01',
        customerId: TEST_CUSTOMER.id,
        amount: 300000, // Tiền hóa đơn 300k
        content: 'Amount mismatch invoice',
        status: 'paid',
        paymentId: 'PAY-AMT-MISMATCH-1',
      });
      await db.insert(payments).values({
        id: 'PAY-AMT-MISMATCH-1',
        invoiceId: 'INV-AMT-MISMATCH-1',
        customerId: TEST_CUSTOMER.id,
        amount: 350000, // Giao dịch thực tế 350k (lệch tiền)
        transactionId: 'TX_AMT_MISMATCH_1',
        paymentMethod: 'bank_transfer',
        type: 'in',
        category: 'revenue',
        paidAt: Date.now(),
      });

      // 4. Seed lệch liên kết ngược 3 bên (payment trỏ tới invoice nhưng invoice lại không trỏ ngược tới payment đó)
      await db.insert(invoices).values({
        id: 'INV-LINK-MISMATCH-1',
        invoiceNumber: 'PO-LINK-MISMATCH-01',
        customerId: TEST_CUSTOMER.id,
        amount: 400000,
        content: 'Link mismatch invoice',
        status: 'paid',
        paymentId: null, // Không trỏ tới payment chéo
      });
      await db.insert(payments).values({
        id: 'PAY-LINK-MISMATCH-1',
        invoiceId: 'INV-LINK-MISMATCH-1', // Payment trỏ tới invoice
        customerId: TEST_CUSTOMER.id,
        amount: 400000,
        transactionId: 'TX_LINK_MISMATCH_1',
        paymentMethod: 'bank_transfer',
        type: 'in',
        category: 'revenue',
        paidAt: Date.now(),
      });

      // 5. Seed lệch khách hàng chéo giữa 3 bên
      await db.insert(invoices).values({
        id: 'INV-CUST-MISMATCH-1',
        invoiceNumber: 'PO-CUST-MISMATCH-01',
        customerId: TEST_CUSTOMER.id, // Khách hàng TEST_CUSTOMER
        amount: 500000,
        content: 'Customer mismatch invoice',
        status: 'paid',
        paymentId: 'PAY-CUST-MISMATCH-1',
      });
      await db.insert(payments).values({
        id: 'PAY-CUST-MISMATCH-1',
        invoiceId: 'INV-CUST-MISMATCH-1',
        customerId: 'DIFFERENT-CUST-ID', // Khách hàng khác (lệch)
        amount: 500000,
        transactionId: 'TX_CUST_MISMATCH_1',
        paymentMethod: 'bank_transfer',
        type: 'in',
        category: 'revenue',
        paidAt: Date.now(),
      });

      // Bật lại foreign keys sau khi chèn xong
      await db.run(sql`PRAGMA foreign_keys = ON`);

      // Gọi API đối soát
      const context = createMockContext('GET', undefined, accountantToken);
      const response = await checkAuditHandler(context);
      if (response.status === 500) {
        console.log("Check API Error Detail:", await response.json());
      }
      expect(response.status).toBe(200);

      const data = await response.json();
      
      // Kiểm tra hóa đơn mồ côi
      expect(data.invoices.orphans.length).toBe(1);
      expect(data.invoices.orphans[0].id).toBe('INV-ORPHAN-1');

      // Kiểm tra hóa đơn paid nhưng paymentId = null (bao gồm cả hóa đơn lệch liên kết ngược)
      expect(data.invoices.paidNullPayment.length).toBe(2);

      // Kiểm tra lệch tiền
      expect(data.invoices.mismatchedAmount.length).toBe(1);
      expect(data.invoices.mismatchedAmount[0].id).toBe('INV-AMT-MISMATCH-1');
      expect(data.invoices.mismatchedAmount[0].paymentAmount).toBe(350000);

      // Kiểm tra lệch liên kết ngược 3 bên
      expect(data.threeWay.mismatchedLinks.length).toBe(1);
      expect(data.threeWay.mismatchedLinks[0].paymentId).toBe('PAY-LINK-MISMATCH-1');

      // Kiểm tra lệch khách hàng chéo
      expect(data.threeWay.mismatchedCustomers.length).toBe(1);
      expect(data.threeWay.mismatchedCustomers[0].paymentId).toBe('PAY-CUST-MISMATCH-1');
    });
  });

  describe('POST: /api/crm/audit/action (Thực thi dọn dẹp)', () => {
    it('nên gỡ liên kết mồ côi (unlink_orphan) thành công', async () => {
      const db = getDb();
      const invoiceId = 'INV-ACTION-UNLINK';

      // Seed hóa đơn mồ côi
      await db.run(sql`PRAGMA foreign_keys = OFF`);
      await db.insert(invoices).values({
        id: invoiceId,
        invoiceNumber: 'PO-UNLINK-TEST',
        customerId: TEST_CUSTOMER.id,
        amount: 150000,
        content: 'Orphaned link test',
        status: 'paid',
        paymentId: 'NON-EXISTENT-LINK',
      });
      await db.run(sql`PRAGMA foreign_keys = ON`);

      const payload = {
        action: 'unlink_orphan',
        targetId: invoiceId,
      };

      const context = createMockContext('POST', payload, adminToken);
      const response = await runActionHandler(context);
      if (response.status === 500) {
        console.log("Action API Error Detail:", await response.json());
      }
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);

      // Kiểm tra DB đã được gỡ liên kết (paymentId = null)
      const updated = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      expect(updated.paymentId).toBeNull();
      
      // Đồng thời status chuyển về 'pending' theo logic auto-fix an toàn của spec
      expect(updated.status).toBe('pending');
    });

    it('nên xóa hóa đơn sai lệch (delete_invoice) an toàn không gây lỗi khóa ngoại', async () => {
      const db = getDb();
      const invoiceId = 'INV-ACTION-DELETE';
      const paymentId = 'PAY-ACTION-DELETE';

      // Seed hóa đơn và thanh toán liên kết
      await db.insert(invoices).values({
        id: invoiceId,
        invoiceNumber: 'PO-DELETE-TEST',
        customerId: TEST_CUSTOMER.id,
        amount: 300000,
        content: 'Invoice to delete test',
        status: 'paid',
        paymentId: null,
      });

      await db.insert(payments).values({
        id: paymentId,
        invoiceId: invoiceId,
        amount: 300000,
        transactionId: 'TX_ACTION_DELETE',
        paymentMethod: 'bank_transfer',
        type: 'in',
        category: 'revenue',
        paidAt: Date.now(),
      });

      await db.update(invoices).set({ paymentId }).where(eq(invoices.id, invoiceId));

      const payload = {
        action: 'delete_invoice',
        targetId: invoiceId,
      };

      // Dọn dẹp log audit trước khi test
      await db.delete(auditLogs);

      const context = createMockContext('POST', payload, adminToken);
      const response = await runActionHandler(context);
      
      // Đảm bảo không lỗi ngoại lệ khóa ngoại của SQLite (FOREIGN KEY constraint failed)
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);

      // Kiểm tra DB: Hóa đơn đã bị xóa
      const updatedInvoice = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
      expect(updatedInvoice).toBeUndefined();

      // Kiểm tra DB: Giao dịch liên quan được gỡ liên kết invoice_id thành NULL tự động thay vì xóa
      const updatedPayment = await db.select().from(payments).where(eq(payments.id, paymentId)).get();
      expect(updatedPayment).toBeDefined();
      expect(updatedPayment.invoiceId).toBeNull();

      // Kiểm tra log audit được ghi lại
      const audits = await db.select().from(auditLogs).all();
      expect(audits.length).toBeGreaterThanOrEqual(1);
      expect(audits[0].action).toBe('audit.delete_invoice');
      expect(audits[0].target).toBe(invoiceId);
    });

    it('nên xóa hàng loạt hóa đơn sai lệch (targetIds) an toàn không gây lỗi khóa ngoại', async () => {
      const db = getDb();
      const invoiceId1 = 'INV-BULK-1';
      const invoiceId2 = 'INV-BULK-2';
      const paymentId1 = 'PAY-BULK-1';
      const paymentId2 = 'PAY-BULK-2';

      // Seed dữ liệu
      await db.insert(invoices).values([
        {
          id: invoiceId1,
          invoiceNumber: 'PO-BULK-1',
          customerId: TEST_CUSTOMER.id,
          amount: 100000,
          content: 'Bulk 1',
          status: 'paid',
          paymentId: null,
        },
        {
          id: invoiceId2,
          invoiceNumber: 'PO-BULK-2',
          customerId: TEST_CUSTOMER.id,
          amount: 200000,
          content: 'Bulk 2',
          status: 'paid',
          paymentId: null,
        }
      ]);

      await db.insert(payments).values([
        {
          id: paymentId1,
          invoiceId: invoiceId1,
          amount: 100000,
          transactionId: 'TX_BULK_1',
          paymentMethod: 'bank_transfer',
          type: 'in',
          category: 'revenue',
          paidAt: Date.now(),
        },
        {
          id: paymentId2,
          invoiceId: invoiceId2,
          amount: 200000,
          transactionId: 'TX_BULK_2',
          paymentMethod: 'bank_transfer',
          type: 'in',
          category: 'revenue',
          paidAt: Date.now(),
        }
      ]);

      await db.update(invoices).set({ paymentId: paymentId1 }).where(eq(invoices.id, invoiceId1));
      await db.update(invoices).set({ paymentId: paymentId2 }).where(eq(invoices.id, invoiceId2));

      const payload = {
        action: 'delete_invoice',
        targetIds: [invoiceId1, invoiceId2],
      };

      await db.delete(auditLogs);

      const context = createMockContext('POST', payload, adminToken);
      const response = await runActionHandler(context);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Kiểm tra DB: Cả hai hóa đơn đã bị xóa
      const updatedInv1 = await db.select().from(invoices).where(eq(invoices.id, invoiceId1)).get();
      const updatedInv2 = await db.select().from(invoices).where(eq(invoices.id, invoiceId2)).get();
      expect(updatedInv1).toBeUndefined();
      expect(updatedInv2).toBeUndefined();

      // Kiểm tra DB: Các thanh toán liên quan được gỡ liên kết
      const updatedPay1 = await db.select().from(payments).where(eq(payments.id, paymentId1)).get();
      const updatedPay2 = await db.select().from(payments).where(eq(payments.id, paymentId2)).get();
      expect(updatedPay1.invoiceId).toBeNull();
      expect(updatedPay2.invoiceId).toBeNull();

      // Kiểm tra log audit được ghi lại
      const audits = await db.select().from(auditLogs).all();
      expect(audits.length).toBeGreaterThanOrEqual(1);
      expect(audits[0].action).toBe('audit.delete_invoice');
      expect(audits[0].target).toContain(invoiceId1);
      expect(audits[0].target).toContain(invoiceId2);
    });
  });
});
