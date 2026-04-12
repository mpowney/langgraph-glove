#!/usr/bin/env node

/**
 * backup-workspace.mjs
 *
 * Create a compressed archive containing the config, data, memories, and
 * secrets directories. By default, the standard repo directories are used.
 * Each location can be overridden with command-line options.
 *
 * Usage:
 *   node scripts/backup-workspace.mjs [options]
 *
 * Options:
 *   --config-dir <path>    Config directory    (default: ./config)
 *   --data-dir <path>      Data directory      (default: ./data)
 *   --memories-dir <path>  Memories directory  (default: ./memories)
 *   --secrets-dir <path>   Secrets directory   (default: ./secrets)
 *   --output <path>        Output archive path (default: ./langgraph-glove-backup-YYYYMMDD-HHMMSS.tgz)
 *   --help                 Print this help message and exit
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function timestampLabel(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") + "-" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}

const directoryMap = {
  config: resolve(repoRoot, opt("config-dir", "config")),
  data: resolve(repoRoot, opt("data-dir", "data")),
  memories: resolve(repoRoot, opt("memories-dir", "memories")),
  secrets: resolve(repoRoot, opt("secrets-dir", "secrets")),
};

for (const [name, dirPath] of Object.entries(directoryMap)) {
  if (!existsSync(dirPath)) {
    console.error(`${name} directory not found: ${dirPath}`);
    process.exit(1);
  }
}

const defaultOutput = resolve(repoRoot, `langgraph-glove-backup-${timestampLabel(new Date())}.tgz`);
const outputPath = resolve(repoRoot, opt("output", defaultOutput));

const stagingRoot = mkdtempSync(resolve(tmpdir(), "langgraph-glove-backup-"));

try {
  const payloadRoot = resolve(stagingRoot, "payload");
  mkdirSync(payloadRoot, { recursive: true });

  for (const [name, dirPath] of Object.entries(directoryMap)) {
    cpSync(dirPath, resolve(payloadRoot, name), {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: false,
      force: true,
    });
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    archiveType: "langgraph-glove-backup",
    contents: Object.keys(directoryMap),
  };

  writeFileSync(resolve(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(dirname(outputPath), { recursive: true });

  const tarResult = spawnSync("tar", ["-czf", outputPath, "-C", stagingRoot, "manifest.json", "payload"], {
    stdio: "inherit",
  });

  if (tarResult.status !== 0) {
    process.exit(tarResult.status ?? 1);
  }

  console.log(`Created backup archive: ${outputPath}`);
  for (const [name, dirPath] of Object.entries(directoryMap)) {
    console.log(`  ${name}: ${dirPath}`);
  }
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}