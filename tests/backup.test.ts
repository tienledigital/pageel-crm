import { describe, it, expect, vi, beforeAll } from 'vitest';
import { getDb } from '../src/lib/db';
import { customers } from '../src/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { pushBackupToGit, exportDatabaseToJson } from '../src/lib/backup/githubClient';

describe('GitHub Backup Client', () => {
  let db: any;

  beforeAll(async () => {
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  });

  describe('exportDatabaseToJson', () => {
    it('should export all tables correctly to JSON', async () => {
      // Seed some test data
      await db.insert(customers).values({
        id: 'CUST-BACKUP-1',
        fullName: 'Customer Backup Test',
        phone: '0987654321',
      });

      const jsonStr = await exportDatabaseToJson(db);
      const data = JSON.parse(jsonStr);

      expect(data).toHaveProperty('customers');
      expect(data).toHaveProperty('invoices');
      expect(data).toHaveProperty('payments');
      expect(data.customers.length).toBeGreaterThan(0);
      expect(data.customers[0].id).toBe('CUST-BACKUP-1');
    });
  });

  describe('pushBackupToGit', () => {
    it('should perform GitHub API commits correctly', async () => {
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      // Mock Step 1: GET ref/heads/main
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ object: { sha: 'parent-commit-sha-123' } }),
      });

      // Mock Step 2: POST blobs
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sha: 'blob-sha-456' }),
      });

      // Mock Step 3: POST trees
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sha: 'tree-sha-789' }),
      });

      // Mock Step 4: POST commits
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sha: 'new-commit-sha-999' }),
      });

      // Mock Step 5: PATCH refs/heads/main
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ object: { sha: 'new-commit-sha-999' } }),
      });

      const params = {
        token: 'github-test-token',
        owner: 'testowner',
        repo: 'testrepo',
        branch: 'main',
        filePath: 'backups/backup.json',
        content: '{"data":[]}',
        commitMessage: 'Backup database',
      };

      const resultSha = await pushBackupToGit(params);

      expect(resultSha).toBe('new-commit-sha-999');

      // Verify requests were made
      expect(mockFetch).toHaveBeenCalledTimes(5);
      
      // Check Step 1 URL
      const [url1, opt1] = mockFetch.mock.calls[0] as [string, any];
      expect(url1).toBe('https://api.github.com/repos/testowner/testrepo/git/ref/heads/main');
      expect(opt1.headers.Authorization).toBe('Bearer github-test-token');

      // Check Step 2 (Blobs) URL
      const [url2, opt2] = mockFetch.mock.calls[1] as [string, any];
      expect(url2).toBe('https://api.github.com/repos/testowner/testrepo/git/blobs');
      expect(JSON.parse(opt2.body).content).toBe('{"data":[]}');

      // Check Step 3 (Trees) URL
      const [url3, opt3] = mockFetch.mock.calls[2] as [string, any];
      expect(url3).toBe('https://api.github.com/repos/testowner/testrepo/git/trees');
      const body3 = JSON.parse(opt3.body);
      expect(body3.base_tree).toBe('parent-commit-sha-123');
      expect(body3.tree[0].path).toBe('backups/backup.json');
      expect(body3.tree[0].sha).toBe('blob-sha-456');

      // Check Step 4 (Commits) URL
      const [url4, opt4] = mockFetch.mock.calls[3] as [string, any];
      expect(url4).toBe('https://api.github.com/repos/testowner/testrepo/git/commits');
      const body4 = JSON.parse(opt4.body);
      expect(body4.tree).toBe('tree-sha-789');
      expect(body4.parents).toContain('parent-commit-sha-123');

      // Check Step 5 (Refs) URL
      const [url5, opt5] = mockFetch.mock.calls[4] as [string, any];
      expect(url5).toBe('https://api.github.com/repos/testowner/testrepo/git/refs/heads/main');
      expect(JSON.parse(opt5.body).sha).toBe('new-commit-sha-999');
    });

    it('should throw error when GitHub API requests fail', async () => {
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const params = {
        token: 'invalid-token',
        owner: 'testowner',
        repo: 'testrepo',
        branch: 'main',
        filePath: 'backups/backup.json',
        content: '{"data":[]}',
        commitMessage: 'Backup database',
      };

      await expect(pushBackupToGit(params)).rejects.toThrow('GitHub API error GET ref: 401 Unauthorized');
    });

    it('should validate inputs before making API requests', async () => {
      const params = {
        token: 'github-test-token',
        owner: 'testowner',
        repo: 'testrepo',
        branch: 'main',
        filePath: 'backups/backup.json',
        content: '{"data":[]}',
        commitMessage: 'Backup database',
      };

      await expect(pushBackupToGit({ ...params, owner: 'invalid owner' })).rejects.toThrow('Invalid GitHub owner');
      await expect(pushBackupToGit({ ...params, repo: 'invalid/repo' })).rejects.toThrow('Invalid GitHub repository name');
      await expect(pushBackupToGit({ ...params, branch: 'invalid branch' })).rejects.toThrow('Invalid GitHub branch name');
      await expect(pushBackupToGit({ ...params, token: '' })).rejects.toThrow('GitHub Backup Token is required');
    });

    it('should parse and include detailed error messages from GitHub JSON responses', async () => {
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ message: 'Bad credentials' }),
      });

      const params = {
        token: 'invalid-token',
        owner: 'testowner',
        repo: 'testrepo',
        branch: 'main',
        filePath: 'backups/backup.json',
        content: '{"data":[]}',
        commitMessage: 'Backup database',
      };

      await expect(pushBackupToGit(params)).rejects.toThrow('GitHub API error GET ref: 401 Unauthorized: Bad credentials');
    });
  });
});

