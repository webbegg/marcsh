import { expect, test } from "bun:test";
import { pausedLabel, sessionModeMessage } from "./permissions-command";

const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​‪-‮⁦-⁩﻿]/;

test("the mode toast escapes a hostile default branch like the dialog row", () => {
  const branch = "main\u001b[31m\u0007‮⁦x​﻿";
  const message = sessionModeMessage("auto", { kind: "default", branch });
  expect(UNSAFE.test(message)).toBe(false);
  expect(message).toContain("on the default branch main\\u001b[31m\\u0007\\u202e\\u2066x\\u200b\\ufeff.");
  expect(pausedLabel("auto", { kind: "default", branch })).toBe("(paused on main\\u001b[31m\\u0007\\u202e\\u2066x\\u200b\\ufeff)");
});

test("the mode toast escapes a none reason", () => {
  const message = sessionModeMessage("yolo", { kind: "none", reason: "x\u001b[2J\u0007‮" });
  expect(UNSAFE.test(message)).toBe(false);
  expect(message).toContain("yolo is paused here: x\\u001b[2J\\u0007\\u202e.");
});

test("normal mode and a feature branch add nothing", () => {
  expect(sessionModeMessage("normal", { kind: "default", branch: "m\u001b" })).toBe("Approval mode: normal for this session");
  expect(sessionModeMessage("yolo", { kind: "feature", branch: "f\u001b" })).toBe("Approval mode: yolo for this session");
});
