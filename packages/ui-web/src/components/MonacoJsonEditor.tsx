/**
 * MonacoJsonEditor — a Monaco-backed JSON editor that supports:
 *   - Full JSON syntax highlighting (via Monaco's built-in json language)
 *   - Custom error/warning markers (red/yellow squiggles) driven by
 *     ConfigValidationIssue objects, including cross-reference checks
 *     such as "modelKey not found in models.json".
 *
 * Worker setup uses Vite's `?worker` suffix so workers are bundled
 * locally rather than loaded from a CDN.
 */

import React, { useEffect, useRef, useCallback } from "react";
import MonacoEditor, { loader, type OnMount } from "@monaco-editor/react";
import * as monacoLib from "monaco-editor";
import type { ConfigValidationIssue } from "../types";

// --------------------------------------------------------------------------
// Monaco worker setup (Vite approach — must run before any editor mounts)
// --------------------------------------------------------------------------
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

// Configure global worker factory once
if (typeof window !== "undefined" && !(window as typeof window & { _monacoWorkersConfigured?: boolean })._monacoWorkersConfigured) {
  (window as typeof window & { _monacoWorkersConfigured?: boolean })._monacoWorkersConfigured = true;
  (self as typeof self & { MonacoEnvironment: { getWorker: (id: string, label: string) => Worker } }).MonacoEnvironment = {
    getWorker(_id: string, label: string): Worker {
      if (label === "json") return new jsonWorker();
      return new editorWorker();
    },
  };
  // Tell @monaco-editor/react to use the locally installed monaco-editor
  // package instead of loading it from a CDN.
  loader.config({ monaco: monacoLib });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Convert a dot-path like "agentKey.modelKey" to the position of the
 * corresponding VALUE in the raw JSON text, so we can place a squiggle
 * on the exact token rather than on line 1.
 *
 * The algorithm is intentionally simple and text-based (not a full JSON
 * parser), which is good enough for the two-level config structures we
 * work with (agents.json, models.json, etc.).
 */
function findValuePosition(
  text: string,
  dotPath: string,
): monacoLib.IRange | null {
  const parts = dotPath.split(".");
  const lines = text.split("\n");

  if (parts.length === 1) {
    const key = parts[0];
    if (!key) return null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const keyIdx = line.indexOf(`"${key}"`);
      if (keyIdx < 0) continue;
      const colonIdx = line.indexOf(":", keyIdx + key.length + 2);
      if (colonIdx < 0) continue;
      const valStart = line.indexOf('"', colonIdx + 1);
      if (valStart < 0) continue;
      const valEnd = line.indexOf('"', valStart + 1);
      if (valEnd < 0) continue;
      return {
        startLineNumber: i + 1,
        startColumn: valStart + 2,
        endLineNumber: i + 1,
        endColumn: valEnd + 1,
      };
    }
    return null;
  }

  if (parts.length < 2) return null;

  // Two-level path: find parent key first, then child key
  const parentKey = parts[0];
  const childKey = parts[1];
  if (!parentKey || !childKey) return null;

  let parentLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.includes(`"${parentKey}"`)) {
      parentLine = i;
      break;
    }
  }
  if (parentLine < 0) return null;

  // Search for child key within the next ~50 lines (covers any realistic JSON block)
  const searchEnd = Math.min(lines.length, parentLine + 50);
  for (let i = parentLine + 1; i < searchEnd; i++) {
    const line = lines[i];
    if (!line) continue;
    const keyIdx = line.indexOf(`"${childKey}"`);
    if (keyIdx < 0) continue;
    const colonIdx = line.indexOf(":", keyIdx + childKey.length + 2);
    if (colonIdx < 0) continue;
    const valStart = line.indexOf('"', colonIdx + 1);
    if (valStart < 0) continue;
    const valEnd = line.indexOf('"', valStart + 1);
    if (valEnd < 0) continue;
    return {
      startLineNumber: i + 1,
      startColumn: valStart + 2,
      endLineNumber: i + 1,
      endColumn: valEnd + 1,
    };
  }
  return null;
}

/**
 * Convert our ConfigValidationIssue list into Monaco IMarkerData objects.
 * JSON syntax errors are already surfaced by Monaco's built-in JSON
 * language service, so we skip them here to avoid duplication.
 */
function issuesToMarkers(
  issues: ConfigValidationIssue[],
  text: string,
  monaco: typeof monacoLib,
): monacoLib.editor.IMarkerData[] {
  return issues
    .filter((issue) => issue.path !== "(root)")  // (root) = JSON parse error, already shown by Monaco
    .map((issue) => {
      const range = findValuePosition(text, issue.path) ?? {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      };
      return {
        ...range,
        message: issue.message,
        severity:
          issue.severity === "error"
            ? monaco.MarkerSeverity.Error
            : monaco.MarkerSeverity.Warning,
        source: "config-validator",
      };
    });
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

interface MonacoJsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  validationIssues: ConfigValidationIssue[];
  /** Used as the aria-label and Monaco model URI. */
  filename?: string;
  /** Prefer dark theme. Defaults to honouring prefers-color-scheme. */
  dark?: boolean;
}

export function MonacoJsonEditor({
  value,
  onChange,
  validationIssues,
  filename = "config.json",
  dark,
}: MonacoJsonEditorProps) {
  const editorRef = useRef<monacoLib.editor.IStandaloneCodeEditor | null>(null);

  const prefersDark =
    dark ??
    (typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  const handleMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor;
    },
    [],
  );

  // Apply custom markers whenever validation issues change
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    const markers = issuesToMarkers(validationIssues, value, monacoLib);
    monacoLib.editor.setModelMarkers(model, "config-validator", markers);

    return () => {
      monacoLib.editor.setModelMarkers(model, "config-validator", []);
    };
  }, [validationIssues, value]);

  return (
    <MonacoEditor
      height="100%"
      language="json"
      value={value}
      theme={prefersDark ? "vs-dark" : "vs"}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        wordWrap: "off",
        automaticLayout: true,
        tabSize: 2,
        formatOnPaste: false,
        quickSuggestions: false,
        folding: true,
        scrollbar: {
          verticalScrollbarSize: 10,
          horizontalScrollbarSize: 10,
        },
      }}
      aria-label={`JSON editor for ${filename}`}
    />
  );
}
