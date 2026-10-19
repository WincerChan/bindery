import { readFileSync } from "node:fs";
export function readEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env[name]) return env[name];
  const file = env[`${name}_FILE`];
  if (!file) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(readFileSync(file))
      .replace(/[\r\n]+$/, "");
  } catch (error) {
    if (error instanceof Error && "code" in error) return undefined;
    throw error;
  }
}
