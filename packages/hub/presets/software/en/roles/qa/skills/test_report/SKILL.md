---
description: Run the tests and produce a test report
produces: test_report
inputs: prd, test_plan, change
---
# Test report

Register as `test_report/<feature>`.

## 1. Verdict
On the first line, write **Ready to release** or **Not ready to release**, with a one-sentence reason.

## 2. Execution
Environment, version under test (commit hash), time of execution. The number of cases in total, passed, failed, and not run (with reasons).

## 3. Failed cases and defects
For each defect:

- **Title**: what happened under what conditions
- **Severity**: Critical (feature unusable, data errors, security issues) / Major / Minor
- **Steps to reproduce**: numbered, including the specific input data
- **Expected** and **Actual**
- **Evidence**: where the output, screenshots, or logs are

## 4. Not covered
What was not tested, and why. This section cannot be omitted: the reader needs to know the limits of the verdict.

## Verdict rules
If there is any critical defect, or any "Must have" requirement without a passing case, the verdict is Not ready to release.
