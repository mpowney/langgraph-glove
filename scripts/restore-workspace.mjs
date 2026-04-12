#!/usr/bin/env node

/**
 * restore-workspace.mjs
 *
 * Restore a compressed backup created by backup-workspace.mjs into the config,
 * data, memories, and secrets directories. By default, the standard repo
 * directories are used. Each destination can be overridden with command-line
 * options.
 *
 * Usage:
 *   node scripts/restore-workspace.mjs --archive <path> [options]
 *
 * Options:
 *   --archive <path>       Backup archive to restore
 *   --config-dir <path>    Config directory    (default: ./config)
 *   --data-dir <path>      Data directory      (default: ./data)
 *   --memories-dir <path>  Memories directory  (default: ./memories)
 *   --secrets-dir <path>   Secrets directory   (default: ./secrets)
 *   --clean                Remove destination directories before restore
 *   --help                 Print this help message and exit
 *
 * Notes:
 *   Existing files with the same paths are overwritten.
 *   Unrelated files already present in the destination directories are kept
 *   unless --clean is used.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(`--${name}`);
}

function opt(name, defaultValue) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return defaultValue;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`Missing value for --${name}`);
    process.exit(1);
  }

  return value;
}

if (flag("help")) {
  const src = readFileSync(__filename, "utf8");
  const block = src.match(/\/\*\*[\s\S]*?\*\//)?.[0] ?? "";
  console.log(block.replace(/^\/\*\*|\*\/$/g, "").replace(/^ \* ?/gm, "").trim());
  process.exit(0);
}

const archivePath = opt("archive", null);
if (!archivePath) {
  console.error("Missing required --archive <path>");
  process.exit(1);
}

const resolvedArchivePath = resolve(repoRoot, archivePath);
if (!existsSync(resolvedArchivePath)) {
  console.error(`Archive not found: ${resolvedArchivePath}`);
  process.exit(1);
}

const directoryMap = {
  config: resolve(repoRoot, opt("config-dir", "config")),
  data: resolve(repoRoot, opt("data-dir", "data")),
  memories: resolve(repoRoot, opt("memories-dir", "memories")),
  secrets: resolve(repoRoot, opt("secrets-dir", "secrets")),
};
const cleanRestore = flag("clean");

const extractRoot = mkdtempSync(resolve(tmpdir(), "langgraph-glove-restore-"));

try {
  const tarResult = spawnSync("tar", ["-xzf", resolvedArchivePath, "-C", extractRoot], {
    stdio: "inherit",
  });

  if (tarResult.status !== 0) {
    process.exit(tarResult.status ?? 1);
  }

  const manifestPath = resolve(extractRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error("Backup archive is missing manifest.json");
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.archiveType !== "langgraph-glove-backup" || manifest.version !== 1) {
    console.error("Unsupported backup archive format");
    process.exit(1);
  }

  const payloadRoot = resolve(extractRoot, "payload");

  for (const [name, targetDir] of Object.entries(directoryMap)) {
    const sourceDir = resolve(payloadRoot, name);
    if (!existsSync(sourceDir)) {
      console.error(`Backup archive is missing payload/${name}`);
      process.exit(1);
    }

    if (cleanRestore && existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }

    mkdirSync(targetDir, { recursive: true });
    cpSync(sourceDir, targetDir, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: false,
      force: true,
    });
  }

  console.log(`Restored backup archive: ${resolvedArchivePath}`);
  for (const [name, dirPath] of Object.entries(directoryMap)) {
    console.log(`  ${name}: ${dirPath}`);
  }
} finally {
  rmSync(extractRoot, { recursive: true, force: true });
}