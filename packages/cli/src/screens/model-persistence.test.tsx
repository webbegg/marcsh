import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-model-persistence-"));
const prefsPath = join(prefsDir, "preferences.json");
// Never the real ~/.marcsh.
process.env.MARCSH_PREFERENCES_PATH = prefsPath;
process.env.MARCSH_AGENTS_DIR = join(prefsDir, "agents");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { usePromptConfig } = await import("../providers/prompt-config");
const { setLaunchEngine } = await import("../lib/preferences");
type PromptConfig = ReturnType<typeof usePromptConfig>;

let config: PromptConfig;
function Probe() {
  config = usePromptConfig();
  return <text>{`model ${config.model}`}</text>;
}

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};

/** One app start: the provider reads the preferences file as it is now. */
async function start() {
  // Claude is the engine of this launch, so the real pi runtime is never asked which models it has.
  setLaunchEngine("claude");
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Probe /> }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width: 60, height: 6 });
  await settle(60);
}

const stop = async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  setLaunchEngine(undefined);
};
const saved = () => JSON.parse(readFileSync(prefsPath, "utf8"));
const message = (role: "user" | "assistant", model?: string) => ({ role, metadata: model ? { model } : undefined }) as any;

afterEach(async () => {
  await stop();
  rmSync(prefsPath, { force: true });
});
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

describe("the Claude model is kept between launches (S2)", () => {
  test("a first launch starts on opus and writes nothing", async () => {
    await start();
    expect(config.model).toBe("opus");
    expect(existsSync(prefsPath)).toBe(false);
  });

  test("the chosen model is saved and the next launch starts on it", async () => {
    await start();
    await act(async () => config.setModel("haiku"));
    await settle();
    expect(config.model).toBe("haiku");
    expect(saved().claudeModel).toBe("haiku");

    await stop();
    await start();
    expect(config.model).toBe("haiku");
  });

  test("an unknown saved model starts on opus", async () => {
    writeFileSync(prefsPath, JSON.stringify({ claudeModel: "gpt-9" }), "utf8");
    await start();
    expect(config.model).toBe("opus");
  });

  test("the pi model and the Claude model are kept apart", async () => {
    writeFileSync(prefsPath, JSON.stringify({ claudeModel: "sonnet", piModel: "openai/gpt-5" }), "utf8");
    await start();
    expect(config.model).toBe("sonnet");
    expect(config.piModel).toBe("openai/gpt-5");
    await act(async () => config.setModel("opus"));
    await settle();
    expect(saved()).toMatchObject({ claudeModel: "opus", piModel: "openai/gpt-5" });
  });
});

describe("a resumed session keeps its model (S2)", () => {
  test("a Claude session starts on the model it used, without changing the saved choice", async () => {
    writeFileSync(prefsPath, JSON.stringify({ claudeModel: "opus" }), "utf8");
    await start();
    await act(async () => config.adoptSessionModel("claude", [message("user", "sonnet"), message("assistant", "sonnet")]));
    await settle();
    expect(config.model).toBe("sonnet");
    expect(saved().claudeModel).toBe("opus");
  });

  test("the latest model named wins", async () => {
    await start();
    await act(async () => config.adoptSessionModel("claude", [message("assistant", "haiku"), message("assistant", "sonnet")]));
    await settle();
    expect(config.model).toBe("sonnet");
  });

  test("a model that is not a Claude alias, or no model at all, leaves the saved one", async () => {
    writeFileSync(prefsPath, JSON.stringify({ claudeModel: "haiku" }), "utf8");
    await start();
    await act(async () => config.adoptSessionModel("claude", [message("assistant", "anthropic/claude-opus-5-5")]));
    await settle();
    expect(config.model).toBe("haiku");
    await act(async () => config.adoptSessionModel("claude", [message("user"), message("assistant")]));
    await settle();
    expect(config.model).toBe("haiku");
  });

  test("a pi session starts on its own model, and leaves the Claude model and the saved pi model alone", async () => {
    writeFileSync(prefsPath, JSON.stringify({ claudeModel: "haiku", piModel: "openai/gpt-5" }), "utf8");
    await start();
    await act(async () => config.adoptSessionModel("pi", [message("assistant", "google/gemini-3")]));
    await settle();
    expect(config.piModel).toBe("google/gemini-3");
    expect(config.model).toBe("haiku");
    expect(saved()).toMatchObject({ claudeModel: "haiku", piModel: "openai/gpt-5" });
  });

  test("a pi session whose model is a Claude alias keeps the saved pi model", async () => {
    writeFileSync(prefsPath, JSON.stringify({ piModel: "openai/gpt-5" }), "utf8");
    await start();
    await act(async () => config.adoptSessionModel("pi", [message("assistant", "sonnet")]));
    await settle();
    expect(config.piModel).toBe("openai/gpt-5");
  });

  test("a session of an engine this build does not know changes nothing", async () => {
    await start();
    await act(async () => config.adoptSessionModel("other", [message("assistant", "sonnet")]));
    await settle();
    expect(config.model).toBe("opus");
  });
});
