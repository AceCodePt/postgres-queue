import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import postgres, { Sql } from 'postgres';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readdirSync } from 'node:fs';

// Global container instance shared across all tests
let globalContainer: StartedTestContainer | null = null;
let globalHost: string;
let globalPort: number;
let dbCounter = 0;

export interface TestContext {
  sql: Sql;
  dbName: string;
}

/**
 * Starts the shared PostgreSQL container (called once)
 */
export async function startGlobalContainer(): Promise<void> {
  if (globalContainer) return;

  console.log('Starting shared PostgreSQL container...');
  
  globalContainer = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'postgres'
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120000)
    .start();

  globalHost = globalContainer.getHost();
  globalPort = globalContainer.getMappedPort(5432);
  
  console.log(`PostgreSQL container running at ${globalHost}:${globalPort}`);
  
  // Test the connection
  const testSql = postgres({
    host: globalHost,
    port: globalPort,
    database: 'postgres',
    user: 'test',
    password: 'test',
  });
  
  await testSql`SELECT 1`;
  await testSql.end();
  
  console.log('PostgreSQL container ready!');
}

/**
 * Stops the shared PostgreSQL container (called once at the end)
 */
export async function stopGlobalContainer(): Promise<void> {
  if (globalContainer) {
    console.log('Stopping shared PostgreSQL container...');
    await globalContainer.stop();
    globalContainer = null;
    console.log('Container stopped');
  }
}

/**
 * Creates a new test database and returns a connection to it
 */
export async function createTestDatabase(options: { runMigrations?: boolean } = {}): Promise<TestContext> {
  if (!globalContainer) {
    throw new Error('Global container not started. Call startGlobalContainer() first.');
  }

  // Generate unique database name
  const dbName = `test_db_${Date.now()}_${dbCounter++}`;
  
  // Connect to postgres database to create new database
  const adminSql = postgres({
    host: globalHost,
    port: globalPort,
    database: 'postgres',
    user: 'test',
    password: 'test',
  });

  // Create database
  await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
  await adminSql.end();

  // Connect to the new database
  const sql = postgres({
    host: globalHost,
    port: globalPort,
    database: dbName,
    user: 'test',
    password: 'test',
    max: 10,
  });

  if (options.runMigrations !== false) {
    const migrationsDir = join(process.cwd(), 'migrations');
    const migrationFiles = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const migrationFile of migrationFiles) {
      const migrationPath = join(migrationsDir, migrationFile);
      const migrationSql = readFileSync(migrationPath, 'utf-8');
      await sql.unsafe(migrationSql);
    }
  }

  return { sql, dbName };
}

export function getDatabaseUrl(dbName: string): string {
  return `postgres://test:test@${globalHost}:${globalPort}/${dbName}`;
}

/**
 * Drops a test database and closes the connection
 */
export async function dropTestDatabase(ctx: TestContext): Promise<void> {
  await ctx.sql.end();
  
  // Connect to postgres database to drop the test database
  const adminSql = postgres({
    host: globalHost,
    port: globalPort,
    database: 'postgres',
    user: 'test',
    password: 'test',
  });

  await adminSql.unsafe(`DROP DATABASE IF EXISTS ${ctx.dbName}`);
  await adminSql.end();
}

/**
 * Clears all data from the queue table
 */
export async function clearQueue(sql: Sql): Promise<void> {
  await sql`DELETE FROM active_listeners`;
  await sql`DELETE FROM broadcasts`;
  await sql`DELETE FROM queue`;
}

/**
 * Helper to wait for a condition to be true
 */
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const timeout = options.timeout || 5000;
  const interval = options.interval || 100;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Helper to get all jobs from the queue
 */
export async function getAllJobs(sql: Sql) {
  return sql`SELECT * FROM queue ORDER BY created_at, id`;
}

/**
 * Helper to get jobs by status
 */
export async function getJobsByStatus(sql: Sql, status: string) {
  return sql`SELECT * FROM queue WHERE status = ${status} ORDER BY created_at, id`;
}

export async function getBroadcasts(sql: Sql, channel: string) {
  return sql`
    SELECT *
    FROM broadcasts
    WHERE channel = ${channel}
    ORDER BY created_at, id
  `;
}
