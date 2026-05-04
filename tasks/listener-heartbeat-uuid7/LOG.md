# Log: Implement Listener Heartbeat with UUIDv7

## Architectural Choice
This task is implemented as a **behavior inside the existing `Queue` factory**, not a new web component. The feature adds runtime capability (listener liveness tracking and stale cleanup) to the queue listener lifecycle, so the "Identity vs. Capability" heuristic favors a behavior-oriented extension of `Queue.listen`.

## Implementation Details
- Added a new migration (`migrations/0002_listener_heartbeat.sql`) that creates `active_listeners` and configures UUIDv7 IDs when the PostgreSQL `uuidv7()` function is available (with `gen_random_uuid()` fallback).
- Extended `QueueOptions` with `heartbeat` configuration and runtime validation for interval/timeout values.
- `Queue.listen` now inserts a row into `active_listeners`, starts a background heartbeat updater, and periodically removes stale listeners by channel.
- Listener teardown now removes its own row from `active_listeners` to avoid ghost listeners.
- Integration tests now verify registration, UUIDv7 identity shape, heartbeat timestamp updates, and stale-listener cleanup behavior.

## State Manifest
| State Entity | Source of Truth | Validation | Description |
|--------------|-----------------|------------|-------------|
| `heartbeat.enabled` | Queue instance options (`QueueOptions.heartbeat`) | `boolean` (default `true`) | Enables/disables listener heartbeat behavior. |
| `heartbeat.intervalMs` | Queue instance options (`heartbeat.interval`) | finite number > 0 | Interval in milliseconds between heartbeat writes. |
| `heartbeat.timeoutMs` | Queue instance options (`heartbeat.timeout`) | finite number > `intervalMs` | Staleness threshold for deleting inactive listeners. |
| `listenerId` | `active_listeners.id` | `uuid` (UUIDv7 when available) | Unique listener identity used for heartbeat updates and cleanup. |
| `last_seen_at` | `active_listeners.last_seen_at` | PostgreSQL timestamp | Updated by heartbeat loop to indicate listener liveness. |
| `heartbeatTimer` | Process memory (`setInterval`) | active timer handle or undefined | Drives periodic heartbeat updates while listener is active. |
