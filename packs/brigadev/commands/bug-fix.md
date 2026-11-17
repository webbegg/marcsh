---
description: "Reproduce, fix at the root cause, and prove it with a test"
argument-hint: "<where it happens, steps to reproduce, expected, actual>"
agent: brigadev
questions:
  - id: where
    label: "Where does it happen?"
    kind: text
    required: true
  - id: environment
    label: "Environment: browser, device, app version, or feature flag"
    kind: text
  - id: steps
    label: "Steps to reproduce"
    kind: long
    required: true
  - id: expected
    label: "What did you expect?"
    kind: text
    required: true
  - id: actual
    label: "What happens instead? Include errors or logs"
    kind: long
    required: true
  - id: ticket
    label: "Ticket or link"
    kind: text
---
Bug fix request. Follow the normal ODD flow: reproduce the problem first, add a failing regression test when a deterministic one applies, fix the root cause, then run the tests.

- Where it happens: {{where}}
- Environment: {{environment}}
- Steps to reproduce: {{steps}}
- Expected: {{expected}}
- Actual (errors or logs): {{actual}}
- Ticket or link: {{ticket}}

Load the `brigadev-diagnosis` skill and run its loop: a command that fails because of the bug comes before any hypothesis.

If the problem cannot be reproduced from the details above, report what was tried instead of guessing at a fix.
