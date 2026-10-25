import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { openDatabase } from "./database";

// Runs the real Python device agent against this API, with fake system files and systemctl.
const agentScript = fileURLToPath(new URL("../../../scripts/edge_agent/agent.py", import.meta.url));
const fakeSystemctl = `#!/usr/bin/env python3
import sys
from pathlib import Path
base = Path(__file__).parent
with (base / "calls").open("a") as calls:
    calls.write(" ".join(sys.argv[1:]) + "\\n")
state = base / "state"
if sys.argv[1] == "is-active":
    print(state.read_text().strip())
elif sys.argv[1] in ("start", "restart"):
    state.write_text("active")
elif sys.argv[1] == "stop":
    state.write_text("inactive")
`;

async function until<T>(check: () => Promise<T | undefined | false>, what: string, seconds = 20) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test("device agent reports health and carries out requests end to end", async () => {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const admin = openDatabase();
  await admin.execute(`CREATE SCHEMA ${schema}`);
  const { app, db } = await createApp(schema);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (endpoint: string, body?: unknown, token?: string) =>
    fetch(origin + "/api" + endpoint, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const temp = await mkdtemp(join(tmpdir(), "beehave-agent-"));
  let agent: ReturnType<typeof spawn> | undefined;
  try {
    const owner = (
      await (
        await request("/auth/register", {
          name: "Owner",
          farm: "Agent farm",
          email: "agent-owner@example.com",
          password: "strong-test-password",
          platform: "native",
        })
      ).json()
    ).token as string;
    const registered = await (
      await request("/devices", { name: "Agent Pi", location: "Hive" }, owner)
    ).json();
    const id = registered.device.id as string;

    // Fake Pi: /proc, /sys, monitor output, systemctl, and the device key.
    const files: Record<string, string> = {
      "root/proc/stat": "cpu  100 0 100 800 0 0 0 0 0 0\n",
      "root/proc/meminfo": "MemTotal: 4000000 kB\nMemAvailable: 3000000 kB\n",
      "root/proc/uptime": "7380.5 1000.0\n",
      "root/proc/asound/cards": " 2 [ICS43434       ]: simple-card - ICS43434\n",
      "root/sys/class/thermal/thermal_zone0/temp": "48250\n",
      "runs/20261020T000000Z/classifications.csv":
        "window_end_utc,audio_valid,audio_status_events,dropped_audio_blocks,sensor_status,ram_status,latest_storage_status,model_sha256\n" +
        "2026-10-20T00:00:03+00:00,True,0,0,ok,ok,ok,abcdef0123\n",
      "tools/systemctl": fakeSystemctl,
      "tools/state": "active",
      "device.key": registered.key,
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(temp, path, ".."), { recursive: true });
      await writeFile(join(temp, path), content);
    }
    await chmod(join(temp, "tools/systemctl"), 0o755);
    await mkdir(join(temp, "state"));
    let output = "";
    agent = spawn("python3", [agentScript], {
      env: {
        ...process.env,
        BEEHAVE_API_URL: origin,
        BEEHAVE_DEVICE_KEY_FILE: join(temp, "device.key"),
        BEEHAVE_RUNS_DIR: join(temp, "runs"),
        BEEHAVE_STATE_DIR: join(temp, "state"),
        BEEHAVE_SYSTEM_ROOT: join(temp, "root"),
        BEEHAVE_SYSTEMCTL: join(temp, "tools/systemctl"),
        BEEHAVE_NMCLI: join(temp, "tools/missing-nmcli"),
        BEEHAVE_HEARTBEAT_SECONDS: "1",
        BEEHAVE_POLL_SECONDS: "0.5",
        BEEHAVE_SETTLE_SECONDS: "0",
      },
    });
    agent.stdout?.on("data", (chunk) => (output += chunk));
    agent.stderr?.on("data", (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => agent!.once("exit", resolve));
    const device = async () =>
      (await (await request("/devices", undefined, owner)).json()).find(
        (row: { id: string }) => row.id === id,
      );

    // Heartbeat: health arrives through the real schema; it is not a data sync.
    const reported = await until(async () => (await device())?.health, "first heartbeat");
    assert.equal(reported.collecting, true);
    assert.equal(reported.microphone, true);
    assert.equal(reported.sensor, true);
    assert.equal(reported.uploader, "not installed");
    assert.equal(reported.uptimeSeconds, 7380.5);
    assert.equal((await device()).lastSync, null);
    assert.ok((await device()).lastSeen);

    const send = async (action: string) =>
      (await (await request(`/devices/${id}/commands`, { action, confirm: true }, owner)).json()).id as string;
    const outcome = (command: string) =>
      until(async () => {
        const rows = await (await request(`/devices/${id}/commands`, undefined, owner)).json();
        const row = rows.find((item: { id: string }) => item.id === command);
        return row && !["pending", "sent", "executing"].includes(row.status) ? row : undefined;
      }, "request outcome");

    const stop = await outcome(await send("monitoring_stop"));
    assert.equal(stop.status, "succeeded");
    assert.equal((await readFile(join(temp, "tools/state"), "utf8")).trim(), "inactive");
    const start = await outcome(await send("monitoring_start"));
    assert.equal(start.status, "succeeded");
    assert.equal(start.message, "Monitoring is running.");
    // Restart: the device's "restarting now" leaves the request executing; it completes only
    // when a heartbeat shows a boot after the claim.
    const rebootId = await send("reboot");
    await until(async () => (await readFile(join(temp, "tools/calls"), "utf8")).includes("reboot\n"), "reboot call");
    const verifying = (await (await request(`/devices/${id}/commands`, undefined, owner)).json())
      .find((item: { id: string }) => item.id === rebootId);
    assert.equal(verifying.status, "executing");
    // Simulate the boot: started_at is backdated so the fresh uptime is unambiguous.
    await db.execute("UPDATE device_commands SET started_at=NOW() - INTERVAL '2 minutes' WHERE id=$1", [rebootId]);
    await writeFile(join(temp, "root/proc/uptime"), "15.0 10.0\n");
    const reboot = await outcome(rebootId);
    assert.equal(reboot.status, "succeeded");
    assert.match(reboot.message, /rebooted and reconnected/);

    // Disconnecting the device revokes its key; the agent stops so systemd can reload a fresh key.
    assert.equal((await request(`/devices/${id}/unpair`, { confirm: true }, owner)).status, 200);
    assert.equal(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 10000))]), 3);
    assert.doesNotMatch(output, new RegExp(registered.key));
  } finally {
    agent?.kill();
    await rm(temp, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await admin.execute(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
