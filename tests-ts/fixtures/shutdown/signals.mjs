import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { installShutdownHandlers } from "../../../scripts/start.mjs";
import { createProductionHandler } from "../../../scripts/production-handler.mjs";
const [root, mode, signal = "SIGTERM"] = process.argv.slice(2);
for (const name of ["BINDERY_DB_PATH", "BINDERY_LIBRARY_DIR", "BINDERY_TEMPLATE_DIR", "BINDERY_RULES_DIR", "BINDERY_THEMES_DIR", "BINDERY_PASSWORD_HASH"]) {
  process.env[name] = ""; process.env[name + "_FILE"] = "";
}
process.env.BINDERY_DB_PATH = join(root, "data.db");
process.env.BINDERY_LIBRARY_DIR = join(root, "library");
process.env.BINDERY_TEMPLATE_DIR = join(root, "templates");
const handler = await createProductionHandler();
await (await handler(new Request("http://localhost/login/data"))).arrayBuffer();
const record = value => appendFileSync(join(root, "events.txt"), value + "\n");
installShutdownHandlers({
  async close(force) {
    record(force ? "force" : "close");
    if (mode === "timeout-http" && !force) await new Promise(() => {});
    await setTimeout(50);
  },
}, {
  async shutdown(options) {
    record("runtime");
    await handler.shutdown(options);
    await handler.shutdown(options);
    if (mode === "shutdown-error") throw new Error("Fixture shutdown failure");
    record("closed");
  },
}, { timeoutMs: mode === "timeout-http" ? 150 : 5000 });
setInterval(() => {}, 1000);
process.kill(process.pid, signal);
if (mode === "normal") setTimeout(10).then(() => process.kill(process.pid, signal === "SIGTERM" ? "SIGINT" : "SIGTERM"));
