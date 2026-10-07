/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** Known values of an open string contract; this annotation does not constrain the wire schema. */
export function extensibleEnumValues(schema: object): string[] | undefined {
    const values = (schema as Record<string, unknown>)["x-extensible-enum"];
    if (values === undefined) return undefined;
    if ((schema as Record<string, unknown>).type !== "string" ||
        !Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === "string")) {
        throw new Error("x-extensible-enum requires a string schema with known string values");
    }
    return values;
}

/** Supply known enum values to generators without rewriting other schema constraints. */
export function normalizeExtensibleEnums<T>(schema: T): T {
    if (Array.isArray(schema)) {
        for (const item of schema) normalizeExtensibleEnums(item);
    } else if (schema !== null && typeof schema === "object") {
        const knownValues = extensibleEnumValues(schema);
        if (knownValues) (schema as Record<string, unknown>).enum = knownValues;
        for (const value of Object.values(schema)) normalizeExtensibleEnums(value);
    }
    return schema;
}
