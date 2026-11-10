import { describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { PI_DEFAULT_MODEL } from "../models";
import { listAvailablePiModels, pickPiModel, piModelRef, type PiModelOption } from "./pi-models";

function fakeProvider(id: string, name: string, models: { id: string; name: string }[]) {
  const faux = fauxProvider({ provider: id, models });
  return {
    ...faux.provider,
    id,
    name,
    auth: {
      apiKey: {
        name: `${name} key`,
        resolve: async ({ credential }: { credential?: { key?: string } }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
      },
    },
  };
}

async function setup(loggedIn: string[]) {
  const credentials = new InMemoryCredentialStore();
  for (const id of loggedIn) await credentials.modify(id, async () => ({ type: "api_key", key: `key-${id}` }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  runtime.registerNativeProvider(fakeProvider("fake-b", "Fake B", [{ id: "b-2", name: "Beta Two" }, { id: "b-1", name: "Beta One" }]));
  runtime.registerNativeProvider(fakeProvider("fake-a", "Fake A", [{ id: "a-1", name: "Alpha One" }]));
  runtime.registerNativeProvider(fakeProvider("fake-none", "Fake None", [{ id: "n-1", name: "Nobody" }]));
  return runtime;
}

const option = (provider: string, id: string): PiModelOption => ({ ref: `${provider}/${id}`, provider, id, name: id });

describe("listAvailablePiModels", () => {
  test("lists only models whose provider has credentials, as provider/id refs with names", async () => {
    const runtime = await setup(["fake-a", "fake-b"]);

    const models = (await listAvailablePiModels(runtime)).filter((m) => m.provider.startsWith("fake-"));

    expect(models.map((m) => [m.ref, m.name])).toEqual([
      ["fake-a/a-1", "Alpha One"],
      ["fake-b/b-1", "Beta One"],
      ["fake-b/b-2", "Beta Two"],
    ]);
  });

  test("sees credentials added after the runtime was created", async () => {
    const runtime = await setup([]);
    expect((await listAvailablePiModels(runtime)).filter((m) => m.provider.startsWith("fake-"))).toEqual([]);

    await runtime.setRuntimeApiKey("fake-a", "late-key");

    expect((await listAvailablePiModels(runtime)).filter((m) => m.provider === "fake-a").map((m) => m.ref)).toEqual(["fake-a/a-1"]);
  });

  test("is empty when nothing is logged in", async () => {
    const runtime = await setup([]);
    expect((await listAvailablePiModels(runtime)).filter((m) => m.provider.startsWith("fake-"))).toEqual([]);
  });
});

describe("piModelRef", () => {
  test("joins provider and id", () => {
    expect(piModelRef({ provider: "anthropic", id: "claude-opus-5-5" })).toBe("anthropic/claude-opus-5-5");
  });
});

describe("pickPiModel", () => {
  const available = [option("fake-a", "a-1"), option("fake-b", "b-1")];

  test("keeps the preferred model when it is available", () => {
    expect(pickPiModel("fake-b/b-1", available)).toBe("fake-b/b-1");
  });

  test("an unknown or unavailable preference falls back to the first available model", () => {
    expect(pickPiModel("fake-none/n-1", available)).toBe("fake-a/a-1");
    expect(pickPiModel("sonnet", available)).toBe("fake-a/a-1");
    expect(pickPiModel(undefined, available)).toBe("fake-a/a-1");
  });

  test("with no available model, the default pi model", () => {
    expect(pickPiModel("fake-b/b-1", [])).toBe(PI_DEFAULT_MODEL);
    expect(pickPiModel(undefined, [])).toBe(PI_DEFAULT_MODEL);
  });
});
