# Log: Refactor API for Channel-Specific Queues & Strong Typing

## Architectural Decision

We are refactoring the `Queue` API to support **Standard Schema**-based runtime validation while maintaining zero-dependency for the core library. The queue will accept either:
1. A **type parameter** for compile-time safety only.
2. A **schema object** (Standard Schema-compliant) for compile-time + runtime validation.

This approach is **validation library agnostic**—users can bring Zod, Valibot, ArkType, or any future Standard Schema-compliant library.

## Why Standard Schema?

The [Standard Schema specification](https://github.com/standard-schema/standard-schema) provides a unified interface for validation libraries. Instead of tightly coupling to Zod or Valibot, we support a protocol that enables interoperability across the ecosystem.

### Key Benefits:
- **Zero-Dependency Core**: The library doesn't ship with a validation library; users opt in.
- **Type Inference**: TypeScript can infer the payload type from the schema automatically using `InferOutput<TSchema>`.
- **Runtime Safety**: Protect against corrupt or malicious payloads from the database.
- **Future-Proof**: New validation libraries can be supported without changing our code.

## State Manifest

| State Entity | Source of Truth | Validation | Description |
|--------------|-----------------|------------|-------------|
| `channel` | Queue Instance Closure | `string` | The PostgreSQL `LISTEN/NOTIFY` channel and job filter. |
| `schema` (optional) | Queue Instance Closure | `StandardSchema` or `undefined` | The validation schema for runtime checks. |
| `payload` | PostgreSQL `jsonb` column | Schema (if provided) | The job data. |

## Type Signature Plan

```typescript
import type { Sql } from 'postgres';
import type { StandardSchema, InferOutput } from '@standard-schema/spec';

// Overload 1: Type parameter only (no runtime validation)
export default function Queue<T>(
  sql: Sql,
  options?: QueueOptions
): QueueInstance<T>;

// Overload 2: Schema-based (runtime validation + type inference)
export default function Queue<TSchema extends StandardSchema>(
  sql: Sql,
  options: QueueOptions & { schema: TSchema }
): QueueInstance<InferOutput<TSchema>>;

interface QueueOptions {
  channel?: string;
  schema?: StandardSchema;
}

interface QueueInstance<T> {
  enqueue(payload: T, options?: EnqueueOptions): Promise<void>;
  listen(handler: (payload: T, job: Job) => Promise<void> | void): Promise<ListenerControl>;
}

interface EnqueueOptions {
  broadcast?: boolean; // Default: false
  runAt?: Date;        // Planned
  delay?: number;      // Planned
}

interface Job {
  id: string; // UUIDv7
  type: 'queue' | 'broadcast';
  createdAt: Date;
}
```

## Implementation Strategy

1. **Add `@standard-schema/spec` as a dev dependency** (for types only, not bundled).
2. **Modify `Queue` function** to accept `schema` in options.
3. **Implement validation helper**:
   ```typescript
   function validate<T>(schema: StandardSchema | undefined, value: unknown): T {
     if (!schema) return value as T;
     
     const result = schema['~standard'].validate(value);
     if (result.issues) {
       throw new ValidationError('Payload validation failed', result.issues);
     }
     return result.value as T;
   }
   ```
4. **Validate on `enqueue`**: Before inserting into the database.
5. **Validate on `listen`**: After fetching from the database (defensive, in case data was corrupted).
6. **Add `channel` column to schema** and update queries.

## Migration SQL

```sql
-- Add channel column
ALTER TABLE queue ADD COLUMN channel TEXT NOT NULL DEFAULT 'queue_channel';

-- Create composite index for channel-filtered queries
CREATE INDEX idx_queue_channel_pending ON queue (channel, id) WHERE status = 'pending';

-- Drop old index (optional, if it exists)
DROP INDEX IF EXISTS idx_queue_pending;
```

## Error Handling

- Create a `ValidationError` class that extends `Error`.
- Include the validation issues in the error for debugging.
- Distinguish validation errors from processing errors in the handler.

## Implementation Update

- Queue IDs were migrated to `uuid` defaults using `gen_random_uuid()` and queue rows now persist `channel`.
- Broadcasts were moved to a dedicated `broadcasts` table with insert triggers that emit `NOTIFY` using the same channel.
- Listener flow now uses channel-specific `SKIP LOCKED` claims and validates both enqueue payloads and fetched payloads when a schema is present.
- Queue creation now binds payload typing at the factory level (`Queue<T>` or schema inference), and `enqueue/listen` no longer accept per-call generics.
