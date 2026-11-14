import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpgradeArgs } from "../cli-args";
import { DEFAULT_INSTALLER_URL, upgradeCommand } from "./upgrade";

// The installer is a fake: it records MARCSH_VERSION and how it was started, and exits with the code the test asks for.
const FAKE_INSTALLER = `#!/usr/bin/env bash
printf '%s\\n' "\${MARCSH_VERSION-unset}" > "$FAKE_OUT"
printf '%s\\n' "$0" >> "$FAKE_OUT"
exit "\${FAKE_EXIT:-0}"
`;

let server: ReturnType<typeof Bun.serve>;
let dir: string;
let out: string;
let err: string;
let hits: string[];
let body: () => Response;
const io = { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text) };

const url = () => `http://127.0.0.1:${server.port}/install.sh`;
const marker = () => join(dir, "recorded");
const recorded = () => readFileSync(marker(), "utf8").trimEnd().split("\n") as [string, string];

/** A copy of this process's environment (bash needs its PATH) with the installer pointed at the local server. */
const envFor = (extra: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, MARCSH_INSTALLER_URL: url(), FAKE_OUT: marker(), ...extra };
  if (!("MARCSH_VERSION" in extra)) delete env.MARCSH_VERSION;
  return env as Record<string, string>;
};
const run = (args: Partial<UpgradeArgs> = {}, env = envFor(), deps: Parameters<typeof upgradeCommand>[1] = {}) =>
  upgradeCommand({ kind: "upgrade", ...args }, { io, env, ...deps });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      hits.push(new URL(request.url).pathname);
      return body();
    },
  });
});
afterAll(() => void server.stop(true));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-cli-upgrade-"));
  out = "";
  err = "";
  hits = [];
  body = () => new Response(FAKE_INSTALLER);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("upgrade", () => {
  test("downloads the installer to a file, runs it with bash and returns its exit code", async () => {
    expect(await run({}, envFor({ FAKE_EXIT: "0" }))).toBe(0);
    expect(hits).toEqual(["/install.sh"]);
    const [version, script] = recorded();
    expect(version).toBe("unset");
    // It ran from a file of its own (not piped), which is gone afterwards.
    expect(script).toContain("install.sh");
    expect(script).not.toBe("bash");
    expect(existsSync(script)).toBe(false);
  });

  test("the exit code of the installer is the exit code of upgrade", async () => {
    expect(await run({}, envFor({ FAKE_EXIT: "7" }))).toBe(7);
  });

  test("prints where the installer comes from before it runs", async () => {
    await run();
    expect(out).toStartWith(`Downloading the installer from ${url()}\n`);
    expect(err).toBe("");
  });

  test("--version sets MARCSH_VERSION for the installer", async () => {
    expect(await run({ version: "0.2.0" })).toBe(0);
    expect(recorded()[0]).toBe("0.2.0");
  });

  test("without --version the installer decides (the environment's own MARCSH_VERSION is left alone)", async () => {
    await run({}, envFor({ MARCSH_VERSION: "0.9.9" }));
    expect(recorded()[0]).toBe("0.9.9");
  });

  test("the default address is the official installer", async () => {
    expect(DEFAULT_INSTALLER_URL).toBe("https://raw.githubusercontent.com/webbegg/marcsh/main/install.sh");
    const seen: string[] = [];
    const env = envFor();
    delete (env as Record<string, string | undefined>).MARCSH_INSTALLER_URL;
    const code = await run({}, env, {
      fetch: async (input) => {
        seen.push(String(input));
        return new Response(FAKE_INSTALLER);
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([DEFAULT_INSTALLER_URL]);
    expect(out).toContain(DEFAULT_INSTALLER_URL);
  });

  test("an HTTP error stops before anything runs", async () => {
    body = () => new Response("nope", { status: 404 });
    expect(await run()).toBe(1);
    expect(err).toBe(`marcsh: cannot download the installer from ${url()}: HTTP 404\n`);
    expect(existsSync(marker())).toBe(false);
  });

  test("something that is not a script is not run", async () => {
    body = () => new Response("<html>sign in to the wifi</html>");
    expect(await run()).toBe(1);
    expect(err).toContain("does not look like a shell script");
    expect(existsSync(marker())).toBe(false);
  });

  test("an installer over 1 MiB is not run", async () => {
    body = () => new Response(`#!/usr/bin/env bash\n${"#".repeat(2 * 1024 * 1024)}\n`);
    expect(await run()).toBe(1);
    expect(err).toContain("too large");
    expect(existsSync(marker())).toBe(false);
  });

  test("a server that is not there is a failure, not a crash", async () => {
    const env = envFor({ MARCSH_INSTALLER_URL: "http://127.0.0.1:1/install.sh" });
    expect(await run({}, env)).toBe(1);
    expect(err).toStartWith('marcsh: cannot download the installer from http://127.0.0.1:1/install.sh: ');
    expect(existsSync(marker())).toBe(false);
  });

  test("only https, or http on this machine, is accepted", async () => {
    for (const bad of ["http://example.com/install.sh", "ftp://example.com/install.sh", "file:///tmp/install.sh", "not a url"]) {
      out = err = "";
      expect(await run({}, envFor({ MARCSH_INSTALLER_URL: bad }))).toBe(1);
      expect(err).toContain("MARCSH_INSTALLER_URL must be an https:// address");
      expect(out).toBe("");
    }
    expect(hits).toEqual([]);
  });

  test("a user name and password in the address are not printed", async () => {
    const address = `http://user:hunter2@127.0.0.1:${server.port}/install.sh`;
    expect(await run({}, envFor({ MARCSH_INSTALLER_URL: address }))).toBe(0);
    expect(out).not.toContain("hunter2");
    expect(out).toContain(`http://***@127.0.0.1:${server.port}/install.sh`);
  });

  test("a redirect to an allowed address (even a relative one) is followed, one hop at a time, without letting fetch follow it", async () => {
    const seen: { url: string; redirect?: string }[] = [];
    const code = await run({}, envFor(), {
      fetch: async (input, init) => {
        seen.push({ url: String(input), redirect: init?.redirect });
        return String(input).includes("/moved/") ? new Response(FAKE_INSTALLER) : new Response(null, { status: 302, headers: { location: "/moved/install.sh" } });
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([
      { url: url(), redirect: "manual" },
      { url: `http://127.0.0.1:${server.port}/moved/install.sh`, redirect: "manual" },
    ]);
  });

  test("a redirect to a refused address stops there, and the refused address is never requested", async () => {
    const seen: string[] = [];
    const code = await run({}, envFor(), {
      fetch: async (input) => {
        seen.push(String(input));
        return new Response(null, { status: 301, headers: { location: "http://example.com/install.sh" } });
      },
    });
    expect(code).toBe(1);
    expect(err).toContain("redirected to http://example.com/install.sh");
    expect(seen).toEqual([url()]);
    expect(existsSync(marker())).toBe(false);
  });

  test("a redirect loop is given up on after 5 hops", async () => {
    let requests = 0;
    const code = await run({}, envFor(), {
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 302, headers: { location: `/hop${requests}` } });
      },
    });
    expect(code).toBe(1);
    expect(err).toContain("redirected to");
    expect(requests).toBe(6);
  });

  test("a blank MARCSH_INSTALLER_URL means the default", async () => {
    const seen: string[] = [];
    await run({}, envFor({ MARCSH_INSTALLER_URL: "  " }), {
      fetch: async (input) => {
        seen.push(String(input));
        return new Response(FAKE_INSTALLER);
      },
    });
    expect(seen).toEqual([DEFAULT_INSTALLER_URL]);
  });
});
