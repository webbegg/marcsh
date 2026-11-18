import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { installExitNotice } from "./resume-notice";

describe("the line printed when marcsh exits (S5)", () => {
  test("nothing is written until the process exits, and then the line goes out with a newline", () => {
    const proc = new EventEmitter();
    const written: string[] = [];
    const say = installExitNotice(proc, (text) => void written.push(text));
    say("marcsh: session abc saved · marcsh -c to resume");
    expect(written).toEqual([]);
    proc.emit("exit", 0);
    expect(written).toEqual(["marcsh: session abc saved · marcsh -c to resume\n"]);
  });

  test("it writes after the listeners that were there first (the renderer restoring the terminal)", () => {
    const proc = new EventEmitter();
    const order: string[] = [];
    proc.on("exit", () => void order.push("restore terminal"));
    const say = installExitNotice(proc, () => void order.push("notice"));
    say("line");
    proc.emit("exit", 0);
    expect(order).toEqual(["restore terminal", "notice"]);
  });

  test("with no line set, or one cleared, nothing is written", () => {
    const proc = new EventEmitter();
    const written: string[] = [];
    const say = installExitNotice(proc, (text) => void written.push(text));
    proc.emit("exit", 0);
    say("line");
    say(undefined);
    proc.emit("exit", 0);
    expect(written).toEqual([]);
  });

  test("a write that fails does not break the exit", () => {
    const proc = new EventEmitter();
    const say = installExitNotice(proc, () => {
      throw new Error("EPIPE");
    });
    say("line");
    expect(() => proc.emit("exit", 0)).not.toThrow();
  });
});
