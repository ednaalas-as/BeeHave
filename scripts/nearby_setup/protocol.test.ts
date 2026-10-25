import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { pairNearby, setupCommand } from "../../packages/shared/src/nearby";

test("real Python/TypeScript encrypted setup protocol, wrong code rejection, and receipt proof", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "beehave-protocol-"));
  const servicePath = path.resolve("scripts/nearby_setup/service.py");
  const python =
    process.env.SETUP_TEST_PYTHON ?? "/tmp/beehave-setup-test-venv/bin/python";
  const child = spawn(
    python,
    [
      "-u",
      "-c",
      `import importlib.util, pathlib\ns=importlib.util.spec_from_file_location('setup',${JSON.stringify(servicePath)})\nm=importlib.util.module_from_spec(s)\ns.loader.exec_module(m)\nm.STATE=pathlib.Path(${JSON.stringify(state)})\nm.identity()\nserver=m.ThreadingHTTPServer(('127.0.0.1',0),m.Handler)\nprint(server.server_port,flush=True)\nserver.serve_forever()`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const originalFetch = globalThis.fetch;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.once("data", (chunk) =>
        resolve(Number(String(chunk).trim())),
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error("Python test service exited " + code)),
      );
    });
    assert(port > 0);
    const identity = JSON.parse(
      await readFile(path.join(state, "identity.json"), "utf8"),
    );
    globalThis.fetch = (input, init) =>
      originalFetch(
        String(input).replace(
          "http://beehave-pi.local:8765",
          `http://127.0.0.1:${port}`,
        ),
        init,
      );
    const url = "http://beehave-pi.local:8765";
    await assert.rejects(
      setupCommand(url, "0".repeat(32), { action: "invite" }, randomBytes),
    );
    let ticket: { publicKey: string; keyHash: string };
    let completed = false;
    let revokedHash = "";
    let deviceId = "test-device";
    const api = async <T>(
      endpoint: string,
      options?: RequestInit,
    ): Promise<T> => {
      const body = JSON.parse(String(options?.body));
      if (endpoint === "/pairing/start") {
        if (revokedHash && body.ticket.keyHash === revokedHash) return { resetRequired: true } as T;
        ticket = body.ticket;
        return {
          session: "test-session",
          deviceId,
          challenge: "test-challenge",
          completed,
          expires: Date.now() + 600000,
        } as T;
      }
      assert.equal(endpoint, "/pairing/complete");
      assert(
        verify(
          null,
          Buffer.from(
            `beehave-confirm-v1\ntest-session\ntest-challenge\n${deviceId}\n${ticket.keyHash}`,
          ),
          createPublicKey({
            key: Buffer.from(ticket.publicKey, "hex"),
            format: "der",
            type: "spki",
          }),
          Buffer.from(body.signature, "hex"),
        ),
      );
      completed = true;
      return { completed: true } as T;
    };
    const pi = { id: "test-pi", name: "Test Pi", url };
    assert.equal(
      await pairNearby(api, pi, identity.code, "Test Pi", "Hive", randomBytes),
      "test-device",
    );
    assert.equal(
      await pairNearby(api, pi, identity.code, "Test Pi", "Hive", randomBytes),
      "test-device",
    );
    const stored = JSON.parse(
      await readFile(path.join(state, "pairing.json"), "utf8"),
    );
    assert(stored.completed);
    assert.equal(stored.deviceId, "test-device");
    revokedHash = ticket!.keyHash; completed = false; deviceId = "new-device";
    assert.equal(await pairNearby(api, pi, identity.code, "Re-paired Pi", "New hive", randomBytes), "new-device");
    const repaired = JSON.parse(await readFile(path.join(state, "pairing.json"), "utf8"));
    assert.notEqual(repaired.key, stored.key);
    assert.equal(repaired.deviceId, "new-device");
    const status = await setupCommand<{ paired: boolean }>(
      url,
      identity.code,
      { action: "status" },
      randomBytes,
    );
    assert(status.paired);
    await assert.rejects(
      setupCommand(url, identity.code, { action: "upload" }, randomBytes),
      /Unsupported/,
    );
    const evil = await originalFetch(`http://127.0.0.1:${port}/challenge`, {
      headers: { Origin: "https://untrusted.example" },
    });
    assert.equal(evil.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
    child.kill();
    await once(child, "exit");
    await rm(state, { recursive: true, force: true }); // Only this test's newly created temporary fixture.
  }
});
