import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { generateS1a, exportYearlyS1aZip, type ExportPayment } from '../src/lib/reports/excelGenerator';
import { GET as exportS1aHandler } from '../src/pages/api/export/s1a';
import { GET as previewS1aHandler } from '../src/pages/api/export/s1a-preview';
import { getDb } from '../src/lib/db';
import { customers, invoices, payments } from '../src/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import crypto from 'crypto';
import { TEMPLATE_BASE64, TEMPLATE_SHA256 } from '../src/lib/reports/excelTemplateBase64';

describe('Excel Template Base64 Integrity', () => {
  it('should match the SHA-256 hash of the static excel template file', () => {
    const staticPath = path.join(__dirname, '../public/templates/S1a-HKD-excel.xlsx');
    const staticBuffer = fs.readFileSync(staticPath);
    const staticHash = crypto.createHash('sha256').update(staticBuffer).digest('hex');

    // Decode the Base64 string to buffer and hash it
    const inlineBuffer = Buffer.from(TEMPLATE_BASE64, 'base64');
    const inlineHash = crypto.createHash('sha256').update(inlineBuffer).digest('hex');

    expect(TEMPLATE_SHA256).toBe(staticHash);
    expect(inlineHash).toBe(staticHash);
    expect(TEMPLATE_BASE64.length).toBeGreaterThan(0);
  });
});

const getTemplateBuffer = (): ArrayBuffer => {
  const filePath = path.join(__dirname, '../public/templates/S1a-HKD-excel.xlsx');
  const buffer = fs.readFileSync(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
};

describe('Excel Generator - generateS1a', () => {
  it('should only include incoming payments (type = in)', async () => {
    const template = getTemplateBuffer();
    const paymentsData: ExportPayment[] = [
      {
        paidAt: new Date('2026-05-15T10:00:00Z').getTime(),
        amount: 200000,
        type: 'in',
        content: 'Payment 1',
        customer: { id: '1005', fullName: 'Nguyễn Văn A' }
      },
      {
        paidAt: new Date('2026-05-16T10:00:00Z').getTime(),
        amount: 50000,
        type: 'out',
        content: 'Refund 1',
        customer: { id: '1005', fullName: 'Nguyễn Văn A' }
      }
    ];

    const result = await generateS1a(template, paymentsData);
    expect(result).toBeDefined();
    expect(result).toBeInstanceOf(ArrayBuffer);

    // Load resulting workbook to verify
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result);
    const worksheet = workbook.worksheets[0];

    // Verify row count or row values
    // Incoming payment is at row 12
    const row12 = worksheet.getRow(12);
    expect(row12.getCell(3).value).toBe('1005 - Nguyễn Văn A - TT GIA HAN');
    expect(row12.getCell(4).value).toBe(200000);

    // Row 13 should be the total row
    const row13 = worksheet.getRow(13);
    expect(row13.getCell(3).value).toBe('Tổng cộng:');
    // Result of formula should be 200000
    expect((row13.getCell(4).value as any).result).toBe(200000);
  });

  it('should map description correctly for payments with invoices', async () => {
    const template = getTemplateBuffer();
    const paymentsData: ExportPayment[] = [
      {
        paidAt: new Date('2026-05-15T10:00:00Z').getTime(),
        amount: 300000,
        type: 'in',
        content: 'Normal content',
        customer: { id: '1001', fullName: 'Lê Văn Tám' },
        invoice: { id: 'INV-1', invoiceNumber: 'INV001', content: 'Gói VIP 6 Tháng' }
      }
    ];

    const result = await generateS1a(template, paymentsData);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result);
    const worksheet = workbook.worksheets[0];

    const row12 = worksheet.getRow(12);
    expect(row12.getCell(3).value).toBe('1001 - Lê Văn Tám - Gói VIP 6 Tháng');
  });

  it('should map description correctly for anonymous payments', async () => {
    const template = getTemplateBuffer();
    const paymentsData: ExportPayment[] = [
      {
        paidAt: new Date('2026-05-15T10:00:00Z').getTime(),
        amount: 150000,
        type: 'in',
        content: 'Chuyen khoan khong co thong tin',
        customer: null,
        invoice: null
      },
      {
        paidAt: new Date('2026-05-16T10:00:00Z').getTime(),
        amount: 100000,
        type: 'in',
        content: '',
        customer: null,
        invoice: null
      }
    ];

    const result = await generateS1a(template, paymentsData);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result);
    const worksheet = workbook.worksheets[0];

    const row12 = worksheet.getRow(12);
    expect(row12.getCell(3).value).toBe('Chuyen khoan khong co thong tin');

    const row13 = worksheet.getRow(13);
    expect(row13.getCell(3).value).toBe('KHACH VANG LAI - THANH TOAN');
  });

  it('should escape formula injection characters (=, +, -, @) in payment content', async () => {
    const template = getTemplateBuffer();
    const paymentsData: ExportPayment[] = [
      {
        paidAt: new Date('2026-05-15T10:00:00Z').getTime(),
        amount: 100000,
        type: 'in',
        content: '=1+1',
        customer: null,
        invoice: null
      }
    ];

    const result = await generateS1a(template, paymentsData);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result);
    const worksheet = workbook.worksheets[0];

    const row12 = worksheet.getRow(12);
    expect(row12.getCell(3).value).toBe("'=1+1");
  });
});

