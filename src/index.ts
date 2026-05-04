import type { Sql } from 'postgres';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export type QueueStatus = 'pending' | 'active' | 'completed' | 'failed';

type StandardSchema = StandardSchemaV1;
type InferOutput<TSchema extends StandardSchema> = StandardSchemaV1.InferOutput<TSchema>;

/**
 * Metadata passed to listener handlers for each delivered message.
 */
export interface Job {
  /**
   * Unique identifier for the queue row or broadcast row.
   */
  id: string;

  /**
   * Delivery mode for this handler invocation.
   * - `queue`: exactly-once queue consumption
   * - `broadcast`: fan-out delivery to all active listeners
   */
  type: 'queue' | 'broadcast';

  /**
   * Creation timestamp stored in PostgreSQL for the backing row.
   */
  createdAt: Date;
}

interface QueueRow {
  id: string;
  payload: unknown;
  created_at: Date;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  retry_after: Date | null;
}

interface BroadcastRow {
  id: string;
  payload: unknown;
  created_at: Date;
}

interface NextDelayedRunRow {
  run_at: Date;
}

/**
 * Structured issue returned by a Standard Schema validator.
 */
export interface ValidationIssue {
  /**
   * Human-readable validation failure message.
   */
  message: string;

  /**
   * Optional path describing where the validation issue occurred.
   */
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
}

/**
 * Error thrown when runtime payload validation fails.
 */
export class ValidationError extends Error {
  /**
   * Collection of validator-reported issues.
   */
  readonly issues: ReadonlyArray<ValidationIssue>;

  /**
   * @param message Error message describing validation failure.
   * @param issues Validator issues for the payload.
   */
  constructor(message: string, issues: ReadonlyArray<ValidationIssue>) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * Queue creation options.
 */
export interface QueueOptions<TSchema extends StandardSchema | undefined = undefined> {
  /**
   * PostgreSQL LISTEN/NOTIFY channel for this queue.
   * If omitted, a random isolated channel is generated.
   */
  channel?: string;

  /**
   * Optional Standard Schema validator used for runtime payload checks.
   */
  schema?: TSchema;

  /**
   * Heartbeat tracking for active listeners.
   * - `true` or omitted: enabled with defaults
   * - `false`: disabled
   * - object: custom heartbeat settings
   */
  heartbeat?: boolean | HeartbeatOptions;

  /**
   * Retry strategy for failed queue jobs.
   */
  retry?: RetryOptions;

  /**
   * Crash recovery and reconciliation behavior.
   */
  recovery?: boolean | RecoveryOptions;
}

/**
 * Retry policy used for queue jobs that throw in the handler.
 */
export interface RetryOptions {
  /**
   * Maximum number of processing attempts before failing the job.
   */
  maxAttempts?: number;

  /**
   * Backoff strategy between retry attempts.
   * - `exponential`: `baseDelay * 2^(attempt-1)`
   * - function: custom delay in milliseconds for a given attempt number
   */
  backoff?: 'exponential' | ((attempt: number) => number);

  /**
   * Base delay in milliseconds for retry calculations.
   */
  baseDelay?: number;

  /**
   * Maximum allowed delay in milliseconds after clamping.
   */
  maxDelay?: number;
}

/**
 * Listener heartbeat configuration.
 */
export interface HeartbeatOptions {
  /**
   * Enables or disables heartbeat when options object is provided.
   */
  enabled?: boolean;

  /**
   * Interval in milliseconds between heartbeat updates.
   */
  interval?: number;

  /**
   * Staleness timeout in milliseconds used for cleanup.
   * Must be greater than `interval`.
   */
  timeout?: number;
}

/**
 * Recovery configuration for crashed workers and missed NOTIFY events.
 */
export interface RecoveryOptions {
  /**
   * Enables or disables recovery when options object is provided.
   */
  enabled?: boolean;

  /**
   * Time in milliseconds after which `active` jobs are considered stale
   * and reclaimed for retry/failure handling.
   */
  leaseTimeoutMs?: number;

  /**
   * Interval in milliseconds for reconciliation sweeps that trigger drains
   * even when no NOTIFY is received.
   */
  reconcileIntervalMs?: number;
}

/**
 * Options for `enqueue`/`push` calls.
 */
export interface EnqueueOptions {
  /**
   * When true, writes to `broadcasts` for fan-out delivery instead of queueing.
   */
  broadcast?: boolean;

