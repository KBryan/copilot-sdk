/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createServer } from "node:http";
import { describe, it } from "vitest";
import type { PermissionRequest } from "../../src/index.js";
import { createSdkTestContext, DEFAULT_GITHUB_TOKEN } from "./harness/sdkTestContext.js";

// Policy tests inject host capabilities; these tests check real OS network enforcement through the SDK.
describe("Sandbox proxy host filtering", async () => {
    const { copilotClient: client } = await createSdkTestContext({
        copilotClientOptions: {
            gitHubToken: DEFAULT_GITHUB_TOKEN,
            env: {
                COPILOT_CLI_ENABLED_FEATURE_FLAGS: "SANDBOX",
                GH_TOKEN: DEFAULT_GITHUB_TOKEN,
                GITHUB_TOKEN: DEFAULT_GITHUB_TOKEN,
            },
        },
    });

    for (const { name, rules, blockedHost } of [
        { name: "allowlist", rules: { allowedHosts: ["127.0.0.1"] }, blockedHost: "127.0.0.2" },
        { name: "blocklist", rules: { blockedHosts: ["localhost"] }, blockedHost: "localhost" },
    ]) {
        it(`enforces the ${name} and blocks direct sockets`, async ({
            expect,
            skip,
            onTestFinished,
        }) => {
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
                requests.push(request.url ?? "");
                response.end("SANDBOX_FILTER_ALLOWED");
            });
            onTestFinished(async () => {
                server.closeAllConnections();
                if (server.listening) {
                    await new Promise<void>((resolve, reject) => {
                        server.close((error) => (error ? reject(error) : resolve()));
                    });
                }
            });
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const address = server.address();
            if (!address || typeof address === "string") {
                throw new Error("Expected a TCP listener address");
            }
            const bypassRequests: PermissionRequest[] = [];
            const session = await client.createSession({
                onPermissionRequest: (request) => {
                    if ("requestSandboxBypass" in request && request.requestSandboxBypass) {
                        bypassRequests.push(request);
                        return { kind: "reject" };
                    }
                    return { kind: "approve-once" };
                },
            });
            try {
                const update = await session.rpc.options.update({
                    sandboxConfig: {
                        enabled: true,
                        allowBypass: false,
                        addCurrentWorkingDirectory: true,
                        auth: { git: false, gh: false },
                        userPolicy: {
                            network: {
                                allowOutbound: true,
                                allowLocalNetwork: true,
                                ...rules,
                            },
                        },
                    },
                });
                expect(update.success).toBe(true);

                const curl = process.platform === "win32" ? "curl.exe" : "curl";
                const suffix = process.platform === "win32" ? "; exit $LASTEXITCODE" : "";
                const allowed = await session.rpc.shell.executeUserRequested({
                    requestId: `${name}-allowed`,
                    command: `${curl} --disable --silent --show-error --fail --max-time 5 http://127.0.0.1:${address.port}/allowed${suffix}`,
                });
                expect(allowed.success, allowed.output).toBe(true);
                expect(allowed.exitCode, allowed.output).toBe(0);
                expect(allowed.output).toContain("SANDBOX_FILTER_ALLOWED");

                const blocked = await session.rpc.shell.executeUserRequested({
                    requestId: `${name}-blocked`,
                    command: `${curl} --disable --silent --show-error --fail --max-time 5 http://${blockedHost}:${address.port}/blocked${suffix}`,
                });
                expect(blocked.exitCode, blocked.output).toBe(22);
                expect(blocked.output).toContain("403");

                const direct = await session.rpc.shell.executeUserRequested({
                    requestId: `${name}-direct`,
                    command: `${curl} --disable --silent --show-error --fail --noproxy '*' --max-time 2 http://127.0.0.1:${address.port}/direct${suffix}`,
                });
                expect([7, 28], direct.output).toContain(direct.exitCode);
                expect(requests).toEqual(["/allowed"]);
                expect(bypassRequests).toEqual([]);
            } finally {
                await session.disconnect();
            }
        });
    }
});
