import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../src/lib/db';
import { config, users } from '../src/lib/db/schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { createSessionCookie } from '../src/lib/auth';
import { t } from '../src/lib/i18n';
import { POST as changeLangHandler } from '../src/pages/api/settings/lang';

const SESSION_SECRET = 'fallback-secret-key-must-be-at-least-32-chars-long';
process.env.SESSION_SECRET = SESSION_SECRET;

function createMockContext(body: any, sessionCookie?: string) {
  const request = new Request('http://localhost/api/settings/lang', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const cookiesMap = new Map();
  if (sessionCookie) {
    cookiesMap.set('session', { value: sessionCookie });
  }

  // To simulate cookie setting, we mock APIContext.cookies.set
  const setCookies: Record<string, any> = {};
  const cookiesObj = {
    get: (name: string) => cookiesMap.get(name),
    set: (name: string, value: any, options: any) => {
      setCookies[name] = { value, options };
    }
  };

  return {
    request,
    url: new URL(request.url),
    cookies: cookiesObj,
    locals: {
      runtime: { env: { SESSION_SECRET } },
      user: sessionCookie ? { id: 'usr-admin', username: 'admin1', role: 'admin' } : undefined
    },
    setCookies // custom reference to inspect set cookies
  };
}

describe('i18n Core & Settings API - Integration Tests', () => {
  let db: any;

  beforeAll(async () => {
    db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  });

  beforeEach(async () => {
    await db.delete(config);
    await db.delete(users);
  });

  describe('Translation Helper t()', () => {
    it('should translate keys correctly in Vietnamese', () => {
      expect(t('sidebar.dashboard', 'vi')).toBe('Tổng quan');
      expect(t('settings.language', 'vi')).toBe('Ngôn ngữ');
    });

    it('should translate keys correctly in English', () => {
      expect(t('sidebar.dashboard', 'en')).toBe('Overview');
      expect(t('settings.language', 'en')).toBe('Language');
    });

    it('should fallback to Vietnamese when language is not supported or key is missing', () => {
      expect(t('sidebar.dashboard', 'fr' as any)).toBe('Tổng quan');
      expect(t('invalid.key', 'vi')).toBe('invalid.key');
    });
  });

  describe('Change Language API endpoint', () => {
    it('should return 401 Unauthorized if user is not logged in', async () => {
      const context: any = createMockContext({ lang: 'en' });
      const response = await changeLangHandler(context);
      expect(response.status).toBe(401);
    });

    it('should set cookie lang to new language and return success', async () => {
      // Seed user
      const userId = 'usr-admin';
      await db.insert(users).values({
        id: userId,
        username: 'admin1',
        passwordHash: 'hash',
        role: 'admin',
      });

      const token = await createSessionCookie({
        id: userId,
        username: 'admin1',
        role: 'admin',
        createdAt: Date.now(),
      }, SESSION_SECRET);

      const context: any = createMockContext({ lang: 'en' }, token);
      const response = await changeLangHandler(context);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.lang).toBe('en');

      // Check cookie was set
      expect(context.setCookies['lang']).toBeDefined();
      expect(context.setCookies['lang'].value).toBe('en');
    });

    it('should reject invalid language values', async () => {
      const userId = 'usr-admin';
      await db.insert(users).values({
        id: userId,
        username: 'admin1',
        passwordHash: 'hash',
        role: 'admin',
      });

      const token = await createSessionCookie({
        id: userId,
        username: 'admin1',
        role: 'admin',
        createdAt: Date.now(),
      }, SESSION_SECRET);

      const context: any = createMockContext({ lang: 'fr' }, token);
      const response = await changeLangHandler(context);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBe('Invalid language');
    });
  });
});
