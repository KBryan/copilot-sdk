/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Sandboxed MCP connection failures", async () => {
    if (process.platform !== "darwin") {
        // The SDK sandbox suite currently has a backend only on macOS.
        it.skip("preserves sandbox context in MCP failures", () => undefined);
        return;
    }

    const { copilotClient: client, workDir } = await createSdkTestContext({
        copilotClientOptions: {
            env: { COPILOT_CLI_ENABLED_FEATURE_FLAGS: "SANDBOX" },
        },
    });

    for (const { enabled, sandboxMcpServers } of [
        { enabled: true, sandboxMcpServers: true },
        { enabled: false, sandboxMcpServers: true },
        { enabled: true, sandboxMcpServers: false },
    ]) {
        it(
            `reports an early server exit with enabled=${enabled}, sandboxMcpServers=${sandboxMcpServers}`,
            { timeout: 120_000 },
            async ({ expect }) => {
                await using session = await client.createSession({
                    onPermissionRequest: approveAll,
                    workingDirectory: workDir,
                    disabledMcpServers: ["exiting"],
                    mcpServers: {
                        exiting: {
                            type: "local",
                            command: "/bin/sh",
                            args: ["-c", "printf 'MCP_STARTUP_DIAGNOSTIC\\n' >&2; exit 42"],
                            workingDirectory: workDir,
                            tools: ["*"],
                        },
                    },
                });
                const update = await session.rpc.options.update({
                    sandboxConfig: {
                        enabled,
                        sandboxMcpServers,
                        addCurrentWorkingDirectory: true,
                        userPolicy: { network: { allowOutbound: false } },
                    },
                });
                expect(update.success).toBe(true);
                // Enable waits for any pending sandbox restart before starting this server.
                await session.rpc.mcp.enable({ serverName: "exiting" });

                await expect
                    .poll(
                        async () => {
                            const server = (await session.rpc.mcp.list()).servers.find(
                                (server) => server.name === "exiting"
                            );
                            return {
                                status: server?.status,
                                error: server?.error,
                                sandboxContext: server?.error?.includes("inside the sandbox."),
                                routingAdvice: server?.error?.includes(
                                    '"sandbox.sandboxMcpServers": false'
                                ),
                                transportTypeLeak: server?.error?.includes("rmcp::"),
                            };
                        },
                        { timeout: 60_000 }
                    )
                    .toMatchObject({
                        status: "failed",
                        error: expect.stringContaining("MCP_STARTUP_DIAGNOSTIC"),
                        sandboxContext: enabled && sandboxMcpServers,
                        routingAdvice: enabled && sandboxMcpServers,
                        transportTypeLeak: false,
                    });
            }
        );
    }
});
