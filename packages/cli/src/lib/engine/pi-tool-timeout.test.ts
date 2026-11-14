import { describe, expect, test } from "bun:test";
import {
  createBashTimeoutExtension,
  isBackgroundCall,
  runWithToolTimeout,
  TOOL_CALL_TIMEOUT_MS,
  ToolCallTimeoutError,
  toolTimeoutMessage,
} from "./pi-tool-timeout";

// A tool that never settles on its own: it only rejects once its signal aborts.
const hanging = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

describe("toolTimeoutMessage", () => {
  test("the default is 3 minutes", () => {
    expect(TOOL_CALL_TIMEOUT_MS).toBe(180_000);
  });

  test("names the tool and the time; bash always suggests an explicit timeout, and nothing points at background tools the turn lacks (R3-2)", () => {
    const message = toolTimeoutMessage("bash", TOOL_CALL_TIMEOUT_MS);

    expect(message).toStartWith('Tool call "bash" timed out after 3m');
    expect(message).toContain("`timeout`");
    expect(message).not.toContain("bg_start");
    expect(message).not.toContain("background: true");
    expect(toolTimeoutMessage("Task", TOOL_CALL_TIMEOUT_MS)).not.toContain("background: true");
    expect(toolTimeoutMessage("Task", TOOL_CALL_TIMEOUT_MS)).not.toContain("bg_start");
  });

  test("with background support, bash points at bg_start and Task at `background: true` (R3-2)", () => {
    const bash = toolTimeoutMessage("bash", TOOL_CALL_TIMEOUT_MS, { background: true });
    expect(bash).toContain("`timeout`");
    expect(bash).toContain("bg_start");
    expect(toolTimeoutMessage("Task", TOOL_CALL_TIMEOUT_MS, { background: true })).toContain("Task and `background: true`");
  });

  test("a time under a minute is shown in seconds, and under a second in milliseconds", () => {
    expect(toolTimeoutMessage("Task", 30_000)).toContain("timed out after 30s");
    expect(toolTimeoutMessage("Task", 250)).toContain("timed out after 250ms");
  });
});

describe("isBackgroundCall", () => {
  test("is only a call whose background parameter is true", () => {
    expect(isBackgroundCall({ background: true })).toBe(true);
    expect(isBackgroundCall({ background: false })).toBe(false);
    expect(isBackgroundCall({ background: "true" })).toBe(false);
    expect(isBackgroundCall({})).toBe(false);
    expect(isBackgroundCall(undefined)).toBe(false);
    expect(isBackgroundCall(null)).toBe(false);
  });
});

