---
description: Run a focused check on a security-sensitive change
---
# Security checklist

Use this when a change involves sign-in, permissions, payments, file uploads, concatenation of external input, or secrets.

- **Input**: whether all external data (requests, files, environment, third-party responses) is validated for type, length, and range before use.
- **Injection**: wherever data is concatenated into SQL, shell commands, file paths, HTML, or regular expressions, whether parameterization or escaping is used.
- **Authentication and privilege escalation**: whether every entry point checks "who is this" and "are they allowed"; whether changing an id gives access to someone else's data.
- **Secrets and sensitive data**: whether any are written into code, logs, error messages, or URLs; whether they are encrypted in transit and at rest.
- **Dependencies**: whether each new dependency is necessary and comes from a trusted source.
- **On failure**: whether errors default to deny or to allow; whether error messages leak internal details.

Write any problems found into the review as "Blocker" findings.
