/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc/node.js";
import { createSessionRpc } from "../src/generated/rpc.js";

const fixtures = JSON.parse(
    readFileSync(new URL("../../test/harness/mcp-prompt-fixtures.json", import.meta.url), "utf8")
);

// These dispatch checks supplement the real MCP transport tests in rpc_mcp_and_skills.
describe("generated MCP prompt RPCs", () => {
    it("keeps the bound session when prompt and existing RPC params contain another session ID", async () => {
        const sendRequest = vi.fn().mockResolvedValue({});
        const rpc = createSessionRpc(
            { sendRequest } as unknown as MessageConnection,
            "bound-session"
        );
        const listParams = {
            sessionId: "foreign-session",
            serverName: "fixture",
            cursor: "opaque-cursor",
        };
        const getParams = {
            sessionId: "foreign-session",
            serverName: "fixture",
            promptName: "rich",
            arguments: { topic: "preserved" },
        };
        const sendParams = { sessionId: "foreign-session", prompt: "preserved" };

        await rpc.mcp.prompts.list(listParams);
        await rpc.mcp.prompts.get(getParams);
        await rpc.send(sendParams);

        expect(sendRequest.mock.calls).toEqual([
            ["session.mcp.prompts.list", { ...listParams, sessionId: "bound-session" }],
            ["session.mcp.prompts.get", { ...getParams, sessionId: "bound-session" }],
            ["session.send", { ...sendParams, sessionId: "bound-session" }],
        ]);
    });

    it("binds the session and forwards the opaque list cursor", async () => {
        const sendRequest = vi
            .fn()
            .mockResolvedValueOnce(fixtures.firstPage)
            .mockResolvedValueOnce(fixtures.secondPage);
        const rpc = createSessionRpc(
            { sendRequest } as unknown as MessageConnection,
            "bound-session"
        );

        const first = await rpc.mcp.prompts.list({ serverName: "fixture" });
        expect(first).toEqual(fixtures.firstPage);
        expect(sendRequest).toHaveBeenNthCalledWith(1, "session.mcp.prompts.list", {
            sessionId: "bound-session",
            serverName: "fixture",
        });
        const second = await rpc.mcp.prompts.list({
            serverName: "fixture",
            cursor: first.nextCursor,
        });
        expect(second).toEqual(fixtures.secondPage);
        expect(sendRequest).toHaveBeenNthCalledWith(2, "session.mcp.prompts.list", {
            sessionId: "bound-session",
            serverName: "fixture",
            cursor: first.nextCursor,
        });
    });

    it.each<Record<string, string> | undefined>([undefined, {}, { topic: "日本語", style: "" }])(
        "preserves optional arguments %j and opaque results",
        async (args) => {
            const sendRequest = vi.fn().mockResolvedValue(fixtures.richPrompt);
            const rpc = createSessionRpc(
                { sendRequest } as unknown as MessageConnection,
                "bound-session"
            );
            const params = {
                serverName: "fixture",
                promptName: "rich",
                ...(args === undefined ? {} : { arguments: args }),
            };
            expect(await rpc.mcp.prompts.get(params)).toEqual(fixtures.richPrompt);
            expect(sendRequest).toHaveBeenCalledExactlyOnceWith("session.mcp.prompts.get", {
                ...params,
                sessionId: "bound-session",
            });
        }
    );

    it("does not swallow upstream errors", async () => {
        const error = new Error("Missing required argument: topic");
        const sendRequest = vi.fn().mockRejectedValue(error);
        const rpc = createSessionRpc(
            { sendRequest } as unknown as MessageConnection,
            "bound-session"
        );
        await expect(
            rpc.mcp.prompts.get({ serverName: "fixture", promptName: "rich" })
        ).rejects.toBe(error);
    });
});
