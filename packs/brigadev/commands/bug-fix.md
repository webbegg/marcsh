---
description: "Reproduce, fix at the root cause, and prove it with a test"
argument-hint: "<where it happens, steps to reproduce, expected, actual>"
agent: brigadev
---
Bug fix request. Follow the normal ODD flow: reproduce the problem first, add a failing regression test when a deterministic one applies, fix the root cause, then run the tests.

Bug: $ARGUMENTS

Needed: where it happens, the steps to reproduce, what was expected, and what happens instead (errors or logs). If any is missing, ask with `AskUserQuestion` and stop. Optional: the environment (browser, device, app version, feature flag) and a ticket or link.

Load the `brigadev-diagnosis` skill and run its loop: a command that fails because of the bug comes before any hypothesis.

If the problem cannot be reproduced from the details above, report what was tried instead of guessing at a fix.