describe('Excel Zip Exporter - exportYearlyS1aZip', () => {
  it('should generate a zip file containing 12 monthly sheets', async () => {
    const template = getTemplateBuffer();
    const paymentsData: ExportPayment[] = [
      {
        paidAt: new Date('2026-01-10T10:00:00Z').getTime(),
        amount: 100000,
        type: 'in',
        content: 'Jan Payment'
      },
      {
        paidAt: new Date('2026-05-20T12:00:00Z').getTime(),
        amount: 500000,
        type: 'in',
        content: 'May Payment'
      }
    ];

    const zipBlob = await exportYearlyS1aZip(paymentsData, 2026, template);
    expect(zipBlob).toBeDefined();

    // Read zip contents
    const zipArrayBuffer = await zipBlob.arrayBuffer();
    const zip = await JSZip.loadAsync(zipArrayBuffer);
    
    // Check that we have files for all 12 months
    for (let m = 1; m <= 12; m++) {
      const monthStr = m.toString().padStart(2, '0');
      const filename = `S1a-HKD_Thang_${monthStr}_2026.xlsx`;
      expect(zip.file(filename)).not.toBeNull();
    }
  });
});

describe('Export S1a API Endpoint - GET /api/export/s1a', () => {
  let db: any;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });

    // Clean up
    await db.delete(payments);
    await db.delete(invoices);
    await db.delete(customers);

    // Seed mock data
    await db.insert(customers).values({
      id: '1005',
      fullName: 'Nguyễn Văn A',
      phone: '0987654321',
    });

    await db.insert(invoices).values({
      id: 'INV-1',
      customerId: '1005',
      invoiceNumber: 'INV001',
      amount: 200000,
      content: 'Gia hạn CRM',
      status: 'paid',
    });

    await db.insert(payments).values({
      id: 'PAY-1',
      customerId: '1005',
      invoiceId: 'INV-1',
      amount: 200000,
      type: 'in',
      transactionId: 'TX100',
      paidAt: new Date('2026-05-15T12:00:00Z').getTime(),
    });
  });

  it('should return 401 Unauthorized if user is not authenticated', async () => {
    const request = new Request('http://localhost/api/export/s1a?year=2026&month=5');
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {},
    };

    const response = await exportS1aHandler(context);
    expect(response.status).toBe(401);
  });

  it('should return 403 Forbidden if user is saler (role not admin/accountant)', async () => {
    const request = new Request('http://localhost/api/export/s1a?year=2026&month=5');
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'saler1', role: 'saler' }
      },
    };

    const response = await exportS1aHandler(context);
    expect(response.status).toBe(403);
  });

  it('should return single Excel sheet for a specific month', async () => {
    const request = new Request('http://localhost/api/export/s1a?year=2026&month=5');
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' }
      },
    };

    const response = await exportS1aHandler(context);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers.get('Content-Disposition')).toContain('S1a-HKD_Thang_05_2026.xlsx');

    const buffer = await response.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    
    // Row 12 is payment
    const row12 = worksheet.getRow(12);
    expect(row12.getCell(3).value).toBe('1005 - Nguyễn Văn A - Gia hạn CRM');
    expect(row12.getCell(4).value).toBe(200000);
  });

  it('should return a ZIP file containing 3 months for quarter filter', async () => {
    const request = new Request('http://localhost/api/export/s1a?year=2026&quarter=2');
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-2', username: 'acc1', role: 'accountant' }
      },
    };

    const response = await exportS1aHandler(context);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-Disposition')).toContain('S1a-HKD_Quy_02_2026.zip');

    const buffer = await response.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file('S1a-HKD_Thang_04_2026.xlsx')).not.toBeNull();
    expect(zip.file('S1a-HKD_Thang_05_2026.xlsx')).not.toBeNull();
    expect(zip.file('S1a-HKD_Thang_06_2026.xlsx')).not.toBeNull();
  });

  it('should return a ZIP file containing 12 months for yearly export', async () => {
    const request = new Request('http://localhost/api/export/s1a?year=2026');
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-2', username: 'acc1', role: 'accountant' }
      },
    };

    const response = await exportS1aHandler(context);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-Disposition')).toContain('S1a-HKD_Nam_2026.zip');

    const buffer = await response.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file('S1a-HKD_Thang_01_2026.xlsx')).not.toBeNull();
    expect(zip.file('S1a-HKD_Thang_12_2026.xlsx')).not.toBeNull();
  });

  it('should exclude payments without customer (anonymous payments)', async () => {
    // Insert a payment with customerId = null
    await db.insert(payments).values({
      id: 'PAY-ANON',
      customerId: null,
      amount: 999999,
      type: 'in',
      transactionId: 'TX-ANON',
      paidAt: new Date('2026-05-18T12:00:00Z').getTime(),
    });

    const request = new Request('http://localhost/api/export/s1a?year=2026&month=5');
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' }
      },
    };

    const response = await exportS1aHandler(context);
    expect(response.status).toBe(200);

    const buffer = await response.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];

    // The payment of 200000 (PAY-1) should be in row 12
    const row12 = worksheet.getRow(12);
    expect(row12.getCell(4).value).toBe(200000);

    // Row 13 should be the total row because PAY-ANON (without customer) is excluded
    const row13 = worksheet.getRow(13);
    expect(row13.getCell(3).value).toBe('Tổng cộng:');
    expect((row13.getCell(4).value as any).result).toBe(200000);
  });
});

