# Task: Support Delayed Jobs

## Classification
- [x] Progression
- [ ] Regression

## Description
Allow users to schedule jobs to be executed at a specific time in the future.

## Acceptance Criteria
- [x] Add `run_at` column to the `queue` table.
- [x] Update `Queue.push` to accept an optional `run_at` or `delay` parameter.
- [x] Update job fetching logic to respect `run_at`.

## Protocol Checklist
- [ ] Plan & Data (Handshake Phase) approved
- [ ] State Manifest updated in LOG.md
- [ ] Zod schemas defined
- [ ] Tests written and failing
- [ ] Implementation completed
- [ ] Tests passing
- [ ] Log updated with Architectural Choice

## Prohibited Patterns
- Polling the database too frequently for delayed jobs.
