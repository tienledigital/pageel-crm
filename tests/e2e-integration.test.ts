import { describe, it, expect, vi, beforeAll } from 'vitest';
import { getDb } from '@/lib/db';
import { customers, payments, syncLogs } from '@/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import path from 'path';
import ExcelJS from 'exceljs';

// Import all three engines
import { POST as webhookHandler } from '@/pages/api/webhook/sepay';
import { GET as exportS1aHandler } from '@/pages/api/export/s1a';
import { POST as backupHandler } from '@/pages/api/backup/index';

const WEBHOOK_SECRET = 'sepay-e2e-secret-key';
process.env.SEPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

// Mock environment variables for backup
process.env.GITHUB_BACKUP_TOKEN = 'e2e-github-token';
process.env.GITHUB_BACKUP_OWNER = 'e2e-owner';
process.env.GITHUB_BACKUP_REPO = 'e2e-repo';
process.env.GITHUB_BACKUP_BRANCH = 'main';

describe('E2E Integration System Flow', () => {
  let db: any;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });

    // Seed customer 1005
    await db.insert(customers).values({
      id: '1005',
      fullName: 'Tran Van E2E',
      phone: '0123456789',
    });
  });

  it('should successfully execute the full CRM data cycle', async () => {
    // ----------------------------------------------------
    // Step 1: Simulate bank transfer via SePay Webhook
    // ----------------------------------------------------
    const webhookPayload = {
      id: 88881,
      gateway: 'Vietcombank',
      transactionDate: '2026-05-21 08:00:00',
      accountNumber: '0071000000000',
      code: 'TX_E2E_001',
      content: '1005 - thanh toan dich vu crm',
      transferType: 'in',
      transferAmount: 500000,
      accumulatedBalance: 9500000,
      subAccount: '',
      referenceCode: 'FT88888',
    };

    const webhookRequest = new Request('http://localhost/api/webhook/sepay', {
      method: 'POST',
      body: JSON.stringify(webhookPayload),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Apikey ${WEBHOOK_SECRET}`,
      },
    });

    const webhookContext: any = {
      request: webhookRequest,
      url: new URL(webhookRequest.url),
      locals: { runtime: { env: { SEPAY_WEBHOOK_SECRET: WEBHOOK_SECRET } } },
    };

    const webhookResponse = await webhookHandler(webhookContext);
    expect(webhookResponse.status).toBe(200);
    const webhookData = await webhookResponse.json();
    expect(webhookData.success).toBe(true);

    // Verify payment was inserted and linked to customer 1005
    const dbPayments = await db.select().from(payments).where(eq(payments.transactionId, 'TX_E2E_001'));
    expect(dbPayments.length).toBe(1);
    expect(dbPayments[0].amount).toBe(500000);
    expect(dbPayments[0].customerId).toBe('1005');

    // ----------------------------------------------------
    // Step 2: Export Excel S1a-HKD report containing the payment
    // ----------------------------------------------------
    const exportRequest = new Request('http://localhost/api/export/s1a?year=2026&month=5');
    const exportContext: any = {
      request: exportRequest,
      url: new URL(exportRequest.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' }
      },
    };

    const exportResponse = await exportS1aHandler(exportContext);
    expect(exportResponse.status).toBe(200);
    
    // Load Excel sheet and verify payment data
    const arrayBuffer = await exportResponse.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const worksheet = workbook.worksheets[0];

    // Row 12 is where the first incoming payment is written
    const row12 = worksheet.getRow(12);
    expect(row12.getCell(3).value).toBe('1005 - Tran Van E2E - TT GIA HAN');
    expect(row12.getCell(4).value).toBe(500000);

    // ----------------------------------------------------
    // Step 3: Trigger Backup to Git
    // ----------------------------------------------------
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    // Mock Git REST API calls
    // Step 3.1: GET ref/heads/main
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ object: { sha: 'git-parent-sha-e2e' } }),
    });
    // Step 3.2: POST blobs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sha: 'git-blob-sha-e2e' }),
    });
    // Step 3.3: POST trees
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sha: 'git-tree-sha-e2e' }),
    });
    // Step 3.4: POST commits
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sha: 'git-new-commit-sha-e2e' }),
    });
    // Step 3.5: PATCH refs/heads/main
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ object: { sha: 'git-new-commit-sha-e2e' } }),
    });

    const backupRequest = new Request('http://localhost/api/backup', { method: 'POST' });
    const backupContext: any = {
      request: backupRequest,
      url: new URL(backupRequest.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    const backupResponse = await backupHandler(backupContext);
    expect(backupResponse.status).toBe(200);
    const backupData = await backupResponse.json();
    expect(backupData.success).toBe(true);
    expect(backupData.commitSha).toBe('git-new-commit-sha-e2e');

    // ----------------------------------------------------
    // Step 4: Verify sync_logs database entries
    // ----------------------------------------------------
    const dbLogs = await db.select().from(syncLogs).where(eq(syncLogs.action, 'github_backup'));
    expect(dbLogs.length).toBe(1);
    expect(dbLogs[0].status).toBe('success');
    expect(dbLogs[0].message).toContain('git-new-commit-sha-e2e');
  });
});
