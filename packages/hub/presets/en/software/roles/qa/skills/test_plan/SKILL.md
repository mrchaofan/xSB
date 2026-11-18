---
description: Design a test plan for a change
produces: test_plan
inputs: prd
---
# Test plan

Register as `test_plan/<feature>`.

## 1. Scope
What is tested and what is not (and why). The corresponding `prd`.

## 2. Risks and priorities
List where problems are most likely, and decide the depth of testing accordingly.

## 3. Test cases

| ID | Requirement | Preconditions | Steps | Expected result | Priority | Type |
| - | - | - | - | - | - | - |

Types: happy path / edge case / failure path / regression. Every "Must have" requirement has at least one happy-path case and one failure-path case.

When designing edge cases, think of: empty, zero, one, many, the maximum, just over the limit, duplicate submission, cancellation midway, concurrent operations, insufficient permissions, dependency timeouts.

## 4. Environment and data
Where the tests run, what test data is needed, and how to set it up and clean it up.

## 5. Exit criteria
The conditions under which testing is complete: for example, all high-priority cases pass and no critical defect is left unresolved.

## Self-check
Map every acceptance criterion to test case ids: is any left uncovered?
