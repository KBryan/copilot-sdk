/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createServer } from "node:http";
import { describe, it } from "vitest";
import type { CopilotSession } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

const TEST_NAME =
    "grants loopback through a restrictive host allowlist and preserves explicit blocks";

describe("Sandbox network", async () => {
    const { copilotClient: client } = await createSdkTestContext({
        copilotClientOptions: {
            env: { COPILOT_CLI_ENABLED_FEATURE_FLAGS: "SANDBOX" },
        },
    });

    it(TEST_NAME, async ({ expect, onTestFinished, skip }) => {
        await client.start();
        const support = await client.rpc.sandbox.getHostSupport();
        if (
            !support.supported ||
            !support.capabilities.some(
                (capability) => capability.name === "network_filtering" && capability.supported
            )
        ) {
            skip(`Host lacks sandbox proxy support: ${JSON.stringify(support)}`);
            return;
        }

        const requests: string[] = [];
        const server = createServer((request, response) => {
            requests.push(request.headers.host ?? "");
            response.end("SANDBOX_LOOPBACK_REACHED");
        });
        let session: CopilotSession | undefined;
        onTestFinished(async () => {
            try {
                await session?.disconnect();
            } finally {
                server.closeAllConnections();
                if (server.listening) {
                    await new Promise<void>((resolve, reject) => {
                        server.close((error) => (error ? reject(error) : resolve()));
                    });
                }
            }
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("Expected a TCP listener address");
        }
        session = await client.createSession({
            onPermissionRequest: (request) =>
                request.kind === "shell" && !request.requestSandboxBypass
                    ? { kind: "approve-once" }
                    : { kind: "reject" },
        });
        const blockedHosts: string[] = [];
        const sandboxConfig = {
            enabled: true,
            failIfUnavailable: true,
            allowBypass: false,
            allowDevToolAccess: false,
            userPolicy: {
                network: {
                    allowOutbound: true,
                    allowLocalNetwork: true,
                    allowedHosts: ["example.test"],
                    blockedHosts,
                },
            },
        };
        expect((await session.rpc.options.update({ sandboxConfig })).success).toBe(true);
        await session.rpc.tools.initializeAndValidate();
        const shell = process.platform === "win32" ? "powershell" : "bash";
        const curl = process.platform === "win32" ? "curl.exe" : "curl";
        const proxy = process.platform === "win32" ? "$env:HTTP_PROXY" : "$HTTP_PROXY";
        const suffix = process.platform === "win32" ? "; exit $LASTEXITCODE" : "";

        for (const host of ["localhost", "127.0.0.1"]) {
            const result = await session.rpc.tools.execute({
                name: shell,
                arguments: {
                    command: `${curl} --disable --silent --show-error --fail --max-time 5 --proxy "${proxy}" http://${host}:${address.port}/${suffix}`,
                    description: "Reach the host loopback server through the sandbox proxy",
                },
                toolCallId: `loopback-${host}`,
            });
            expect(result).toMatchObject({
                resultType: "success",
                textResultForLlm: expect.stringContaining("SANDBOX_LOOPBACK_REACHED"),
            });
        }
        expect(requests).toEqual([`localhost:${address.port}`, `127.0.0.1:${address.port}`]);

        blockedHosts.push("localhost");
        expect((await session.rpc.options.update({ sandboxConfig })).success).toBe(true);
        const blocked = await session.rpc.tools.execute({
            name: shell,
            arguments: {
                command: `${curl} --disable --silent --show-error --max-time 5 --proxy "${proxy}" http://localhost:${address.port}/${suffix}`,
                description: "Check that an explicit host block still wins",
            },
            toolCallId: "loopback-blocked",
        });
        expect(blocked.textResultForLlm).toContain("Sandbox host policy denied the destination");
        expect(requests).toHaveLength(2);
    });
});
