import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate } from '../src/bin.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLI - generate (unit)', () => {
  it('creates a sanitized migration file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgq-generate-'));
    tempDirs.push(tempDir);

    await generate('Add Users Table', tempDir);

    const migrationFile = path.join(tempDir, 'migrations', 'add_users_table.sql');
    assert.ok(fs.existsSync(migrationFile));

    const content = fs.readFileSync(migrationFile, 'utf8');
    assert.strictEqual(content, '-- Write your migration SQL here\n');
  });

  it('throws when the migration already exists', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgq-generate-'));
    tempDirs.push(tempDir);

    await generate('duplicate_name', tempDir);

    await assert.rejects(
      () => generate('duplicate_name', tempDir),
      /Migration file already exists/
    );
  });
});
