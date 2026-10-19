import { existsSync } from "node:fs";

// Load .env from the working directory when present; real environment variables win.
if (existsSync(".env")) process.loadEnvFile(".env");
