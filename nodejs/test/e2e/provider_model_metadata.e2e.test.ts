/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createServer } from "node:http";
import { describe, it, onTestFinished } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Provider model metadata", async () => {
    const { copilotClient: client } = await createSdkTestContext();

    it("cleans prompt labels while sending the exact provider model ID", async ({ expect }) => {
        const requests: { route: string; body: string }[] = [];
        const server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                requests.push({
                    route: `${request.method} ${request.url}`,
                    body: Buffer.concat(chunks).toString("utf8"),
                });
                // The outgoing request is the contract; reject it rather than invent an assistant response.
                response.writeHead(400, { "Content-Type": "application/json" }).end(
                    JSON.stringify({
                        error: {
                            type: "invalid_request_error",
                            message: "MODEL_METADATA_PROBE_COMPLETE",
                        },
                    })
                );
            });
        });
        onTestFinished(async () => {
            server.closeAllConnections();
            if (server.listening) {
                await new Promise<void>((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve()))
                );
            }
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("Expected an assigned loopback TCP port");
        }

        const rawId = `raw\n\u202Eid<&"${"é".repeat(100)}`;
        const rawName = `  Display\r\n\u200Bname<&"${"名".repeat(100)}`;
        const selectionId = `local/${rawId}`;
        const expectedId = [...`local/raw id<&"${"é".repeat(100)}`].slice(0, 80).join("");
        const expectedName = [...`Display name<&"${"名".repeat(100)}`].slice(0, 80).join("");
        const escapeXml = (text: string) =>
            text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            model: selectionId,
            providers: [
                {
                    name: "local",
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: `http://127.0.0.1:${address.port}/v1`,
                },
            ],
            models: [{ id: rawId, provider: "local", wireModel: rawId, name: rawName }],
        });
        try {
            await expect(session.sendAndWait({ prompt: "What is 2 + 2?" })).rejects.toThrow(
                "MODEL_METADATA_PROBE_COMPLETE"
            );
            expect(requests).toHaveLength(1);
            expect(requests[0].route).toBe("POST /v1/chat/completions");
            const body = JSON.parse(requests[0].body);
            expect(body.model).toBe(rawId);
            const system = body.messages.find(
                (message: { role: string }) => message.role === "system"
            )?.content;
            expect(system).toBeTypeOf("string");
            expect(system).toContain(
                `<model name="${escapeXml(expectedName)}" id="${escapeXml(expectedId)}" />`
            );
            const information = system.match(
                /<model_information>([\s\S]*?)<\/model_information>/
            )?.[1];
            expect(information).toBeDefined();
            expect(information).not.toContain(rawId);
            expect(information).not.toContain(rawName);
            expect(information).not.toMatch(/[\u200B\u202E\r]/);
        } finally {
            await session.disconnect();
        }
    });
});