  /**
   * Absolute schedule time for delayed queue processing.
   * Mutually exclusive with `delay`.
   */
  runAt?: Date;

  /**
   * Relative delay in milliseconds before queue processing starts.
   * Mutually exclusive with `runAt`.
   */
  delay?: number;
}

/**
 * Queue API returned by `Queue(...)`.
 */
export interface QueueInstance<T> {
  /**
   * Adds a payload to the queue or to broadcasts based on options.
   * @param payload Payload to persist and later deliver to listeners.
   * @param options Delivery mode and scheduling options.
   */
  enqueue(payload: T, options?: EnqueueOptions): Promise<void>;

  /**
   * Backwards-compatible alias for `enqueue`.
   * @param payload Payload to persist and later deliver to listeners.
   * @param options Delivery mode and scheduling options.
   */
  push(payload: T, options?: EnqueueOptions): Promise<void>;

  /**
   * Starts queue and broadcast listeners for the configured channel.
   * @param handler Async or sync handler invoked for each delivered message.
   */
  listen(handler: (payload: T, job: Job) => Promise<void> | void): Promise<{
    stop: () => Promise<void>;
    unlisten: () => Promise<void>;
  }>;
}

/**
 * Resolves delayed execution time for an enqueue request.
 * @param enqueueOptions Enqueue scheduling options.
 * @returns The scheduled time or `undefined` for immediate execution.
 */
function resolveRunAt(enqueueOptions: EnqueueOptions): Date | undefined {
  if (enqueueOptions.runAt && enqueueOptions.delay != null) {
    throw new Error('Provide either runAt or delay, not both');
  }

  if (enqueueOptions.runAt != null) {
    if (!(enqueueOptions.runAt instanceof Date) || Number.isNaN(enqueueOptions.runAt.getTime())) {
      throw new Error('runAt must be a valid Date');
    }

    return enqueueOptions.runAt;
  }

  if (enqueueOptions.delay != null) {
    if (!Number.isFinite(enqueueOptions.delay) || enqueueOptions.delay < 0) {
      throw new Error('delay must be a non-negative number');
    }

    return new Date(Date.now() + enqueueOptions.delay);
  }

  return undefined;
}

/**
 * Resolves the queue channel name.
 * @param channel Optional explicit channel name.
 * @returns The provided channel or a generated isolated channel.
 */
function resolveChannel(channel?: string): string {
  if (channel && channel.length > 0) return channel;
  return `queue_${crypto.randomUUID()}`;
}

/**
 * Derives the LISTEN/NOTIFY channel used for broadcasts.
 * @param channel Base queue channel.
 * @returns Broadcast channel suffixing the base channel.
 */
function resolveBroadcastChannel(channel: string): string {
  return `${channel}_broadcast`;
}

/**
 * Generates a UUIDv7 value in userland for listener heartbeat rows.
 * @returns UUIDv7 string.
 */
function generateUuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const timestamp = BigInt(Date.now());

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);

  const byte6 = bytes[6] ?? 0;
  const byte8 = bytes[8] ?? 0;
  bytes[6] = (byte6 & 0x0f) | 0x70;
  bytes[8] = (byte8 & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 1;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_RECOVERY_LEASE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RECOVERY_RECONCILE_INTERVAL_MS = 1_000;

interface ResolvedHeartbeatOptions {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  getDelayMs: (attempt: number) => number;
}

interface ResolvedRecoveryOptions {
  enabled: boolean;
  leaseTimeoutMs: number;
  reconcileIntervalMs: number;
}

/**
 * Normalizes heartbeat options into validated runtime values.
 * @param heartbeat Heartbeat options from queue construction.
 * @returns Resolved heartbeat configuration.
 */
function resolveHeartbeatOptions(heartbeat?: boolean | HeartbeatOptions): ResolvedHeartbeatOptions {
  if (heartbeat === false) {
    return {
      enabled: false,
      intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      timeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS
    };
  }

  const heartbeatOptions = heartbeat === true || heartbeat == null ? {} : heartbeat;
  const intervalMs = heartbeatOptions.interval ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const timeoutMs = heartbeatOptions.timeout ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const enabled = heartbeatOptions.enabled ?? true;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('heartbeat.interval must be a positive number');
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('heartbeat.timeout must be a positive number');
  }

  if (timeoutMs <= intervalMs) {
    throw new Error('heartbeat.timeout must be greater than heartbeat.interval');
  }

  return { enabled, intervalMs, timeoutMs };
}

