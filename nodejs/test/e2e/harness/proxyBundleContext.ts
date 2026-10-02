/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

export const CAPI_PROXY_BUNDLE = "capiProxyBundle";

declare module "vitest" {
    export interface ProvidedContext {
        capiProxyBundle: string;
    }
}
