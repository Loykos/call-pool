import { expectTypeOf } from "vitest";
import { CallPool, type CallPoolResponse, type RequestOptions } from "../../src/index.js";

// Compile-only assertions: Vitest's runtime transform does not check overloads.
declare const pool: CallPool;
interface User { id: number }
declare const options: RequestOptions;
declare const optionalOptions: RequestOptions | undefined;
declare const response: "body" | "raw";

expectTypeOf(pool.request<User>("/user")).toEqualTypeOf<Promise<User>>();
expectTypeOf(pool.request<User>("/user", undefined)).toEqualTypeOf<Promise<User>>();
expectTypeOf(pool.request<User>("/user", {})).toEqualTypeOf<Promise<User>>();
expectTypeOf(pool.request<User>("/user", { response: "body" })).toEqualTypeOf<Promise<User>>();
expectTypeOf(pool.request<User>("/user", { response: "raw" })).toEqualTypeOf<Promise<CallPoolResponse<User>>>();
expectTypeOf(pool.request<User>("/user", options)).toEqualTypeOf<Promise<User | CallPoolResponse<User>>>();
expectTypeOf(pool.request<User>("/user", optionalOptions)).toEqualTypeOf<Promise<User | CallPoolResponse<User>>>();
expectTypeOf(pool.request<User>("/user", { response })).toEqualTypeOf<Promise<User | CallPoolResponse<User>>>();
expectTypeOf(pool.request("/user")).toEqualTypeOf<Promise<unknown>>();
expectTypeOf(pool.request("/user", { response: "raw" })).toEqualTypeOf<Promise<CallPoolResponse<unknown>>>();
expectTypeOf(pool.request<Buffer>("/file", { binary: true })).toEqualTypeOf<Promise<Buffer>>();
expectTypeOf(pool.request<void>("/empty")).toEqualTypeOf<Promise<void>>();

// A general overload must not accidentally permit invalid request options.
// @ts-expect-error Unsupported response mode
pool.request("/user", { response: "stream" });
// @ts-expect-error The transport's error policy must remain inaccessible
pool.request("/user", { throwOnError: true });
