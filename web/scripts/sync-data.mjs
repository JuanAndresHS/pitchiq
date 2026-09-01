/**
 * Copies the data produced by the Python pipeline into the Next.js app.
 *
 * Vercel builds from a root directory, and anything above it is not bundled
 * into the deployment. Since the pipeline writes to ../data, that content has
 * to be pulled inside web/ before the build runs. Wiring this as a `prebuild`
 * script means it happens automatically both locally and on Vercel.
 */

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const repoRoot = resolve(webRoot, "..");

const sources = [
  { from: join(repoRoot, "data", "processed"), to: join(webRoot, "data", "processed") },
  { from: join(repoRoot, "data", "predictions"), to: join(webRoot, "data", "predictions") },
];

for (const { from, to } of sources) {
  if (!existsSync(from)) {
    console.warn(`[sync-data] missing: ${from} — skipped`);
    continue;
  }

  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });

  // Predictions live in per-league subdirectories, so a flat readdir would
  // report zero even when the copy succeeded.
  const entries = await readdir(to, { withFileTypes: true, recursive: true });
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".csv"));
  console.log(`[sync-data] ${files.length} file(s) → ${to.replace(webRoot, "web")}`);
}
