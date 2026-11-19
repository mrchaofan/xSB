---
description: Implement a code change and deliver its change description
produces: change
inputs: prd, architecture
---
# Code change

## Steps

1. Read the input assets and list the acceptance criteria this change must meet.
2. Read the relevant code and tests, and confirm that the interface contracts in the design match the code as it is; if they do not, stop and explain in the result.
3. Write or update the tests first so that they express the acceptance criteria, then write the implementation.
4. Run the project's tests, type checks, and lint. Continue only when all of them pass.
5. Read the diff yourself: any debug output, unrelated changes, or unused code?
6. Write the change description and register it as `change/<feature>`.

## Structure of the change description

- **What was done**: described as behavior, mapped to the PRD requirement ids.
- **Why it was done this way**: where it departs from the design, and why.
- **Files touched**: each path with a one-sentence note.
- **How to view the change**: the base commit, and the command that shows this diff (for example, `git diff <base-commit>`).
- **How it was verified**: which commands were run, with a summary of the real results (passed and failed counts).
- **Not done and known issues**: in-scope work left unfinished, issues found outside the scope, and anything not verified. If there are none, write "None".

## Do not

- Do not change unrelated tests just to make things pass.
- Do not commit anything containing secrets or tokens.
- Do not introduce a new dependency without giving the reason.
