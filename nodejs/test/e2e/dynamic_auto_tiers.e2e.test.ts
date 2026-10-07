/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createGetModelsResponse } from "../../../test/harness/replayingCapiProxy.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { getNextEventOfType } from "./harness/sdkTestHelper.js";
import { isByokBackend } from "./harness/testBackend";

function metadataResponse() {
    return {
        models: createGetModelsResponse(["claude-sonnet-5"]),
        auto: {
            default_tier: "premium-v2",
            tiers: [
                {
                    id: "efficiency",
                    display_name: "Quick",
                    description: "Provider quick description",
                    type: "auto",
                    status: { enabled: true },
                },
                {
                    id: "premium-v2",
                    display_name: "Adaptive",
                    description: "Provider adaptive description",
                    type: "auto",
                    status: { enabled: true },
                },
                {
                    id: "intelligence",
                    display_name: "Careful",
                    description: "Provider disabled description",
                    type: "auto",
                    status: { enabled: false, message: "Contact admin" },
                },
                {
                    id: "ensemble",
                    display_name: "Ensemble",
                    description: "Not an Auto execution type",
                    type: "ensemble",
                    status: { enabled: true },
                },
            ],
        },
    };
}

describe.skipIf(isByokBackend)("Assignment-only Dynamic Auto tiers", async () => {
    let context: Awaited<ReturnType<typeof createSdkTestContext>>;
    if (!isByokBackend) {
        context = await createSdkTestContext({
            useStdio: true,
            copilotClientOptions: {
                env: {
                    DYNAMIC_AUTO_TIERS: "false",
                    COPILOT_EXP_COPILOT_CLI_DYNAMIC_AUTO_TIERS: "false",
                },
            },
        });
    }
    const expAssignments = {
        Features: [],
        Flights: {},
        Configs: [{ Id: "default", Parameters: { copilot_cli_dynamic_auto_tiers: true } }],
        AssignmentContext: "assignment-only-dynamic-auto",
    };

    for (const operation of ["create", "cold resume"] as const) {
        for (const [tier, error] of [
            ["premium-v2", undefined],
            ["intelligence", "Contact admin"],
            ["removed", "unavailable"],
        ] as const) {
            it(`${operation} validates ${tier} using the request assignment`, async () => {
                const { copilotClient: client, createClient, openAiEndpoint: proxy } = context;
                await client.stop();
                await proxy.setMetaResponse(metadataResponse());
                const config = {
                    model: "auto",
                    capi: { autoTier: tier },
                    expAssignments,
                    onPermissionRequest: approveAll,
                };
                let resumedClient: ReturnType<typeof createClient> | undefined;
                try {
                    let request;
                    if (operation === "create") {
                        request = client.createSession(config);
                    } else {
                        await proxy.updateConfig({
                            filePath: fileURLToPath(
                                new URL(
                                    "../../../test/snapshots/auto_tier/should_commit_fast_auto_tier_after_successful_turn.yaml",
                                    import.meta.url
                                )
                            ),
                            workDir: context.workDir,
                            replayOnly: true,
                        });
                        await proxy.setMetaResponse(metadataResponse());
                        const original = await client.createSession({
                            model: "auto",
                            capi: { enableWebSocketResponses: false },
                            onPermissionRequest: approveAll,
                        });
                        const reply = await original.sendAndWait({
                            prompt: "Reply with exactly AUTO_TIER_FAST_COMMITTED.",
                        });
                        expect(reply?.data.content).toBe("AUTO_TIER_FAST_COMMITTED");
                        const sessionId = original.sessionId;
                        await original.disconnect();
                        await client.stop();
                        resumedClient = createClient();
                        request = resumedClient.resumeSession(sessionId, config);
                    }
                    if (error) {
                        await expect(request).rejects.toThrow(error);
                    } else {
                        const session = await request;
                        expect((await session.rpc.model.getCurrent()).autoTier).toBe(tier);
                        await session.disconnect();
                    }
                    const requests = await proxy.getRequests();
                    expect(requests.some((entry) => entry.url === "/meta")).toBe(true);
                } finally {
                    await resumedClient?.stop();
                }
            });
        }
    }
});

