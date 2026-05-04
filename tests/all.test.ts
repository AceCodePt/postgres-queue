import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import Queue, { ValidationError } from '../src/index.ts';
import { migrate } from '../src/bin.ts';
import {
  startGlobalContainer,
  stopGlobalContainer,
  createTestDatabase,
  dropTestDatabase,
  getDatabaseUrl,
  clearQueue,
  waitFor,
  getAllJobs,
  getJobsByStatus,
  getBroadcasts,
  type TestContext
} from './helpers.ts';

// Shared context for all tests
let ctx: TestContext;
let testCounter = 0;
let activeListeners: Array<{ unlisten: () => Promise<void> }> = [];

// Helper to generate unique channel names
function uniqueChannel(base: string): string {
  return `${base}_${testCounter++}`;
}

function numberPayloadSchema() {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'tests',
      validate(value: unknown) {
        if (
          typeof value === 'object'
          && value !== null
          && 'value' in value
          && typeof (value as { value: unknown }).value === 'number'
        ) {
          return { value: value as { value: number } };
        }

        return {
          issues: [{ message: 'value must be a number' }]
        };
      }
    }
  };
}

before(async () => {
  // Start the shared container once
  await startGlobalContainer();
  
  // Create a database for this test suite
  ctx = await createTestDatabase();
  console.log('Test database ready!');
}, { timeout: 60000 }); // 60 second timeout for container startup

after(async () => {
  // Drop this test database
  if (ctx) {
    await dropTestDatabase(ctx);
  }
  
  // Stop the shared container
  await stopGlobalContainer();
  console.log('Cleanup complete!');
});

beforeEach(async () => {
  // Clean up any active listeners from previous tests
  await Promise.all(activeListeners.map(l => l.unlisten().catch(() => {})));
  activeListeners = [];
  
  // Wait a bit for any pending async operations to settle
  await new Promise(resolve => setTimeout(resolve, 50));
  await clearQueue(ctx.sql);
});

