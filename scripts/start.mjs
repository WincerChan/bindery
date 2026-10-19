import "./load-env.mjs";
import { serve } from "srvx";
import { createProductionHandler } from "./production-handler.mjs";
serve({
  fetch: await createProductionHandler(),
  port: Number(process.env.PORT || 3000),
  hostname: process.env.HOST || "0.0.0.0",
});