// This contract belongs to CAPI discovery/routing, not the alternate BYOK backend matrix.
describe.skipIf(isByokBackend)("Dynamic Auto tiers", async () => {
    let context: Awaited<ReturnType<typeof createSdkTestContext>>;
    if (!isByokBackend) {
        context = await createSdkTestContext({
            useStdio: true,
            copilotClientOptions: {
                env: { DYNAMIC_AUTO_TIERS: "true" },
            },
        });
    }

    it("creates Fast without catalog discovery when metadata is unavailable", async () => {
        const { copilotClient: client, openAiEndpoint: proxy } = context;
        await proxy.setMetaResponse({ message: "Meta is disabled" }, 404);
        const session = await client.createSession({
            model: "auto",
            capi: { autoTier: "fast" },
            onPermissionRequest: approveAll,
        });
        try {
            expect((await session.rpc.model.getCurrent()).autoTier).toBe("fast");
            const fastRequests = await proxy.getRequests();
            expect(
                fastRequests.filter(
                    (request) => request.url === "/meta" || request.url === "/models"
                )
            ).toEqual([]);

            await expect(
                client.createSession({
                    model: "auto",
                    capi: { autoTier: "efficiency" },
                    onPermissionRequest: approveAll,
                })
            ).rejects.toThrow("Meta is disabled");
            const requests = await proxy.getRequests();
            expect(requests.some((request) => request.url === "/meta")).toBe(true);
            expect(requests.some((request) => request.url === "/models")).toBe(false);
        } finally {
            await session.disconnect();
        }
    });

    it("discovers provider tiers without committing the default and validates staged preferences", async () => {
        const { copilotClient: client, openAiEndpoint: proxy } = context;
        await proxy.setMetaResponse(metadataResponse());
        const session = await client.createSession({
            model: "auto",
            onPermissionRequest: approveAll,
        });
        const catalog = await session.rpc.model.list();
        expect(catalog.auto?.defaultTier).toBe("premium-v2");
        expect(catalog.auto?.tiers.map((tier) => tier.id)).toEqual([
            "efficiency",
            "premium-v2",
            "intelligence",
            "ensemble",
        ]);
        expect(catalog.auto?.tiers[1].displayName).toBe("Adaptive");
        expect((await session.rpc.model.getCurrent()).autoTier).toBeUndefined();

        const pending = await session.setAutoTier("premium-v2");
        expect(pending.status).toBe("pending");
        expect(pending.pendingAutoTier).toBe("premium-v2");
        expect((await session.rpc.model.getCurrent()).autoTier).toBeUndefined();
        await session.setModel("auto");
        expect((await session.rpc.model.getCurrent()).pendingAutoTier).toBe("premium-v2");
        await expect(session.setAutoTier("intelligence")).rejects.toThrow("Contact admin");
        await expect(session.setAutoTier("ensemble")).rejects.toThrow();
        await expect(session.setAutoTier("removed")).rejects.toThrow();
        expect((await session.rpc.model.getCurrent()).pendingAutoTier).toBe("premium-v2");
        await session.setAutoTier(null);
        expect((await session.rpc.model.getCurrent()).pendingAutoTier).toBeUndefined();
        await session.disconnect();
    });

    it("does not use models as a fallback when required metadata discovery fails", async () => {
        const { copilotClient: client, openAiEndpoint: proxy } = context;
        await proxy.setMetaResponse(metadataResponse());
        const session = await client.createSession({
            model: "auto",
            onPermissionRequest: approveAll,
        });
        await proxy.setMetaResponse({ message: "Meta is disabled" }, 404);
        await expect(session.rpc.model.list({ skipCache: true })).rejects.toThrow();
        const requests = await proxy.getRequests();
        expect(requests.some((request) => request.url === "/meta")).toBe(true);
        expect(requests.some((request) => request.url === "/models")).toBe(false);
        await session.disconnect();
    });

    it("preserves a newer reset while an older tier request waits for discovery", async () => {
        const { copilotClient: client, openAiEndpoint: proxy } = context;
        await client.stop();
        await proxy.setMetaResponse(metadataResponse());
        const session = await client.createSession({
            model: "auto",
            onPermissionRequest: approveAll,
        });
        const gate = await proxy.gateMetaResponse();
        const older = session.setAutoTier("premium-v2").then(
            (value) => ({ value, error: undefined }),
            (error: Error) => ({ value: undefined, error })
        );
        try {
            await gate.reached();
            const reset = await session.setAutoTier(null);
            expect(reset.status).toBe("unchanged");
        } finally {
            await gate.release();
        }
        const outcome = await older;
        const current = await session.rpc.model.getCurrent();
        expect(current.autoTier).toBeUndefined();
        expect(current.pendingAutoTier).toBeUndefined();
        expect(outcome.error).toBeInstanceOf(Error);
        expect(outcome.error?.message).toContain("superseded");
        await session.disconnect();
    });

    it("validates explicit create and resume preferences without rejecting restored historical preferences", async () => {
        const { copilotClient: client, openAiEndpoint: proxy } = context;
        await proxy.setMetaResponse(metadataResponse());
        await expect(
            client.createSession({
                model: "auto",
                capi: { autoTier: "intelligence" },
                onPermissionRequest: approveAll,
            })
        ).rejects.toThrow("Contact admin");
        const session = await client.createSession({
            model: "auto",
            capi: { autoTier: "premium-v2" },
            onPermissionRequest: approveAll,
        });
        expect((await session.rpc.model.getCurrent()).autoTier).toBe("premium-v2");
        await expect(
            client.resumeSession(session.sessionId, {
                capi: { autoTier: "removed" },
                onPermissionRequest: approveAll,
            })
        ).rejects.toThrow("removed");
        expect((await session.rpc.model.getCurrent()).autoTier).toBe("premium-v2");
        await session.disconnect();
    });

    it("does not synthesize Auto options when the metadata envelope omits auto", async () => {
        const { copilotClient: client, openAiEndpoint: proxy } = context;
        await proxy.setMetaResponse({ models: createGetModelsResponse(["claude-sonnet-5"]) });
        const session = await client.createSession({
            model: "auto",
            onPermissionRequest: approveAll,
        });
        expect((await session.rpc.model.list({ skipCache: true })).auto).toBeUndefined();
        await expect(session.setAutoTier("balance")).rejects.toThrow(
            "unavailable for this account"
        );
        await session.disconnect();
    });

    it("routes a new tier unchanged and retains it on cold resume after removal", async () => {
        const { copilotClient: client, createClient, openAiEndpoint: proxy, workDir } = context;
        // Replay the same assistant exchange; the routing endpoint and its tier are asserted independently.
        await proxy.updateConfig({
            filePath: fileURLToPath(
                new URL(
                    "../../../test/snapshots/auto_tier/should_commit_fast_auto_tier_after_successful_turn.yaml",
                    import.meta.url
                )
            ),
            workDir,
            replayOnly: true,
        });
        await proxy.setMetaResponse(metadataResponse());
        const session = await client.createSession({
            model: "auto",
            onPermissionRequest: approveAll,
            capi: { enableWebSocketResponses: false },
        });
        await session.rpc.model.list({ skipCache: true });
        const changed = getNextEventOfType(session, "session.model_change");
        await session.setAutoTier("premium-v2");
        const reply = await session.sendAndWait({
            prompt: "Reply with exactly AUTO_TIER_FAST_COMMITTED.",
        });
        expect(reply?.data.content).toBe("AUTO_TIER_FAST_COMMITTED");
        expect((await changed).data.autoTier).toBe("premium-v2");
        expect((await session.rpc.model.getCurrent()).autoTier).toBe("premium-v2");
        const request = (await proxy.getRequests()).find((entry) => entry.url === "/auto");
        expect(JSON.parse(request!.body).tier).toBe("premium-v2");
        const sessionId = session.sessionId;
        await session.disconnect();
        await client.stop();

        const removed = metadataResponse();
        removed.auto.default_tier = "efficiency";
        removed.auto.tiers = removed.auto.tiers.filter((tier) => tier.id !== "premium-v2");
        await proxy.setMetaResponse(removed);
        const resumedClient = createClient();
        try {
            const resumed = await resumedClient.resumeSession(sessionId, {
                onPermissionRequest: approveAll,
            });
            expect((await resumed.rpc.model.getCurrent()).autoTier).toBe("premium-v2");
            await expect(resumed.setModel("auto")).rejects.toThrow("premium-v2");
            const replacement = await resumed.setAutoTier("efficiency");
            expect(replacement.pendingAutoTier).toBe("efficiency");
            expect(replacement.effectiveAutoTier).toBe("premium-v2");
        } finally {
            await resumedClient.stop();
        }
    }, 120_000);
});
