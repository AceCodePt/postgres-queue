# Task: Refactor API for Channel-Specific Queues & Strong Typing

## Classification
- [ ] Progression
- [x] Regression

## Description
Refactor the `Queue` API to bind **type, channel, and behavior** at queue instantiation. Each queue instance should represent a single logical channel with a strongly-typed payload contract. If no channel is provided, the system should auto-generate a unique channel ID to enable isolated or ephemeral queues.

This is a **regression** task because it fundamentally changes the API surface and requires updates to all existing usage patterns.

## Acceptance Criteria
- [x] Change `id` column from `bigint` to `uuid` (UUIDv7) in the `queue` table using PostgreSQL 17+ `gen_random_uuid()`.
- [x] Create `broadcasts` table with schema: `id` (uuid), `channel` (text), `payload` (jsonb), `created_at` (timestamptz).
- [x] Add trigger on `broadcasts` table to send `NOTIFY` after insert.
- [x] Update `Queue` factory to accept either a **type parameter** (`Queue<T>`) OR a **schema object** that follows the Standard Schema spec.
- [x] Support type inference: If a schema is provided, infer `T` from the schema; otherwise use the explicit type parameter.
- [x] Accept an optional `channel` parameter as part of options. If omitted, generate a unique channel ID using `crypto.randomUUID()`.
- [x] Implement runtime validation: Validate payloads on `enqueue` and `listen` using the provided schema (if present).
- [x] Add `broadcast` option to `enqueue()`: when `true`, insert into `broadcasts` table instead of `queue` table.
- [x] Remove generic type parameters from `enqueue` and `listen` methods (types are inferred from queue creation).
- [x] Add a `channel` column to the `queue` table to allow filtering jobs by queue.
- [x] Update `listen` to use `LISTEN/NOTIFY` + `SKIP LOCKED` pattern (no polling).
- [x] Update `listen` handler signature to: `(payload: T, job: Job) => Promise<void>` where `Job = { id: string, type: 'queue' | 'broadcast', createdAt: Date }`.
- [x] Update the `listen` SQL query to only fetch jobs for the specific channel using a `WHERE channel = $1 AND status = 'pending'` clause.
- [x] Update the `enqueue` SQL query to include the channel name in the insert and use `RETURNING id, created_at`.
- [x] Add trigger on `queue` table to send `NOTIFY` after insert.
- [x] Update `README.md` with the new usage pattern and migration guide for existing users.

## Detailed API Design

### Current API (Before)
```typescript
const queue = Queue(sql, { channel: 'my_channel' });

await queue.enqueue<EmailJob>({ to: 'user@example.com', body: 'Hello' });
await queue.listen<EmailJob>(async (payload, job) => {
  // ...
});
```

### New API (After)

#### Option 1: Type-only (Compile-time validation only)
```typescript
interface EmailJob {
  to: string;
  body: string;
}

// Explicit type parameter
const emailQueue = Queue<EmailJob>(sql, { channel: 'email_jobs' });

await emailQueue.push({ to: 'user@example.com', body: 'Hello' });

await emailQueue.listen(async (payload, job) => {
  // payload is automatically typed as EmailJob
  // job: { id: string (UUIDv7), type: 'queue' | 'broadcast', createdAt: Date }
  console.log(payload.to); // TypeScript knows this is a string
});
```

#### Option 2: Schema-based (Compile-time + Runtime validation)
```typescript
import { z } from 'zod';

// Define schema using any Standard Schema-compliant library (Zod, Valibot, ArkType, etc.)
const emailJobSchema = z.object({
  to: z.string().email(),
  body: z.string().min(1)
});

// Pass schema instead of type parameter
// Type is inferred from the schema
const emailQueue = Queue(sql, { 
  channel: 'email_jobs',
  schema: emailJobSchema 
});

// Runtime validation on push
await emailQueue.push({ to: 'user@example.com', body: 'Hello' });
// Throws if validation fails: { to: 'invalid', body: '' }

// Runtime validation on listen (defensive against corrupt data)
await emailQueue.listen(async (payload, job) => {
  // payload is inferred as z.infer<typeof emailJobSchema>
  // job: { id: string (UUIDv7), type: 'queue' | 'broadcast', createdAt: Date }
  console.log(payload.to); // string (validated email)
});
```

#### Option 3: Mixed usage (Advanced)
```typescript
// You can also use a schema with an explicit type parameter for complex scenarios
const emailQueue = Queue<EmailJob>(sql, { 
  channel: 'email_jobs',
  schema: emailJobSchema 
});
```

### Multi-Queue Example (Type-only)
```typescript
interface EmailJob { to: string; body: string }
interface ReportJob { report_id: number; format: 'pdf' | 'csv' }

const emailQueue = Queue<EmailJob>(sql, { channel: 'emails' });
const reportQueue = Queue<ReportJob>(sql, { channel: 'reports' });

// Each queue is isolated and type-safe
await emailQueue.push({ to: 'alice@example.com', body: 'Welcome!' });
await reportQueue.push({ report_id: 123, format: 'pdf' });

// Listeners only process their respective channels
await emailQueue.listen(async (payload) => {
  // payload is EmailJob
});

await reportQueue.listen(async (payload) => {
  // payload is ReportJob
});
```

