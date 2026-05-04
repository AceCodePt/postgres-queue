# Testing

This directory contains integration tests for the postgres-queue library.

## Setup

Tests use **testcontainers** to spin up a real PostgreSQL instance in Docker. The test suite:

1. Starts a single PostgreSQL container (once at the beginning)
2. Creates a unique database for the test run
3. Runs migrations on that database
4. Executes all tests
5. Drops the test database
6. Stops the PostgreSQL container

## Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch
```

## Test Structure

- **tests/all.test.ts** - Main test file containing all test suites
- **tests/helpers.ts** - Test utilities for database setup/teardown and helper functions

## Test Coverage

The test suite covers:

### Core Functionality
- Queue creation and initialization
- Job enqueueing (push)
- Job processing with listeners
- Job status transitions (pending → active → completed)
- Multiple job processing in FIFO order

### Error Handling
- Failed job marking when handler throws
- Continued processing after failures
- Async error handling

### Concurrency
- Multiple workers processing jobs (SKIP LOCKED verification)
- Exactly-once processing guarantees
- Race condition handling

## Requirements

- Docker must be installed and running
- Node.js 20+ (for native test runner)
- pnpm (or npm/bun)

## Known Issues

The test output may show a warning about "asynchronous activity after the test ended". This is a benign warning related to PostgreSQL LISTEN/NOTIFY subscriptions that remain active after tests complete. All functional tests pass successfully.