describe('Preview S1a API Endpoint - GET /api/export/s1a-preview', () => {
  let db: any;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });

    // Clean up
    await db.delete(payments);
    await db.delete(invoices);
    await db.delete(customers);

    // Seed mock data
    await db.insert(customers).values({
      id: '1005',
      fullName: 'Nguyễn Văn A',
      phone: '0987654321',
    });

    await db.insert(payments).values({
      id: 'PAY-1',
      customerId: '1005',
      amount: 200000,
      type: 'in',
      transactionId: 'TX100',
      paidAt: new Date('2026-05-15T12:00:00Z').getTime(),
    });

    // Anonymous payment (should be excluded)
    await db.insert(payments).values({
      id: 'PAY-ANON',
      customerId: null,
      amount: 999000,
      type: 'in',
      transactionId: 'TX-ANON',
      paidAt: new Date('2026-05-16T12:00:00Z').getTime(),
    });
  });

  it('should return 401 Unauthorized if user is not authenticated', async () => {
    const request = new Request('http://localhost/api/export/s1a-preview?year=2026&month=5');
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {},
    };

    const response = await previewS1aHandler(context);
    expect(response.status).toBe(401);
  });

  it('should return JSON preview excluding anonymous payments', async () => {
    const request = new Request('http://localhost/api/export/s1a-preview?year=2026&month=5');
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' }
      },
    };

    const response = await previewS1aHandler(context);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.totalCount).toBe(1);
    expect(data.totalAmount).toBe(200000);
    expect(data.payments.length).toBe(1);
    expect(data.payments[0].id).toBe('PAY-1');
    expect(data.payments[0].customer.fullName).toBe('Nguyễn Văn A');
  });
});
