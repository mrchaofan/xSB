---
description: Review a code change
produces: review
inputs: prd, architecture, change
---
# Code review

Register as `review/<feature>`.

## Order of checks

1. **Does it do the right thing**: check against the PRD's acceptance criteria one by one for anything missing or anything extra.
2. **Correctness**: boundary values, null values, error paths, concurrency and reentrancy, resource release.
3. **Security**: whether external input is validated; any injection (SQL, command, path); whether authorization is enforced on the server; whether secrets are hardcoded or end up in logs.
4. **Tests**: whether new behavior has tests; whether the tests assert behavior or implementation details; whether failure paths are tested.
5. **Design**: whether it follows the technical design; any duplication, unused code, or premature abstraction.
6. **Readability**: naming, and whether comments explain "why".

## Format of each finding

- **Location**: `file:line`
- **Problem**: one sentence
- **Failure scenario**: a specific input or state → the wrong output or crash
- **Suggested fix**: how to change it

## Severity

- **Blocker**: causes wrong results, data loss, or a security issue, or fails to meet a "Must have" requirement. Must be fixed.
- **Should fix**: nothing breaks today, but it is error-prone or hard to maintain.
- **Suggestion**: optional.

## Verdict

Write "Approved" or "Changes required". If there is any Blocker, the verdict is "Changes required". Even when you find no problems, state which aspects you checked rather than just writing "no problems".
