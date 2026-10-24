import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "codex-reset-build-"));

try {
  // Never read production config or credentials for a build-only check.
  const config = JSON.parse(await readFile(join(project, "wrangler.example.jsonc"), "utf8"));
  delete config.$schema;
  config.main = join(project, "src/index.js");
  config.kv_namespaces[0].id = "00000000000000000000000000000000";
  const configPath = join(temporary, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config));
  const result = spawnSync(process.execPath, [
    join(project, "node_modules/wrangler/bin/wrangler.js"),
    "deploy", "--dry-run", "--config", configPath,
    "--outdir", join(temporary, "dist"),
  ], {
    cwd: temporary,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
