#!/usr/bin/env node
/**
 * fix-memory-storage-paths.cjs
 *
 * Rewrites legacy absolute memories.storage_path values in SQLite to paths
 * relative to the configured memories directory.
 *
 * Usage (run from repo root):
 *   node scripts/fix-memory-storage-paths.cjs --from <old-memories-dir> [options]
 *
 * Required:
 *   --from <path>   Original absolute memories directory used before the fix.
 *
 * Options:
 *   --db  <path>    Path to memories SQLite DB (default: from config/memories.json)
 *   --dir <path>    Current memories directory (default: from config/memories.json)
 *   --dry-run       Show updates without writing to DB
 *   --help          Print this help message and exit
 */
"use strict";

const { createRequire } = require("module");
const { resolve, relative, isAbsolute, normalize, sep } = require("path");
const { existsSync, readFileSync } = require("fs");

const toolMemoryRequire = createRequire(
  resolve(__dirname, "../packages/tool-memory/package.json"),
);
const Database = toolMemoryRequire("better-sqlite3");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
};

if (flag("help")) {
  const src = readFileSync(__filename, "utf8");
  const block = src.match(/\/\*\*[\s\S]*?\*\//)?.[0] ?? "";
  console.log(block.replace(/^\/\*\*|\*\/$/g, "").replace(/^ \* ?/gm, "").trim());
  process.exit(0);
}

const repoRoot = resolve(__dirname, "..");
const configPath = resolve(repoRoot, "config/memories.json");

if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(`Failed to parse config/memories.json: ${error.message}`);
  process.exit(1);
}

const defaults = config.default ?? {};
const configuredDbPath = resolve(repoRoot, defaults.indexDbPath ?? "data/memories.sqlite");
const configuredDirPath = resolve(repoRoot, defaults.storageDir ?? "memories");

const fromArg = opt("from", "");
if (!fromArg) {
  console.error("Missing required argument: --from <old-memories-dir>");
  process.exit(1);
}

const dbPath = resolve(opt("db", configuredDbPath));
const currentDirPath = resolve(opt("dir", configuredDirPath));
const oldDirPath = resolve(fromArg);
const dryRun = flag("dry-run");

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const oldDirPrefix = normalize(oldDirPath.endsWith(sep) ? oldDirPath : `${oldDirPath}${sep}`);

const db = new Database(dbPath);

try {
  const rows = db.prepare("SELECT id, storage_path FROM memories ORDER BY id").all();

  const updates = [];

  for (const row of rows) {
    const storagePath = String(row.storage_path ?? "").trim();
    if (!storagePath || !isAbsolute(storagePath)) {
      continue;
    }

    const normalizedStoragePath = normalize(storagePath);
    const isUnderOldDir = normalizedStoragePath === normalize(oldDirPath)
      || normalizedStoragePath.startsWith(oldDirPrefix);

    if (!isUnderOldDir) {
      continue;
    }

    const relativePath = relative(oldDirPath, normalizedStoragePath);

    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      continue;
    }

    updates.push({
      id: row.id,
      before: storagePath,
      after: relativePath,
      currentResolvedPath: resolve(currentDirPath, relativePath),
    });
  }

  if (updates.length === 0) {
    console.log("No rows required updates.");
    process.exit(0);
  }

  console.log(`Matched rows: ${updates.length}`);
  for (const update of updates) {
    console.log(`- ${update.id}`);
    console.log(`  before: ${update.before}`);
    console.log(`  after:  ${update.after}`);
  }

  if (dryRun) {
    console.log("Dry run complete. No changes were written.");
    process.exit(0);
  }

  const tx = db.transaction(() => {
    const stmt = db.prepare("UPDATE memories SET storage_path = ? WHERE id = ?");
    for (const update of updates) {
      stmt.run(update.after, update.id);
    }
  });

  tx();
  console.log(`Updated ${updates.length} rows in ${dbPath}`);
} finally {
  db.close();
}
