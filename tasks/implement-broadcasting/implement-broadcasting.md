# Task: Implement One-to-Many Broadcasting

## Classification
- [x] Progression
- [ ] Regression

## Description
Implement a broadcasting mechanism that allows sending messages to all active listeners simultaneously. This is distinct from the current queue behavior where only one worker processes each job.

## Acceptance Criteria
- [x] Support `queue.enqueue(payload, { broadcast: true })` to send a message to all listeners.
- [x] Use `queue.listen(handler)` for receiving both queued jobs and broadcast messages with clear `job.type` differentiation.
- [x] Ensure broadcasting uses a separate PostgreSQL channel or a distinct message format to avoid interference with the job queue.
- [x] Support payload serialization/deserialization for broadcast messages.

## Protocol Checklist
- [x] Plan & Data (Handshake Phase) approved
- [x] State Manifest updated in LOG.md
- [ ] Zod schemas defined
- [x] Tests written and failing
- [x] Implementation completed
- [x] Tests passing
- [x] Log updated with Architectural Choice

## Prohibited Patterns
- Using the same `LISTEN/NOTIFY` channel for both queue wakeups and broadcast data without a clear discriminator.
- Storing broadcast messages in the `queue` table (unless persistence is explicitly required and handled).