describe('Queue - Core Functionality', () => {
  it('should create a queue instance', () => {
    const queue = Queue(ctx.sql, { channel: 'test' });
    assert.ok(queue);
    assert.ok(typeof queue.enqueue === 'function');
    assert.ok(typeof queue.push === 'function');
    assert.ok(typeof queue.listen === 'function');
  });

  it('should push a job to the queue', async () => {
    const queue = Queue<{ message: string }>(ctx.sql, { channel: 'test_push' });
    
    await queue.enqueue({ message: 'hello' });
    
    const jobs = await getAllJobs(ctx.sql);
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0]?.['status'], 'pending');
    assert.deepStrictEqual(jobs[0]?.['payload'], { message: 'hello' });
  });

  it('should process a job with listen', async () => {
    const queue = Queue<{ value: number }>(ctx.sql, { channel: uniqueChannel('test_listen') });
    
    const processed: any[] = [];
    
    // Start listener
    const listener = await queue.listen(async (payload, job) => {
      processed.push({ payload, job });
    });
    activeListeners.push(listener);

    // Push a job
    await queue.enqueue({ value: 42 });

    // Wait for processing
    await waitFor(async () => {
      const jobs = await getJobsByStatus(ctx.sql, 'completed');
      return jobs.length === 1;
    });

    // Verify job was processed
    assert.strictEqual(processed.length, 1);
    assert.deepStrictEqual(processed[0].payload, { value: 42 });
    assert.ok(processed[0].job.id);
    
    // Verify database state
    const completedJobs = await getJobsByStatus(ctx.sql, 'completed');
    assert.strictEqual(completedJobs.length, 1);
    assert.strictEqual(completedJobs[0]?.['status'], 'completed');
  });

  it('should process multiple jobs', async () => {
    const queue = Queue<{ id: number }>(ctx.sql, { channel: uniqueChannel('test_multiple') });
    
    const processed: number[] = [];
    
    const listener = await queue.listen(async (payload) => {
      processed.push(payload.id);
      // Add small delay to ensure sequential processing
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    activeListeners.push(listener);

    // Push multiple jobs
    await queue.enqueue({ id: 1 });
    await queue.enqueue({ id: 2 });
    await queue.enqueue({ id: 3 });

    // Wait for all jobs to complete
    await waitFor(async () => {
      const jobs = await getJobsByStatus(ctx.sql, 'completed');
      return jobs.length === 3;
    });

    assert.strictEqual(processed.length, 3);
    assert.deepStrictEqual([...processed].sort((a, b) => a - b), [1, 2, 3]);
  });

  it('should stop gracefully after the current job completes', async () => {
    const queue = Queue<{ id: number }>(ctx.sql, { channel: uniqueChannel('test_graceful_stop') });

    const processed: number[] = [];
    let releaseCurrentJob: (() => void) | undefined;
    const currentJobStarted = new Promise<void>((resolve) => {
      releaseCurrentJob = resolve;
    });

    const listener = await queue.listen(async (payload) => {
      processed.push(payload.id);
      if (payload.id === 1) {
        await currentJobStarted;
      }
    });
    activeListeners.push(listener);

    assert.ok(typeof listener.stop === 'function');

    await queue.enqueue({ id: 1 });
    await queue.enqueue({ id: 2 });

    await waitFor(() => processed.includes(1));

    let stopSettled = false;
    const stopPromise = listener.stop().then(() => {
      stopSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(stopSettled, false, 'stop should wait for current job completion');

    releaseCurrentJob?.();
    await stopPromise;

    activeListeners = activeListeners.filter((entry) => entry !== listener);

    await waitFor(async () => {
      const completed = await getJobsByStatus(ctx.sql, 'completed');
      return completed.length === 1;
    });

    const completed = await getJobsByStatus(ctx.sql, 'completed');
    const pending = await getJobsByStatus(ctx.sql, 'pending');

    assert.deepStrictEqual(processed, [1]);
    assert.strictEqual(completed.length, 1);
    assert.strictEqual(pending.length, 1);
  });
});

describe('Queue - Delayed Jobs', () => {
  it('stores explicit runAt when enqueuing', async () => {
    const channel = uniqueChannel('delayed_run_at');
    const queue = Queue<{ value: number }>(ctx.sql, { channel });
    const runAt = new Date(Date.now() + 5_000);

    await queue.enqueue({ value: 1 }, { runAt });

    const [stored] = await ctx.sql<{ run_at: Date }[]>`
      SELECT run_at
      FROM queue
      WHERE channel = ${channel}
      LIMIT 1
    `;

    assert.ok(stored, 'Expected delayed job row to be stored');
    assert.ok(stored.run_at.getTime() >= runAt.getTime() - 5);
  });

  it('computes run_at from delay', async () => {
    const channel = uniqueChannel('delayed_delay');
    const queue = Queue<{ value: number }>(ctx.sql, { channel });
    const beforeEnqueue = Date.now();

    await queue.enqueue({ value: 1 }, { delay: 300 });

    const [stored] = await ctx.sql<{ run_at: Date }[]>`
      SELECT run_at
      FROM queue
      WHERE channel = ${channel}
      LIMIT 1
    `;

    assert.ok(stored, 'Expected delayed job row to be stored');
    assert.ok(stored.run_at.getTime() >= beforeEnqueue + 250);
  });

  it('waits to process delayed jobs until run_at', async () => {
    const queue = Queue<{ value: number }>(ctx.sql, { channel: uniqueChannel('delayed_processing') });
    const processed: number[] = [];

    const listener = await queue.listen(async (payload) => {
      processed.push(payload.value);
    });
    activeListeners.push(listener);

    await queue.enqueue({ value: 42 }, { delay: 350 });

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepStrictEqual(processed, []);

    const pendingBeforeDue = await getJobsByStatus(ctx.sql, 'pending');
    assert.strictEqual(pendingBeforeDue.length, 1);

    await waitFor(async () => {
      const completed = await getJobsByStatus(ctx.sql, 'completed');
      return completed.length === 1;
    }, { timeout: 5_000, interval: 25 });

    assert.deepStrictEqual(processed, [42]);
  });
});

describe('Queue - Recovery and Reconciliation', () => {
  it('reclaims stale active jobs and processes them again', async () => {
    const channel = uniqueChannel('recovery_stale_active');
    const queue = Queue<{ value: number }>(ctx.sql, {
      channel,
      retry: { maxAttempts: 3, backoff: () => 0 },
      recovery: { leaseTimeoutMs: 50, reconcileIntervalMs: 25 }
    });

    await ctx.sql`
      INSERT INTO queue (channel, status, payload, run_at, attempts, max_attempts, updated_at)
      VALUES (
        ${channel},
        'active',
        ${ctx.sql.json({ value: 7 })},
        now(),
        0,
        3,
        now() - interval '1 minute'
      )
    `;

    const processed: number[] = [];
    const listener = await queue.listen(async (payload) => {
      processed.push(payload.value);
    });
    activeListeners.push(listener);

    await waitFor(async () => {
      const [job] = await ctx.sql<{ status: string; attempts: number }[]>`
        SELECT status, attempts
        FROM queue
        WHERE channel = ${channel}
        LIMIT 1
      `;

      return Boolean(job) && job.status === 'completed';
    }, { timeout: 5000, interval: 20 });

    const [job] = await ctx.sql<{ status: string; attempts: number }[]>`
      SELECT status, attempts
      FROM queue
      WHERE channel = ${channel}
      LIMIT 1
    `;

    assert.ok(job, 'Expected recovered job row');
    assert.strictEqual(job.status, 'completed');
    assert.strictEqual(job.attempts, 1);
    assert.deepStrictEqual(processed, [7]);
  });

  it('reconciles pending jobs even when no NOTIFY is emitted', async () => {
    const channel = uniqueChannel('recovery_reconcile_pending');
    const queue = Queue<{ value: string }>(ctx.sql, {
      channel,
      recovery: { reconcileIntervalMs: 30 }
    });

    const processed: string[] = [];
    const listener = await queue.listen(async (payload) => {
      processed.push(payload.value);
    });
    activeListeners.push(listener);

    await queue.enqueue({ value: 'picked-by-reconcile' }, { delay: 60_000 });

    const [delayedJob] = await ctx.sql<{ id: string }[]>`
      SELECT id
      FROM queue
      WHERE channel = ${channel}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    assert.ok(delayedJob, 'Expected delayed job row');

    await ctx.sql`
      UPDATE queue
      SET run_at = now(), updated_at = now()
      WHERE id = ${delayedJob.id}
    `;

    await waitFor(() => processed.length === 1, { timeout: 5000, interval: 20 });
    assert.deepStrictEqual(processed, ['picked-by-reconcile']);
  });
});

describe('Queue - Error Handling', () => {
  it('should mark job as failed when handler throws', async () => {
    const queue = Queue<{ shouldFail: boolean }>(ctx.sql, { channel: uniqueChannel('test_fail') });

    const listener = await queue.listen(async (payload) => {
      if (payload.shouldFail) {
        throw new Error('Simulated failure');
      }
    });
    activeListeners.push(listener);

    await queue.enqueue({ shouldFail: true });

    // Wait for job to fail
    await waitFor(async () => {
      const jobs = await getJobsByStatus(ctx.sql, 'failed');
      return jobs.length === 1;
    });

    const failedJobs = await getJobsByStatus(ctx.sql, 'failed');
    assert.strictEqual(failedJobs.length, 1);
    assert.strictEqual(failedJobs[0]?.['status'], 'failed');
  });

  it('should continue processing after a failed job', async () => {
    const queue = Queue<{ id: number; shouldFail: boolean }>(ctx.sql, { 
      channel: uniqueChannel('test_continue') 
    });

    const processed: number[] = [];

    const listener = await queue.listen(async (payload) => {
      if (payload.shouldFail) {
        throw new Error('Simulated failure');
      }
      processed.push(payload.id);
    });
    activeListeners.push(listener);

    // Push jobs: success, fail, success
    await queue.enqueue({ id: 1, shouldFail: false });
    await queue.enqueue({ id: 2, shouldFail: true });
    await queue.enqueue({ id: 3, shouldFail: false });

    // Wait for processing
    await waitFor(async () => {
      const completed = await getJobsByStatus(ctx.sql, 'completed');
      const failed = await getJobsByStatus(ctx.sql, 'failed');
      return completed.length === 2 && failed.length === 1;
    }, { timeout: 10000 });

    // Verify that successful jobs were processed
    assert.strictEqual(processed.length, 2);
    assert.deepStrictEqual(processed, [1, 3]);

    // Verify database state
    const completedJobs = await getJobsByStatus(ctx.sql, 'completed');
    const failedJobs = await getJobsByStatus(ctx.sql, 'failed');
    assert.strictEqual(completedJobs.length, 2);
    assert.strictEqual(failedJobs.length, 1);
  });

  it('retries failed jobs with configured backoff and then completes', async () => {
    const channel = uniqueChannel('test_retry_success');
    const queue = Queue<{ id: number }>(ctx.sql, {
      channel,
      retry: {
        maxAttempts: 3,
        backoff: (attempt) => attempt * 40
      }
    });

    let handledCount = 0;

    const listener = await queue.listen(async () => {
      handledCount += 1;
      if (handledCount < 3) {
        throw new Error('Simulated retryable failure');
      }
    });
    activeListeners.push(listener);

    await queue.enqueue({ id: 1 });

    await waitFor(async () => {
      const [job] = await ctx.sql<{ status: string; attempts: number; retry_after: Date | null }[]>`
        SELECT status, attempts, retry_after
        FROM queue
        WHERE channel = ${channel}
        LIMIT 1
      `;

      return Boolean(job) && job.status === 'completed';
    }, { timeout: 10_000, interval: 20 });

    const [job] = await ctx.sql<{ status: string; attempts: number; max_attempts: number; retry_after: Date | null }[]>`
      SELECT status, attempts, max_attempts, retry_after
      FROM queue
      WHERE channel = ${channel}
      LIMIT 1
    `;

    assert.ok(job, 'Expected retried job row');
    assert.strictEqual(job.status, 'completed');
    assert.strictEqual(job.attempts, 2);
    assert.strictEqual(job.max_attempts, 3);
    assert.strictEqual(job.retry_after, null);
    assert.strictEqual(handledCount, 3);
  });

  it('marks jobs as failed when max attempts are exhausted', async () => {
    const channel = uniqueChannel('test_retry_exhausted');
    const queue = Queue<{ id: number }>(ctx.sql, {
      channel,
      retry: {
        maxAttempts: 2,
        backoff: () => 30
      }
    });

    let handledCount = 0;

    const listener = await queue.listen(async () => {
      handledCount += 1;
      throw new Error('Always fails');
    });
    activeListeners.push(listener);

    await queue.enqueue({ id: 1 });

    await waitFor(async () => {
      const [job] = await ctx.sql<{ status: string; attempts: number }[]>`
        SELECT status, attempts
        FROM queue
        WHERE channel = ${channel}
        LIMIT 1
      `;

      return Boolean(job) && job.status === 'failed';
    }, { timeout: 10_000, interval: 20 });

    const [job] = await ctx.sql<{ status: string; attempts: number; max_attempts: number; retry_after: Date | null }[]>`
      SELECT status, attempts, max_attempts, retry_after
      FROM queue
      WHERE channel = ${channel}
      LIMIT 1
    `;

    assert.ok(job, 'Expected failed retry row');
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.attempts, 2);
    assert.strictEqual(job.max_attempts, 2);
    assert.strictEqual(job.retry_after, null);
    assert.strictEqual(handledCount, 2);
  });
});

describe('Queue - Concurrency', () => {
  it('should process jobs with multiple workers (SKIP LOCKED)', async () => {
    const channel = uniqueChannel('test_multi_worker');
    const queue1 = Queue<{ id: number }>(ctx.sql, { channel });
    const queue2 = Queue<{ id: number }>(ctx.sql, { channel });

    const worker1Results: number[] = [];
    const worker2Results: number[] = [];

    // Start two workers on the same channel
    const listener1 = await queue1.listen(async (payload) => {
      worker1Results.push(payload.id);
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    activeListeners.push(listener1);

    const listener2 = await queue2.listen(async (payload) => {
      worker2Results.push(payload.id);
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    activeListeners.push(listener2);

    // Push multiple jobs
    await queue1.enqueue({ id: 1 });
    await queue1.enqueue({ id: 2 });
    await queue1.enqueue({ id: 3 });
    await queue1.enqueue({ id: 4 });

    // Wait for all jobs to complete
    await waitFor(async () => {
      const jobs = await getJobsByStatus(ctx.sql, 'completed');
      return jobs.length === 4;
    }, { timeout: 10000 });

    // Both workers should have processed jobs
    const totalProcessed = worker1Results.length + worker2Results.length;
    assert.strictEqual(totalProcessed, 4, 'All 4 jobs should be processed');
    
    // Each worker should have processed at least one job (with high probability)
    assert.ok(worker1Results.length > 0, 'Worker 1 should process at least one job');
    assert.ok(worker2Results.length > 0, 'Worker 2 should process at least one job');

    // No job should be processed by both workers (exactly-once processing)
    const allProcessed = [...worker1Results, ...worker2Results].sort();
    const uniqueProcessed = [...new Set(allProcessed)];
    assert.deepStrictEqual(allProcessed, uniqueProcessed, 'Each job should be processed exactly once');
  });

  it('should ensure exactly-once processing with SKIP LOCKED', async () => {
    const channel = uniqueChannel('test_exactly_once');
    const queue1 = Queue<{ value: string }>(ctx.sql, { channel });
    const queue2 = Queue<{ value: string }>(ctx.sql, { channel });
    const queue3 = Queue<{ value: string }>(ctx.sql, { channel });

    const processedIds = new Set<string>();
    const processCount = { count: 0 };

    const handler = async (_payload: { value: string }, job: any) => {
      processCount.count++;
      processedIds.add(job.id);
      // Simulate some work
      await new Promise(resolve => setTimeout(resolve, 50));
    };

    // Start 3 workers
    const listener1 = await queue1.listen(handler);
    const listener2 = await queue2.listen(handler);
    const listener3 = await queue3.listen(handler);
    activeListeners.push(listener1, listener2, listener3);

    // Push 10 jobs
    for (let i = 0; i < 10; i++) {
      await queue1.enqueue({ value: `job-${i}` });
    }

    // Wait for all to complete
    await waitFor(async () => {
      const jobs = await getJobsByStatus(ctx.sql, 'completed');
      return jobs.length === 10;
    }, { timeout: 10000 });

    // Each job should be processed exactly once
    assert.strictEqual(processCount.count, 10, 'Exactly 10 jobs should be processed');
    assert.strictEqual(processedIds.size, 10, 'All job IDs should be unique');

    // Verify database state
    const completedJobs = await getJobsByStatus(ctx.sql, 'completed');
    assert.strictEqual(completedJobs.length, 10);
  });
});

describe('Queue - Channels, Broadcasts and Validation', () => {
  it('isolates jobs by channel', async () => {
    const queueA = Queue<{ source: string }>(ctx.sql, { channel: uniqueChannel('channel_a') });
    const queueB = Queue<{ source: string }>(ctx.sql, { channel: uniqueChannel('channel_b') });

    const processedA: string[] = [];
    const processedB: string[] = [];

    const listenerA = await queueA.listen(async (payload) => {
      processedA.push(payload.source);
    });
    const listenerB = await queueB.listen(async (payload) => {
      processedB.push(payload.source);
    });
    activeListeners.push(listenerA, listenerB);

    await queueA.enqueue({ source: 'a' });
    await queueB.enqueue({ source: 'b' });

    await waitFor(() => processedA.length === 1 && processedB.length === 1);

    assert.deepStrictEqual(processedA, ['a']);
    assert.deepStrictEqual(processedB, ['b']);
  });

  it('stores and delivers broadcast messages to all subscribers', async () => {
    const channel = uniqueChannel('broadcast');
    const queue1 = Queue<{ value: number }>(ctx.sql, { channel });
    const queue2 = Queue<{ value: number }>(ctx.sql, { channel });
    const receivedByFirst: Array<{ payload: { value: number }; type: string }> = [];
    const receivedBySecond: Array<{ payload: { value: number }; type: string }> = [];

    const listener1 = await queue1.listen(async (payload, job) => {
      if (job.type === 'broadcast') {
        receivedByFirst.push({ payload, type: job.type });
      }
    });
    const listener2 = await queue2.listen(async (payload, job) => {
      if (job.type === 'broadcast') {
        receivedBySecond.push({ payload, type: job.type });
      }
    });
    activeListeners.push(listener1, listener2);

    await queue1.enqueue({ value: 99 }, { broadcast: true });

    await waitFor(() => receivedByFirst.length === 1 && receivedBySecond.length === 1);

    assert.deepStrictEqual(receivedByFirst, [{ payload: { value: 99 }, type: 'broadcast' }]);
    assert.deepStrictEqual(receivedBySecond, [{ payload: { value: 99 }, type: 'broadcast' }]);

    const broadcasts = await getBroadcasts(ctx.sql, channel);
    assert.strictEqual(broadcasts.length, 1);
    assert.deepStrictEqual(broadcasts[0]?.['payload'], { value: 99 });
  });

  it('keeps broadcast fan-out and queue exactly-once semantics', async () => {
    const channel = uniqueChannel('broadcast_isolation');
    const queue1 = Queue<{ value: number }>(ctx.sql, { channel });
    const queue2 = Queue<{ value: number }>(ctx.sql, { channel });

    const worker1 = { queue: [] as number[], broadcast: [] as number[] };
    const worker2 = { queue: [] as number[], broadcast: [] as number[] };

    const listener1 = await queue1.listen(async (payload, job) => {
      if (job.type === 'broadcast') {
        worker1.broadcast.push(payload.value);
        return;
      }

      worker1.queue.push(payload.value);
    });

    const listener2 = await queue2.listen(async (payload, job) => {
      if (job.type === 'broadcast') {
        worker2.broadcast.push(payload.value);
        return;
      }

      worker2.queue.push(payload.value);
    });

    activeListeners.push(listener1, listener2);

    await queue1.enqueue({ value: 1 }, { broadcast: true });
    await waitFor(() => worker1.broadcast.length === 1 && worker2.broadcast.length === 1);

    await queue1.enqueue({ value: 2 });
    await waitFor(() => worker1.queue.length + worker2.queue.length === 1);

    assert.deepStrictEqual(worker1.broadcast, [1]);
    assert.deepStrictEqual(worker2.broadcast, [1]);
    assert.strictEqual(worker1.queue.length + worker2.queue.length, 1);
  });

  it('validates payloads on enqueue when schema is provided', async () => {
    const queue = Queue(ctx.sql, {
      channel: uniqueChannel('schema_enqueue'),
      schema: numberPayloadSchema()
    });

    await queue.enqueue({ value: 1 });

    await assert.rejects(
      () => queue.enqueue({ value: 'oops' } as unknown as { value: number }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        return true;
      }
    );
  });

  it('validates payloads while listening and fails invalid queued rows', async () => {
    const channel = uniqueChannel('schema_listen');
    const queue = Queue(ctx.sql, {
      channel,
      schema: numberPayloadSchema()
    });

    await ctx.sql`
      INSERT INTO queue (channel, payload)
      VALUES (${channel}, ${ctx.sql.json({ value: 'bad' })})
    `;

    const listener = await queue.listen(async () => {
      assert.fail('Handler should not run for invalid payloads');
    });
    activeListeners.push(listener);

    await waitFor(async () => {
      const failed = await getJobsByStatus(ctx.sql, 'failed');
      return failed.length === 1;
    });
  });

  it('auto-generates isolated channels when omitted', async () => {
    const queueA = Queue<{ value: string }>(ctx.sql);
    const queueB = Queue<{ value: string }>(ctx.sql);

    const seenA: string[] = [];
    const seenB: string[] = [];

    const listenerA = await queueA.listen(async (payload) => {
      seenA.push(payload.value);
    });

    const listenerB = await queueB.listen(async (payload) => {
      seenB.push(payload.value);
    });

    activeListeners.push(listenerA, listenerB);

    await queueA.enqueue({ value: 'from-a' });

    await waitFor(() => seenA.length === 1);
    assert.deepStrictEqual(seenA, ['from-a']);
    assert.deepStrictEqual(seenB, []);
  });
});

describe('Queue - Listener Heartbeat', () => {
  it('registers active listeners and removes them on unlisten', async () => {
    const channel = uniqueChannel('heartbeat_register');
    const queue = Queue<{ value: string }>(ctx.sql, {
      channel,
      heartbeat: { interval: 50, timeout: 300 }
    });

    const listener = await queue.listen(async () => {
      // no-op
    });
    activeListeners.push(listener);

    await waitFor(async () => {
      const rows = await ctx.sql<{ id: string }[]>`
        SELECT id
        FROM active_listeners
        WHERE channel = ${channel}
      `;

      return rows.length === 1;
    });

    const [row] = await ctx.sql<{ id: string }[]>`
      SELECT id
      FROM active_listeners
      WHERE channel = ${channel}
      LIMIT 1
    `;

    assert.ok(row, 'Expected an active listener row');
    assert.match(
      row.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'Expected listener ID to be UUIDv7'
    );

    await listener.unlisten();
    activeListeners = activeListeners.filter((entry) => entry !== listener);

    await waitFor(async () => {
      const rows = await ctx.sql<{ id: string }[]>`
        SELECT id
        FROM active_listeners
        WHERE channel = ${channel}
      `;

      return rows.length === 0;
    });
  });

  it('updates listener heartbeat timestamps while running', async () => {
    const channel = uniqueChannel('heartbeat_update');
    const queue = Queue<{ value: number }>(ctx.sql, {
      channel,
      heartbeat: { interval: 50, timeout: 500 }
    });

    const listener = await queue.listen(async () => {
      // no-op
    });
    activeListeners.push(listener);

    const [initial] = await ctx.sql<{ last_seen_at: Date }[]>`
      SELECT last_seen_at
      FROM active_listeners
      WHERE channel = ${channel}
      LIMIT 1
    `;

    assert.ok(initial, 'Expected listener heartbeat row');

    await waitFor(async () => {
      const [updated] = await ctx.sql<{ last_seen_at: Date }[]>`
        SELECT last_seen_at
        FROM active_listeners
        WHERE channel = ${channel}
        LIMIT 1
      `;

      if (!updated) return false;
      return updated.last_seen_at.getTime() > initial.last_seen_at.getTime();
    }, { timeout: 2000, interval: 50 });
  });

  it('cleans up stale listeners during heartbeat ticks', async () => {
    const channel = uniqueChannel('heartbeat_cleanup');
    const [stale] = await ctx.sql<{ id: string }[]>`
      INSERT INTO active_listeners (channel, last_seen_at)
      VALUES (${channel}, now() - interval '1 minute')
      RETURNING id
    `;

    const queue = Queue<{ value: string }>(ctx.sql, {
      channel,
      heartbeat: { interval: 50, timeout: 120 }
    });

    const listener = await queue.listen(async () => {
      // no-op
    });
    activeListeners.push(listener);

    await waitFor(async () => {
      const rows = await ctx.sql<{ id: string }[]>`
        SELECT id
        FROM active_listeners
        WHERE channel = ${channel}
      `;

      return rows.length === 1 && rows[0]?.id !== stale.id;
    }, { timeout: 3000, interval: 50 });
  });
});

describe('CLI - migrate (integration)', () => {
  it('applies migrations to a custom schema', async () => {
    const migrationCtx = await createTestDatabase({ runMigrations: false });

    try {
      await migrate(getDatabaseUrl(migrationCtx.dbName), { schema: 'queue_app' });

      const [customSchemaQueueTable] = await migrationCtx.sql<{ exists: string | null }[]>`
        SELECT to_regclass('queue_app.queue') AS exists
      `;
      assert.strictEqual(customSchemaQueueTable?.['exists'], 'queue_app.queue');

      const [publicQueueTable] = await migrationCtx.sql<{ exists: string | null }[]>`
        SELECT to_regclass('public.queue') AS exists
      `;
      assert.strictEqual(publicQueueTable?.['exists'], null);

      const [migrationTable] = await migrationCtx.sql<{ exists: string | null }[]>`
        SELECT to_regclass('queue_app._pg_queue_migrations') AS exists
      `;
      assert.strictEqual(migrationTable?.['exists'], null);
    } finally {
      await dropTestDatabase(migrationCtx);
    }
  });
});