describe("runWithToolTimeout", () => {
  test("returns what the tool returns when it finishes in time", async () => {
    expect(await runWithToolTimeout("bash", 1_000, undefined, async () => "done")).toBe("done");
  });

  test("a tool that hangs is aborted and rejects with the timeout error", async () => {
    let seen: AbortSignal | undefined;
    const startedAt = Date.now();

    const error = await runWithToolTimeout("bash", 50, undefined, (signal) => {
      seen = signal;
      return hanging(signal);
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolCallTimeoutError);
    expect((error as Error).message).toBe(toolTimeoutMessage("bash", 50));
    expect(seen?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("an interrupt is not a timeout: it rejects with the interrupt and aborts the tool", async () => {
    const turn = new AbortController();
    let seen: AbortSignal | undefined;

    const running = runWithToolTimeout("Task", 5_000, turn.signal, (signal) => {
      seen = signal;
      return hanging(signal);
    }).catch((caught: unknown) => caught);
    turn.abort(new Error("interrupted by the user"));
    const error = await running;

    expect(error).not.toBeInstanceOf(ToolCallTimeoutError);
    expect((error as Error).message).toBe("interrupted by the user");
    expect(seen?.aborted).toBe(true);
  });

  test("a signal that is already aborted rejects at once", async () => {
    const turn = new AbortController();
    turn.abort(new Error("over"));

    await expect(runWithToolTimeout("bash", 5_000, turn.signal, hanging)).rejects.toThrow("over");
  });

  test("the clock stops while the tool holds it (an approval waits for the user) and runs on after (R3-3)", async () => {
    const startedAt = Date.now();
    const value = await runWithToolTimeout("Task", 60, undefined, async (_signal, clock) => {
      const release = clock.hold();
      await Bun.sleep(150);
      release();
      release();
      await Bun.sleep(20);
      return "answered";
    });
    expect(value).toBe("answered");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);

    // Held and released, the time before and after still adds up to the timeout.
    const error = await runWithToolTimeout("Task", 60, undefined, async (signal, clock) => {
      await Bun.sleep(30);
      const release = clock.hold();
      await Bun.sleep(100);
      release();
      return hanging(signal);
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolCallTimeoutError);
  });

  test("the timeout error says what the turn offers (R3-2)", async () => {
    const error = await runWithToolTimeout("Task", 20, undefined, hanging, { background: true }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(toolTimeoutMessage("Task", 20, { background: true }));
  });

  test("a tool error passes through unchanged", async () => {
    await expect(
      runWithToolTimeout("bash", 1_000, undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

type Handler = (event: any) => unknown;

// The parts of pi's extension API the bash extension uses: its handlers by event, and the registered tools.
function loadBashExtension(timeoutMs: number, bashSource = "builtin:bash", options?: { background?: boolean }) {
  const handlers = new Map<string, Handler[]>();
  const extension = createBashTimeoutExtension(timeoutMs, options);
  if (typeof extension === "function") throw new Error("expected a named inline extension");
  extension.factory({
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getAllTools: () => [{ name: "bash", sourceInfo: { path: bashSource } }],
  } as never);
  const emit = (event: Record<string, unknown>) => (handlers.get(event.type as string) ?? []).map((handler) => handler(event));
  // pi runs the call with `input` (the object it hands the first handler); handlers after this one get `event.input`.
  let executed: Record<string, unknown> = {};
  const call = (input: Record<string, unknown>, toolCallId = "call-1", toolName = "bash") => {
    executed = input;
    const event = { type: "tool_call", toolName, toolCallId, input };
    emit(event);
    return { executed: input, later: event.input };
  };
  const result = (text: string, toolCallId = "call-1", toolName = "bash", isError = true) => {
    const event = { type: "tool_result", toolName, toolCallId, input: executed, content: [{ type: "text", text }], isError, details: undefined };
    return { changed: emit(event)[0], later: event.input };
  };
  return { extension, emit, call, result };
}

const TIMED_OUT = "partial output\n\nCommand timed out after 0.5 seconds";

describe("createBashTimeoutExtension", () => {
  test("is a hidden inline extension with its own marcsh name", () => {
    const { extension } = loadBashExtension(500);

    if (typeof extension === "function") throw new Error("expected a named inline extension");
    expect(extension.name).toBe("marcsh-bash-timeout");
    expect(extension.hidden).toBe(true);
  });

  test("a bash call without a timeout runs with the default one, in seconds", () => {
    const { call } = loadBashExtension(500);

    expect(call({ command: "sleep 30" }).executed).toEqual({ command: "sleep 30", timeout: 0.5 });
  });

  test("the handlers after it (approval) get the input as the model sent it, an object the timeout never touches", () => {
    const { call } = loadBashExtension(500);

    const { executed, later } = call({ command: "sleep 30" });

    expect(later).toEqual({ command: "sleep 30" });
    expect(later).not.toBe(executed);
  });

  test("a timeout the call passes wins, shorter or longer, and the input is not copied", () => {
    const { call } = loadBashExtension(500);

    const shorter = call({ command: "sleep 30", timeout: 1 });
    const longer = call({ command: "sleep 30", timeout: 600 }, "call-2");

    expect(shorter.executed).toEqual({ command: "sleep 30", timeout: 1 });
    expect(shorter.later).toBe(shorter.executed);
    expect(longer.executed).toEqual({ command: "sleep 30", timeout: 600 });
  });

  test("a bash call that says background: true still gets the timeout: only bg_start and Task run in the background (S5)", () => {
    const { call } = loadBashExtension(500);

    const background = call({ command: "sleep 30", background: true });

    expect(background.executed).toEqual({ command: "sleep 30", background: true, timeout: 0.5 });
    expect(background.later).toEqual({ command: "sleep 30", background: true });
  });

  test("other tools are left alone", () => {
    const { call } = loadBashExtension(500);

    const read = call({ path: "a.txt" }, "call-2", "read");

    expect(read.executed).toEqual({ path: "a.txt" });
  });

  test("a bash tool that is not pi's own is left alone", () => {
    const { call } = loadBashExtension(500, "/home/u/.marcsh/agent/extensions/bash.ts");

    expect(call({ command: "sleep 30" }).executed).toEqual({ command: "sleep 30" });
  });

  test("pi's timeout text for a defaulted call becomes marcsh's message; the output before it stays", () => {
    const { call, result } = loadBashExtension(500);
    call({ command: "sleep 30" });

    const { changed } = result(TIMED_OUT) as { changed: { content: { type: string; text: string }[] } };

    expect(changed.content).toEqual([{ type: "text", text: `partial output\n\n${toolTimeoutMessage("bash", 500)}` }]);
  });

  test("in a turn with background support the message points at bg_start (R3-2)", () => {
    const { call, result } = loadBashExtension(500, "builtin:bash", { background: true });
    call({ command: "sleep 30" });

    const { changed } = result(TIMED_OUT) as { changed: { content: { type: string; text: string }[] } };

    expect(changed.content).toEqual([{ type: "text", text: `partial output\n\n${toolTimeoutMessage("bash", 500, { background: true })}` }]);
    expect(changed.content[0]!.text).toContain("bg_start");
  });

  test("the result handlers after it (pack hooks) see the input without the timeout marcsh added", () => {
    const { call, result } = loadBashExtension(500);
    call({ command: "sleep 30" });

    expect(result(TIMED_OUT).later).toEqual({ command: "sleep 30" });
  });

  test("a call that passed its own timeout keeps pi's text and its timeout", () => {
    const { call, result } = loadBashExtension(500);
    call({ command: "sleep 30", timeout: 0.5 });

    const { changed, later } = result(TIMED_OUT);

    expect(changed).toBeUndefined();
    expect(later).toEqual({ command: "sleep 30", timeout: 0.5 });
  });

  test("the id is forgotten once its result is seen, so a later call with the same id keeps pi's text", () => {
    const { call, result } = loadBashExtension(500);
    call({ command: "true" });
    expect(result("ok", "call-1", "bash", false).changed).toBeUndefined();

    call({ command: "sleep 30", timeout: 0.5 });
    expect(result(TIMED_OUT).changed).toBeUndefined();
  });

  test("a call that ends without a result (blocked or aborted before it ran) leaves no id behind", () => {
    const { call, emit, result } = loadBashExtension(500);
    call({ command: "sleep 30" });
    emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {}, isError: true });

    call({ command: "sleep 30", timeout: 0.5 });
    expect(result(TIMED_OUT).changed).toBeUndefined();
  });
});
