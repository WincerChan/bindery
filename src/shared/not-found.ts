import { notFound } from "@tanstack/solid-router";

/** HTTP/RPC errors must become router notFound at the loader boundary. */
export async function loadOrNotFound<T>(load: () => T | Promise<T>): Promise<T> {
  try { return await load(); }
  catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 404) {
      const detail = "detail" in error && typeof error.detail === "string" ? error.detail : error instanceof Error ? error.message : "资源不存在";
      throw notFound({ data: detail });
    }
    throw error;
  }
}
