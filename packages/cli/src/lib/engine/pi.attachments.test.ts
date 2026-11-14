import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import type { EngineEvent, NoticeLevel, TurnHost, TurnRequest } from "./types";

// S6: pi takes images as image input when the model does, and everything else as @path references.

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-attachments-"));
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A real 1x1 PNG: pi decodes and resizes images before it sends them.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const png = () => ({ path: join(cwd, "shot.png"), mime: "image/png", kind: "image" as const, bytes: new Uint8Array(Buffer.from(PNG_BASE64, "base64")) });
const pdf = () => ({ path: join(cwd, "spec.pdf"), mime: "application/pdf", kind: "pdf" as const, bytes: new Uint8Array([4, 5]) });

async function setup(input: ("text" | "image")[]) {
  const users: Message[] = [];
  const respond: FauxResponseStep = (context) => {
    users.push(context.messages.filter((message) => message.role === "user").at(-1)!);
    return fauxAssistantMessage([fauxText("ok")]);
  };
  const faux = fauxProvider({ models: [{ id: "faux-1", input }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([respond]);
  const engine = createPiEngine({
    agentDir: join(dir, "agent"),
    modelRuntime,
    permissionRules: openStorage(":memory:"),
    projectTrust: { getProjectTrust: () => "trusted", setProjectTrust: () => {} },
  });

  async function turn(overrides: Partial<TurnRequest>) {
    const events: EngineEvent[] = [];
    const notices: [string, NoticeLevel][] = [];
    const host: TurnHost = {
      emit: (event) => events.push(event),
      askPermission: async () => "deny",
      askQuestions: async () => null,
      notify: (message, level) => notices.push([message, level]),
    };
    await engine.startTurn({ prompt: "what is this?", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...overrides }, host).done;
    return { notices, errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])) };
  }
  return { users, turn };
}

const blocks = (message: Message | undefined) => (typeof message?.content === "string" ? [{ type: "text", text: message.content }] : (message?.content ?? [])) as any[];

describe("pi turns with attachments", () => {
  test("an image goes as image input to a model that takes images, and the prompt text is untouched", async () => {
    const { users, turn } = await setup(["text", "image"]);

    const { errors, notices } = await turn({ attachments: [png()] });

    expect(errors).toEqual([]);
    expect(notices).toEqual([]);
    expect(blocks(users[0])).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
  });

  test("a model without image input gets an @path reference instead, with a notice", async () => {
    const { users, turn } = await setup(["text"]);

    const { errors, notices } = await turn({ attachments: [png()] });

    expect(errors).toEqual([]);
    expect(blocks(users[0])).toEqual([{ type: "text", text: "what is this?\n@shot.png" }]);
    expect(notices).toEqual([["This model cannot take images as input, so shot.png goes as an @path reference.", "warning"]]);
  });

  test("a PDF goes as an @path reference even to a model that takes images, with a notice; the image still goes inline", async () => {
    const { users, turn } = await setup(["text", "image"]);

    const { errors, notices } = await turn({ attachments: [png(), pdf()] });

    expect(errors).toEqual([]);
    expect(blocks(users[0])).toEqual([
      { type: "text", text: "what is this?\n@spec.pdf" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
    expect(notices).toEqual([["This engine cannot take PDFs as input, so spec.pdf goes as an @path reference.", "warning"]]);
  });

  test("another file is an @path mention and needs no notice", async () => {
    const { users, turn } = await setup(["text"]);

    const { notices } = await turn({ attachments: [{ path: join(cwd, "notes.txt"), mime: "text/plain", kind: "file" }] });

    expect(blocks(users[0])).toEqual([{ type: "text", text: "what is this?\n@notes.txt" }]);
    expect(notices).toEqual([]);
  });
});
