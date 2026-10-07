/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    approveAll,
    CopilotRequestHandler,
    type CopilotSession,
    type SessionEvent,
} from "../../src/index.js";
import { createSdkTestContext, isCI } from "./harness/sdkTestContext.js";
import { testBackend } from "./harness/testBackend.js";

const compactionTimeoutMs = 60_000;

class RefusalBudgetReplayHandler extends CopilotRequestHandler {
    readonly requests: { model: string; max_tokens: number }[] = [];

    protected override async sendRequest(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/models") {
            return Response.json({
                data: [
                    ["claude-sonnet-5.5", 250_000, 384_000, 128_000],
                    ["claude-sonnet-5", 112_000, 128_000, 64_000],
                ].map(([id, prompt, context, output]) => ({
                    id,
                    name: id,
                    object: "model",
                    vendor: "Anthropic",
                    version: "1",
                    model_picker_enabled: true,
                    supported_endpoints: ["/v1/messages"],
                    capabilities: {
                        type: "chat",
                        family: id,
                        tokenizer: "o200k_base",
                        supports: { streaming: true, tool_calls: true, vision: false },
                        limits: {
                            max_prompt_tokens: prompt,
                            max_context_window_tokens: context,
                            max_output_tokens: output,
                        },
                    },
                })),
            });
        }
        if (path.endsWith("/models/session")) return Response.json({});
        if (path.includes("/policy")) return Response.json({ state: "enabled" });
        expect(path).toBe("/v1/messages");
        const body = (await request.json()) as {
            model: string;
            max_tokens: number;
            stream?: boolean;
        };
        this.requests.push(body);
        const refuses = body.model === "claude-sonnet-5.5";
        const content = refuses ? "PRIMARY_REFUSAL" : "FALLBACK_BUDGET_OK";
        const message = {
            id: "refusal-budget-replay",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: content }],
            stop_reason: refuses ? "refusal" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 10 },
        };
        if (!body.stream) return Response.json(message);
        const events = [
            {
                type: "message_start",
                message: { ...message, content: [], stop_reason: null },
            },
            {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            },
            {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: content },
            },
            { type: "content_block_stop", index: 0 },
            {
                type: "message_delta",
                delta: { stop_reason: message.stop_reason, stop_sequence: null },
                usage: { output_tokens: 10 },
            },
            { type: "message_stop" },
        ];
        return new Response(
            events
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(""),
            { headers: { "content-type": "text/event-stream" } }
        );
    }
}

class BudgetReplayHandler extends CopilotRequestHandler {
    readonly requests: unknown[] = [];

