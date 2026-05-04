# Log: Implement One-to-Many Broadcasting

## Architectural Choice
This work is implemented as a **behavior extension inside the existing `Queue` factory**, not a web component. Broadcasting is runtime capability in the queue transport layer (message fan-out and subscription), so the "Identity vs. Capability" heuristic favors adding queue behavior via `broadcast()` and `onBroadcast()`.

## Implementation Details
- Kept broadcasting in the unified API via `enqueue(..., { broadcast: true })`.
- Kept subscription in the unified API via `listen(handler)` with `job.type` as the delivery discriminator.
- Isolated queue wakeups and broadcast notifications at the PostgreSQL channel level by emitting broadcast NOTIFY events to `<channel>_broadcast`.
- Updated integration tests to verify one-to-many fan-out and queue/broadcast listener isolation.

## State Manifest
| State Entity | Source of Truth | Validation | Description |
|--------------|-----------------|------------|-------------|
| `channel` | Queue instance closure | non-empty string (or generated UUID-based name) | Logical queue namespace used for queue rows and broadcast persistence. |
| `broadcastChannel` | Derived in queue instance closure (`${channel}_broadcast`) | string concatenation of `channel` + `_broadcast` | Dedicated PostgreSQL LISTEN/NOTIFY channel for broadcast delivery. |
| `payload` | Input to `enqueue` / `broadcast` and persisted JSONB | `StandardSchema` validation when `schema` is configured | Message body delivered to queue workers or broadcast subscribers. |
| `job.type` | Runtime dispatch context in handlers | `'queue' | 'broadcast'` literal union | Distinguishes exactly-once queue jobs from fan-out broadcast messages. |
| `broadcasts.id` | PostgreSQL `broadcasts` table | `uuid` default (`gen_random_uuid()`) | Broadcast identifier sent via NOTIFY payload and used for row lookup. |
