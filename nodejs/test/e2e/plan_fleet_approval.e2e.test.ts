/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { CopilotSession, SessionEvent } from "../../src/index.js";
import { approveAll } from "../../src/index.js";
import type { ParsedHttpExchange } from "../../../test/harness/replayingCapiProxy.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { isByokBackend } from "./harness/testBackend.js";

// Planning and then implementing the plan takes several model turns, which
// live recording runs against real models.
const TEST_TIMEOUT_MS = 180_000;
const FLOW_TIMEOUT_MS = 150_000;
const SESSION_MODEL = "claude-haiku-4.5";
const PLAN_MODEL = "claude-sonnet-5";
const FLEET_PROMPT_OPENING = "You are now in fleet mode.";
const FLEET_INSTRUCTIONS_TAG = "<fleet_mode_instructions>";

type EventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;
type RequestMessage = ParsedHttpExchange["request"]["messages"][number];

// The replay proxy's path normalizer corrupts JSON escapes next to the work
// directory in tool arguments, which sub-agent prompts and shell commands embed.
// Without them the models implement with the create tool, which replays cleanly.
const EXCLUDED_TOOLS = ["task", "bash", "powershell"];

// Planning writes nothing, so the capture holds no per-run session-state path.
function planPrompt(fileName: string, contents: string): string {
    return (
        `The plan is one step: create a file named ${fileName} in the current directory containing exactly the text ${contents}. ` +
        "Do not write a plan file, create todos, or call any other tool first. " +
        "Request approval right away with exit_plan_mode, setting recommendedAction to autopilot_fleet."
    );
}

/** Records every session event from now on, rejecting waits on a session error. */
function recordEvents(session: CopilotSession) {
    const events: SessionEvent[] = [];
    const waiters = new Set<() => void>();
    let failure: Error | undefined;
    const unsubscribe = session.on((event) => {
        events.push(event);
        if (event.type === "session.error") {
            failure = new Error(`${event.data.message}\n${event.data.stack ?? ""}`);
        }
        for (const check of waiters) check();
    });

    function waitUntil(done: (events: SessionEvent[]) => boolean, description: string) {
        return new Promise<void>((resolve, reject) => {
            const finish = (error?: Error) => {
                clearTimeout(timer);
                waiters.delete(check);
                if (error) reject(error);
                else resolve();
            };
            const check = () => {
                if (failure) finish(failure);
                else if (done(events)) finish();
            };
            const timer = setTimeout(() => {
                const seen = events.map((event) => event.type).join(", ");
                finish(new Error(`Timed out waiting for ${description}. Events: ${seen}`));
            }, FLOW_TIMEOUT_MS);
            waiters.add(check);
            check();
        });
    }

    return { events, waitUntil, unsubscribe };
}

function mainAgent(events: SessionEvent[]): SessionEvent[] {
    return events.filter((event) => event.agentId === undefined);
}

function isType<T extends SessionEvent["type"]>(type: T) {
    return (event: SessionEvent): event is EventOf<T> => event.type === type;
}

/** The main agent's exit_plan_mode completion, or undefined before it arrives. */
function exitPlanModeCompletion(events: SessionEvent[]) {
    const main = mainAgent(events);
    const start = main
        .filter(isType("tool.execution_start"))
        .find((event) => event.data.toolName === "exit_plan_mode");
    return main
        .filter(isType("tool.execution_complete"))
        .find((event) => event.data.toolCallId === start?.data.toolCallId);
}

function fleetTurns(events: SessionEvent[]): EventOf<"user.message">[] {
    return mainAgent(events)
        .filter(isType("user.message"))
        .filter((event) => event.data.source === "fleet");
}

function messageText(message: RequestMessage): string {
    const { content } = message as { content?: unknown };
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (part as { text?: unknown }).text)
            .filter((text): text is string => typeof text === "string")
            .join("");
    }
    return "";
}

