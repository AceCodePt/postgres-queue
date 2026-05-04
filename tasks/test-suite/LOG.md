# Log: Implement Comprehensive Test Suite

## Architectural Decision
We are implementing an integration-first test suite using the native Node.js test runner (`node:test`) and `testcontainers`. This approach avoids external dependencies for the runner and ensures high fidelity by testing against a real PostgreSQL 18 instance. Node 24's native TypeScript support will be used without additional flags.

## postgres.js Integration Details
Based on the `postgres.js` documentation:
- `sql.listen` returns a promise that resolves once the `LISTEN` command has been acknowledged by the server. This is critical for avoiding race conditions where we `NOTIFY` before the listener is active.
- `sql.notify` is a simple query helper.
- We must ensure each test uses a fresh schema or cleans up the `queue` table to maintain test isolation.

## State Manifest
| State Entity | Source of Truth | Validation | Description |
|--------------|-----------------|------------|-------------|
| `PgContainer` | Test Suite Memory | `instanceof PostgreSqlContainer` | Lifecycle of the ephemeral database. |
| `sql` instance | Test Suite Memory | `instance instanceof postgres` | Connection pool to the test database. |
| `queue` table | PostgreSQL | Migration schema | The actual job storage. |

## Plan
1. **Initialize Test Infrastructure**:
   - Create `tests/helpers/db.ts` to manage the `testcontainers` lifecycle.
   - Ensure the container uses `postgres:18-alpine`.
   - Implement a migration helper that reads `migrations/*.sql` and applies them to the test container using `sql.unsafe`.
2. **Implement Core Tests**:
   - `push`: Verify a payload is correctly inserted and the `NOTIFY` is triggered.
   - `listen`: Verify a worker picks up a job, processes it, and updates the status to `completed`. We will wait for the `sql.listen` promise to resolve before pushing test data.
   - `concurrency`: Verify multiple workers can process jobs without duplicates using `SKIP LOCKED`.
3. **Verify Programmatic Migrations**:
   - Ensure `src/bin.ts` logic can be reused or replicated in the test helper to verify the migration flow itself.
