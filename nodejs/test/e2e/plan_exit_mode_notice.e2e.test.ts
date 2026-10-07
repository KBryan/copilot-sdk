/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { describe, expect, it, onTestFinished } from "vitest";
import type {
    CopilotSession,
    NamedProviderConfig,
    ProviderModelConfig,
    SessionEvent,
} from "../../src/index.js";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

const EVENT_TIMEOUT_MS = 30_000;
const EXIT_ONLY_MARKER = "EXIT_ONLY_MODE_NOTICE_REPRO";
const DEFERRED_MARKER = "DEFERRED_MODE_NOTICE_REPRO";
const DEFERRED_AUTOPILOT_MARKER = "DEFERRED_AUTOPILOT_NOTICE_REPRO";
const IMMEDIATE_MARKER = "IMMEDIATE_MODE_NOTICE_CONTROL";

type ModelRequest = {
    messages?: Array<{
        role?: string;
        content?: unknown;
        tool_calls?: Array<{ function?: { name?: string } }>;
    }>;
};

function waitForExitPlanModeRequest(
    session: CopilotSession,
    summary: string
): Promise<Extract<SessionEvent, { type: "exit_plan_mode.requested" }>> {
    return new Promise((resolve, reject) => {
        let unsubscribe: () => void = () => {};
        const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error(`Timed out waiting for exit_plan_mode.requested for ${summary}`));
        }, EVENT_TIMEOUT_MS);

        unsubscribe = session.on((event) => {
            if (event.type === "exit_plan_mode.requested" && event.data.summary === summary) {
                clearTimeout(timer);
                unsubscribe();
                resolve(event);
            } else if (event.type === "session.error") {
                clearTimeout(timer);
                unsubscribe();
                reject(new Error(`${event.data.message}\n${event.data.stack ?? ""}`));
            }
        });
    });
}

function waitForIdle(session: CopilotSession): Promise<void> {
    return new Promise((resolve, reject) => {
        let unsubscribe: () => void = () => {};
        const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error("Timed out waiting for session.idle"));
        }, EVENT_TIMEOUT_MS);

        unsubscribe = session.on((event) => {
            if (event.type === "session.idle") {
                clearTimeout(timer);
                unsubscribe();
                resolve();
            } else if (event.type === "session.error") {
                clearTimeout(timer);
                unsubscribe();
                reject(new Error(`${event.data.message}\n${event.data.stack ?? ""}`));
            }
        });
    });
}

