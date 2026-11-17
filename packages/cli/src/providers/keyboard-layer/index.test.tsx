import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect } from "react";

process.env.MARCSH_DB_PATH = ":memory:";

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../theme");
const { ToastProvider } = await import("../toast");
const { KeyboardLayerProvider, useKeyboardLayer } = await import("./index");
const { createQuitConfirm } = await import("./quit-confirm");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterEach(async () => {
  if (screen && !screen.renderer.isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const ctrlC = async () => {
  await act(async () => screen!.mockInput.pressCtrlC());
  await settle();
};
const frame = () => screen!.captureCharFrame();

/** A layer like the input or a menu: handles Ctrl+C while `handles()` says so. */
function Layer({ id, handles }: { id: string; handles: () => boolean }) {
  const layers = useKeyboardLayer();
  useEffect(() => {
    layers.push(id, () => handles());
    return () => layers.pop(id);
  }, []);
  return null;
}

async function mount(options: { now?: () => number; layer?: () => boolean } = {}) {
  const quits: number[] = [];
  let clock = 0;
  const now = options.now ?? (() => clock);
  screen = await testRender(
    <ThemeProvider>
      <ToastProvider>
        <KeyboardLayerProvider quit={() => void quits.push(1)} now={now} confirmWindowMs={1500}>
          {options.layer ? <Layer id="input" handles={options.layer} /> : null}
          <text>app</text>
        </KeyboardLayerProvider>
      </ToastProvider>
    </ThemeProvider>,
    { width: 80, height: 12, exitOnCtrlC: false },
  );
  await settle();
  return { quits, advance: (ms: number) => void (clock += ms) };
}

describe("createQuitConfirm (S5)", () => {
  test("the first press arms, a second inside the window quits, one after the window arms again", () => {
    let t = 1000;
    const confirm = createQuitConfirm({ windowMs: 1500, now: () => t });
    expect(confirm.press()).toBe(false);
    t += 1499;
    expect(confirm.press()).toBe(true);

    t += 10_000;
    expect(confirm.press()).toBe(false);
    t += 1501;
    expect(confirm.press()).toBe(false);
    t += 100;
    expect(confirm.press()).toBe(true);
  });

  test("reset forgets an armed press", () => {
    let t = 0;
    const confirm = createQuitConfirm({ windowMs: 1500, now: () => t });
    confirm.press();
    confirm.reset();
    t += 100;
    expect(confirm.press()).toBe(false);
  });
});

describe("Ctrl+C in the keyboard layer (S5)", () => {
  test("with nothing to handle it, the first press only asks for a second one", async () => {
    const { quits } = await mount();
    await ctrlC();
    expect(quits).toEqual([]);
    expect(frame()).toContain("ctrl+c again to quit");
  });

  test("a second press within the window quits", async () => {
    const { quits, advance } = await mount();
    await ctrlC();
    advance(1000);
    await ctrlC();
    expect(quits).toEqual([1]);
  });

  test("a press after the window asks again instead of quitting", async () => {
    const { quits, advance } = await mount();
    await ctrlC();
    advance(1600);
    await ctrlC();
    expect(quits).toEqual([]);
    expect(frame()).toContain("ctrl+c again to quit");
    advance(500);
    await ctrlC();
    expect(quits).toEqual([1]);
  });

  test("a press a layer handles (clearing text, closing a menu) is not the first press, and shows no toast", async () => {
    let handling = true;
    const { quits, advance } = await mount({ layer: () => handling });
    await ctrlC();
    expect(quits).toEqual([]);
    expect(frame()).not.toContain("ctrl+c again to quit");

    handling = false;
    advance(100);
    await ctrlC(); // the first unhandled press: arms
    expect(quits).toEqual([]);
    expect(frame()).toContain("ctrl+c again to quit");
  });

  test("a handled press between two unhandled ones disarms the quit", async () => {
    let handling = false;
    const { quits, advance } = await mount({ layer: () => handling });
    await ctrlC();
    handling = true;
    advance(100);
    await ctrlC();
    handling = false;
    advance(100);
    await ctrlC();
    expect(quits).toEqual([]);
  });
});
