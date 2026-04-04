#!/usr/bin/env node
/**
 * inspect-memories.cjs
 *
 * Prints all memory rows from the SQLite index and shows the raw on-disk
 * content for each (encrypted payload visible for personal memories).
 *
 * Usage (run from repo root):
 *   node scripts/inspect-memories.cjs [options]
 *
 * Options:
 *   --db  <path>   Path to the memories SQLite database  (default: data/memories.sqlite)
 *   --dir <path>   Directory containing the memory .md files (default: memories)
 *   --personal     Show only personal (is_personal = 1) memories
 *   --help         Print this help message and exit
 */
"use strict";

const { createRequire } = require("module");
const { resolve, join } = require("path");
const { readFileSync, existsSync } = require("fs");

// Resolve better-sqlite3 from the package that depends on it.
const toolMemoryRequire = createRequire(
  resolve(__dirname, "../packages/tool-memory/package.json"),
);
const Database = toolMemoryRequire("better-sqlite3");

// ---------------------------------------------------------------------------
// Argument parsing (no external deps)
// ---------------------------------------------------------------------------
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

const dbPath  = resolve(opt("db",  "data/memories.sqlite"));
const dirPath = resolve(opt("dir", "memories"));
const onlyPersonal = flag("personal");

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------
const db = new Database(dbPath, { readonly: true });

const rows = onlyPersonal
  ? db.prepare("SELECT * FROM memories WHERE is_personal = 1 ORDER BY updated_at DESC").all()
  : db.prepare("SELECT * FROM memories ORDER BY is_personal DESC, updated_at DESC").all();

db.close();

if (rows.length === 0) {
  console.log("No memories found.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const RED    = "\x1b[31m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";

for (const row of rows) {
  const isPersonal = row.is_personal === 1;
  const label = isPersonal ? `${RED}[PERSONAL]${RESET}` : `${DIM}[standard]${RESET}`;

  console.log();
  console.log(`${BOLD}${CYAN}${row.title}${RESET}  ${label}`);
  console.log(`  id:            ${row.id}`);
  console.log(`  slug:          ${row.slug}`);
  console.log(`  scope:         ${row.scope}`);
  console.log(`  retention:     ${row.retention_tier}`);
  console.log(`  status:        ${row.status}`);
  console.log(`  storage_path:  ${row.storage_path}`);
  console.log(`  content_hash:  ${row.content_hash}`);
  console.log(`  updated_at:    ${row.updated_at}`);

  // Resolve the file — storage_path may be relative or absolute.
  let filePath = existsSync(row.storage_path)
    ? row.storage_path
    : join(dirPath, row.storage_path.replace(/^memories[/\\]/, ""));

  if (!existsSync(filePath)) {
    console.log(`  ${YELLOW}⚠ File not found: ${filePath}${RESET}`);
    continue;
  }

  const fileContent = readFileSync(filePath, "utf8");

  // Split on "---" separators to isolate the body after the frontmatter.
  // File format:  ---\n<frontmatter>\n---\n<body>
  const parts = fileContent.split(/^---\s*$/m);
  // parts: ["", "<frontmatter>", "<body>", ...]
  const body = parts.slice(2).join("---").trim();

  if (!body) {
    console.log(`  ${DIM}(empty body)${RESET}`);
    continue;
  }

  if (isPersonal) {
    if (body.startsWith("glove-personal-v1:")) {
      const b64 = body.slice("glove-personal-v1:".length);
      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
      } catch {
        decoded = null;
      }
      console.log(`  ${BOLD}${RED}ENCRYPTED CONTENT${RESET}`);
      if (decoded && typeof decoded === "object") {
        const ct = String(decoded.ciphertext ?? "");
        console.log(`    algo:       AES-256-GCM`);
        console.log(`    salt:       ${decoded.salt ?? "?"}`);
        console.log(`    iv:         ${decoded.iv ?? "?"}`);
        console.log(`    auth tag:   ${decoded.tag ?? "?"}`);
        console.log(`    ciphertext: ${ct.slice(0, 64)}${ct.length > 64 ? "…" : ""}`);
        console.log(`                (${ct.length} base64url chars ≈ ${Math.round(ct.length * 3 / 4)} bytes ciphertext)`);
      } else {
        console.log(`    raw: ${body.slice(0, 120)}`);
      }
    } else {
      // Flagged personal but content was not encrypted (e.g. saved before encryption was enabled)
      console.log(`  ${YELLOW}⚠ Personal flag set but content is NOT encrypted:${RESET}`);
      const preview = body.length > 200 ? body.slice(0, 200) + "…" : body;
      for (const line of preview.split("\n")) {
        console.log(`    ${line}`);
      }
    }
  } else {
    const preview = body.length > 300 ? body.slice(0, 300) + "…" : body;
    console.log(`  ${GREEN}content:${RESET}`);
    for (const line of preview.split("\n")) {
      console.log(`    ${line}`);
    }
  }
}

console.log();
