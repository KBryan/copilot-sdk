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
 * API methods for the {@code user.settings} namespace.
 *
 * @since 1.0.0
 */
@javax.annotation.processing.Generated("copilot-sdk-codegen")
public final class ServerUserSettingsApi {

    private final RpcCaller caller;

    /** @param caller the RPC transport function */
    ServerUserSettingsApi(RpcCaller caller) {
        this.caller = caller;
    }

    /**
     * Lists every known user setting from settings.json, each with its effective value, its default, and whether it is at the default — so settings the user has never set still appear with their default value. Does not include repository- or enterprise-managed overrides that the runtime layers on top at session time.
     *
     * @apiNote This method is experimental and may change in a future version.
     * @since 1.0.0
     */
    @CopilotExperimental
    public CompletableFuture<UserSettingsGetResult> get() {
        return caller.invoke("user.settings.get", java.util.Map.of(), UserSettingsGetResult.class);
    }

    /**
     * Writes one or more user settings to settings.json, replacing each provided top-level key. A key whose value is null is removed.
     *
     * @apiNote This method is experimental and may change in a future version.
     * @since 1.0.0
     */
    @CopilotExperimental
    public CompletableFuture<Void> set(UserSettingsSetParams params) {
        return caller.invoke("user.settings.set", params, Void.class);
    }

}
