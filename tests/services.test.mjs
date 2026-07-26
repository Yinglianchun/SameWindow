import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw lastError || new Error(`service did not start: ${url}`);
}

async function withService(script, environment, callback) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await callback(child);
  } finally {
    child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  assert.equal(stderr, "", stderr);
}

test("control service is healthy and rejects untrusted browser origins", async () => {
  const port = await freePort();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "samewindow-"));
  try {
    await withService("src/control-server.mjs", {
      SAMEWINDOW_CONTROL_PORT: String(port),
      SAMEWINDOW_CURSOR_STATE_FILE: path.join(temporary, "cursor-state.json"),
    }, async () => {
      const health = await waitFor(`http://127.0.0.1:${port}/health`);
      assert.deepEqual(await health.json(), { ok: true, service: "samewindow-control" });

      const rejected = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: "https://untrusted.example" },
      });
      assert.equal(rejected.status, 403);
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
test("lifecycle dashboard and health endpoint start independently", async () => {
  const port = await freePort();
  await withService("src/lifecycle-server.mjs", {
    SAMEWINDOW_LIFECYCLE_PORT: String(port),
    SAMEWINDOW_DASHBOARD_PATH: path.join(root, "web", "dashboard.html"),
  }, async () => {
    const health = await waitFor(`http://127.0.0.1:${port}/health`);
    assert.deepEqual(await health.json(), { ok: true, service: "samewindow-lifecycle" });
    const dashboard = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(await dashboard.text(), /SameWindow shared browser/);
    const fox = await fetch(`http://127.0.0.1:${port}/sleeping-fox.svg`);
    assert.equal(fox.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    assert.match(await fox.text(), /Sleeping fox/);
  });
});
