/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveAll, type SessionEvent } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { waitForCondition } from "./harness/sdkTestHelper.js";

describe("User-requested shell RPC", async () => {
    const { copilotClient: client, homeDir } = await createSdkTestContext();

    function compactUuid(): string {
        return randomUUID().replace(/-/g, "");
    }

    function quotePowerShell(value: string): string {
        return `'${value.replace(/'/g, "''")}'`;
    }

    function quoteSh(value: string): string {
        return `'${value.replace(/'/g, "'\\''")}'`;
    }

    function createMarkerThenSleepCommand(markerPath: string, seconds: number): string {
        if (process.platform === "win32") {
            return `Set-Content -LiteralPath ${quotePowerShell(markerPath)} -Value 'running'; Start-Sleep -Seconds ${seconds}`;
        }
        return `echo running > ${quoteSh(markerPath)}; sleep ${seconds}`;
    }

    async function waitForFileExists(filePath: string): Promise<void> {
        await waitForCondition(() => existsSync(filePath), {
            timeoutMs: 30_000,
            intervalMs: 100,
            timeoutMessage: `Timed out waiting for the shell command to create '${filePath}'.`,
        });
    }

    async function withTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        message: string
    ): Promise<T> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
                }),
            ]);
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    function tryDeleteFile(filePath: string): void {
        try {
            rmSync(filePath, { force: true });
        } catch {
            // Best-effort cleanup.
        }
    }

    it("should execute user requested shell command", { timeout: 120_000 }, async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            const marker = `copilotusershell${compactUuid()}`;
            const requestId = `req-${compactUuid()}`;

            const result = await session.rpc.shell.executeUserRequested({
                requestId,
                command: `echo ${marker}`,
            });

            expect(result.success).toBe(true);
            expect(result.exitCode).toBe(0);
            expect(result.output).toContain(marker);
            expect(result.toolCallId).toBeTruthy();
        } finally {
            await session.disconnect();
        }
    });

    it.for([0, 7])(
        "dispatches queued exit after user shell completes with code %i",
        { timeout: 120_000 },
        async (exitCode, { onTestFinished }) => {
            const session = await client.createSession({ onPermissionRequest: approveAll });
            const markerPath = join(homeDir, `shell-started-${compactUuid()}`);
            const releasePath = join(homeDir, `shell-release-${compactUuid()}`);
            let executeTask: ReturnType<typeof session.rpc.shell.executeUserRequested> | undefined;
            let interestHandle: string | undefined;
            let unsubscribe: (() => void) | undefined;
            onTestFinished(async () => {
                writeFileSync(releasePath, "release");
                try {
                    if (executeTask) {
                        await withTimeout(executeTask, 30_000, "Shell completion did not drain.");
                    }
                } finally {
                    unsubscribe?.();
                    try {
                        if (interestHandle !== undefined) {
                            await session.rpc.eventLog.releaseInterest({ handle: interestHandle });
                        }
                    } finally {
                        await session.disconnect();
                    }
                }
            });

            const interest = await session.rpc.eventLog.registerInterest({
                eventType: "command.queued",
            });
            interestHandle = interest.handle;
            const queued =
                Promise.withResolvers<Extract<SessionEvent, { type: "command.queued" }>>();
            const idle = Promise.withResolvers<void>();
            let commandDispatched = false;
            let dispatchedBeforeRelease = false;
            unsubscribe = session.on((event) => {
                if (event.type === "command.queued" && event.data.command === "/exit") {
                    commandDispatched = true;
                    dispatchedBeforeRelease ||= !existsSync(releasePath);
                    queued.resolve(event);
                } else if (event.type === "session.idle" && commandDispatched) {
                    idle.resolve();
                }
            });
            const handled = queued.promise.then((event) =>
                session.rpc.commands.respondToQueuedCommand({
                    requestId: event.data.requestId,
                    result: { handled: true },
                })
            );
            handled.catch(() => {});

            const command =
                process.platform === "win32"
                    ? `Set-Content -LiteralPath ${quotePowerShell(markerPath)} -Value 'running'; while (-not (Test-Path -LiteralPath ${quotePowerShell(releasePath)})) { Start-Sleep -Milliseconds 50 }; exit ${exitCode}`
                    : `echo running > ${quoteSh(markerPath)}; while [ ! -f ${quoteSh(releasePath)} ]; do sleep 0.05; done; exit ${exitCode}`;
            executeTask = session.rpc.shell.executeUserRequested({
                requestId: `req-${compactUuid()}`,
                command,
            });
            executeTask.catch(() => {});
            await waitForFileExists(markerPath);
            expect((await session.rpc.commands.enqueue({ command: "/exit" })).queued).toBe(true);

            // Enqueue has acknowledged the command while the real subprocess is
            // held; inspect the queue rather than using a delay to prove parking.
            expect((await session.rpc.queue.pendingItems()).items).toEqual([
                expect.objectContaining({ kind: "command", displayText: "/exit" }),
            ]);

            writeFileSync(releasePath, "release");
            const result = await withTimeout(
                executeTask,
                30_000,
                "Shell completion did not resume the queued exit."
            );
            expect(result.exitCode).toBe(exitCode);
            expect(result.success).toBe(exitCode === 0);
            expect(await withTimeout(handled, 30_000, "Queued exit was not dispatched.")).toEqual({
                success: true,
            });
            expect(dispatchedBeforeRelease).toBe(false);
            await withTimeout(idle.promise, 30_000, "Session did not settle after queued exit.");
            expect((await session.rpc.queue.pendingItems()).items).toEqual([]);
        }
    );

    it("should cancel user requested shell command", { timeout: 120_000 }, async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        const markerPath = join(homeDir, `shell-cancel-${compactUuid()}.txt`);
        let executeTask:
            | Promise<Awaited<ReturnType<typeof session.rpc.shell.executeUserRequested>>>
            | undefined;
        let executeSettled = false;
        try {
            const missing = await session.rpc.shell.cancelUserRequested({
                requestId: `missing-${compactUuid()}`,
            });
            expect(missing.cancelled).toBe(false);

            const requestId = `req-${compactUuid()}`;
            executeTask = session.rpc.shell.executeUserRequested({
                requestId,
                command: createMarkerThenSleepCommand(markerPath, 60),
            });
            executeTask
                .finally(() => {
                    executeSettled = true;
                })
                .catch(() => {});
            executeTask.catch(() => {});

            await waitForFileExists(markerPath);

            await waitForCondition(
                async () => (await session.rpc.shell.cancelUserRequested({ requestId })).cancelled,
                {
                    timeoutMs: 15_000,
                    intervalMs: 100,
                    timeoutMessage:
                        "Timed out waiting for the user-requested shell command to become cancellable.",
                }
            );

            const result = await withTimeout(
                executeTask,
                30_000,
                "Timed out waiting for cancelled shell command to finish."
            );
            expect(result.success).toBe(false);
        } finally {
            if (executeTask && !executeSettled) {
                await withTimeout(
                    executeTask,
                    30_000,
                    "Timed out draining cancelled shell command."
                ).catch(() => {});
            }
            tryDeleteFile(markerPath);
            await session.disconnect();
        }
    });
});
