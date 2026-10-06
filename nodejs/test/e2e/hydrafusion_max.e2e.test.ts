/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import {
    approveAll,
    CopilotRequestHandler,
    RuntimeConnection,
    type SessionEvent,
} from "../../src/index.js";
import {
    createSdkTestContext,
    DEFAULT_GITHUB_TOKEN,
    getLegacyCliPathForTests,
} from "./harness/sdkTestContext.js";
import { isByokBackend } from "./harness/testBackend.js";

const MODEL = "gpt-5.6-sol";
const REPLY = "SDK_HYDRAFUSION_MAX_DONE: Au";

class FusionRequestHandler extends CopilotRequestHandler {
    readonly plans: unknown[] = [];
    readonly inference: unknown[] = [];

    protected override async sendRequest(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/models") {
            return Response.json({
                data: [
                    {
                        id: MODEL,
                        name: MODEL,
                        model_picker_enabled: true,
                        policy: { state: "enabled" },
                        supported_endpoints: ["/chat/completions"],
                        capabilities: {
                            supports: { streaming: true, tool_calls: true, vision: true },
                            limits: {
                                max_prompt_tokens: 128000,
                                max_output_tokens: 16384,
                                max_context_window_tokens: 144384,
                            },
                        },
                    },
                ],
            });
        }
        if (path === "/model/fusion") {
            this.plans.push(await request.json());
            return Response.json({
                fusion_mode: "hydrafusion-max",
                fusion_pattern: "solo",
                plan_version: "2",
                steps: [{ role: "generation", model_id: MODEL }],
                session: { token: "jwt.fake.sdk.max.plan", expires_at: 0 },
            });
        }
        if (path === "/chat/completions") {
            const body = (await request.json()) as { model?: string; stream?: boolean };
            this.inference.push(body);
            if (body.model !== MODEL) {
                throw new Error(`Expected concrete Fusion constituent, received ${body.model}`);
            }
            const completion = {
                id: "chatcmpl-sdk-max",
                object: "chat.completion",
                created: 0,
                model: MODEL,
                choices: [
                    {
                        index: 0,
                        message: { role: "assistant", content: REPLY },
                        finish_reason: "stop",
                    },
                ],
                usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            };
            if (!body.stream) return Response.json(completion);
            return new Response(
                `data: ${JSON.stringify({
                    ...completion,
                    object: "chat.completion.chunk",
                    choices: [
                        {
                            index: 0,
                            delta: { role: "assistant", content: REPLY },
                            finish_reason: "stop",
                        },
                    ],
                })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } }
            );
        }
        if (path === "/models/session/intent") {
            return Response.json({ error: "Intent unavailable in this fixture" }, { status: 404 });
        }
        if (path === "/models/session") {
            return Response.json({
                available_models: [MODEL],
                selected_model: MODEL,
                session_token: "jwt.fake.sdk.max.routing",
                expires_at: 0,
            });
        }
        throw new Error(`Unexpected model request: ${request.method} ${path}`);
    }
}

describe.skipIf(isByokBackend).each([false, true])(
    "HydraFusion Max plan-v2 gate: %s",
    async (enabled) => {
        const handler = new FusionRequestHandler();
        const { copilotClient: client, workDir } = await createSdkTestContext({
            copilotClientOptions: {
                gitHubToken: DEFAULT_GITHUB_TOKEN,
                requestHandler: handler,
                env: {
                    HYDRAFUSION: "true",
                    HYDRAFUSION_ROLLOUT: "true",
                    HYDRAFUSION_PLAN_V2: String(enabled),
                    COPILOT_EXP_COPILOT_CLI_HYDRAFUSION_PLAN_V2: String(enabled),
                },
            },
        });

        if (!enabled) {
            it.each([false, true])(
                "rejects public SDK creation before inference (provider=%s)",
                async (providerPresent) => {
                    await expect(
                        client.createSession({
                            model: "hydrafusion-max",
                            enableExperimentalMode: true,
                            workingDirectory: workDir,
                            onPermissionRequest: approveAll,
                            ...(providerPresent
                                ? {
                                      provider: {
                                          baseUrl: "https://provider.example.invalid",
                                          apiKey: "fixture-key",
                                      },
                                  }
                                : {}),
                        })
                    ).rejects.toThrow('Model "hydrafusion-max" is not available.');
                    expect(handler.plans).toEqual([]);
                    expect(handler.inference).toEqual([]);
                }
            );

            describe.skipIf(isByokBackend).each(["native", "legacy"] as const)(
                "HydraFusion Max session flags (%s)",
                async (transport) => {
                    const handler = new FusionRequestHandler();
                    const { copilotClient: client, workDir } = await createSdkTestContext({
                        copilotClientOptions: {
                            connection: RuntimeConnection.forStdio({
                                path:
                                    transport === "legacy"
                                        ? await getLegacyCliPathForTests()
                                        : process.env.COPILOT_CLI_PATH,
                            }),
                            gitHubToken: DEFAULT_GITHUB_TOKEN,
                            requestHandler: handler,
                            env: {
                                HYDRAFUSION: "true",
                                HYDRAFUSION_ROLLOUT: "true",
                                HYDRAFUSION_PLAN_V2: "false",
                                COPILOT_EXP_COPILOT_CLI_HYDRAFUSION_PLAN_V2: "false",
                            },
                        },
                    });

                    it("enables Max for one session without enabling it for the host", async () => {
                        const options = {
                            model: "hydrafusion-max",
                            enableExperimentalMode: true,
                            workingDirectory: workDir,
                            onPermissionRequest: approveAll,
                        };
                        const session = await client.createSession({
                            ...options,
                            featureFlags: {
                                HYDRAFUSION: true,
                                HYDRAFUSION_ROLLOUT: true,
                                HYDRAFUSION_PLAN_V2: true,
                            },
                        });
                        const events: SessionEvent[] = [];
                        const unsubscribe = session.on((event) => events.push(event));
                        try {
                            const reply = await session.sendAndWait({
                                prompt: "What is the chemical symbol for gold? Do not use tools.",
                            });
                            expect(reply?.data.content).toBe(REPLY);
                            expect(handler.plans).toEqual([
                                expect.objectContaining({
                                    fusion_mode: "hydrafusion-max",
                                    plan_version: "2",
                                }),
                            ]);
                            expect(events).toEqual(
                                expect.arrayContaining([
                                    expect.objectContaining({
                                        type: "session.fusion_resolved",
                                        data: expect.objectContaining({
                                            syntheticModel: "hydrafusion-max",
                                            policy: "max",
                                            planVersion: "2",
                                        }),
                                    }),
                                ])
                            );
                            await expect(client.createSession(options)).rejects.toThrow(
                                'Model "hydrafusion-max" is not available.'
                            );
                        } finally {
                            unsubscribe();
                            await session.disconnect();
                        }
                    });
                }
            );
        } else {
            it("creates Max through the public SDK and executes a concrete v2 plan", async () => {
                const session = await client.createSession({
                    model: "hydrafusion-max",
                    enableExperimentalMode: true,
                    workingDirectory: workDir,
                    onPermissionRequest: approveAll,
                });
                const events: SessionEvent[] = [];
                const unsubscribe = session.on((event) => events.push(event));
                try {
                    const reply = await session.sendAndWait({
                        prompt: "What is the chemical symbol for gold? Do not use tools.",
                    });
                    expect(reply?.data.content).toBe(REPLY);
                    expect(handler.plans).toEqual([
                        expect.objectContaining({
                            fusion_mode: "hydrafusion-max",
                            plan_version: "2",
                        }),
                    ]);
                    expect(handler.inference.length).toBeGreaterThan(0);
                    expect(events).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                type: "session.fusion_resolved",
                                data: expect.objectContaining({
                                    syntheticModel: "hydrafusion-max",
                                    policy: "max",
                                    planVersion: "2",
                                }),
                            }),
                        ])
                    );
                } finally {
                    unsubscribe();
                    await session.disconnect();
                }
            });
        }
    }
);
