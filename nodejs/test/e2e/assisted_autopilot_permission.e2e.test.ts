/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { describe, expect, it, onTestFinished } from "vitest";
import {
    createAttributedPermissionResult,
    type CopilotSession,
    type NamedProviderConfig,
    type ProviderModelConfig,
} from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { getNextEventOfType } from "./harness/sdkTestHelper.js";

const JUDGE_OUTPUT = "ALLOW: Explicitly authorized bounded filename search.";
const HUMAN_REVIEW_OUTPUT = "DENY: Ask the registered human permission handler.";
const SHELL_TOOL = process.platform === "win32" ? "powershell" : "bash";

describe("Assisted permission handling in Autopilot", async () => {
    const { copilotClient: client, workDir } = await createSdkTestContext({ useStdio: true });

    it("executes eligible shell and path ALLOWs without calling created or resumed SDK hosts", async () => {
        let agentCalls = 0;
        const judgeOutputs: string[] = [];
        const providerFailures: Error[] = [];
        const outsideDir = `${workDir}-outside`;
        await mkdir(outsideDir, { recursive: true });
        await writeFile(join(outsideDir, "approval-probe.txt"), "ASSISTED_READ_PROBE\n");
        onTestFinished(() => rm(outsideDir, { recursive: true, force: true }));
        const modelServer = createServer((request, response) => {
            void (async () => {
                const body = JSON.parse(await text(request)) as {
                    model: string;
                    stream?: boolean;
                    messages: Array<{ role?: string; content?: unknown }>;
                };
                const isJudge = body.model === "gpt-6-luna";
                const messages = JSON.stringify(body.messages);
                let message:
                    | { role: "assistant"; content: string }
                    | {
                          role: "assistant";
                          content: string;
                          tool_calls: Array<{
                              id: string;
                              type: "function";
                              function: { name: string; arguments: string };
                          }>;
                      };
                if (isJudge) {
                    const output = messages.includes("assisted-human-ask")
                        ? HUMAN_REVIEW_OUTPUT
                        : JUDGE_OUTPUT;
                    judgeOutputs.push(output);
                    message = { role: "assistant", content: output };
                } else {
                    agentCalls++;
                    const toolResultCount = body.messages.filter(
                        (entry) => entry.role === "tool"
                    ).length;
                    const primeIndex = messages.lastIndexOf("ASSISTED_SESSION_PRIME");
                    const shellIndex = messages.lastIndexOf("ASSISTED_SHELL_");
                    const pathIndex = messages.lastIndexOf("ASSISTED_PATH_ROUTE");
                    const humanIndex = messages.lastIndexOf("ASSISTED_HUMAN_");
                    const primeRoute = primeIndex > Math.max(shellIndex, pathIndex, humanIndex);
                    const humanRoute = humanIndex > Math.max(primeIndex, shellIndex, pathIndex);
                    const shellRoute = shellIndex > Math.max(primeIndex, pathIndex, humanIndex);
                    const resumedShellRoute =
                        messages.lastIndexOf("ASSISTED_SHELL_RESUME_ROUTE") === shellIndex;
                    const humanApproved = messages.includes("ASSISTED_HUMAN_APPROVE_");
                    const humanLifecycle =
                        messages.includes("ASSISTED_HUMAN_APPROVE_RESUME_ROUTE") ||
                        messages.includes("ASSISTED_HUMAN_DENY_RESUME_ROUTE")
                            ? "resume"
                            : "create";
                    const finalText = humanRoute
                        ? humanApproved
                            ? "human-approved"
                            : "human-denied"
                        : shellRoute
                          ? "shell-approved"
                          : "approval-probe.txt";
                    message = primeRoute
                        ? { role: "assistant", content: "prime-ready" }
                        : toolResultCount >= 2
                          ? {
                                role: "assistant",
                                content: finalText,
                            }
                          : toolResultCount === 1
                            ? {
                                  role: "assistant",
                                  content: "",
                                  tool_calls: [
                                      {
                                          id: "assisted-autopilot-task-complete",
                                          type: "function",
                                          function: {
                                              name: "task_complete",
                                              arguments: JSON.stringify({
                                                  summary: finalText,
                                              }),
                                          },
                                      },
                                  ],
                              }
                            : {
                                  role: "assistant",
                                  content: "",
                                  tool_calls: [
                                      {
                                          id: shellRoute
                                              ? "assisted-autopilot-shell"
                                              : humanRoute
                                                ? "assisted-autopilot-human"
                                                : "assisted-autopilot-glob",
                                          type: "function",
                                          function:
                                              shellRoute || humanRoute
                                                  ? {
                                                        name: SHELL_TOOL,
                                                        arguments: JSON.stringify({
                                                            command: humanRoute
                                                                ? process.platform === "win32"
                                                                    ? `New-Item -ItemType Directory -Path assisted-human-ask-${humanApproved ? "approve" : "deny"}-${humanLifecycle}`
                                                                    : `mkdir assisted-human-ask-${humanApproved ? "approve" : "deny"}-${humanLifecycle}`
                                                                : process.platform === "win32"
                                                                  ? `New-Item -ItemType Directory -Path assisted-shell-${resumedShellRoute ? "resume" : "create"}`
                                                                  : `mkdir assisted-shell-${resumedShellRoute ? "resume" : "create"}`,
                                                            description: humanRoute
                                                                ? "Create the human-reviewed SDK permission fixture"
                                                                : "Create the authorized SDK permission fixture",
                                                        }),
                                                    }
                                                  : {
                                                        name: "glob",
                                                        arguments: JSON.stringify({
                                                            pattern: "*.txt",
                                                            path: outsideDir,
                                                        }),
                                                    },
                                      },
                                  ],
                              };
                }

                const choice = {
                    index: 0,
                    message,
                    finish_reason: "tool_calls" in message ? "tool_calls" : "stop",
                };
                const completion = {
                    id: `assisted-autopilot-${judgeOutputs.length + agentCalls}`,
                    object: "chat.completion",
                    created: 1,
                    model: body.model,
                    choices: [choice],
                    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
                };
                if (body.stream) {
                    response.writeHead(200, { "content-type": "text/event-stream" });
                    response.end(
                        `data: ${JSON.stringify({
                            ...completion,
                            object: "chat.completion.chunk",
                            choices: [
                                {
                                    index: 0,
                                    delta: {
                                        ...message,
                                        ...("tool_calls" in message
                                            ? {
                                                  tool_calls: message.tool_calls.map(
                                                      (call, index) => ({ index, ...call })
                                                  ),
                                              }
                                            : {}),
                                    },
                                    finish_reason: choice.finish_reason,
                                },
                            ],
                        })}\n\ndata: [DONE]\n\n`
                    );
                } else {
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end(JSON.stringify(completion));
                }
            })().catch((error: unknown) => {
                providerFailures.push(error instanceof Error ? error : new Error(String(error)));
                response.writeHead(500).end();
            });
        });
        await new Promise<void>((resolve, reject) => {
            modelServer.once("error", reject);
            modelServer.listen(0, "127.0.0.1", resolve);
        });
        onTestFinished(async () => {
            modelServer.closeAllConnections();
            if (modelServer.listening) {
                await new Promise<void>((resolve, reject) => {
                    modelServer.close((error) => (error ? reject(error) : resolve()));
                });
            }
        });
        const address = modelServer.address();
        if (!address || typeof address === "string") {
            throw new Error("Missing local model server address");
        }

        execFileSync("git", ["init", "--quiet"], { cwd: workDir });
        await writeFile(join(workDir, "approval-probe.txt"), "ASSISTED_READ_PROBE\n");

        const providers: NamedProviderConfig[] = [
            {
                name: "local",
                type: "openai",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "synthetic-test-token",
                wireApi: "completions",
            },
        ];
        const models: ProviderModelConfig[] = ["gpt-5.6-sol", "gpt-6-luna"].map((id) => ({
            id,
            provider: "local",
            modelId: "gpt-4o",
            wireModel: id,
        }));
        const scenarios = [
            { route: "shell", lifecycle: "create", decision: "judge" },
            { route: "path", lifecycle: "create", decision: "judge" },
            { route: "shell", lifecycle: "resume", decision: "judge" },
            { route: "path", lifecycle: "resume", decision: "judge" },
            { route: "human", lifecycle: "create", decision: "approve" },
            { route: "human", lifecycle: "create", decision: "deny" },
            { route: "human", lifecycle: "resume", decision: "approve" },
            { route: "human", lifecycle: "resume", decision: "deny" },
        ] as const;
        for (const scenario of scenarios) {
            let permissionCallbacks = 0;
            const recommendations: string[] = [];
            const recoveryStatuses: string[] = [];
            const toolResults: Array<{ success?: boolean; result?: { content?: string } }> = [];
            const decisionSources: string[] = [];
            const taskOutcomes: Array<{ success?: boolean; summary?: string }> = [];
            const sessionConfig = {
                model: "local/gpt-5.6-sol",
                providers,
                models,
                availableTools: [SHELL_TOOL, "glob", "task_complete"],
                streaming: false,
                skipCustomInstructions: true,
                featureFlags: {
                    AUTO_APPROVAL: true,
                    ASSISTED_PERMISSIONS_V2: true,
                },
                onPermissionRequest: () => {
                    permissionCallbacks++;
                    if (scenario.decision === "judge") {
                        return createAttributedPermissionResult(
                            { kind: "approve-once" },
                            {
                                outcome: "auto_approved",
                                source: "assisted_approval",
                                surface: "sdk",
                                responseCapability: "headless",
                            }
                        );
                    }
                    return createAttributedPermissionResult(
                        { kind: scenario.decision === "approve" ? "approve-once" : "reject" },
                        {
                            outcome: "prompted_user",
                            source: "human_response",
                            surface: "sdk",
                            responseCapability: "interactive",
                        }
                    );
                },
            } as const;
            let session: CopilotSession | undefined;
            try {
                session = await client.createSession(sessionConfig);
                if (scenario.lifecycle === "resume") {
                    const sessionId = session.sessionId;
                    await session.sendAndWait({
                        prompt: "ASSISTED_SESSION_PRIME: Reply with prime-ready without tools.",
                    });
                    await session.disconnect();
                    session = undefined;
                    session = await client.resumeSession(sessionId, sessionConfig);
                }
                await configureAssistedAutopilot(session, workDir);
                session.on((event) => {
                    if (event.type === "permission.requested") {
                        const promptRequest = (
                            event.data as {
                                promptRequest?: {
                                    assistedApproval?: { recommendation?: string };
                                    autoApproval?: { recommendation?: string };
                                };
                            }
                        ).promptRequest;
                        const recommendation =
                            promptRequest?.assistedApproval?.recommendation ??
                            promptRequest?.autoApproval?.recommendation;
                        if (recommendation) recommendations.push(recommendation);
                    } else if (event.type === "permission.completed") {
                        const source = (event.data as { decisionSource?: string }).decisionSource;
                        if (source) decisionSources.push(source);
                    } else if (event.type === "session.permission_recovery") {
                        recoveryStatuses.push((event.data as { status: string }).status);
                    } else if (event.type === "tool.execution_complete") {
                        toolResults.push(event.data);
                    } else if (event.type === "session.task_complete") {
                        taskOutcomes.push(event.data);
                    }
                });

                try {
                    const taskComplete = getNextEventOfType(session, "session.task_complete");
                    await session.send({
                        prompt:
                            scenario.route === "shell"
                                ? `ASSISTED_SHELL_${scenario.lifecycle.toUpperCase()}_ROUTE: Create the authorized fixture directory once and report shell-approved.`
                                : scenario.route === "path"
                                  ? `ASSISTED_PATH_ROUTE: Use only glob to find *.txt in ${outsideDir} and report the matching filename.`
                                  : `ASSISTED_HUMAN_${scenario.decision.toUpperCase()}_${scenario.lifecycle.toUpperCase()}_ROUTE: Try to create the human-reviewed fixture directory once and report human-${scenario.decision === "approve" ? "approved" : "denied"}.`,
                    });
                    await taskComplete;
                } catch (error) {
                    throw new Error(`${JSON.stringify(scenario)} failed`, { cause: error });
                }

                const expectedCompletions = scenario.route === "path" ? 2 : 1;
                expect(permissionCallbacks, JSON.stringify(scenario)).toBe(expectedCompletions);
                expect(recommendations, JSON.stringify(scenario)).toEqual(
                    Array(expectedCompletions).fill(
                        scenario.decision === "judge" ? "approve" : "requireApproval"
                    )
                );
                expect(decisionSources, JSON.stringify(scenario)).toEqual(
                    Array(expectedCompletions).fill(
                        scenario.decision === "judge" ? "assisted_approval" : "human_response"
                    )
                );
                expect(recoveryStatuses, JSON.stringify(scenario)).toEqual([]);
                expect(toolResults, JSON.stringify(scenario)).toHaveLength(2);
                if (scenario.decision === "deny") {
                    expect(
                        toolResults.some((result) => result.success === false),
                        JSON.stringify(scenario)
                    ).toBe(true);
                    expect(toolResults.at(-1)?.success, JSON.stringify(scenario)).toBe(true);
                } else {
                    expect(
                        toolResults.every((result) => result.success === true),
                        JSON.stringify(scenario)
                    ).toBe(true);
                }
                expect(taskOutcomes, JSON.stringify(scenario)).toHaveLength(1);
                expect(taskOutcomes[0], JSON.stringify(scenario)).toMatchObject({
                    success: true,
                });
                expect(taskOutcomes[0]?.summary, JSON.stringify(scenario)).toContain(
                    scenario.route === "shell"
                        ? "shell-approved"
                        : scenario.route === "path"
                          ? "approval-probe.txt"
                          : `human-${scenario.decision === "approve" ? "approved" : "denied"}`
                );
                if (scenario.route === "human") {
                    expect(
                        existsSync(
                            join(
                                workDir,
                                `assisted-human-ask-${scenario.decision}-${scenario.lifecycle}`
                            )
                        ),
                        JSON.stringify(scenario)
                    ).toBe(scenario.decision === "approve");
                }
            } finally {
                if (session) {
                    await session.abort();
                    await session.disconnect();
                }
            }
        }

        expect(providerFailures).toEqual([]);
        expect(judgeOutputs).toEqual([
            ...Array(4).fill(JUDGE_OUTPUT),
            ...Array(4).fill(HUMAN_REVIEW_OUTPUT),
        ]);
        expect(agentCalls).toBe(scenarios.length * 2 + 4);
    });
});

async function configureAssistedAutopilot(session: CopilotSession, workDir: string): Promise<void> {
    await session.rpc.permissions.folderTrust.addTrusted({ path: workDir });
    await session.rpc.permissions.configure({
        approveAllToolPermissionRequests: false,
        approveAllReadPermissionRequests: false,
        rules: { approved: [], denied: [] },
        paths: {
            workspacePath: workDir,
            additionalDirectories: [],
            unrestricted: false,
            includeTempDirectory: false,
        },
    });
    await session.rpc.permissions.setMode({
        mode: "assisted",
        assistedApprovalModel: "local/gpt-6-luna",
        source: "rpc",
    });
    await session.rpc.mode.set({ mode: "autopilot" });
}