### Multi-Queue Example (Schema-based with Valibot)
```typescript
import * as v from 'valibot';

const emailJobSchema = v.object({
  to: v.pipe(v.string(), v.email()),
  body: v.pipe(v.string(), v.minLength(1))
});

const reportJobSchema = v.object({
  report_id: v.number(),
  format: v.picklist(['pdf', 'csv'])
});

const emailQueue = Queue(sql, { channel: 'emails', schema: emailJobSchema });
const reportQueue = Queue(sql, { channel: 'reports', schema: reportJobSchema });

// Runtime validation on push
await emailQueue.push({ to: 'alice@example.com', body: 'Welcome!' }); // ✅
await emailQueue.push({ to: 'invalid', body: '' }); // ❌ Throws ValidationError

// Type inference works automatically
await emailQueue.listen(async (payload) => {
  // payload is inferred as { to: string; body: string }
});
```

## Benefits
1. **Type Safety at the Boundary**: The queue instance becomes the contract. You can't accidentally mix job types.
2. **Runtime Validation**: Optional schema-based validation ensures data integrity at runtime, protecting against corrupt or malicious payloads.
3. **Validation Library Agnostic**: Uses Standard Schema spec, supporting Zod, Valibot, ArkType, and any future-compliant library.
4. **Type Inference**: When using a schema, TypeScript automatically infers the payload type—no need to manually specify `<T>`.
5. **Cleaner Call Sites**: No need to repeat `<EmailJob>` at every operation.
6. **Multi-Queue Architecture**: Multiple queues can operate independently on the same database.
7. **Auto-Isolation**: Auto-generated channels enable testing and ephemeral queues without manual coordination.
8. **Performance**: Channel-based filtering reduces query scope and improves `SKIP LOCKED` efficiency.

## Implementation Notes

### Queue Factory Signature
The `Queue` function needs to support two modes:

```typescript
// Mode 1: Type parameter only (no runtime validation)
function Queue<T>(
  sql: Sql,
  options?: { channel?: string }
): QueueInstance<T>

// Mode 2: Schema-based (runtime validation + type inference)
function Queue<TSchema extends StandardSchema>(
  sql: Sql,
  options: { channel?: string; schema: TSchema }
): QueueInstance<InferOutput<TSchema>>

// Combined signature (overload):
export default function Queue<T = unknown, TSchema extends StandardSchema = any>(
  sql: Sql,
  options?: { channel?: string; schema?: TSchema }
): QueueInstance<TSchema extends StandardSchema ? InferOutput<TSchema> : T>

  interface QueueInstance<T> {
    enqueue(payload: T, options?: { broadcast?: boolean; runAt?: Date; delay?: number }): Promise<void>;
    listen(handler: (payload: T, job: Job) => Promise<void> | void): Promise<ListenerControl>;
  }
  
  interface Job {
    id: string; // UUIDv7
    type: 'queue' | 'broadcast';
    createdAt: Date;
  }
```

### Standard Schema Integration
- Use the `@standard-schema/spec` package for the `StandardSchema` type definition.
- Validation logic:
  ```typescript
  if (options?.schema) {
    const result = options.schema['~standard'].validate(payload);
    if (result.issues) {
      throw new ValidationError('Invalid payload', result.issues);
    }
    // Use result.value (normalized output)
  }
  ```
- Validate on both `push` (before insert) and `listen` (after fetch, defensive).

### Channel Management
- The `channel` should be stored in the closure returned by the `Queue` factory.
- For auto-generated channels, use `crypto.randomUUID()` prefixed with `queue_` (e.g., `queue_a1b2c3d4-...`).

### Database Migration
```sql
-- Update queue table to use UUIDv7
ALTER TABLE queue ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE queue ADD COLUMN channel TEXT NOT NULL DEFAULT 'queue_channel';
CREATE INDEX idx_queue_channel_pending ON queue (channel, id) WHERE status = 'pending';

-- Add trigger to notify on insert
CREATE OR REPLACE FUNCTION notify_queue_insert()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(NEW.channel, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER queue_notify
AFTER INSERT ON queue
FOR EACH ROW
EXECUTE FUNCTION notify_queue_insert();

-- Create broadcasts table
CREATE TABLE broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_broadcasts_channel ON broadcasts (channel, created_at DESC);

-- Add trigger to notify on broadcast insert
CREATE OR REPLACE FUNCTION notify_broadcast_insert()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(NEW.channel, json_build_object('broadcast_id', NEW.id)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER broadcast_notify
AFTER INSERT ON broadcasts
FOR EACH ROW
EXECUTE FUNCTION notify_broadcast_insert();
```

### Error Handling
- Validation failures should throw a distinct `ValidationError` type.
- Consumers can choose to handle validation errors separately from processing errors.

## Protocol Checklist
- [x] Plan & Data (Handshake Phase) approved
- [x] State Manifest updated in LOG.md
- [x] Zod schemas defined
- [x] Tests written and failing
- [x] Implementation completed
- [x] Tests passing
- [x] Log updated with Architectural Choice

## Prohibited Patterns
- Allowing untyped `push` or `listen` when the Queue was initialized with a type.
- Polling all jobs in the table regardless of channel.
