/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveAll, RuntimeConnection } from "../../src/index.js";
import { createSdkTestContext, DEFAULT_GITHUB_TOKEN } from "./harness/sdkTestContext.js";

interface SkillPolicyCase {
    label: string;
    includedBuiltinSkills?: string[];
    disabledSkills?: string[];
    enableSkills?: boolean;
    expectedEnabled?: boolean;
    expectedCustom?: boolean;
}

describe("Runtime-bundled skills", async () => {
    const { createClient, workDir, env } = await createSdkTestContext({ useStdio: true });

    it.each<SkillPolicyCase>([
        { label: "default", expectedEnabled: true },
        {
            label: "explicit opt-in",
            includedBuiltinSkills: ["github-pr-media"],
            expectedEnabled: true,
        },
        { label: "explicit opt-out", includedBuiltinSkills: [] },
        {
            label: "disabled builtin",
            disabledSkills: ["github-pr-media"],
            expectedEnabled: false,
        },
        { label: "skills disabled", enableSkills: false, expectedCustom: false },
    ])(
        "preserves $label on create and resume alongside custom skills",
        async ({
            includedBuiltinSkills,
            disabledSkills,
            enableSkills,
            expectedEnabled,
            expectedCustom = true,
        }) => {
            const skillsDir = join(workDir, randomUUID());
            const customSkillDir = join(skillsDir, "custom-proof");
            mkdirSync(customSkillDir, { recursive: true });
            writeFileSync(
                join(customSkillDir, "SKILL.md"),
                "---\nname: custom-proof\ndescription: Explicit custom skill.\n---\nCustom instructions.\n"
            );

            // A replacement child process proves cold resume, not a warm registry lookup.
            await using client = createClient({
                connection: RuntimeConnection.forStdio(),
                mode: "copilot-cli",
                gitHubToken: DEFAULT_GITHUB_TOKEN,
            });
            await client.start();
            await client.rpc.plugins.builtin.set({ paths: [] });
            const config = {
                onPermissionRequest: approveAll,
                enableConfigDiscovery: false,
                skillDirectories: [skillsDir],
                includedBuiltinSkills,
                disabledSkills,
                enableSkills,
            };
            const session = await client.createSession(config);
            let history;
            try {
                await session.rpc.name.set({ name: "Builtin skill discovery" });
                const { skills } = await session.rpc.skills.list();
                expect(skills.some((skill) => skill.name === "custom-proof" && skill.enabled)).toBe(
                    expectedCustom
                );
                expect(skills.find((skill) => skill.name === "github-pr-media")?.enabled).toBe(
                    expectedEnabled
                );
                history = await session.getEvents();
                expect(history[0]?.type).toBe("session.start");
            } finally {
                await session.disconnect();
            }
            expect(await client.stop()).toHaveLength(0);
            // A no-turn session has no persisted journal. Seed its real emitted history
            // after the writer stops, without a model call or any upload.
            writeFileSync(
                join(env.COPILOT_HOME, "session-state", session.sessionId, "events.jsonl"),
                `${history.map((event) => JSON.stringify(event)).join("\n")}\n`
            );

            await using replacement = createClient({
                connection: RuntimeConnection.forStdio(),
                mode: "copilot-cli",
                gitHubToken: DEFAULT_GITHUB_TOKEN,
            });
            const resumed = await replacement.resumeSession(session.sessionId, config);
            try {
                const { skills } = await resumed.rpc.skills.list();
                expect(skills.some((skill) => skill.name === "custom-proof" && skill.enabled)).toBe(
                    expectedCustom
                );
                expect(skills.find((skill) => skill.name === "github-pr-media")?.enabled).toBe(
                    expectedEnabled
                );
            } finally {
                await resumed.disconnect();
            }
        }
    );
});