/**
 * Normalizes retry options into validated runtime values.
 * @param retry Retry options from queue construction.
 * @returns Resolved retry configuration.
 */
function resolveRetryOptions(retry?: RetryOptions): ResolvedRetryOptions {
  if (!retry) {
    return {
      maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
      getDelayMs: () => 0
    };
  }

  const maxAttempts = retry.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('retry.maxAttempts must be an integer >= 1');
  }

  const baseDelayMs = retry.baseDelay ?? DEFAULT_RETRY_BASE_DELAY_MS;
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error('retry.baseDelay must be a non-negative number');
  }

  const maxDelayMs = retry.maxDelay ?? DEFAULT_RETRY_MAX_DELAY_MS;
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new Error('retry.maxDelay must be a non-negative number');
  }

  if (maxDelayMs < baseDelayMs) {
    throw new Error('retry.maxDelay must be greater than or equal to retry.baseDelay');
  }

  const backoff = retry.backoff ?? 'exponential';

  return {
    maxAttempts,
    getDelayMs: (attempt: number) => {
      if (!Number.isInteger(attempt) || attempt < 1) {
        throw new Error('attempt must be an integer >= 1');
      }

      const rawDelayMs = backoff === 'exponential'
        ? baseDelayMs * (2 ** (attempt - 1))
        : backoff(attempt);

      if (!Number.isFinite(rawDelayMs) || rawDelayMs < 0) {
        throw new Error('retry.backoff must resolve to a non-negative number');
      }

      return Math.min(rawDelayMs, maxDelayMs);
    }
  };
}

/**
 * Normalizes recovery options into validated runtime values.
 * @param recovery Recovery options from queue construction.
 * @returns Resolved recovery configuration.
 */