describe("Plan exit mode notices", async () => {
    const { copilotClient: client, workDir } = await createSdkTestContext();

    it("does not inject a mode notice after exit-only and deferred approvals", async () => {
        const modelRequests: ModelRequest[] = [];
        let modelFailure: Error | undefined;
        const modelServer = createServer((request, response) => {
            void (async () => {
                const modelRequest = JSON.parse(await text(request)) as ModelRequest;
                modelRequests.push(modelRequest);
                const serializedMessages = JSON.stringify(modelRequest.messages ?? []);
                const marker = [
                    EXIT_ONLY_MARKER,
                    DEFERRED_MARKER,
                    DEFERRED_AUTOPILOT_MARKER,
                    IMMEDIATE_MARKER,
                ].find((candidate) => serializedMessages.includes(candidate));
                if (!marker) {
                    throw new Error(`Unexpected model request: ${serializedMessages}`);
                }
                const exitPlanModeCalled = modelRequest.messages?.some((message) =>
                    message.tool_calls?.some(
                        (toolCall) => toolCall.function?.name === "exit_plan_mode"
                    )
                );
                const latestUserContent = JSON.stringify(
                    modelRequest.messages?.findLast((message) => message.role === "user")
                        ?.content ?? ""
                );
                const message = latestUserContent.includes(`${marker}_FOLLOW_UP`)
                    ? { role: "assistant", content: `${marker}_FOLLOW_UP_ACK` }
                    : marker === DEFERRED_AUTOPILOT_MARKER && exitPlanModeCalled
                      ? {
                            role: "assistant",
                            content: null,
                            tool_calls: [
                                {
                                    id: `${marker}-task-complete`,
                                    type: "function",
                                    function: {
                                        name: "task_complete",
                                        arguments: JSON.stringify({
                                            summary: "Deferred Autopilot notice verified",
                                        }),
                                    },
                                },
                            ],
                        }
                      : exitPlanModeCalled
                        ? { role: "assistant", content: `${marker}_ACK` }
                        : {
                              role: "assistant",
                              content: null,
                              tool_calls: [
                                  {
                                      id: `${marker}-exit-plan-mode`,
                                      type: "function",
                                      function: {
                                          name: "exit_plan_mode",
                                          arguments: JSON.stringify({ summary: marker }),
                                      },
                                  },
                              ],
                          };
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        id: `${marker}-${modelRequests.length}`,
                        object: "chat.completion",
                        created: 0,
                        model: "test-model",
                        choices: [
                            {
                                index: 0,
                                message,
                                finish_reason: "tool_calls" in message ? "tool_calls" : "stop",
                            },
                        ],
                        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
                    })
                );
            })().catch((error: unknown) => {
                modelFailure = error instanceof Error ? error : new Error(String(error));
                response.writeHead(500).end();
            });
        });
        const sessions: CopilotSession[] = [];
        let serverStart: Promise<void> | undefined;
        onTestFinished(async () => {
            const errors: unknown[] = [];
            for (const session of sessions.toReversed()) {
                try {
                    await session.disconnect();
                } catch (error) {
                    errors.push(error);
                }
            }
            if (serverStart) {
                const [startup] = await Promise.allSettled([serverStart]);
                if (startup.status === "rejected") {
                    errors.push(startup.reason);
                }
            }
            modelServer.closeAllConnections();
            if (modelServer.listening) {
                try {
                    await new Promise<void>((resolve, reject) => {
                        modelServer.close((error) => (error ? reject(error) : resolve()));
                    });
                } catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length) {
                throw new AggregateError(errors, "Plan exit mode notice fixture cleanup failed");
            }
        });
        serverStart = new Promise<void>((resolve, reject) => {
            modelServer.once("error", reject);
            modelServer.listen(0, "127.0.0.1", resolve);
        });
        await serverStart;
        const address = modelServer.address();
        if (!address || typeof address === "string") {
            throw new Error("Missing local model server address");
        }

        const providers: NamedProviderConfig[] = [
            {
                name: "local",
                type: "openai",
                baseUrl: `http://127.0.0.1:${address.port}`,
                apiKey: "test",
                wireApi: "completions",
            },
        ];
        const models: ProviderModelConfig[] = [
            { id: "model", provider: "local", modelId: "test-model", wireModel: "test-model" },
        ];

        const runScenario = async (
            marker: string,
            selectedAction: "exit_only" | "interactive",
            deferImplementation: boolean,
            expectsImmediateModelRound: boolean
        ) => {
            const session = await client.createSession({
                onPermissionRequest: approveAll,
                workingDirectory: workDir,
                providers,
                models,
                model: "local/model",
            });
            sessions.push(session);
            const interest = await session.rpc.eventLog.registerInterest({
                eventType: "exit_plan_mode.requested",
            });
            try {
                await session.rpc.mode.set({ mode: "plan" });
                const requested = waitForExitPlanModeRequest(session, marker);
                const send = session.sendAndWait({
                    prompt: `Call exit_plan_mode with summary ${marker}.`,
                });
                const requestEvent = await requested;
                const response = {
                    approved: true,
                    selectedAction,
                    ...(deferImplementation ? ({ deferImplementation: true } as object) : {}),
                };
                const handled = await session.rpc.ui.handlePendingExitPlanMode({
                    requestId: requestEvent.data.requestId,
                    response,
                });
                expect(handled.success).toBe(true);
                const finalResponse = await send;
                if (expectsImmediateModelRound) {
                    expect(finalResponse?.data.content).toBe(`${marker}_ACK`);
                }

                const immediateRequests = modelRequests.filter((request) =>
                    JSON.stringify(request.messages ?? []).includes(marker)
                );
                expect(immediateRequests).toHaveLength(expectsImmediateModelRound ? 2 : 1);
                const immediateUserMessage = immediateRequests[1]?.messages?.findLast(
                    (message) => message.role === "user"
                );
                const followUpResponse = await session.sendAndWait({
                    prompt: `${marker}_FOLLOW_UP`,
                });
                expect(followUpResponse?.data.content).toBe(`${marker}_FOLLOW_UP_ACK`);
                const requestsAfterFollowUp = modelRequests.filter((request) =>
                    JSON.stringify(request.messages ?? []).includes(marker)
                );
                expect(requestsAfterFollowUp).toHaveLength(expectsImmediateModelRound ? 3 : 2);
                const followUpUserMessage = requestsAfterFollowUp
                    .at(-1)
                    ?.messages?.findLast((message) => message.role === "user");
                return {
                    immediate: JSON.stringify(immediateUserMessage?.content ?? ""),
                    followUp: JSON.stringify(followUpUserMessage?.content ?? ""),
                    immediateRequestCount: immediateRequests.length,
                };
            } finally {
                await session.rpc.eventLog.releaseInterest({ handle: interest.handle });
            }
        };

        const runDeferredAutopilotScenario = async () => {
            const session = await client.createSession({
                onPermissionRequest: approveAll,
                workingDirectory: workDir,
                providers,
                models,
                model: "local/model",
            });
            sessions.push(session);
            const interest = await session.rpc.eventLog.registerInterest({
                eventType: "exit_plan_mode.requested",
            });
            try {
                await session.rpc.mode.set({ mode: "plan" });
                const requested = waitForExitPlanModeRequest(session, DEFERRED_AUTOPILOT_MARKER);
                const initialIdle = waitForIdle(session);
                await session.send({
                    prompt: `Call exit_plan_mode with summary ${DEFERRED_AUTOPILOT_MARKER}.`,
                });
                const requestEvent = await requested;
                const handled = await session.rpc.ui.handlePendingExitPlanMode({
                    requestId: requestEvent.data.requestId,
                    response: {
                        approved: true,
                        selectedAction: "autopilot",
                        ...({ deferImplementation: true } as object),
                    },
                });
                expect(handled.success).toBe(true);
                await initialIdle;

                const immediateRequests = modelRequests.filter((request) =>
                    JSON.stringify(request.messages ?? []).includes(DEFERRED_AUTOPILOT_MARKER)
                );
                expect(immediateRequests).toHaveLength(2);
                const followUpUserMessage = immediateRequests
                    .at(-1)
                    ?.messages?.findLast((message) => message.role === "user");
                return JSON.stringify(followUpUserMessage?.content ?? "");
            } finally {
                await session.rpc.eventLog.releaseInterest({ handle: interest.handle });
            }
        };

        const [exitOnlyMessages, deferredMessages, deferredAutopilotFollowUp, immediateMessages] =
            await Promise.all([
                runScenario(EXIT_ONLY_MARKER, "exit_only", false, true),
                runScenario(DEFERRED_MARKER, "interactive", true, false),
                runDeferredAutopilotScenario(),
                runScenario(IMMEDIATE_MARKER, "interactive", false, true),
            ]);
        expect
            .soft(exitOnlyMessages.immediate, "exit-only immediate continuation")
            .not.toContain("Plan mode is no longer active.");
        expect
            .soft(deferredMessages.immediate, "deferred immediate continuation")
            .not.toContain("Plan mode is no longer active.");
        expect
            .soft(deferredMessages.immediateRequestCount, "deferred approval model rounds")
            .toBe(1);
        expect
            .soft(exitOnlyMessages.followUp, "exit-only follow-up turn")
            .toContain("Plan mode is no longer active.");
        expect
            .soft(deferredMessages.followUp, "deferred follow-up turn")
            .toContain("Plan mode is no longer active.");
        expect
            .soft(deferredAutopilotFollowUp, "deferred Autopilot follow-up turn")
            .toContain("Plan mode is no longer active.");
        expect
            .soft(deferredAutopilotFollowUp, "deferred Autopilot instructions")
            .toContain("<autopilot_mode>");
        expect
            .soft(deferredAutopilotFollowUp, "deferred Autopilot continuation")
            .toContain("You have not yet marked the task as complete");
        expect
            .soft(immediateMessages.immediate, "ordinary interactive continuation")
            .toContain("Plan mode is no longer active.");

        if (modelFailure) {
            throw modelFailure;
        }
    });
});
