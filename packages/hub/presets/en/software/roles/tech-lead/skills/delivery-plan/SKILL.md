---
description: Break a requirement into tasks that can be dispatched
---
# Breakdown and dispatch

## How to slice

- Slice by **user-visible behavior**, not by technical layer (not "finish all the APIs first, then all the UI"). Each slice can be verified independently.
- A task goes to one person only and produces one type of asset only.
- Use `after` for tasks with ordering dependencies; dispatch tasks with no dependencies at the same time, then bring them together with `await_tasks`.

## Every task must state

| Item | Content |
| - | - |
| Goal | What is true once it is done (one sentence) |
| Scope | Which modules or files are involved |
| Out of scope | What is explicitly excluded, to prevent scope creep |
| Acceptance criteria | Conditions that can be checked one by one |
| `inputs` | Which assets it is based on |
| `produces` | The type of asset to deliver |

## When sending work back

State clearly: which acceptance criterion was not met, what the evidence is (the review finding or the id of the failing test case), and what the result should look like. Do not just say "there are problems, please fix".
