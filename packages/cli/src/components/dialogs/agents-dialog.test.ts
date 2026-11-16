import { describe, expect, test } from "bun:test";
import type { Subagent } from "../../lib/agents";
import { Mode } from "../../lib/modes";
import { subagentRowText } from "./agents-dialog";

// M1: /agents lists the named subagents apart from the agents, as information only.

const sub = (over: Partial<Subagent>): Subagent => ({ id: "user/x", address: "x", name: "x", mode: Mode.BUILD, pack: "user", ignored: [], ...over });

describe("a subagent's row in /agents", () => {
  test("shows how it is addressed, where it comes from, its permission, limited tools and description", () => {
    expect(subagentRowText(sub({ address: "refuter-security", name: "Security refuter", pack: "acme/flows", mode: Mode.PLAN, description: "Refutes" }))).toBe(
      "   ↳ refuter-security  (acme/flows, read-only)  Security refuter: Refutes",
    );
    expect(subagentRowText(sub({ address: "helper", name: "helper", tools: { deny: ["bash"] } }))).toBe("   ↳ helper  (user, build, limited tools)");
  });
});
