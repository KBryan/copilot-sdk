// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { createServer } from "node:http";
import { describe, expect, it, onTestFinished } from "vitest";
import { CopilotClient, RuntimeConnection, approveAll } from "../../src/index.js";
import { createSdkTestContext, DEFAULT_GITHUB_TOKEN } from "./harness/sdkTestContext.js";

describe("Ollama provider discovery", async () => {
    const { env, workDir } = await createSdkTestContext({ useStdio: true });

    it("routes provider operations and reads OLLAMA_HOST in the runtime subprocess", async () => {
        const requests: string[] = [];
        const server = createServer((request, response) => {
            const route = `${request.method} ${request.url}`;
            requests.push(route);
            response.setHeader("Content-Type", "application/json");
            if (route === "GET /api/version") {
                response.end(JSON.stringify({ version: "0.6.2" }));
            } else if (route === "GET /api/tags") {
                response.end(JSON.stringify({ models: [{ name: "test-chat:latest" }] }));
            } else if (route === "POST /api/show") {
                request.resume();
                response.end(
                    JSON.stringify({
                        capabilities: ["completion", "tools"],
                        model_info: {
                            "general.architecture": "llama",
                            "llama.context_length": 8192,
                            "clip.context_length": 1024,
                        },
                    })
                );
            } else {
                response.writeHead(404).end(JSON.stringify({ error: "unexpected route" }));
            }
        });
        const clients: CopilotClient[] = [];
        onTestFinished(async () => {
            try {
                await Promise.all(clients.map((client) => client.stop()));
            } finally {
                server.closeAllConnections();
                if (server.listening) {
                    await new Promise<void>((resolve, reject) =>
                        server.close((error) => (error ? reject(error) : resolve()))
                    );
                }
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
        const endpoint = `http://127.0.0.1:${address.port}`;
        function makeClient(ollamaHost: string) {
            // Stdio keeps ambient environment inputs in a child, even in in-process CI jobs.
            const client = new CopilotClient({
                connection: RuntimeConnection.forStdio(),
                workingDirectory: workDir,
                gitHubToken: DEFAULT_GITHUB_TOKEN,
                env: {
                    ...env,
                    GH_TOKEN: DEFAULT_GITHUB_TOKEN,
                    GITHUB_TOKEN: DEFAULT_GITHUB_TOKEN,
                    OLLAMA_HOST: ollamaHost,
                },
            });
            clients.push(client);
            return client;
        }
        const client = makeClient(endpoint);
        const session = await client.createSession({ onPermissionRequest: approveAll });
        const providers = session.rpc.providers;
        const catalog = await providers.getCatalog();
        const adapter = catalog.providers.find((provider) => provider.providerKind === "ollama");
        expect(adapter).toBeDefined();
        if (!adapter) throw new Error("Ollama adapter missing from the public catalog");
        expect(requests).toEqual([]);

        const discovered = await providers.discover({ adapterId: adapter.adapterId });
        expect(discovered.outcome.code).toBe("success");
        expect(discovered.instances).toHaveLength(1);
        const instance = discovered.instances[0];
        expect(instance.reference.managementEndpoint).toBe(endpoint);
        const repeated = await providers.discover({ adapterId: adapter.adapterId });
        expect(repeated.instances[0].reference).toEqual(instance.reference);
        const status = await providers.getStatus({ instance: instance.reference });
        expect(status).toMatchObject({
            outcome: { code: "success" },
            status: "healthy",
            version: "0.6.2",
        });
        const inventory = await providers.models.list({ instance: instance.reference });
        expect(inventory.outcome.code).toBe("success");
        expect(inventory.models).toHaveLength(1);
        const model = inventory.models[0];
        expect(model.id).toBe("test-chat:latest");
        expect(model.capabilities.limits?.max_context_window_tokens).toBe(8192);
        const plan = await providers.models.prepareConfiguration({ instance, model });
        expect(plan.provider).toMatchObject({ baseUrl: `${endpoint}/v1` });
        expect(plan.model).toMatchObject({ id: model.id, maxContextWindowTokens: 8192 });
        expect(plan.selectionId).toBe(`${plan.provider.name}/${model.id}`);
        const unsafeInstance = {
            ...instance,
            reference: { ...instance.reference, id: "///", providerKind: "a/b" },
        };
        const cleanedPlan = await providers.models.prepareConfiguration({
            instance: unsafeInstance,
            model: { ...model, name: "  Test\n\u202Emodel\u200B " },
        });
        expect(cleanedPlan.provider.name).toBe("a-b");
        expect(cleanedPlan.model.name).toBe("Test model");
        expect(cleanedPlan.model.wireModel).toBe(model.id);
        expect(cleanedPlan.selectionId).toBe(`a-b/${model.id}`);
        expect(requests).toContain("POST /api/show");
        expect(
            requests.every((route) =>
                ["GET /api/version", "GET /api/tags", "POST /api/show"].includes(route)
            )
        ).toBe(true);

        // Port zero cannot be claimed by another local service.
        const unreachableSession = await makeClient("http://127.0.0.1:0").createSession({
            onPermissionRequest: approveAll,
        });
        const unreachableProviders = unreachableSession.rpc.providers;
        const failure = await unreachableProviders.discover({ adapterId: adapter.adapterId });
        expect(failure).toMatchObject({ outcome: { code: "unreachable" }, instances: [] });
        const explicit = await unreachableProviders.discover({
            adapterId: adapter.adapterId,
            input: { endpoint },
        });
        expect(explicit.instances[0].reference).toEqual(instance.reference);
        expect(explicit.outcome.code).toBe("success");
        await expect(
            providers.discover({
                adapterId: adapter.adapterId,
                input: { ollamaHost: endpoint },
            })
        ).rejects.toThrow(/invalid.*discovery.*input|does not match schema/i);
    });
});
