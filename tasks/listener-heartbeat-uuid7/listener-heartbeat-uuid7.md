# Task: Implement Listener Heartbeat with UUIDv7

## Classification
- [x] Progression
- [ ] Regression

## Description
Implement a mechanism to track active listeners and detect stale ones using a heartbeat system. This will use an `active_listeners` table with a UUIDv7 primary key to leverage PostgreSQL's (v17+) sequential UUID performance for optimized index locality and "read boost" for time-ordered queries.

## Acceptance Criteria
- [x] Migration to create `active_listeners` table.
- [x] Use `uuid` type with UUIDv7 generation (PostgreSQL 17+ `gen_random_uuid()` or specific v7 function).
- [x] `Queue.listen` should register itself in `active_listeners` upon starting.
- [x] Implement a background heartbeat that updates a `last_seen_at` timestamp.
- [x] Automatic cleanup of stale listeners from the table.
- [x] Ensure the use of UUIDv7 as PK provides the expected B-tree performance benefits.

## Protocol Checklist
- [x] Plan & Data (Handshake Phase) approved
- [x] State Manifest updated in LOG.md
- [x] Tests written and failing
- [x] Implementation completed
- [x] Tests passing
- [x] Log updated with Architectural Choice

## Prohibited Patterns
- Polling for heartbeats at an excessively high frequency.
- Hardcoding the heartbeat interval without allowing configuration.
