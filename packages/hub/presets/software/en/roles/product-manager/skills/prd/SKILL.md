---
description: Write a requirements document
produces: prd
---
# Requirements document (PRD)

Register as `prd/<feature>`, in markdown, using the structure below.

## 1. Background and problem
The current situation, who is affected, and what happens if it is not solved. Use facts, not adjectives.

## 2. Goals and non-goals
- **Goals**: the observable changes once the work is done, 2–4 items.
- **Non-goals**: what is explicitly out of scope this time, and why. This section matters as much as the goals.

## 3. Users and scenarios
Who uses it and in what situation. Write each scenario as "As a ..., I want ..., so that ...".

## 4. Requirements
Group by priority into three sets: **Must have / Should have / Could have**. For each requirement:

| ID | Requirement | Acceptance criteria |
| - | - | - |
| R1 | One sentence describing the behavior | Given ... (precondition), when ... (action), then ... (observable result) |

Acceptance criteria must cover the happy path, edge cases, and failure paths (what should happen on invalid input, insufficient permissions, or an unavailable dependency).

## 5. Success metrics
Which numbers will show after launch that it is working, and what the current baseline is.

## 6. Risks and open questions
For each open question, state who can answer it and which requirement is blocked if it goes unanswered.

## Self-check
- Does any requirement actually dictate how to implement it? Remove it.
- Hand the acceptance criteria alone to a tester: could they write the test cases without asking you?
