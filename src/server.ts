import { createStartHandler, defaultStreamHandler, type RequestHandler } from "@tanstack/solid-start/server";
import type { Register } from "@tanstack/solid-router";
import { handleAuthRequest } from "./server/auth-http";
import { getLibrary } from "./server/runtime";
const start = createStartHandler(defaultStreamHandler);
const fetch: RequestHandler<Register> = async (request, options) => {
  const response = (await handleAuthRequest(request, getLibrary().db)) ?? (await start(request, options));
  // Authentication and private SSR/RPC responses must not be shared or retained.
  response.headers.set("Cache-Control", "no-store");
  return response;
};
export default {
  fetch
};
