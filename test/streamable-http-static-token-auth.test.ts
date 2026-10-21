import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { afterEach, describe, test } from "node:test";
import * as path from "node:path";
import { findAvailablePort } from "./utils/server-launcher.js";

const ERROR_MESSAGE =
  "STREAMABLE_HTTP=true/--streamable-http with server-side GitLab credentials requires REMOTE_AUTHORIZATION=true/--remote-auth=true, GITLAB_MCP_OAUTH=true/--mcp-oauth=true, or STREAMABLE_HTTP_AUTH_TOKEN/--streamable-http-auth-token";

const HOST = process.env.HOST || "127.0.0.1";
const SERVER_PATH = path.resolve(process.cwd(), "build/index.js");

const running = new Set<ReturnType<typeof spawn>>();

function startServer(env: Record<string, string>, port: number) {
  const child = spawn("node", [SERVER_PATH], {
    env: {
      ...process.env,
      GITLAB_API_URL: "https://gitlab.example.com",
      HOST,
      PORT: String(port),
      STREAMABLE_HTTP: "true",
      REMOTE_AUTHORIZATION: "false",
      GITLAB_MCP_OAUTH: "false",
      GITLAB_USE_OAUTH: "false",
      GITLAB_PERSONAL_ACCESS_TOKEN: "",
      GITLAB_JOB_TOKEN: "",
      GITLAB_AUTH_COOKIE_PATH: "",
      MCP_SERVER_URL: "",
      GITLAB_OAUTH_APP_ID: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  running.add(child);
  child.once("exit", () => running.delete(child));
  return child;
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 5000) {
  let output = "";
  child.stdout?.on("data", chunk => {
    output += chunk.toString();
  });
  child.stderr?.on("data", chunk => {
    output += chunk.toString();
  });

  let timeoutHandle: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`server did not exit within ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    const [code] = (await Promise.race([once(child, "exit"), timeout])) as [number | null];
    return { code, output };
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

async function waitForHealth(port: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${HOST}:${port}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`server did not become healthy: ${String(lastError)}`);
}

async function postMcpWithoutAuth(port: number) {
  return postMcp(port);
}

async function postMcp(port: number, token?: string) {
  return fetch(`http://${HOST}:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "static-token-auth-test", version: "1.0.0" },
      },
    }),
  });
}

afterEach(async () => {
  const exits: Promise<unknown>[] = [];
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) {
      exits.push(once(child, "exit", { signal: AbortSignal.timeout(5000) }));
      child.kill("SIGTERM");
    }
  }
  await Promise.all(exits);
  running.clear();
});

