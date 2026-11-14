import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeCommand } from "./upgrade";

// S13: every redirect hop must pass the same rule as the address (https, or http to 127.0.0.1/localhost), not only the last one.
let dir: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("a redirect chain through a host the rule refuses is not followed, and nothing runs", async () => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-upgrade-redirect-"));
  const marker = join(dir, "ran");
  server = Bun.serve({
    hostname: "::",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const port = server!.port;
      // [::1] is loopback but not one of the hosts plain http is allowed for.
      if (pathname === "/start") return Response.redirect(`http://[::1]:${port}/hop`, 302);
      if (pathname === "/hop") return Response.redirect(`http://127.0.0.1:${port}/install.sh`, 302);
      return new Response(`#!/bin/bash\ntouch "${marker}"\n`);
    },
  });
  let err = "";
  const code = await upgradeCommand(
    { kind: "upgrade" },
    { env: { PATH: process.env.PATH, MARCSH_INSTALLER_URL: `http://127.0.0.1:${server.port}/start` }, io: { stdout: () => {}, stderr: (text) => void (err += text) } },
  );

  expect(code).toBe(1);
  expect(err).toContain("redirected to");
  expect(existsSync(marker)).toBe(false);
});
