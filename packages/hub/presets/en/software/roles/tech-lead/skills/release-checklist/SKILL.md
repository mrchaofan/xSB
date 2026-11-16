---
description: Final checks before a release
---
# Release checklist

Confirm each item, and give every one a source (an asset id or command output); do not go by memory:

- [ ] Every "Must have" requirement in `prd` has a corresponding passing test case (see `test_report`)
- [ ] The `review` verdict is Approved, with no open Blocker findings
- [ ] The `test_report` verdict is Ready to release; every known defect has a disposition (fixed / accepted and recorded)
- [ ] The user has been told about the "Not done and known issues" in the change description
- [ ] Where there is a data or configuration migration, there is a way to roll back
- [ ] Changes to external behavior are written into the documentation or the changelog

If any item is not met, the verdict is "Not ready to release"; state which item is missing.