describe("Streamable HTTP static server token auth", () => {
  test("refuses startup with PAT and no MCP-layer auth", async () => {
    const port = await findAvailablePort(4300);
    const child = startServer({ GITLAB_PERSONAL_ACCESS_TOKEN: "glpat_test" }, port);

    const { code, output } = await waitForExit(child);

    assert.notEqual(code, 0);
    assert.match(output, new RegExp(ERROR_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("refuses startup with JOB-TOKEN and no MCP-layer auth", async () => {
    const port = await findAvailablePort(4310);
    const child = startServer({ GITLAB_JOB_TOKEN: "job_test" }, port);

    const { code, output } = await waitForExit(child);

    assert.notEqual(code, 0);
    assert.match(output, new RegExp(ERROR_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("refuses startup with cookie auth and no MCP-layer auth", async () => {
    const port = await findAvailablePort(4315);
    const child = startServer({ GITLAB_AUTH_COOKIE_PATH: "./cookies.txt" }, port);

    const { code, output } = await waitForExit(child);

    assert.notEqual(code, 0);
    assert.match(output, new RegExp(ERROR_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("allows startup with PAT when REMOTE_AUTHORIZATION is enabled", async () => {
    const port = await findAvailablePort(4320);
    startServer(
      {
        GITLAB_PERSONAL_ACCESS_TOKEN: "glpat_test",
        REMOTE_AUTHORIZATION: "true",
      },
      port
    );

    await waitForHealth(port);

    const initResponse = await postMcpWithoutAuth(port);
    assert.equal(initResponse.status, 401);
  });

  test("requires configured Streamable HTTP auth token", async () => {
    const port = await findAvailablePort(4325);
    startServer(
      {
        GITLAB_PERSONAL_ACCESS_TOKEN: "glpat_test",
        STREAMABLE_HTTP_AUTH_TOKEN: "mcp_static_secret",
      },
      port
    );

    await waitForHealth(port);

    const unauthenticated = await postMcpWithoutAuth(port);
    assert.equal(unauthenticated.status, 401);

    const authenticated = await postMcp(port, "mcp_static_secret");
    assert.equal(authenticated.status, 200);
  });

  test("allows startup with PAT when GITLAB_MCP_OAUTH is enabled", async () => {
    const port = await findAvailablePort(4330);
    startServer(
      {
        GITLAB_PERSONAL_ACCESS_TOKEN: "glpat_test",
        GITLAB_MCP_OAUTH: "true",
        MCP_SERVER_URL: `http://${HOST}:${port}`,
        GITLAB_OAUTH_APP_ID: "oauth-app-id",
      },
      port
    );

    await waitForHealth(port);

    const response = await postMcpWithoutAuth(port);
    assert.equal(response.status, 401);
  });
});

const MCP_TOKEN = "mcp_static_session_test_secret";
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function startSessionServer(env: Record<string, string> = {}) {
  const port = await findAvailablePort(0);
  startServer(
    {
      GITLAB_PERSONAL_ACCESS_TOKEN: "glpat_session_lifecycle_test",
      STREAMABLE_HTTP_AUTH_TOKEN: MCP_TOKEN,
      SESSION_TIMEOUT_SECONDS: "1",
      MAX_SESSIONS: "2",
      MAX_REQUESTS_PER_MINUTE: "1000",
      GITLAB_DISABLE_VERSION_CHECK: "true",
      ...env,
    },
    port
  );
  await waitForHealth(port);
  return port;
}

async function initializeSession(port: number) {
  const response = await postMcp(port, MCP_TOKEN);
  assert.equal(response.status, 200);
  const sid = response.headers.get("mcp-session-id");
  assert.ok(sid);
  await response.text();
  return sid;
}

async function sessionRequest(port: number, sid: string, method = "POST") {
  return fetch(`http://${HOST}:${port}/mcp`, {
    method,
    headers: {
      Authorization: `Bearer ${MCP_TOKEN}`,
      "Mcp-Session-Id": sid,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    ...(method === "POST"
      ? { body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) }
      : {}),
  });
}

async function sessionMetrics(port: number): Promise<{
  activeSessions: number;
  expiredSessions: number;
}> {
  const response = await fetch(`http://${HOST}:${port}/metrics.json`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForSessionCount(port: number, expected: number) {
  const deadline = Date.now() + 4000;
  let actual: number;
  do {
    actual = (await sessionMetrics(port)).activeSessions;
    if (actual === expected) return;
    await delay(50);
  } while (Date.now() < deadline);
  assert.equal(actual, expected, "session slots must be released after inactivity");
}

describe("Streamable HTTP session lifecycle with a server-owned token", { timeout: 60_000 }, () => {
  test("expires abandoned sessions, frees capacity and rejects their old IDs", async () => {
    const port = await startSessionServer();
    const first = await initializeSession(port);
    await initializeSession(port);
    assert.equal((await sessionMetrics(port)).activeSessions, 2);
    const full = await postMcp(port, MCP_TOKEN);
    assert.equal(full.status, 503);
    await full.text();

    await waitForSessionCount(port, 0);
    assert.equal((await sessionMetrics(port)).expiredSessions, 2);
    const expired = await sessionRequest(port, first);
    assert.equal(expired.status, 404);
    assert.deepEqual(await expired.json(), { error: "Session not found" });
    await initializeSession(port);
    assert.equal((await sessionMetrics(port)).activeSessions, 1);
  });

  test("renews inactivity expiry on valid requests, then expires when requests stop", async () => {
    const port = await startSessionServer();
    const sid = await initializeSession(port);
    // Each request arrives within the one-second timeout; their total span exceeds it.
    for (let i = 0; i < 5; i++) {
      await delay(350);
      const response = await sessionRequest(port, sid);
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal((await sessionMetrics(port)).activeSessions, 1);
    assert.equal((await sessionMetrics(port)).expiredSessions, 0);
    await waitForSessionCount(port, 0);
    assert.equal((await sessionMetrics(port)).expiredSessions, 1);
  });

  test("keeps an open SSE stream alive across POST activity and expires after disconnect", async () => {
    const port = await startSessionServer();
    const sid = await initializeSession(port);
    const controller = new AbortController();
    try {
      const stream = await fetch(`http://${HOST}:${port}/mcp`, {
        headers: {
          Authorization: `Bearer ${MCP_TOKEN}`,
          "Mcp-Session-Id": sid,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      assert.equal(stream.status, 200);
      const ping = await sessionRequest(port, sid);
      assert.equal(ping.status, 200);
      await ping.text();
      await delay(2100);
      const stillActive = await sessionRequest(port, sid);
      assert.equal(stillActive.status, 200);
      await stillActive.text();
      assert.equal((await sessionMetrics(port)).expiredSessions, 0);
    } finally {
      controller.abort();
    }
    await waitForSessionCount(port, 0);
    assert.equal((await sessionMetrics(port)).expiredSessions, 1);
  });

  test("DELETE releases the slot once and cancels its inactivity timer", async () => {
    const port = await startSessionServer();
    const sid = await initializeSession(port);
    const closed = await sessionRequest(port, sid, "DELETE");
    assert.equal(closed.status, 204);
    await closed.text();
    const duplicate = await sessionRequest(port, sid, "DELETE");
    assert.equal(duplicate.status, 404);
    await duplicate.text();
    await delay(1200);
    const metrics = await sessionMetrics(port);
    assert.equal(metrics.activeSessions, 0);
    assert.equal(metrics.expiredSessions, 0);
  });

  test("rejected credentials do not renew the session timeout", async () => {
    const port = await startSessionServer();
    const sid = await initializeSession(port);
    for (let i = 0; i < 6; i++) {
      if (i > 0) await delay(350);
      const response = await fetch(`http://${HOST}:${port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token",
          "Mcp-Session-Id": sid,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
      });
      if (i === 0) assert.equal(response.status, 401);
      await response.text();
    }
    assert.equal((await sessionMetrics(port)).activeSessions, 0);
    assert.equal((await sessionMetrics(port)).expiredSessions, 1);
  });

  test("DELETE closes an open SSE response without rearming its expired timer", async () => {
    const port = await startSessionServer();
    const sid = await initializeSession(port);
    const controller = new AbortController();
    try {
      const stream = await fetch(`http://${HOST}:${port}/mcp`, {
        headers: {
          Authorization: `Bearer ${MCP_TOKEN}`,
          "Mcp-Session-Id": sid,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      assert.equal(stream.status, 200);
      const ended = stream.text();
      const deleted = await sessionRequest(port, sid, "DELETE");
      assert.equal(deleted.status, 204);
      await ended;
      await delay(1200);
      assert.equal((await sessionMetrics(port)).activeSessions, 0);
      assert.equal((await sessionMetrics(port)).expiredSessions, 0);
      await initializeSession(port);
    } finally {
      controller.abort();
    }
  });

  test("returns 404 if the session expires before a POST body is complete", async () => {
    const port = await startSessionServer();
    const sid = await initializeSession(port);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" });
    const upload = request(`http://${HOST}:${port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MCP_TOKEN}`,
        "Mcp-Session-Id": sid,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Expect: "100-continue",
        Accept: "application/json, text/event-stream",
      },
    });
    const response = once(upload, "response", { signal: AbortSignal.timeout(5000) });
    try {
      const continued = once(upload, "continue", { signal: AbortSignal.timeout(5000) });
      upload.flushHeaders();
      await continued;
      upload.write(body.slice(0, -1));
      await waitForSessionCount(port, 0);
      upload.end(body.slice(-1));
      const [result] = await response;
      assert.equal(result.statusCode, 404);
      let received = "";
      for await (const chunk of result) received += chunk;
      assert.deepEqual(JSON.parse(received), { error: "Session not found" });
      assert.equal((await sessionMetrics(port)).expiredSessions, 1);
      await initializeSession(port);
    } finally {
      upload.destroy();
      await response.catch(() => undefined);
    }
  });

  test("keeps a slow tool response alive when another POST finishes", async () => {
    let signalRequest!: () => void;
    let releaseRequest!: () => void;
    const started = new Promise<void>(resolve => {
      signalRequest = resolve;
    });
    const released = new Promise<void>(resolve => {
      releaseRequest = resolve;
    });
    const requests: string[] = [];
    const user = {
      id: 42,
      username: "slow-user",
      name: "Slow User",
      state: "active",
      avatar_url: null,
      web_url: "https://gitlab.example.com/slow-user",
      created_at: "2026-01-01T00:00:00Z",
      bio: null,
      location: null,
      public_email: null,
      website_url: null,
      organization: null,
      job_title: null,
      email: null,
      last_sign_in_at: null,
      confirmed_at: null,
      last_activity_on: null,
    };
    const upstream = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      signalRequest();
      void released.then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(user));
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, HOST, resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    try {
      const port = await startSessionServer({
        GITLAB_API_URL: `http://${HOST}:${address.port}/api/v4`,
        GITLAB_TOOLSETS: "all",
      });
      const sid = await initializeSession(port);
      const response = fetch(`http://${HOST}:${port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MCP_TOKEN}`,
          "Mcp-Session-Id": sid,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        }),
      });
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          started,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("GitLab request did not arrive")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      const ping = await sessionRequest(port, sid);
      assert.equal(ping.status, 200);
      await ping.text();
      await delay(2100);
      assert.equal((await sessionMetrics(port)).activeSessions, 1);
      assert.equal((await sessionMetrics(port)).expiredSessions, 0);
      releaseRequest();
      const completed = await response;
      assert.equal(completed.status, 200);
      const body = await completed.text();
      const event = /^data: (\{.*\})$/m.exec(body);
      assert.ok(event, body);
      const message = JSON.parse(event[1]);
      assert.equal(message.id, 42);
      assert.equal(message.error, undefined);
      assert.equal(message.result.isError, undefined);
      assert.equal(JSON.parse(message.result.content[0].text).id, "42");
      assert.deepEqual(requests, ["GET /api/v4/user"]);
      await waitForSessionCount(port, 0);
      assert.equal((await sessionMetrics(port)).expiredSessions, 1);
    } finally {
      releaseRequest();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close(err => (err ? reject(err) : resolve()))
      );
    }
  });
});
