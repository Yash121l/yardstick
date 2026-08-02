# Fix the failing background-sync tests

`src/sync.ts` drains a queue of pending records and writes them to a store.
The suite in `tests/` is failing.

Run `npx vitest run tests` to see the failures, work out why they happen, and
fix `src/sync.ts` so they pass.

Constraints:

- Do not change the exported function signatures.
- Do not weaken or delete the tests. You are graded on a superset of them.
- Do not create a git commit.
- Keep the fix inside `src/`.
