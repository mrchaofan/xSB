---
description: Write a technical design
produces: architecture
inputs: prd
---
# Technical design

Register as `architecture/<feature>`, in markdown.

## 1. Context and constraints
Which `prd` this addresses; the relevant parts of the existing system (with file paths); the constraints that must be respected (compatibility, performance, things that cannot be touched).

## 2. Design overview
In one paragraph plus one text diagram, explain what the parts are, what each is responsible for, and how data flows. Mark new parts and changed parts separately.

## 3. Interface contracts
For every module boundary: the signatures of functions or endpoints, the data structures of inputs and outputs, and the possible errors and what they mean. This is the shared basis for development and review; write it in enough detail to code from directly.

## 4. Data
New or changed data structures, where they are stored, how to migrate, and how to roll back.

## 5. Key decisions
For each decision: **context → options considered → decision → consequences** (including its downsides).

## 6. Non-functional requirements
Only what is relevant to this change: performance expectations, security (authentication and authorization, input validation, secrets), behavior on failure, and observability (how a problem would be noticed).

## 7. Implementation slices
Break the implementation into steps that can each be merged and verified independently, listed in order, with the PRD requirements each step covers.

## 8. Risks
Where things are most likely to go wrong, and how to find out early.

## Self-check
- Ask of every component: "what happens if we remove it?"
- Is anything in the design there because it "might be needed someday"? Remove it.
- Can every "Must have" requirement in the PRD be traced to a place in the design?
