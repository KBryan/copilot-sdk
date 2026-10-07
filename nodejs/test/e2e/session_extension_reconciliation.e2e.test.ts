/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { approveAll, RuntimeConnection } from "../../src/index.js";
import { createSdkTestContext, getLegacyCliPathForTests } from "./harness/sdkTestContext.js";
import { retry } from "./harness/sdkTestHelper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(__dirname, "..", "..", "dist");

const { copilotClient, env, workDir } = await createSdkTestContext({
    copilotClientOptions: {
        connection: RuntimeConnection.forStdio({ path: await getLegacyCliPathForTests() }),
        env: { COPILOT_CLI_ENABLED_FEATURE_FLAGS: "EXTENSIONS" },
    },
});

async function writeExtension(extensionDir: string, readyFile: string): Promise<void> {
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
        join(extensionDir, "extension.mjs"),
        `
import { writeFileSync } from "node:fs";
import { joinSession } from "@github/copilot-sdk/extension";

await joinSession({});
writeFileSync(${JSON.stringify(readyFile)}, "joined");
setInterval(() => {}, 60_000);
`
    );
}

it("reconciles session extensions without persisting preferences", async () => {
    const copilotHome = env.COPILOT_HOME!;
    const readyFile = join(workDir, "project-probe-joined");
    await writeExtension(join(workDir, ".github", "extensions", "probe"), readyFile);
    await writeExtension(
        join(copilotHome, "extensions", "explicitly-disabled"),
        join(workDir, "disabled-probe-joined")
    );
    const settingsPath = join(copilotHome, "settings.json");
    const settings = '{"extensions":{"disabledExtensions":["user:explicitly-disabled"]}}';
    await writeFile(settingsPath, settings);
    execFileSync("git", ["init", "--quiet"], { cwd: workDir });

    await using session = await copilotClient.createSession({
        requestExtensions: true,
        extensionSdkPath: DIST_DIR,
        onPermissionRequest: approveAll,
    });
    await retry(
        "wait for the project extension to join the session",
        async () => {
            expect(existsSync(readyFile) && readFileSync(readyFile, "utf-8")).toBe("joined");
        },
        300,
        100
    );
    const listed = await session.rpc.extensions.list();
    const project = listed.extensions.find(({ id }) => id === "project:probe");
    expect(project).toMatchObject({ source: "project", status: "running" });
    expect(project?.pid).toBeTypeOf("number");
    const configPath = join(copilotHome, "config.json");
    const configBefore = existsSync(configPath) ? await readFile(configPath, "utf-8") : undefined;

    const reconciled = await session.rpc.extensions.reconcile();

    expect(reconciled.extensions).toEqual(
        expect.arrayContaining([
            project,
            expect.objectContaining({ id: "user:explicitly-disabled", status: "disabled" }),
        ])
    );
    expect(existsSync(join(workDir, "disabled-probe-joined"))).toBe(false);
    expect(await readFile(settingsPath, "utf-8")).toBe(settings);
    expect(existsSync(configPath) ? await readFile(configPath, "utf-8") : undefined).toBe(
        configBefore
    );
    expect((await session.rpc.extensions.list()).extensions).toEqual(reconciled.extensions);
});
