# Project Tasks

## Agent Protocol

This file is managed via **Optimistic Concurrency**.

### Executing Tasks

1.  **Read**: Parse the file to find the next available task (`[ ]`).
    - **Check Dependencies**: If a task is marked with `🔒 Blocked by: [...]`, verify the blocking task is `[x]` (Done) before starting.
2.  **Lock**: Immediately change the status to `[-]` (In Progress) and **save the file**.
3.  **Initialize**: Create a new worktree for the task using `gwadd <branch-name>` as defined in `docs/guides/worktree-management.md`.
4.  **Execute (PDSRTDD Flow)**: Perform the task following the **Plan-Data-Test-Develop** protocol:
    - **Plan & Data (Handshake Phase)**: Analyze the requirements and make the **Architectural Decision**. Update `LOG.md` with the plan and a **State Manifest** (listing every piece of state, its source of truth, and its validation schema). **STOP and wait for approval before writing any code.**
    - **Test**: Write tests against the Schemas and Registry definitions. Ensure the tests fail or correctly assert the missing implementation.
5.  **Log**: Create a `LOG.md` file within the feature's folder in `feature/sub-feature` documenting:
    - **Architectural Choice**: Explicitly state why you chose a **Behavior** vs. a **Web Component** based on the "Identity vs. Capability" heuristic.
    - **Implementation Details**: Decisions made, and any relevant technical notes.
    - **State Manifest**: List the attributes that represent the component's state.
6.  **Verify & Commit**: Run `pnpm test` to ensure project-wide type safety. Verify that all tests pass within the feature worktree. Commit all changes to the feature branch. **DO NOT** merge to `main` and **DO NOT** delete the worktree. The user will handle merging and cleanup.
7.  **Verify Alignment (Regression)**: If a core component or protocol was changed, identify all existing implementations that rely on it. Create new tasks to "regress" and align those implementations with the new core.
8.  **Standardize Usage (Progression)**: For new features, ensure the usage standards are documented in the relevant guide (e.g., `AGENTS.md`). Create follow-up tasks to propagate this standard to other relevant areas.
9.  **Complete**: Update the status to `[x]` (Done).

### Adding New Tasks

1.  **Classify**: Determine if the task is a **Progression** (new feature/capability) or a **Regression** (alignment/refactoring due to core changes).
2.  **Create Task Folder**: Create a directory in `tasks/` named after the task (kebab-case).
3.  **Document Task**: Create a detailed `.md` file inside that folder using the template in `docs/templates/task.md`. Ensure it includes the Protocol Checklist and Prohibited Patterns.
4.  **Register Task**: Add a new `[ ]` entry **at the top** of the `Backlog` section in this file, linking to the `.md` file created in step 3.
    - **Define Dependencies**: If the new task depends on another task being completed first, append `🔒 Blocked by: [Task Name]` to the line.
    - **Bottom-Up Ordering**: New tasks are always added at the top. This makes it easier to see the most recent work and maintains a chronological history from newest (top) to oldest (bottom).

## Status Legend

- `[ ]` **Todo**: Available to be picked up.
- `[-]` **In Progress**: Currently being executed.
- `[x]` **Done**: Completed and verified (including regression/progression checks).
- `[?]` **Indeterminate**: Blocked or needs review.

## Backlog

- [x] [Refactor API for Channel-Specific Queues & Strong Typing](tasks/api-refactor/api-refactor.md)
- [x] [Implement Listener Heartbeat with UUIDv7](tasks/listener-heartbeat-uuid7/listener-heartbeat-uuid7.md) 🔒 Blocked by: [Implement Comprehensive Test Suite]
- [x] [Implement One-to-Many Broadcasting](tasks/implement-broadcasting/implement-broadcasting.md) 🔒 Blocked by: [Implement Comprehensive Test Suite]
- [x] [Implement Graceful Shutdown](tasks/graceful-shutdown/graceful-shutdown.md) 🔒 Blocked by: [Implement Comprehensive Test Suite]
- [x] [Support Delayed Jobs](tasks/delayed-jobs/delayed-jobs.md) 🔒 Blocked by: [Implement Comprehensive Test Suite]
- [x] [Implement Job Retries with Exponential Backoff](tasks/implement-retries/implement-retries.md) 🔒 Blocked by: [Implement Comprehensive Test Suite]
- [x] [Implement Comprehensive Test Suite](tasks/test-suite/test-suite.md)
