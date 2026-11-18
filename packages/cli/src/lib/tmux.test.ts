import { afterEach, describe, expect, test } from "bun:test";
import { cachedTmuxKeys, detectTmuxKeys, resetTmuxKeys, tmuxKeys } from "./tmux";

// S1: inside tmux without extended keys, Shift+Enter arrives as Enter. marcsh asks tmux once whether extended keys are off.

afterEach(() => resetTmuxKeys());

const run = (output: string) => async () => output;
const fails = async () => {
  throw new Error("tmux: not found");
};

describe("detectTmuxKeys", () => {
  test("outside tmux no command runs and the answer is `none`", async () => {
    let ran = 0;
    const result = await detectTmuxKeys({ env: {}, run: async () => (ran++, "off\n") });
    expect(result).toBe("none");
    expect(ran).toBe(0);
  });

  test("an empty TMUX counts as outside tmux", async () => {
    expect(await detectTmuxKeys({ env: { TMUX: "" }, run: run("off") })).toBe("none");
  });

  test("inside tmux with extended-keys off, the answer is `tmux-basic`", async () => {
    expect(await detectTmuxKeys({ env: { TMUX: "/tmp/tmux-1/default,1,0" }, run: run("off\n") })).toBe("tmux-basic");
  });

  test("inside tmux with extended-keys on or always, the answer is `extended`", async () => {
    expect(await detectTmuxKeys({ env: { TMUX: "x" }, run: run("on\n") })).toBe("extended");
    expect(await detectTmuxKeys({ env: { TMUX: "x" }, run: run("always\n") })).toBe("extended");
  });

  test("asks tmux for the global extended-keys option", async () => {
    let asked: string[] = [];
    await detectTmuxKeys({ env: { TMUX: "x" }, run: async (command) => ((asked = command), "on") });
    expect(asked).toEqual(["tmux", "show", "-gv", "extended-keys"]);
  });

  test("a failing command, an empty answer or an unknown value is `unknown`", async () => {
    expect(await detectTmuxKeys({ env: { TMUX: "x" }, run: fails })).toBe("unknown");
    expect(await detectTmuxKeys({ env: { TMUX: "x" }, run: run("") })).toBe("unknown");
    expect(await detectTmuxKeys({ env: { TMUX: "x" }, run: run("maybe") })).toBe("unknown");
  });

  test("a command that never answers gives up as `unknown`", async () => {
    const hang = () => new Promise<string>(() => {});
    expect(await detectTmuxKeys({ env: { TMUX: "x" }, run: hang, timeoutMs: 20 })).toBe("unknown");
  });
});

describe("the cached answer", () => {
  test("is asked once per process", async () => {
    let ran = 0;
    const options = { env: { TMUX: "x" }, run: async () => (ran++, "off") };
    expect(cachedTmuxKeys()).toBeUndefined();
    expect(await tmuxKeys(options)).toBe("tmux-basic");
    expect(await tmuxKeys(options)).toBe("tmux-basic");
    expect(ran).toBe(1);
    expect(cachedTmuxKeys()).toBe("tmux-basic");
  });
});
