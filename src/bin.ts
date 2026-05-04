#!/usr/bin/env node

import postgres from 'postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Validates and normalizes a PostgreSQL schema name.
 * @param schema Raw schema input from CLI flag or environment.
 * @returns A safe schema identifier, defaulting to `public`.
 */
function parseSchemaName(schema?: string): string {
  const schemaName = schema?.trim() || 'public';

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }

  return schemaName;
}

/**
 * Escapes an SQL identifier using double-quote syntax.
 * @param identifier Raw identifier value.
 * @returns Escaped identifier suitable for SQL snippets.
 */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Applies all SQL files in the packaged `migrations/` directory.
 * @param databaseUrl Optional PostgreSQL connection string.
 * When omitted, `postgres()` resolves connection details from `PG*` environment variables.
 * @param options Migration options.
 * @param options.schema Optional target schema name.
 */
export async function migrate(
  databaseUrl?: string,
  options: { schema?: string } = {}
) {
  const sql = databaseUrl ? postgres(databaseUrl) : postgres();
  const schemaName = parseSchemaName(options.schema ?? process.env['PGSCHEMA']);
  const quotedSchema = quoteIdentifier(schemaName);

  try {
    console.log(`Running migrations (schema: ${schemaName})...`);

    if (schemaName !== 'public') {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
    }

    // 1. Read migration files
    // The dist/bin.js is in ./dist/, so migrations is at ../migrations/
    const migrationsDir = path.resolve(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    // 2. Apply migrations in a transaction
    await sql.begin(async sql => {
      await sql.unsafe(`SET LOCAL search_path TO ${quotedSchema}, public`);

      for (const file of files) {

        console.log(`Applying migration: ${file}`);
        const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        
        // Execute the entire file content
        // We use sql.unsafe for the raw SQL content
        await sql.unsafe(content);
      }
    });

    console.log('Migrations completed successfully.');
  } catch (err) {
    throw err;
  } finally {
    await sql.end();
  }
}

/**
 * Generates a migration SQL file in `<cwd>/migrations`.
 * @param name Optional migration name used for file naming.
 * Non-alphanumeric characters are replaced with underscores.
 * @param cwd Working directory where `migrations/` lives.
 */
export async function generate(name?: string, cwd = process.cwd()) {
  const migrationsDir = path.resolve(cwd, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
  }

  const fileName = name 
    ? `${name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.sql`
    : `migration.sql`;
  const filePath = path.join(migrationsDir, fileName);

  if (fs.existsSync(filePath)) {
    throw new Error(`Migration file already exists: ${filePath}`);
  }

  fs.writeFileSync(filePath, '-- Write your migration SQL here\n');
  console.log(`Generated migration: ${filePath}`);
}

/**
 * Runs the command-line interface dispatcher.
 * @param argv CLI argument vector excluding `node` and script path.
 */
export async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  const arg = argv[1];

  if (command === 'migrate') {
    const schemaFlag = argv.slice(1).find((value) => value.startsWith('--schema='));
    const schemaValueFromEquals = schemaFlag?.slice('--schema='.length);
    const schemaValueFromNext = arg === '--schema' ? argv[2] : undefined;

    await migrate(process.env['DATABASE_URL'], {
      schema: schemaValueFromEquals ?? schemaValueFromNext
    });
    return;
  }

  if (command === 'generate') {
    await generate(arg);
    return;
  }

  console.log(`
Usage: postgres-queue <command> [options]

Commands:
  migrate    Run database migrations.
  generate   Generate a new migration file.

Options:
  --schema <name>    Apply migrations into the specified schema (default: public)

Environment Variables:
  DATABASE_URL    Postgres connection string
  PGSCHEMA        Default schema for migrate command
  PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT (standard defaults)
  `);
}

const isDirectExecution = process.argv[1] != null
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runCli().catch((err) => {
    if (err instanceof Error) {
      console.error('Command failed:', err.message);
    } else {
      console.error('Command failed:', err);
    }
    process.exit(1);
  });
}
