/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { test } from "vitest";
import { startSessionExpiryMcpServer } from "./test-mcp-session-expiry-server.mjs";

test("negotiates legacy session semantics even when the client requests modern MCP", async ({
  expect,
  onTestFinished,
}) => {
  const server = await startSessionExpiryMcpServer();
  onTestFinished(() => server.close());

  const initialize = () =>
    fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          capabilities: {},
          clientInfo: { name: "session-expiry-test", version: "1" },
        },
      }),
    });
  const initialized = await initialize();
  expect(initialized.status).toBe(200);
  expect((await initialized.json()).result.protocolVersion).toBe("2025-03-26");
  const sessionId = initialized.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  const ping = () =>
    fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
  const alive = await ping();
  expect(alive.status).toBe(200);
  expect(await alive.json()).toEqual({ jsonrpc: "2.0", id: 2, result: {} });

  const expired = await fetch(`${server.url}/__expire`, { method: "POST" });
  expect(expired.status).toBe(200);
  expect(await expired.json()).toEqual({ expired: 1 });
  const afterExpiry = await ping();
  expect(afterExpiry.status).toBe(404);
  expect(await afterExpiry.json()).toEqual({ error: "session_expired" });

  const reinitialized = await initialize();
  expect(reinitialized.status).toBe(200);
  expect((await reinitialized.json()).result.protocolVersion).toBe("2025-03-26");
  expect(reinitialized.headers.get("mcp-session-id")).not.toBe(sessionId);
  expect(server.stats.initializations).toBe(2);
});
