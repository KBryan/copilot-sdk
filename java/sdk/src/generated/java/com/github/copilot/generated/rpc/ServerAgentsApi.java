/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from: api.schema.json

package com.github.copilot.generated.rpc;

import com.github.copilot.CopilotExperimental;
import java.util.concurrent.CompletableFuture;
import javax.annotation.processing.Generated;

/**
 * API methods for the {@code agents} namespace.
 *
 * @since 1.0.0
 */
@javax.annotation.processing.Generated("copilot-sdk-codegen")
public final class ServerAgentsApi {

    private final RpcCaller caller;

    /** @param caller the RPC transport function */
    ServerAgentsApi(RpcCaller caller) {
        this.caller = caller;
    }

    /**
     * Discovers custom agents across user, project, plugin, and remote sources.
     *
     * @apiNote This method is experimental and may change in a future version.
     * @since 1.0.0
     */
    @CopilotExperimental
    public CompletableFuture<AgentsDiscoverResult> discover(AgentsDiscoverParams params) {
        return caller.invoke("agents.discover", params, AgentsDiscoverResult.class);
    }

    /**
     * Returns the canonical directories where a client may create custom agents that the runtime will recognize, including ones that do not exist yet. Project directories become active once created.
     *
     * @apiNote This method is experimental and may change in a future version.
     * @since 1.0.0
     */
    @CopilotExperimental
    public CompletableFuture<AgentsGetDiscoveryPathsResult> getDiscoveryPaths(AgentsGetDiscoveryPathsParams params) {
        return caller.invoke("agents.getDiscoveryPaths", params, AgentsGetDiscoveryPathsResult.class);
    }

}
