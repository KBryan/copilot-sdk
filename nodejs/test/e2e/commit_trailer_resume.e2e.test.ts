/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, onTestFinished } from "vitest";
import { approveAll, RuntimeConnection, type SessionConfig } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Commit trailer resume", async () => {
    const { createClient, openAiEndpoint } = await createSdkTestContext();

    it.each(["options update", "cold resume"])(
        "allows coauthor opt-in after an initial opt-out via %s",
        async (transition) => {
            const config: SessionConfig = {
                model: "claude-sonnet-5",
                coauthorEnabled: false,
                featureFlags: { SESSION_TRAILER: true },
                onPermissionRequest: approveAll,
                availableTools: [],
                skipCustomInstructions: true,
            };
            const first = createClient({ connection: RuntimeConnection.forStdio() });
            onTestFinished(() => first.stop());
            let session = await first.createSession(config);
            const sessionId = session.sessionId;
            const disabledResponse = await session.sendAndWait({
                prompt: "Reply with exactly COAUTHOR_DISABLED_OK.",
            });
            expect(disabledResponse?.data.content).toContain("COAUTHOR_DISABLED_OK");
            const disabledRequest = (await openAiEndpoint.getExchanges()).at(-1);
            const disabledSystem = disabledRequest?.request.messages.find(
                (message) => message.role === "system"
            )?.content;
            expect(typeof disabledSystem).toBe("string");
            expect(disabledSystem).not.toContain("<git_commit_trailer>");

            if (transition === "options update") {
                await session.rpc.options.update({ coauthorEnabled: true });
            } else {
                await session.disconnect();
                await first.stop();
                const second = createClient({ connection: RuntimeConnection.forStdio() });
                onTestFinished(() => second.stop());
                session = await second.resumeSession(sessionId, {
                    ...config,
                    coauthorEnabled: true,
                });
            }

            const enabledResponse = await session.sendAndWait({
                prompt: "Reply with exactly COAUTHOR_ENABLED_OK.",
            });
            expect(enabledResponse?.data.content).toContain("COAUTHOR_ENABLED_OK");
            const enabledRequest = (await openAiEndpoint.getExchanges()).at(-1);
            const enabledSystem = enabledRequest?.request.messages.find(
                (message) => message.role === "system"
            )?.content;
            expect(enabledSystem).toContain("Co-authored-by: Copilot");
            expect(enabledSystem).toContain(`Copilot-Session: ${sessionId}`);
            await session.disconnect();
        }
    );

    it.each([false, true])(
        "restores uncustomized attribution across cold resume (quoted tags: %s)",
        async (quotedTags) => {
            const config: SessionConfig = {
                model: "claude-sonnet-5",
                coauthorEnabled: true,
                featureFlags: { SESSION_TRAILER: true },
                onPermissionRequest: approveAll,
                availableTools: [],
                skipCustomInstructions: true,
                systemMessage: {
                    mode: "customize",
                    sections: {
                        custom_instructions: {
                            action: "append",
                            content: quotedTags
                                ? "Quoted example: <git_commit_trailer>before</git_commit_trailer>"
                                : "",
                        },
                        runtime_instructions: {
                            action: (content: string) =>
                                content
                                    .replace("Co-authored-by: ", "Co-authored-by: Team ")
                                    .replace(
                                        "</git_commit_trailer>",
                                        "TRAILER_POLICY_ONCE\n</git_commit_trailer>"
                                    ),
                        },
                        last_instructions: {
                            action: "append",
                            content: quotedTags
                                ? "Quoted example: <git_commit_trailer>after</git_commit_trailer>"
                                : "",
                        },
                    },
                },
            };
            const first = createClient({ connection: RuntimeConnection.forStdio() });
            onTestFinished(() => first.stop());
            const session = await first.createSession(config);
            const sessionId = session.sessionId;
            const response = await session.sendAndWait({
                prompt: "Reply with exactly TRAILER_INITIAL_OK.",
            });
            expect(response?.data.content).toContain("TRAILER_INITIAL_OK");
            const before = (await openAiEndpoint.getExchanges()).at(-1);
            const initialSystem = before?.request.messages.find(
                (message) => message.role === "system"
            )?.content;
            expect(typeof initialSystem).toBe("string");
            const initialBlocks = String(initialSystem).match(
                /<git_commit_trailer>[\s\S]*?<\/git_commit_trailer>/g
            );
            expect(initialBlocks).toHaveLength(quotedTags ? 3 : 1);
            const generated = initialBlocks?.[quotedTags ? 1 : 0];
            expect(generated).toContain(`Copilot-Session: ${sessionId}`);
            expect(generated).toContain("Co-authored-by: Team Copilot");
            expect(generated?.match(/TRAILER_POLICY_ONCE/g)).toHaveLength(1);
            await session.disconnect();
            await first.stop();

            const second = createClient({ connection: RuntimeConnection.forStdio() });
            onTestFinished(() => second.stop());
            const resumed = await second.resumeSession(sessionId, config);
            const resumedResponse = await resumed.sendAndWait({
                prompt: "Reply with exactly TRAILER_RESUMED_OK.",
            });
            expect(resumedResponse?.data.content).toContain("TRAILER_RESUMED_OK");
            const after = (await openAiEndpoint.getExchanges()).at(-1);
            const resumedSystem = after?.request.messages.find(
                (message) => message.role === "system"
            )?.content;
            expect(
                String(resumedSystem).match(/<git_commit_trailer>[\s\S]*?<\/git_commit_trailer>/g)
            ).toEqual(initialBlocks);
            await resumed.disconnect();
            await second.stop();

            const third = createClient({ connection: RuntimeConnection.forStdio() });
            onTestFinished(() => third.stop());
            const optedOut = await third.resumeSession(sessionId, {
                ...config,
                coauthorEnabled: false,
            });
            const finalResponse = await optedOut.sendAndWait({
                prompt: "Reply with exactly TRAILER_OPT_OUT_OK.",
            });
            expect(finalResponse?.data.content).toContain("TRAILER_OPT_OUT_OK");
            const finalRequest = (await openAiEndpoint.getExchanges()).at(-1);
            const finalSystem = finalRequest?.request.messages.find(
                (message) => message.role === "system"
            )?.content;
            expect(finalSystem).not.toContain(`Copilot-Session: ${sessionId}`);
            expect(finalSystem).not.toContain("Co-authored-by:");
            await optedOut.disconnect();
        }
    );
});
