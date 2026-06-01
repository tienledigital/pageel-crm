import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '@/lib/db';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import {
  createService,
  getService,
  updateService,
  listServices
} from '@/lib/services/serviceManager';

describe('Services Manager CRUD Logic', () => {
  beforeAll(async () => {
    const db = getDb();
    migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });
  });

  it('should successfully create, read, update, and list services', async () => {
    const db = getDb();

    // 1. Create a service
    const service = await createService(db, {
      name: 'Cloud Server Hosting',
      price: 150000,
      billingCycle: 30,
      prefix: 'HOSTING'
    });

    expect(service).toBeDefined();
    expect(service.id).toBeDefined();
    expect(service.name).toBe('Cloud Server Hosting');
    expect(service.price).toBe(150000);
    expect(service.billingCycle).toBe(30);
    expect(service.prefix).toBe('HOSTING');
    expect(service.status).toBe('active');

    // 2. Read the service
    const retrieved = await getService(db, service.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved.name).toBe('Cloud Server Hosting');

    // 3. Update the service
    const updated = await updateService(db, service.id, {
      price: 180000,
      billingCycle: 60,
      status: 'inactive'
    });

    expect(updated).toBeDefined();
    expect(updated.price).toBe(180000);
    expect(updated.billingCycle).toBe(60);
    expect(updated.status).toBe('inactive');

    // 4. List services
    const servicesList = await listServices(db);
    expect(servicesList.length).toBeGreaterThan(0);
    const found = servicesList.find((s) => s.id === service.id);
    expect(found).toBeDefined();
    expect(found?.price).toBe(180000);
  });
});