function resolveRecoveryOptions(recovery?: boolean | RecoveryOptions): ResolvedRecoveryOptions {
  if (recovery === false) {
    return {
      enabled: false,
      leaseTimeoutMs: DEFAULT_RECOVERY_LEASE_TIMEOUT_MS,
      reconcileIntervalMs: DEFAULT_RECOVERY_RECONCILE_INTERVAL_MS
    };
  }

  const recoveryOptions = recovery === true || recovery == null ? {} : recovery;
  const enabled = recoveryOptions.enabled ?? true;
  const leaseTimeoutMs = recoveryOptions.leaseTimeoutMs ?? DEFAULT_RECOVERY_LEASE_TIMEOUT_MS;
  const reconcileIntervalMs = recoveryOptions.reconcileIntervalMs ?? DEFAULT_RECOVERY_RECONCILE_INTERVAL_MS;

  if (!Number.isFinite(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
    throw new Error('recovery.leaseTimeoutMs must be a positive number');
  }

  if (!Number.isFinite(reconcileIntervalMs) || reconcileIntervalMs <= 0) {
    throw new Error('recovery.reconcileIntervalMs must be a positive number');
  }

  return { enabled, leaseTimeoutMs, reconcileIntervalMs };
}

/**
 * Validates payload via Standard Schema when configured.
 * @param schema Optional runtime schema validator.
 * @param payload Raw payload to validate.
 * @returns Validated payload with inferred output type.
 */
async function validatePayload<T>(schema: StandardSchema | undefined, payload: unknown): Promise<T> {
  if (!schema) return payload as T;

  const result = await schema['~standard'].validate(payload);
  if (result.issues) {
    throw new ValidationError('Invalid payload', result.issues);
  }

  return result.value as T;
}

/**
 * Creates a queue instance with type-only payload safety.
 * @param sql A `postgres` client instance.
 * @param options Queue behavior options.
 */
export default function Queue<T>(sql: Sql, options?: QueueOptions): QueueInstance<T>;
/**
 * Creates a queue instance with runtime schema validation.
 * @param sql A `postgres` client instance.
 * @param options Queue behavior options including a Standard Schema validator.
 */
export default function Queue<TSchema extends StandardSchema>(
  sql: Sql,
  options: QueueOptions<TSchema> & { schema: TSchema }
): QueueInstance<InferOutput<TSchema>>;
/**
 * Creates a queue bound to a channel with optional validation, retries,
 * heartbeat tracking, and recovery/reconciliation.
 * @param sql A `postgres` client instance.
 * @param options Queue behavior options.
 * @returns Queue API for enqueueing payloads and starting listeners.
 */
export default function Queue<T = unknown, TSchema extends StandardSchema | undefined = undefined>(
  sql: Sql,
  options: QueueOptions<TSchema> = {}
): QueueInstance<TSchema extends StandardSchema ? InferOutput<Exclude<TSchema, undefined>> : T> {
  type Payload = TSchema extends StandardSchema ? InferOutput<Exclude<TSchema, undefined>> : T;

  const channel = resolveChannel(options.channel);
  const broadcastChannel = resolveBroadcastChannel(channel);
  const schema = options.schema as StandardSchema | undefined;
  const heartbeat = resolveHeartbeatOptions(options.heartbeat);
  const retry = resolveRetryOptions(options.retry);
  const recovery = resolveRecoveryOptions(options.recovery);

  /**
   * Persists and notifies a broadcast payload for fan-out delivery.
   * @param payload Payload to broadcast to all active listeners.
   */
  async function broadcast(payload: Payload) {
    const validatedPayload = await validatePayload<Payload>(schema, payload);

    await sql`
      INSERT INTO broadcasts (channel, payload)
      VALUES (${channel}, ${sql.json(validatedPayload as any)})
    `;
  }

  /**
   * Enqueues a queue job or a broadcast message.
   * @param payload Payload to store.
   * @param enqueueOptions Delivery and scheduling options.
   */
  async function enqueue(payload: Payload, enqueueOptions: EnqueueOptions = {}) {
    if (enqueueOptions.broadcast) {
      if (enqueueOptions.runAt != null || enqueueOptions.delay != null) {
        throw new Error('Delayed broadcasts are not supported');
      }

      await broadcast(payload);
      return;
    }

    const validatedPayload = await validatePayload<Payload>(schema, payload);
    const runAt = resolveRunAt(enqueueOptions);

    await sql`
      INSERT INTO queue (channel, payload, run_at, max_attempts)
      VALUES (${channel}, ${sql.json(validatedPayload as any)}, ${runAt ?? new Date()}, ${retry.maxAttempts})
      RETURNING id, created_at
    `;
  }

  /**
   * Drains available jobs from the queue and invokes the handler.
   * @param handler Listener callback for each claimed queue job.
   * @param shouldContinue Guard used to stop draining during shutdown.
   * @returns `true` if at least one job was processed.
   */
  async function drainQueue(
    handler: (payload: Payload, job: Job) => Promise<void> | void,
    shouldContinue: () => boolean
  ): Promise<boolean> {
    let processedAny = false;

    if (recovery.enabled) {
      const staleJobs = await sql<Pick<QueueRow, 'id' | 'attempts' | 'max_attempts'>[]>`
        SELECT id, attempts, max_attempts
        FROM queue
        WHERE channel = ${channel}
          AND status = 'active'
          AND updated_at < now() - (${recovery.leaseTimeoutMs} * interval '1 millisecond')
        FOR UPDATE SKIP LOCKED
      `;

      for (const staleJob of staleJobs) {
        const nextAttempts = staleJob.attempts + 1;

        if (nextAttempts < staleJob.max_attempts) {
          const retryAfter = new Date(Date.now() + retry.getDelayMs(nextAttempts));
          await sql`
            UPDATE queue
            SET status = 'pending', attempts = ${nextAttempts}, retry_after = ${retryAfter}, updated_at = now()
            WHERE id = ${staleJob.id}
          `;
          continue;
        }

        await sql`
          UPDATE queue
          SET status = 'failed', attempts = ${nextAttempts}, retry_after = NULL, updated_at = now()
          WHERE id = ${staleJob.id}
        `;
      }
    }

    while (shouldContinue()) {
      const [job] = await sql<QueueRow[]>`
        UPDATE queue
        SET status = 'active', retry_after = NULL, updated_at = now()
        WHERE id = (
          SELECT id
          FROM queue
          WHERE channel = ${channel}
            AND status = 'pending'
            AND GREATEST(run_at, COALESCE(retry_after, run_at)) <= now()
          ORDER BY GREATEST(run_at, COALESCE(retry_after, run_at)), id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, payload, created_at, run_at, attempts, max_attempts, retry_after
      `;

      if (!job) return processedAny;

      processedAny = true;

      try {
        const payload = await validatePayload<Payload>(schema, job.payload);
        await handler(payload, {
          id: job.id,
          type: 'queue',
          createdAt: job.created_at
        });
        await sql`UPDATE queue SET status = 'completed', retry_after = NULL, updated_at = now() WHERE id = ${job.id}`;
      } catch {
        const nextAttempts = job.attempts + 1;
        if (nextAttempts < job.max_attempts) {
          const retryAfter = new Date(Date.now() + retry.getDelayMs(nextAttempts));
          await sql`
            UPDATE queue
            SET status = 'pending', attempts = ${nextAttempts}, retry_after = ${retryAfter}, updated_at = now()
            WHERE id = ${job.id}
          `;
          continue;
        }

        await sql`
          UPDATE queue
          SET status = 'failed', attempts = ${nextAttempts}, retry_after = NULL, updated_at = now()
          WHERE id = ${job.id}
        `;
      }
    }

    return processedAny;
  }

  /**
   * Finds the next future-ready timestamp for delayed pending jobs.
   * @returns The earliest delayed run time or `undefined` when none exist.
   */
  async function findNextDelayedRunAt(): Promise<Date | undefined> {
    const [nextDelayedJob] = await sql<NextDelayedRunRow[]>`
      SELECT GREATEST(run_at, COALESCE(retry_after, run_at)) AS run_at
      FROM queue
      WHERE channel = ${channel}
        AND status = 'pending'
        AND GREATEST(run_at, COALESCE(retry_after, run_at)) > now()
      ORDER BY GREATEST(run_at, COALESCE(retry_after, run_at))
      LIMIT 1
    `;

    return nextDelayedJob?.run_at;
  }

  /**
   * Resolves a broadcast notification payload to a DB row and handles it.
   * @param payload Broadcast NOTIFY payload containing broadcast row ID.
   * @param handler Listener callback used for delivery.
   */
  async function processBroadcast(payload: string, handler: (value: Payload, job: Job) => Promise<void> | void) {
    if (!payload) return;

    const [broadcast] = await sql<BroadcastRow[]>`
      SELECT id, payload, created_at
      FROM broadcasts
      WHERE channel = ${channel} AND id = ${payload}
      LIMIT 1
    `;

    if (!broadcast) return;

    try {
      const value = await validatePayload<Payload>(schema, broadcast.payload);
      await handler(value, {
        id: broadcast.id,
        type: 'broadcast',
        createdAt: broadcast.created_at
      });
    } catch {
      // Broadcasts are fire-and-forget and have no status transitions.
    }
  }

  return {
    enqueue,
    push: enqueue,

    /**
     * Starts listening for queue and broadcast notifications.
     * @param handler Callback invoked for each processed payload.
     */
    async listen(handler) {
      let draining = false;
      let rerunDrain = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let listenerId: string | undefined;
      let stopping = false;
      let drainPromise: Promise<void> | undefined;
      let stopPromise: Promise<void> | undefined;
      let delayedDrainTimer: ReturnType<typeof setTimeout> | undefined;
      let delayedDrainAtMs: number | undefined;
      let reconcileTimer: ReturnType<typeof setInterval> | undefined;

      /**
       * Clears the delayed-drain timeout, if present.
       */
      const clearDelayedDrainTimer = () => {
        if (!delayedDrainTimer) return;
        clearTimeout(delayedDrainTimer);
        delayedDrainTimer = undefined;
        delayedDrainAtMs = undefined;
      };

      /**
       * Schedules a drain at the specified absolute time.
       * @param runAt Absolute run time used for the timer.
       */
      const scheduleDrainAt = (runAt: Date) => {
        if (stopping) return;

        const runAtMs = runAt.getTime();

        if (Number.isNaN(runAtMs)) return;

        if (delayedDrainAtMs != null && delayedDrainAtMs <= runAtMs) {
          return;
        }

        clearDelayedDrainTimer();

        const delayMs = Math.max(runAtMs - Date.now(), 0);
        delayedDrainAtMs = runAtMs;
        delayedDrainTimer = setTimeout(() => {
          delayedDrainTimer = undefined;
          delayedDrainAtMs = undefined;
          scheduleDrain();
        }, delayMs);
        delayedDrainTimer.unref?.();
      };

      /**
       * Looks up and schedules the nearest delayed pending job.
       */
      const scheduleNextDelayedDrain = async () => {
        if (stopping) return;

        const runAt = await findNextDelayedRunAt();
        if (!runAt) {
          clearDelayedDrainTimer();
          return;
        }

        scheduleDrainAt(runAt);
      };

      /**
       * Starts or queues a drain pass for ready jobs.
       */
      const scheduleDrain = () => {
        if (stopping) return;

        clearDelayedDrainTimer();

        if (draining) {
          rerunDrain = true;
          return;
        }

        draining = true;

        drainPromise = (async () => {
          try {
            do {
              rerunDrain = false;
              await drainQueue(handler, () => !stopping);
            } while (rerunDrain);

            await scheduleNextDelayedDrain();
          } finally {
            draining = false;
          }
        })();

        void drainPromise;
      };

      const queueListener = await sql.listen(channel, async () => {
        scheduleDrain();
      });
      const broadcastListener = await sql.listen(broadcastChannel, async (payload) => {
        await processBroadcast(payload, handler);
      });

      if (heartbeat.enabled) {
        const generatedListenerId = generateUuidV7();
        const [activeListener] = await sql<{ id: string }[]>`
          INSERT INTO active_listeners (id, channel)
          VALUES (${generatedListenerId}, ${channel})
          RETURNING id
        `;

        listenerId = activeListener?.id;

        if (!listenerId) {
          throw new Error('Failed to register listener heartbeat');
        }

        const registeredListenerId = listenerId;

        const removeStaleListeners = async () => {
          await sql`
            DELETE FROM active_listeners
            WHERE channel = ${channel}
              AND last_seen_at < now() - (${heartbeat.timeoutMs} * interval '1 millisecond')
          `;
        };

        let heartbeatInFlight = false;

        const sendHeartbeat = async () => {
          if (heartbeatInFlight) return;
          heartbeatInFlight = true;

          try {
            await sql`
              UPDATE active_listeners
              SET last_seen_at = now()
              WHERE id = ${registeredListenerId}
            `;

            await removeStaleListeners();
          } finally {
            heartbeatInFlight = false;
          }
        };

        await removeStaleListeners();
        heartbeatTimer = setInterval(() => {
          void sendHeartbeat();
        }, heartbeat.intervalMs);
        heartbeatTimer.unref?.();
      }

      scheduleDrain();

      if (recovery.enabled) {
        reconcileTimer = setInterval(() => {
          scheduleDrain();
        }, recovery.reconcileIntervalMs);
        reconcileTimer.unref?.();
      }

      /**
       * Stops listeners, timers, and waits for in-flight drain completion.
       */
      const stopListener = async () => {
        if (stopPromise) return stopPromise;

        stopPromise = (async () => {
          stopping = true;

          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }

          clearDelayedDrainTimer();

          if (reconcileTimer) {
            clearInterval(reconcileTimer);
            reconcileTimer = undefined;
          }

          let unlistenError: unknown;

          try {
            await queueListener.unlisten();
          } catch (error) {
            unlistenError = error;
          }

          try {
            await broadcastListener.unlisten();
          } catch (error) {
            unlistenError ??= error;
          }

          if (drainPromise) {
            await drainPromise;
          }

          if (listenerId) {
            await sql`
              DELETE FROM active_listeners
              WHERE id = ${listenerId}
            `;
          }

          if (unlistenError) throw unlistenError;
        })();

        return stopPromise;
      };

      return {
        async stop() {
          await stopListener();
        },
        async unlisten() {
          await stopListener();
        },
      };
    }
  };
}
