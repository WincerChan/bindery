import { createStartHandler, defaultStreamHandler, type RequestHandler } from "@tanstack/solid-start/server";
import type { Register } from "@tanstack/solid-router";
import { handleAuthRequest } from "./server/auth-http";
import { getLibrary } from "./server/runtime";
import { startJobWorker } from "./server/ingest/lifecycle";
const start = createStartHandler(defaultStreamHandler);
const fetch: RequestHandler<Register> = async (request, options) => {
  const library = getLibrary();
  startJobWorker(library);
  const response = (await handleAuthRequest(request, library.db)) ?? (await start(request, options));
  // Authentication and private SSR/RPC responses must not be shared or retained.
  if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "no-store");
  return response;
};
export default {
  fetch
};
