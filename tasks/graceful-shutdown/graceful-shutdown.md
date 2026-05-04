# Task: Implement Graceful Shutdown

## Classification
- [x] Progression
- [ ] Regression

## Description
Ensure that the queue listener can be stopped gracefully, allowing currently processing jobs to finish before shutting down.

## Acceptance Criteria
- [x] `Queue.listen` should return an object with a `stop` method.
- [x] The `stop` method should wait for the current job handler to complete.
- [x] Prevent new jobs from being picked up once `stop` is called.

## Protocol Checklist
- [ ] Plan & Data (Handshake Phase) approved
- [ ] State Manifest updated in LOG.md
- [ ] Zod schemas defined
- [ ] Tests written and failing
- [x] Implementation completed
- [x] Tests passing
- [ ] Log updated with Architectural Choice

## Prohibited Patterns
- Using `process.exit()` directly inside the library.
