# Task: Implement Job Retries with Exponential Backoff

## Classification
- [x] Progression
- [ ] Regression

## Description
Jobs that fail should be retried automatically based on a configurable retry policy. This should include a maximum number of retries and exponential backoff between attempts.

## Acceptance Criteria
- [x] Add `attempts` and `max_attempts` columns to the `queue` table.
- [x] Add `retry_after` column to schedule the next attempt.
- [x] Update `Queue.listen` to handle failures by incrementing `attempts` and setting `retry_after`.
- [x] Update job fetching logic to include jobs where `retry_after <= now()`.

## Protocol Checklist
- [ ] Plan & Data (Handshake Phase) approved
- [ ] State Manifest updated in LOG.md
- [ ] Zod schemas defined
- [ ] Tests written and failing
- [ ] Implementation completed
- [ ] Tests passing
- [ ] Log updated with Architectural Choice

## Prohibited Patterns
- Hardcoding retry intervals.
- Not updating `updated_at` on retry.