function userMessagesWith(exchange: ParsedHttpExchange, text: string): RequestMessage[] {
    return exchange.request.messages.filter(
        (message) => message.role === "user" && messageText(message).includes(text)
    );
}

describe("Plan approval with fleet", async () => {
    const { copilotClient: client, openAiEndpoint, workDir } = await createSdkTestContext();

    it(
        "should deliver fleet instructions with the approved plan tool result",
        async () => {
            const session = await client.createSession({
                onPermissionRequest: approveAll,
                excludedTools: EXCLUDED_TOOLS,
                onExitPlanModeRequest: () => ({
                    approved: true,
                    selectedAction: "autopilot_fleet",
                }),
            });
            const recorder = recordEvents(session);

            try {
                await session.send({
                    prompt: planPrompt("fleet-alpha.txt", "alpha"),
                    agentMode: "plan",
                });
                await recorder.waitUntil((events) => {
                    const completion = exitPlanModeCompletion(events);
                    return (
                        completion !== undefined &&
                        events
                            .slice(events.indexOf(completion))
                            .some((event) => event.type === "session.idle")
                    );
                }, "session.idle after the fleet plan approval");

                const completion = exitPlanModeCompletion(recorder.events)!;
                expect(completion.data.success).toBe(true);
                const toolResult = completion.data.result?.content ?? "";
                expect(toolResult).toContain("fleet-mode instructions below");
                expect(toolResult).toContain(FLEET_INSTRUCTIONS_TAG);
                expect(toolResult).toContain(FLEET_PROMPT_OPENING);

                // The instructions arrive with the tool result, not as a queued turn.
                expect(fleetTurns(recorder.events)).toEqual([]);
                const prompts = mainAgent(recorder.events)
                    .filter(isType("user.message"))
                    .filter((event) => !event.data.isAutopilotContinuation);
                expect(prompts).toHaveLength(1);

                const exchanges = await openAiEndpoint.getExchanges();
                expect(
                    exchanges.some((exchange) =>
                        exchange.request.messages.some(
                            (message) =>
                                message.role === "tool" &&
                                messageText(message).includes(FLEET_INSTRUCTIONS_TAG)
                        )
                    )
                ).toBe(true);
                expect(
                    exchanges.flatMap((exchange) =>
                        userMessagesWith(exchange, FLEET_PROMPT_OPENING)
                    )
                ).toEqual([]);

                expect((await readFile(join(workDir, "fleet-alpha.txt"), "utf-8")).trim()).toBe(
                    "alpha"
                );
            } finally {
                recorder.unsubscribe();
                await session.disconnect();
            }
        },
        TEST_TIMEOUT_MS
    );

    // The session model must be in this context's cached model list, so the
    // deferred flow gets its own context.
    describe("deferred approval (isolated to avoid models cache contamination)", async () => {
        const {
            copilotClient: deferredClient,
            openAiEndpoint: deferredEndpoint,
            workDir: deferredWorkDir,
        } = await createSdkTestContext();

        // Switches between two CAPI models; the BYOK matrix pins one provider model.
        it.skipIf(isByokBackend)(
            "should run one hidden fleet turn on the session model after a deferred approval",
            async () => {
                const session = await deferredClient.createSession({
                    model: SESSION_MODEL,
                    onPermissionRequest: approveAll,
                    excludedTools: EXCLUDED_TOOLS,
                });
                const recorder = recordEvents(session);
                // The runtime offers exit_plan_mode only when a consumer handles its approval event.
                const interest = await session.rpc.eventLog.registerInterest({
                    eventType: "exit_plan_mode.requested",
                });

                try {
                    const enterPlan = await session.rpc.mode.set({
                        mode: "plan",
                        planModelConfigured: true,
                        planModel: PLAN_MODEL,
                    });
                    expect(enterPlan).toMatchObject({ modelChanged: true });

                    // Approve the way an interactive host does when the plan ran on its
                    // own model: restore the session model first, then forward whether
                    // the runtime wants implementation deferred to a fresh turn.
                    const approval = new Promise<void>((resolve, reject) => {
                        const unsubscribe = session.on("exit_plan_mode.requested", (event) => {
                            unsubscribe();
                            void (async () => {
                                const leavePlan = await session.rpc.mode.set({
                                    mode: "plan",
                                    planModelConfigured: false,
                                    restorePlanModel: true,
                                    planExitAction: "autopilot_fleet",
                                });
                                expect(leavePlan).toMatchObject({
                                    modelChanged: true,
                                    deferImplementation: true,
                                    armInteractiveContinuation: false,
                                });
                                const handled = await session.rpc.ui.handlePendingExitPlanMode({
                                    requestId: event.data.requestId,
                                    response: {
                                        approved: true,
                                        selectedAction: "autopilot_fleet",
                                        deferImplementation: leavePlan.deferImplementation,
                                    },
                                });
                                expect(handled.success).toBe(true);
                            })().then(resolve, reject);
                        });
                    });

                    await session.send({
                        prompt: planPrompt("fleet-beta.txt", "beta"),
                        agentMode: "plan",
                    });
                    await Promise.all([
                        approval,
                        recorder.waitUntil((events) => {
                            const [fleetTurn] = fleetTurns(events);
                            return (
                                fleetTurn !== undefined &&
                                events
                                    .slice(events.indexOf(fleetTurn))
                                    .some((event) => event.type === "session.idle")
                            );
                        }, "session.idle after the deferred fleet turn"),
                    ]);

                    const completion = exitPlanModeCompletion(recorder.events)!;
                    const toolResult = completion.data.result?.content ?? "";
                    expect(toolResult).toContain("End your turn now");
                    expect(toolResult).not.toContain(FLEET_INSTRUCTIONS_TAG);
                    expect(toolResult).not.toContain(FLEET_PROMPT_OPENING);

                    // Exactly one fleet turn follows the plan turn. The runtime ends the
                    // plan turn at the tool result, so nothing runs in between: no idle,
                    // no other prompt such as an autopilot continuation, and no further
                    // plan-model work.
                    const fleet = fleetTurns(recorder.events);
                    expect(fleet).toHaveLength(1);
                    const between = recorder.events.slice(
                        recorder.events.indexOf(completion) + 1,
                        recorder.events.indexOf(fleet[0])
                    );
                    expect(
                        between
                            .filter(
                                (event) =>
                                    event.type === "session.idle" ||
                                    (event.agentId === undefined &&
                                        (event.type === "user.message" ||
                                            event.type === "assistant.turn_start" ||
                                            event.type === "assistant.message" ||
                                            event.type === "tool.execution_start"))
                            )
                            .map((event) => event.type)
                    ).toEqual([]);

                    const exchanges = await deferredEndpoint.getExchanges();
                    const planRequest = exchanges.find(
                        (exchange) => userMessagesWith(exchange, "fleet-beta.txt").length > 0
                    );
                    expect(planRequest?.request.model).toBe(PLAN_MODEL);
                    // Every request carrying the approval result belongs to the fleet
                    // turn, so the plan model was never asked to act on it.
                    const afterApproval = exchanges.filter((exchange) =>
                        exchange.request.messages.some(
                            (message) =>
                                message.role === "tool" &&
                                messageText(message).includes("End your turn now")
                        )
                    );
                    expect(afterApproval.length).toBeGreaterThan(0);
                    for (const exchange of afterApproval) {
                        expect(exchange.request.model).toBe(SESSION_MODEL);
                        expect(userMessagesWith(exchange, FLEET_PROMPT_OPENING)).toHaveLength(1);
                    }

                    expect(
                        (await readFile(join(deferredWorkDir, "fleet-beta.txt"), "utf-8")).trim()
                    ).toBe("beta");
                } finally {
                    recorder.unsubscribe();
                    await session.rpc.eventLog.releaseInterest({ handle: interest.handle });
                    await session.disconnect();
                }
            },
            TEST_TIMEOUT_MS
        );
    });
});
