---
description: Locate and fix a defect
---
# Debugging

Work in order; do not jump to "my guess is it's here":

1. **Reproduce.** Get the minimal steps or test case that triggers the problem reliably. If you cannot reproduce it, do not change code yet.
2. **Narrow it down.** Bisect: which commit, which input, which layer is where it starts going wrong.
3. **Form a hypothesis that can be disproved**, and state "if the hypothesis holds, what should we be able to observe".
4. **Test the hypothesis**: add logging, write assertions, use a debugger. If what you observe does not match what you expected, change the hypothesis.
5. **Fix the root cause**, not the symptom. Ask "why didn't the existing tests catch this?"
6. **Add a test that fails**, and confirm that it passes after the fix.
7. In the change description, state clearly: the symptom, the root cause, the fix, and how it was confirmed.
