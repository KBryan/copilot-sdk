/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { build } from "esbuild";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { CAPI_PROXY_BUNDLE } from "./proxyBundleContext";

export default async function setup(project: TestProject): Promise<void> {
    const { testFiles } = await project.globTestFiles();
    if (!testFiles.some((file) => file.replaceAll("\\", "/").includes("/test/e2e/"))) {
        return;
    }

    const serverPath = join(project.tmpDir, "capi-proxy", "server.mjs");
    const buildBundle = async () => {
        await build({
            entryPoints: [
                fileURLToPath(new URL("../../../../test/harness/server.ts", import.meta.url)),
            ],
            outfile: serverPath,
            bundle: true,
            platform: "node",
            format: "esm",
            target: "node20",
            // Bundled CommonJS dependencies still require Node built-ins dynamically.
            banner: {
                js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
            },
        });
    };

    await buildBundle();
    project.provide(CAPI_PROXY_BUNDLE, serverPath);
    project.onTestsRerun(buildBundle);
}