// Import the API Handler (which doesn't exist yet, creating a RED state)
import { POST as backupApiHandler } from '../src/pages/api/backup/index';
import { syncLogs } from '../src/lib/db/schema';

describe('Astro API Endpoint - POST /api/backup', () => {
  let db: any;

  beforeAll(async () => {
    db = getDb();
    // process.env will mock env from cloudflare:workers
    process.env.GITHUB_BACKUP_TOKEN = 'mock-github-token-api';
    process.env.GITHUB_BACKUP_OWNER = 'mock-owner';
    process.env.GITHUB_BACKUP_REPO = 'mock-repo';
    process.env.GITHUB_BACKUP_BRANCH = 'main';
  });

  it('should return 401 Unauthorized if user is not authenticated', async () => {
    const request = new Request('http://localhost/api/backup', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {},
    };

    const response = await backupApiHandler(context);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('should return 403 Forbidden if user is not an admin', async () => {
    const request = new Request('http://localhost/api/backup', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'accountant1', role: 'accountant' },
      },
    };

    const response = await backupApiHandler(context);
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('Forbidden - Admin access required');
  });

  it('should run backup, save success to sync_logs, and return 200 on success', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    // Mock Step 1: GET ref/heads/main
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ object: { sha: 'parent-sha-xyz' } }),
    });

    // Mock Step 2: POST blobs
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sha: 'blob-sha-xyz' }),
    });

    // Mock Step 3: POST trees
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sha: 'tree-sha-xyz' }),
    });

    // Mock Step 4: POST commits
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sha: 'new-commit-sha-xyz' }),
    });

    // Mock Step 5: PATCH refs/heads/main
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ object: { sha: 'new-commit-sha-xyz' } }),
    });

    const request = new Request('http://localhost/api/backup', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    // Clean syncLogs before test
    await db.delete(syncLogs);

    const response = await backupApiHandler(context);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.commitSha).toBe('new-commit-sha-xyz');

    // Verify a syncLog was inserted
    const logs = await db.select().from(syncLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].action).toBe('github_backup');
    expect(logs[0].status).toBe('success');
    expect(logs[0].message).toContain('new-commit-sha-xyz');
  });

  it('should handle errors, save failure to sync_logs, and return 500 when push fails', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    // Fail at Step 1: GET ref
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal GitHub Error',
    });

    const request = new Request('http://localhost/api/backup', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    // Clean syncLogs before test
    await db.delete(syncLogs);

    const response = await backupApiHandler(context);
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain('GitHub API error GET ref');

    // Verify a failed syncLog was inserted
    const logs = await db.select().from(syncLogs);
    expect(logs.length).toBe(1);
    expect(logs[0].action).toBe('github_backup');
    expect(logs[0].status).toBe('failed');
    expect(logs[0].message).toContain('GitHub API error GET ref');
  });
});

import { POST as testConnectionApiHandler } from '../src/pages/api/backup/test-connection';

describe('Astro API Endpoint - POST /api/backup/test-connection', () => {
  beforeAll(async () => {
    process.env.GITHUB_BACKUP_TOKEN = 'mock-github-token-api';
    process.env.GITHUB_BACKUP_OWNER = 'mock-owner';
    process.env.GITHUB_BACKUP_REPO = 'mock-repo';
  });

  it('should return 401 Unauthorized if user is not authenticated', async () => {
    const request = new Request('http://localhost/api/backup/test-connection', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {},
    };

    const response = await testConnectionApiHandler(context);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('should return 403 Forbidden if user is not an admin', async () => {
    const request = new Request('http://localhost/api/backup/test-connection', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-2', username: 'member1', role: 'member' },
      },
    };

    const response = await testConnectionApiHandler(context);
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('Forbidden - Admin access required');
  });

  it('should return 400 Bad Request if repository configuration is invalid', async () => {
    const request = new Request('http://localhost/api/backup/test-connection', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    const prevOwner = process.env.GITHUB_BACKUP_OWNER;
    process.env.GITHUB_BACKUP_OWNER = 'invalid owner';

    const response = await testConnectionApiHandler(context);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid GitHub owner format');

    process.env.GITHUB_BACKUP_OWNER = prevOwner;
  });

  it('should return 200 with success: false if token does not have push permissions', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        full_name: 'mock-owner/mock-repo',
        private: true,
        permissions: {
          pull: true,
          push: false,
        },
      }),
    });

    const request = new Request('http://localhost/api/backup/test-connection', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    const response = await testConnectionApiHandler(context);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain('Token không có quyền ghi');
  });

  it('should return 200 with success: true and repository info when connection is healthy', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        full_name: 'mock-owner/mock-repo',
        private: true,
        permissions: {
          pull: true,
          push: true,
        },
      }),
    });

    const request = new Request('http://localhost/api/backup/test-connection', { method: 'POST' });
    const context: any = {
      request,
      url: new URL(request.url),
      locals: {
        user: { id: 'usr-1', username: 'admin1', role: 'admin' },
      },
    };

    const response = await testConnectionApiHandler(context);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.repo).toBe('mock-owner/mock-repo');
  });
});

