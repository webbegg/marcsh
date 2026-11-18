import { describe, expect, test } from "bun:test";
import { normalizeClaudeCommands, normalizeEngineCommands } from "./claude-commands";

const UNSAFE = /[\u0000-\u001f\u007f-\u009f​‪-‮⁦-⁩﻿]/;

describe("engine command text in the / menu", () => {
  test("description, hint and source are one printable line", () => {
    const [command] = normalizeEngineCommands([
      { name: "x", description: "a\u001b]0;pwn\u0007b\nc\td‮​ e   f", argumentHint: "<a>\u001b[2J\r\n", source: "skill\u001b[1m" },
    ]);
    expect(command).toEqual({ name: "x", description: "a]0;pwnb c d e f", argumentHint: "<a>[2J", source: "skill[1m" });
    for (const value of Object.values(command!)) expect(UNSAFE.test(String(value))).toBe(false);
  });

  test("normalizing twice (storage round trip) changes nothing", () => {
    const once = normalizeEngineCommands([{ name: "x", description: "a\u001b[31m\n b", argumentHint: "\t<h>", source: "prompt" }]);
    expect(normalizeEngineCommands(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  test("a name that hides text is left out; ordinary names stay", () => {
    const hostile = ["x\u001b[31m", "x‮y", "x​y", "x y", "x　y"];
    const ordinary = ["plugin:cmd", "ns:sub:x", "café", "日本語", "my-cmd", "a_b.c", "review pr"];
    const names = normalizeClaudeCommands([...hostile, ...ordinary].map((name) => ({ name, description: "" }))).map((c) => c.name);
    expect(names).toEqual(ordinary);
  });
});
