/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as aiData from "../aiData.js";
import type * as chat from "../chat.js";
import type * as chatData from "../chatData.js";
import type * as importExport from "../importExport.js";
import type * as importExportData from "../importExportData.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_workspace from "../lib/workspace.js";
import type * as migration from "../migration.js";
import type * as migrationData from "../migrationData.js";
import type * as workspace from "../workspace.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  aiData: typeof aiData;
  chat: typeof chat;
  chatData: typeof chatData;
  importExport: typeof importExport;
  importExportData: typeof importExportData;
  "lib/auth": typeof lib_auth;
  "lib/validators": typeof lib_validators;
  "lib/workspace": typeof lib_workspace;
  migration: typeof migration;
  migrationData: typeof migrationData;
  workspace: typeof workspace;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
