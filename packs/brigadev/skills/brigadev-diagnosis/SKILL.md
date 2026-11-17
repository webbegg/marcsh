---
name: brigadev-diagnosis
description: "Trigger: bug, regression, failing behavior, debug. Diagnosis loop: a failing command first, minimise, ranked hypotheses, fix and prove."
---

# Diagnosis loop

Load this when fixing a bug. It sharpens the ODD rules; it does not replace them: a Bug always starts with a failing test, and RED and GREEN are observed, never assumed.

Redact secrets in every command, output, and log you show or record: write `<REDACTED>`.

## 1. A failing command first

Before any hypothesis, run one command that fails because of this bug, and show its output. No theory from reading code until it exists.

- Best seam first: a failing test, then a script or CLI call with a fixture, a request against a dev server, a replayed captured input, a throwaway harness, and bisection or old-vs-new diffing when the bug appeared between two states.
- It must assert the user's exact symptom, not "runs without error", and be fast, deterministic, and runnable unattended. For a flaky bug, loop it until the failure rate is debuggable.
- When the pack's evidence hooks are enabled, the failing run is recorded as evidence automatically, provided it is a recognised test or check command. The PR body later quotes it as the RED. Run it through `Bash` as the command itself; do not wrap it in a pipe, `||`, or `;`, which would record it as unknown.
- No loop possible: stop, list what you tried, and ask for access, a redacted artifact, or permission for temporary instrumentation. Do not guess.

## 2. Minimise

Cut inputs, callers, config, data, and steps one at a time, re-running after each cut. Stop when every remaining element is load-bearing: removing any one makes the command pass. This is the regression test.

## 3. Rank hypotheses before testing

Write 3 to 5 hypotheses, ranked. Each states a prediction: "If X is the cause, changing Y makes the bug disappear (or Z makes it worse)". Discard what cannot be falsified. Show the ranked list to the user before testing any of them, and go on with your ranking if they do not answer.

## 4. Probe one variable at a time

Each probe maps to one prediction. Prefer a debugger or a targeted log at a boundary that tells hypotheses apart; never log everything. Tag every temporary log with a unique prefix such as `[DEBUG-a4f2]`. For performance bugs, measure a baseline first, then bisect.

## 5. Fix and prove

1. Turn the minimised repro into the failing test (RED) at the seam where the bug really occurs. If only a shallow seam exists, say so: that is a finding, not a licence for a test that cannot catch the bug.
2. Make the minimum root-cause change, then run the same command again (GREEN) and the suite.
3. Re-run the step 1 command on the original, un-minimised scenario.

## 6. Clean up

Run `grep -rn "DEBUG-a4f2" .` with your prefix and remove every hit; delete throwaway harnesses. State the hypothesis that proved correct in the commit message so the next debugger learns from it. End with the Risk line.