    protected override async sendRequest(request: Request): Promise<Response> {
        expect(request.url).toMatch(/\/chat\/completions$/);
        const body = (await request.json()) as { stream?: boolean };
        this.requests.push(body);
        if (!body.stream) {
            return Response.json({
                id: "budget-replay",
                object: "chat.completion",
                created: 1,
                model: "uncatalogued-budget-model",
                choices: [
                    {
                        index: 0,
                        message: { role: "assistant", content: "BUDGET_CONTROL_OK" },
                        finish_reason: "stop",
                    },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
            });
        }
        const chunk = {
            id: "budget-replay",
            object: "chat.completion.chunk",
            created: 1,
            model: "uncatalogued-budget-model",
            choices: [{ index: 0, delta: { content: "BUDGET_CONTROL_OK" }, finish_reason: null }],
        };
        return new Response(
            `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({
                ...chunk,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } }
        );
    }
}

describe("Refusal fallback output budget", async () => {
    const { createClient } = await createSdkTestContext({
        copilotClientOptions: {
            env: {
                ANTHROPIC_REFUSAL_FALLBACK: "true",
                COPILOT_EXP_COPILOT_CLI_ANTHROPIC_REFUSAL_FALLBACK: "true",
            },
        },
    });

    it("should clamp fallback output before admission and retain its effective budget", async () => {
        const handler = new RefusalBudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        try {
            await budgetClient.start();
            expect(
                (await budgetClient.listModels()).find((model) => model.id === "claude-sonnet-5")
            ).toMatchObject({
                capabilities: {
                    limits: {
                        max_prompt_tokens: 112_000,
                        max_context_window_tokens: 128_000,
                        max_output_tokens: 64_000,
                    },
                },
            });
            const session = await budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: "claude-sonnet-5.5",
                // Refusal fallback is a first-party contract, not a BYOK switch.
                providers: [],
                infiniteSessions: { enabled: false },
            });
            const events: SessionEvent[] = [];
            session.on((event) => events.push(event));
            expect(
                (await session.sendAndWait({ prompt: "Exercise refusal fallback admission." }))
                    ?.data.content
            ).toBe("FALLBACK_BUDGET_OK");
            expect(
                handler.requests.map(({ model, max_tokens }) => ({ model, max_tokens }))
            ).toEqual([
                { model: "claude-sonnet-5.5", max_tokens: 128_000 },
                { model: "claude-sonnet-5", max_tokens: 64_000 },
            ]);
            expect(events.filter((event) => event.type === "session.error")).toEqual([]);
            // Recorded model changes can arrive after the directly forwarded idle event.
            await expect
                .poll(() => events.filter((event) => event.type === "session.model_change"))
                .toEqual([
                    expect.objectContaining({
                        data: expect.objectContaining({
                            newModel: "claude-sonnet-5",
                            previousModel: "claude-sonnet-5.5",
                            cause: "refusal_fallback",
                            source: "automatic",
                        }),
                    }),
                ]);
            expect((await session.rpc.model.getCurrent()).modelId).toBe("claude-sonnet-5");
            const usage = events.filter((event) => event.type === "assistant.usage");
            expect(
                usage.map(({ data: { model, maxPromptTokens, maxOutputTokens } }) => ({
                    model,
                    maxPromptTokens,
                    maxOutputTokens,
                }))
            ).toEqual([
                { model: "claude-sonnet-5.5", maxPromptTokens: 250_000, maxOutputTokens: 128_000 },
                { model: "claude-sonnet-5", maxPromptTokens: 64_000, maxOutputTokens: 64_000 },
            ]);
            expect(
                (
                    await session.rpc.metadata.contextInfo({
                        promptTokenLimit: 0,
                        outputTokenLimit: 64_000,
                    })
                ).contextInfo
            ).toMatchObject({
                modelName: "claude-sonnet-5",
                limit: 112_000,
                promptTokenLimit: 64_000,
            });
            // The next turn uses Sonnet 5's normal 32k cap, not the one-shot retry's 64k cap.
            expect(
                (
                    await session.rpc.metadata.contextInfo({
                        promptTokenLimit: 0,
                        outputTokenLimit: 0,
                    })
                ).contextInfo
            ).toMatchObject({ limit: 112_000, promptTokenLimit: 96_000 });
            expect(
                (await session.sendAndWait({ prompt: "Check the retained fallback budget." }))?.data
                    .content
            ).toBe("FALLBACK_BUDGET_OK");
            expect(handler.requests).toHaveLength(3);
            expect(handler.requests[2]).toMatchObject({
                model: "claude-sonnet-5",
                max_tokens: 32_000,
            });
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });
});

function getNextSessionEvent<TEventType extends SessionEvent["type"]>(
    session: CopilotSession,
    eventType: TEventType,
    description: string,
    predicate: (event: Extract<SessionEvent, { type: TEventType }>) => boolean = () => true
): Promise<Extract<SessionEvent, { type: TEventType }>> {
    return new Promise((resolve, reject) => {
        let unsubscribe: () => void = () => {};
        const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error(`Timed out waiting for ${description}`));
        }, compactionTimeoutMs);

        unsubscribe = session.on((event) => {
            if (event.type === eventType) {
                const typedEvent = event as Extract<SessionEvent, { type: TEventType }>;
                if (predicate(typedEvent)) {
                    clearTimeout(timeout);
                    unsubscribe();
                    resolve(typedEvent);
                }
            } else if (event.type === "session.error") {
                clearTimeout(timeout);
                unsubscribe();
                reject(new Error(`${event.data.message}\n${event.data.stack}`));
            }
        });
    });
}

describe("Compaction", async () => {
    const {
        copilotClient: client,
        openAiEndpoint,
        createClient,
        workDir,
    } = await createSdkTestContext();

    // Paused-clock Rust tests pin the cancellation/timeout budgets; this covers
    // cancellation across the real SDK filesystem callback boundary.
    it("should abort manual compaction while workflow storage is stalled", async () => {
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        let releaseStorage!: () => void;
        const release = new Promise<void>((resolve) => {
            releaseStorage = resolve;
        });
        const database = new DatabaseSync(":memory:");
        const handler = new BudgetReplayHandler();
        const compactionClient = createClient({
            requestHandler: handler,
            sessionFs: {
                initialCwd: workDir,
                sessionStatePath: join(workDir, "compaction-state"),
                conventions: process.platform === "win32" ? "windows" : "posix",
                capabilities: { sqlite: true },
            },
        });
        let stalled = false;
        let storageRequest: Promise<void> | undefined;
        try {
            await using session = await compactionClient.createSession({
                onPermissionRequest: approveAll,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                    maxPromptTokens: 100_000,
                },
                infiniteSessions: { enabled: false },
                createSessionFsProvider: () => ({
                    readFile: (path) => fs.readFile(path, "utf8"),
                    writeFile: (path, content) => fs.writeFile(path, content),
                    appendFile: (path, content) => fs.appendFile(path, content),
                    exists: async (path) => existsSync(path),
                    stat: async (path) => {
                        const info = await fs.stat(path);
                        return {
                            isFile: info.isFile(),
                            isDirectory: info.isDirectory(),
                            size: info.size,
                            mtime: info.mtime.toISOString(),
                            birthtime: info.birthtime.toISOString(),
                        };
                    },
                    mkdir: async (path, recursive, mode) => {
                        await fs.mkdir(path, { recursive, mode });
                    },
                    readdir: (path) => fs.readdir(path),
                    readdirWithTypes: async (path) =>
                        (await fs.readdir(path, { withFileTypes: true })).map((entry) => ({
                            name: entry.name,
                            type: entry.isDirectory() ? "directory" : "file",
                        })),
                    rm: (path, recursive, force) => fs.rm(path, { recursive, force }),
                    rename: (from, to) => fs.rename(from, to),
                    sqlite: {
                        exists: async () => true,
                        query: async (queryType, query, params) => {
                            if (stalled && /\b(?:factory|workflow)_runs\b/.test(query)) {
                                markEntered();
                                storageRequest = release;
                                await storageRequest;
                                throw new Error("Controlled workflow storage failure");
                            }
                            if (queryType === "exec") {
                                database.exec(query);
                                return;
                            }
                            const statement = database.prepare(query);
                            if (queryType === "query") {
                                const rows = statement.all(params ?? {}).map((row) => {
                                    const values: Record<string, string | number | null> = {};
                                    for (const [key, value] of Object.entries(row)) {
                                        if (
                                            value !== null &&
                                            typeof value !== "string" &&
                                            typeof value !== "number"
                                        ) {
                                            throw new Error(`Unexpected SQLite value in ${key}`);
                                        }
                                        values[key] = value;
                                    }
                                    return values;
                                });
                                return {
                                    rows,
                                    columns: statement.columns().map((column) => column.name),
                                    rowsAffected: 0,
                                };
                            }
                            const result = statement.run(params ?? {});
                            return {
                                rows: [],
                                columns: [],
                                rowsAffected: Number(result.changes),
                                lastInsertRowid: Number(result.lastInsertRowid),
                            };
                        },
                    },
                }),
            });
            expect(
                (await session.sendAndWait({ prompt: "Initialize cancellable compaction." }))?.data
                    .content
            ).toBe("BUDGET_CONTROL_OK");
            const conversation = (events: SessionEvent[]) =>
                events.filter(
                    (event) => event.type === "user.message" || event.type === "assistant.message"
                );
            const before = conversation(await session.getEvents());
            const completed: Extract<SessionEvent, { type: "session.compaction_complete" }>[] = [];
            session.on("session.compaction_complete", (event) => completed.push(event));
            stalled = true;
            const compaction = session.rpc.history.compact().then(
                (result) => ({ result }),
                (error: unknown) => ({ error })
            );
            await Promise.race([
                entered,
                compaction.then((outcome) => {
                    throw new Error(
                        `Compaction settled before workflow storage: ${JSON.stringify(outcome)}`
                    );
                }),
            ]);

            expect(await session.rpc.history.abortManualCompaction()).toEqual({ aborted: true });
            const outcome = await compaction;
            expect(outcome).toMatchObject({
                error: expect.objectContaining({
                    message: expect.stringContaining("Compaction Cancelled"),
                }),
            });
            await expect
                .poll(() => completed)
                .toEqual([
                    expect.objectContaining({
                        data: expect.objectContaining({
                            success: false,
                            error: "Compaction Cancelled",
                        }),
                    }),
                ]);
            expect(conversation(await session.getEvents())).toEqual(before);
            expect(await session.rpc.history.abortManualCompaction()).toEqual({ aborted: false });
            expect(
                (await session.sendAndWait({ prompt: "Continue after the cancelled compaction." }))
                    ?.data.content
            ).toBe("BUDGET_CONTROL_OK");
            expect(handler.requests.at(-1)).toMatchObject({
                messages: expect.arrayContaining([
                    expect.objectContaining({
                        role: "user",
                        content: expect.stringContaining("Initialize cancellable compaction."),
                    }),
                ]),
            });
        } finally {
            releaseStorage();
            await storageRequest;
            try {
                await compactionClient.stop();
            } finally {
                database.close();
            }
        }
    });

    it("should reject an oversized provider prompt before any inference request", async () => {
        const handler = new BudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        const createSession = (maxPromptTokens: number) =>
            budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                    maxPromptTokens,
                    maxOutputTokens: 200_000,
                },
                infiniteSessions: { enabled: false },
            });
        try {
            const prompt = "budget-boundary ".repeat(16_384);
            const control = await createSession(250_000);
            expect((await control.sendAndWait({ prompt }))?.data.content).toBe("BUDGET_CONTROL_OK");
            expect(handler.requests).toHaveLength(1);
            await control.disconnect();
            // Leave room for static context so this reaches final request admission.
            const session = await createSession(32_000);
            const errors: Extract<SessionEvent, { type: "session.error" }>[] = [];
            session.on((event) => {
                if (event.type === "session.error") errors.push(event);
            });
            const admissionError =
                /Request exceeds the model's prompt budget after reserving output \(\d+ tokens; limit 32000\)\. Reduce context or compact before continuing\./;
            await expect(session.sendAndWait({ prompt })).rejects.toThrow(admissionError);
            expect(errors).toHaveLength(1);
            expect(errors[0].data.message).toMatch(admissionError);
            expect(handler.requests).toHaveLength(1);
            expect((await session.rpc.model.getCurrent()).modelId).toBe(
                "uncatalogued-budget-model"
            );
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });

    it("should report the effective prompt budget after manual compaction", async () => {
        const handler = new BudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        try {
            const session = await budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                },
                modelCapabilities: {
                    limits: {
                        max_prompt_tokens: 112_000,
                        max_context_window_tokens: 128_000,
                        max_output_tokens: 32_000,
                    },
                },
                infiniteSessions: { enabled: false },
            });
            expect(
                (await session.sendAndWait({ prompt: "Initialize manual compaction." }))?.data
                    .content
            ).toBe("BUDGET_CONTROL_OK");
            const events: SessionEvent[] = [];
            session.on((event) => {
                if (
                    event.type === "session.compaction_start" ||
                    event.type === "session.compaction_complete"
                ) {
                    events.push(event);
                }
            });
            const result = await session.rpc.history.compact({ trigger: "manual" });
            expect(result).toMatchObject({
                success: true,
                summaryContent: "BUDGET_CONTROL_OK",
                contextWindow: { tokenLimit: 96_000 },
            });
            expect(events.map((event) => [event.type, event.data])).toEqual([
                ["session.compaction_start", expect.objectContaining({ tokenLimit: 96_000 })],
                [
                    "session.compaction_complete",
                    expect.objectContaining({ success: true, tokenLimit: 96_000 }),
                ],
            ]);
            expect(handler.requests).toHaveLength(2);
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });

    it("should reject capacity-consuming output caps without an inference request", async () => {
        const handler = new BudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        try {
            const session = await budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                },
                modelCapabilities: {
                    limits: {
                        max_prompt_tokens: 112_000,
                        max_context_window_tokens: 128_000,
                        max_output_tokens: 128_000,
                    },
                },
                infiniteSessions: { enabled: false },
            });
            const noCapacity =
                "Output token reservation 128000 leaves no room in the 128000-token context window";
            await expect(
                session.sendAndWait({ prompt: "Initialize an invalid context budget." })
            ).rejects.toThrow(noCapacity);
            for (const outputTokenLimit of [128_000, 0]) {
                await expect(
                    session.rpc.metadata.contextInfo({ promptTokenLimit: 0, outputTokenLimit })
                ).rejects.toThrow(noCapacity);
            }
            await expect(session.rpc.history.compact({ trigger: "manual" })).rejects.toThrow(
                noCapacity
            );
            const context = await session.rpc.metadata.contextInfo({
                promptTokenLimit: 0,
                outputTokenLimit: 32_000,
            });
            expect(context.contextInfo).toMatchObject({
                limit: 112_000,
                promptTokenLimit: 96_000,
            });
            expect(handler.requests).toHaveLength(0);
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });

    it("should resolve model switch budgets after the next request initializes context", async () => {
        const handler = new BudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        try {
            const session = await budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                },
                modelCapabilities: {
                    limits: {
                        max_prompt_tokens: 112_000,
                        max_context_window_tokens: 128_000,
                        max_output_tokens: 32_000,
                    },
                },
                infiniteSessions: { enabled: false },
            });
            for (const promptLimit of [112_000, 100_000]) {
                if (promptLimit === 100_000) {
                    await session.setModel("uncatalogued-budget-model", {
                        modelCapabilities: {
                            limits: {
                                max_prompt_tokens: promptLimit,
                                max_context_window_tokens: 128_000,
                                max_output_tokens: 32_000,
                            },
                        },
                    });
                }
                expect(
                    (await session.sendAndWait({ prompt: "Initialize the current budget." }))?.data
                        .content
                ).toBe("BUDGET_CONTROL_OK");
                const context = await session.rpc.metadata.contextInfo({
                    promptTokenLimit: 0,
                    outputTokenLimit: 0,
                });
                expect(context.contextInfo).toMatchObject({
                    modelName: "uncatalogued-budget-model",
                    limit: promptLimit,
                    promptTokenLimit: 96_000,
                });
            }
            expect(handler.requests).toHaveLength(2);
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });

    it("should trigger compaction with low threshold and emit events", async () => {
        // Create session with very low compaction thresholds to trigger compaction quickly
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            modelCapabilities: {
                limits: {
                    max_prompt_tokens: 112_000,
                    max_context_window_tokens: 128_000,
                    max_output_tokens: 32_000,
                },
            },
            infiniteSessions: {
                enabled: true,
                // Trigger background compaction at 0.5% context usage (~1000 tokens)
                backgroundCompactionThreshold: 0.005,
                // Block at 1% to ensure compaction runs
                bufferExhaustionThreshold: 0.01,
            },
        });

        // The first prompt leaves the session below the compaction processor's minimum
        // message count. The second prompt is therefore the first deterministic point
        // at which low thresholds can trigger compaction. Register event waiters before
        // any prompts are sent so we never miss the events.
        const compactionStartedP = getNextSessionEvent(
            session,
            "session.compaction_start",
            "session.compaction_start"
        );
        const usageEvents: Extract<SessionEvent, { type: "session.usage_info" }>[] = [];
        session.on((event) => {
            if (event.type === "session.usage_info") usageEvents.push(event);
        });
        // Wait specifically for a *successful* compaction_complete so that any transient
        // failed compaction event the daemon may emit before a successful retry is ignored
        // (mirrors the dotnet/rust references).
        const compactionCompletedP = getNextSessionEvent(
            session,
            "session.compaction_complete",
            "successful session.compaction_complete",
            (event) => event.data.success
        );

        await session.sendAndWait({
            prompt: "Tell me a story about a dragon. Be detailed.",
        });
        await session.sendAndWait({
            prompt: "Continue the story with more details about the dragon's castle.",
        });

        const [startEvent, completeEvent] = await Promise.all([
            compactionStartedP,
            compactionCompletedP,
        ]);

        expect(startEvent.data.conversationTokens ?? 0).toBeGreaterThan(0);
        expect(completeEvent.data.success).toBe(true);
        expect(completeEvent.data.compactionTokensUsed).toBeDefined();
        // Replay has no prompt usage; recording must preserve the provider's value or absence.
        if (isCI) {
            expect(completeEvent.data.compactionTokensUsed?.inputTokens ?? 0).toBe(0);
        } else {
            const exchanges = await openAiEndpoint.getExchanges();
            const compactions = exchanges.filter(
                ({ compactionUsage }) =>
                    compactionUsage && compactionUsage.summary === completeEvent.data.summaryContent
            );
            expect(
                compactions,
                "Expected one provider compaction chain for the completed summary"
            ).toHaveLength(1);
            expect(completeEvent.data.compactionTokensUsed?.inputTokens).toBe(
                compactions[0].compactionUsage?.inputTokens
            );
        }
        const summary = (completeEvent.data.summaryContent ?? "").toLowerCase();
        expect(summary).toContain("<overview>");
        expect(summary).toContain("<history>");
        expect(summary).toContain("<checkpoint_title>");

        await session.sendAndWait({
            prompt: "Now describe the dragon's treasure in great detail.",
        });

        // Verify the session still works after compaction
        const answer = await session.sendAndWait({ prompt: "What was the story about?" });
        const content = (answer?.data.content ?? "").toLowerCase();
        // Should remember it was about a dragon (context preserved via summary)
        expect(content).toContain("kaedrith");
        expect(content).toContain("dragon");

        // OpenAI transports omit the output cap; Anthropic sends its advertised maximum.
        // Both must reserve the same output headroom.
        expect(usageEvents.length).toBeGreaterThan(0);
        for (const event of usageEvents) expect(event.data.tokenLimit).toBe(96_000);
        const context = await session.rpc.metadata.contextInfo({
            promptTokenLimit: 0,
            outputTokenLimit: 0,
        });
        expect(context.contextInfo).toMatchObject({ limit: 112_000, promptTokenLimit: 96_000 });
        const attribution = await session.rpc.metadata.getContextAttribution();
        expect(attribution.contextAttribution).toMatchObject({
            modelId: context.contextInfo?.modelName,
            limit: 112_000,
            promptTokenLimit: 96_000,
            bufferTokens: context.contextInfo?.bufferTokens,
            compactionThreshold: context.contextInfo?.compactionThreshold,
        });
        for (const outputTokenLimit of [-1, 32_001]) {
            await expect(
                session.rpc.metadata.contextInfo({ promptTokenLimit: 0, outputTokenLimit })
            ).rejects.toThrow(
                outputTokenLimit < 0
                    ? /Invalid output token limit/
                    : /exceeds the advertised maximum/
            );
        }
        const afterInvalidCaps = await session.rpc.metadata.contextInfo({
            promptTokenLimit: 0,
            outputTokenLimit: 0,
        });
        expect(afterInvalidCaps.contextInfo).toMatchObject({
            limit: 112_000,
            promptTokenLimit: 96_000,
        });
        const endpoint = {
            capi: "/chat/completions",
            "openai-completions": "/chat/completions",
            "openai-responses": "/responses",
            "anthropic-messages": "/v1/messages",
        }[testBackend];
        const requests = (await openAiEndpoint.getRequests()).filter(
            (request) => request.method === "POST" && request.url.endsWith(endpoint)
        );
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
            const body = JSON.parse(request.body);
            if (testBackend === "anthropic-messages") {
                expect(body.max_tokens).toBe(32_000);
            } else {
                expect(body).not.toHaveProperty("max_tokens");
                expect(body).not.toHaveProperty("max_output_tokens");
            }
        }
    }, 120000);

    it("should not emit compaction events when infinite sessions disabled", async () => {
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            infiniteSessions: {
                enabled: false,
            },
        });

        const compactionEvents: SessionEvent[] = [];
        session.on((event) => {
            if (
                event.type === "session.compaction_start" ||
                event.type === "session.compaction_complete"
            ) {
                compactionEvents.push(event);
            }
        });

        await session.sendAndWait({ prompt: "What is 2+2?" });

        // Should not have any compaction events when disabled
        expect(compactionEvents.length).toBe(0);
    });

    it("should return empty handoff summary for fresh session", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            const result = await session.rpc.history.summarizeForHandoff();
            expect(result.summary).toBe("");
        } finally {
            await session.disconnect();
        }
    });

    it("should summarize for handoff after non-ephemeral log event", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            await session.log("handoff summary log coverage");
            const result = await session.rpc.history.summarizeForHandoff();
            expect(typeof result.summary).toBe("string");
        } finally {
            await session.disconnect();
        }
    });

    it("should report no-op when cancelling compaction without in-flight work", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            const backgroundResult = await session.rpc.history.cancelBackgroundCompaction();
            const manualResult = await session.rpc.history.abortManualCompaction();

            expect(backgroundResult.cancelled).toBe(false);
            expect(manualResult.aborted).toBe(false);
        } finally {
            await session.disconnect();
        }
    });
    it("should resolve selected-tier defaults and confirm a smaller-tier switch", async () => {
        const modelId = "gpt-5.4-mini";
        class TierBudgetReplayHandler extends BudgetReplayHandler {
            protected override async sendRequest(request: Request): Promise<Response> {
                const path = new URL(request.url).pathname;
                if (path === "/models") {
                    return Response.json({
                        data: [
                            {
                                id: modelId,
                                name: "Tier budget fixture",
                                object: "model",
                                vendor: "OpenAI",
                                version: "1",
                                model_picker_enabled: true,
                                supported_endpoints: ["/chat/completions"],
                                capabilities: {
                                    type: "chat",
                                    family: modelId,
                                    tokenizer: "o200k_base",
                                    supports: { vision: false, streaming: true, tool_calls: true },
                                    limits: {
                                        max_prompt_tokens: 112_000,
                                        max_context_window_tokens: 128_000,
                                        max_output_tokens: 32_000,
                                    },
                                },
                                billing: {
                                    token_prices: {
                                        default: { max_prompt_tokens: 88_000 },
                                        long_context: { max_prompt_tokens: 112_000 },
                                    },
                                },
                            },
                        ],
                    });
                }
                if (path.endsWith("/models/session")) return Response.json({});
                if (path.includes("/policy")) return Response.json({ state: "enabled" });
                return super.sendRequest(request);
            }
        }
        const handler = new TierBudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        try {
            await budgetClient.start();
            expect(
                (await budgetClient.listModels()).find((model) => model.id === modelId)
            ).toMatchObject({
                capabilities: {
                    limits: { max_prompt_tokens: 112_000 },
                },
            });
            const session = await budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: modelId,
                // Exercise CAPI pricing tiers even in the provider transport matrix.
                providers: [],
                contextTier: "long_context",
                infiniteSessions: { enabled: false },
            });
            expect(
                (await session.sendAndWait({ prompt: "tier-budget-boundary ".repeat(16_384) }))
                    ?.data.content
            ).toBe("BUDGET_CONTROL_OK");
            const longContext = await session.rpc.metadata.contextInfo({
                promptTokenLimit: 0,
                outputTokenLimit: 0,
            });
            expect(longContext.contextInfo).toMatchObject({
                modelName: modelId,
                limit: 112_000,
                promptTokenLimit: 96_000,
            });
            const attribution = await session.rpc.metadata.getContextAttribution();
            expect(attribution.contextAttribution).toMatchObject({
                modelId,
                limit: 112_000,
                promptTokenLimit: 96_000,
                bufferTokens: longContext.contextInfo?.bufferTokens,
            });
            expect((await session.rpc.model.getCurrent()).contextTier).toBe("long_context");
            const target = {
                modelId,
                contextTier: "default",
                modelCapabilities: { limits: { max_output_tokens: 64_000 } },
                runCompactionPreflight: true,
            } as const;
            const preflight = await session.rpc.model.switchTo(target);
            expect(preflight).toMatchObject({
                status: "confirmation_required",
                modelState: { contextTier: "long_context" },
                confirmation: {
                    targetModelDisplayName: modelId,
                    targetLimit: 64_000,
                },
            });
            expect(preflight.confirmation?.currentTokens).toBeGreaterThan(64_000);
            expect(preflight.confirmation?.currentTokens).toBeLessThanOrEqual(88_000);
            expect(handler.requests).toHaveLength(1);
            expect(
                await session.rpc.model.switchTo({ ...target, compactionDecision: "cancel" })
            ).toMatchObject({
                status: "cancelled",
                modelState: { contextTier: "long_context" },
            });
            expect(handler.requests).toHaveLength(1);
            const compactionEvents: SessionEvent[] = [];
            session.on((event) => {
                if (
                    event.type === "session.compaction_start" ||
                    event.type === "session.compaction_complete"
                ) {
                    compactionEvents.push(event);
                }
            });
            expect(
                await session.rpc.model.switchTo({ ...target, compactionDecision: "compact" })
            ).toMatchObject({
                status: "applied",
                modelState: { contextTier: "default" },
            });
            expect(compactionEvents.map((event) => [event.type, event.data])).toEqual([
                ["session.compaction_start", expect.objectContaining({ tokenLimit: 64_000 })],
                [
                    "session.compaction_complete",
                    expect.objectContaining({ success: true, tokenLimit: 64_000 }),
                ],
            ]);
            expect(handler.requests).toHaveLength(2);
            expect(
                (await session.sendAndWait({ prompt: "Check the compacted default tier." }))?.data
                    .content
            ).toBe("BUDGET_CONTROL_OK");
            const defaultContext = await session.rpc.metadata.contextInfo({
                promptTokenLimit: 0,
                outputTokenLimit: 0,
            });
            expect(defaultContext.contextInfo).toMatchObject({
                modelName: modelId,
                limit: 88_000,
                promptTokenLimit: 64_000,
            });
            expect(handler.requests).toHaveLength(3);
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });
});
