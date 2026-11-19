---
description: Record a single architecture decision on its own
produces: adr
---
# Architecture decision record (ADR)

One per decision, registered as `adr/<number>-<topic>`. Once written, it is not edited; when a new decision supersedes it, write a new record and note that in the old one's status.

- **Status**: Proposed / Accepted / Superseded by adr/xxx
- **Context**: what forces us to decide now. Write facts and constraints.
- **Options**: at least two, including "do nothing". The benefits and costs of each.
- **Decision**: which one, and the reasons that decided it (usually only one or two).
- **Consequences**: what gets easier, what gets harder, and which signals to watch for afterward.
