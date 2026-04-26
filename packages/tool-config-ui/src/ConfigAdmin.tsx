import React, { lazy, Suspense, useCallback, useEffect, useState, useMemo, useRef } from "react";
import {
  makeStyles,
  mergeClasses,
  tokens,
  Text,
  Button,
  Spinner,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  Divider,
  Tab,
  TabList,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";

import { SystemPromptDialog } from "./SystemPromptDialog.js";
import { ConfigItemNav } from "./config/ConfigItemNav.js";
import { SecretsPanel } from "./config/SecretsPanel.js";
import { DependentsPanel } from "./config/DependentsPanel.js";
import { FriendlyEntryEditor } from "./config/FriendlyEntryEditor.js";
import { HistoryDialog } from "./config/HistoryDialog.js";
import { AddItemDialog } from "./config/AddItemDialog.js";
import { computeDependents, extractSecretRefs } from "./config/configUtils.js";

// Monaco editor is large — lazy-load it so it doesn't bloat the initial bundle
const MonacoJsonEditor = lazy(() =>
  import("./MonacoJsonEditor").then((m) => ({ default: m.MonacoJsonEditor })),
);
import {
  Dismiss24Regular,
  DocumentEdit24Regular,
  History24Regular,
  CheckmarkCircle24Regular,
  Save24Regular,
  ArrowReset24Regular,
  ChevronRight24Regular,
  ErrorCircle24Regular,
  TextWrap24Regular,
  TextWrapOff24Regular,
  BotSparkle24Regular,
  KeyMultiple24Regular,
} from "@fluentui/react-icons";
import type {
  ConfigFileSummary,
  ConfigValidationIssue,
} from "./types.js";
import { useConfigAdmin } from "./useConfigAdmin.js";
import { useSecrets } from "./useSecrets.js";
import { PrivilegedAccessButton } from "@langgraph-glove/ui-shared";

const useStyles = makeStyles({
  drawerBody: {
    display: "flex",
    flexDirection: "row",
    gap: "0",
    padding: "0",
    overflow: "hidden",
    height: "100%",
  },
  fileBrowser: {
    width: "160px",
    flexShrink: 0,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  fileBrowserTitle: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    fontWeight: tokens.fontWeightSemibold,
    flexShrink: 0,
  },
  fileList: {
    flex: 1,
    overflowY: "auto",
  },
  fileItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    cursor: "pointer",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  fileItemSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    ":hover": {
      backgroundColor: tokens.colorBrandBackground2Hover,
    },
  },
  editorPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  editorToolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
    gap: tokens.spacingHorizontalS,
  },
  editorToolbarRight: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  editorContent: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "row",
  },
  editorMain: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  monacoWrapper: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  friendlyEditorScroll: {
    flex: 1,
    overflowY: "auto",
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
  },
  editorBottomBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
    gap: tokens.spacingHorizontalS,
  },
  editorBottomBarRight: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground3,
  },
  noPrivileged: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalXL,
    textAlign: "center",
  },
});

interface ConfigAdminProps {
  open: boolean;
  onClose: () => void;
  configToolUrl: string;
  /** Base URL of the Admin API (e.g. "" in dev, or the configured API URL in production). */
  adminApiUrl: string;
  privilegeGrantId: string;
  conversationId: string;
  authToken?: string;
  /** Admin RPC handler to restart the core service */
  onRestartService?: () => Promise<void>;
  // Privileged access management (forwarded to PrivilegedAccessButton)
  privilegedAccessActive: boolean;
  privilegedAccessExpiresAt?: string;
  onEnablePrivilegedAccessWithToken: (token: string) => Promise<boolean>;
  onEnablePrivilegedAccessWithPasskey?: () => Promise<boolean>;
  onDisablePrivilegedAccess: () => void;
  privilegeTokenRegistered: boolean;
  onRegisterPrivilegeToken: (newToken: string, currentToken?: string) => Promise<boolean>;
  authError?: string | null;
  passkeyEnabled?: boolean;
}

type EditorTab = "raw" | "friendly";

// --------------------------------------------------------------------------
// Per-file editor prefs (tab + word-wrap) persisted in localStorage
// --------------------------------------------------------------------------
interface FileEditorPrefs {
  tab: EditorTab;
  wordWrap: boolean;
}

function getFilePrefs(filename: string): FileEditorPrefs {
  try {
    const raw = localStorage.getItem(`configAdmin:prefs:${filename}`);
    if (raw) return JSON.parse(raw) as FileEditorPrefs;
  } catch { /* ignore */ }
  return { tab: "raw", wordWrap: false };
}

function saveFilePrefs(filename: string, prefs: FileEditorPrefs): void {
  try {
    localStorage.setItem(`configAdmin:prefs:${filename}`, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function parseModelKeys(content?: string): string[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return Object.keys(parsed);
  } catch {
    return [];
  }
}

export function ConfigAdmin({
  open,
  onClose,
  configToolUrl,
  adminApiUrl,
  privilegeGrantId,
  conversationId,
  authToken,
  onRestartService,
  privilegedAccessActive,
  privilegedAccessExpiresAt,
  onEnablePrivilegedAccessWithToken,
  onEnablePrivilegedAccessWithPasskey,
  onDisablePrivilegedAccess,
  privilegeTokenRegistered,
  onRegisterPrivilegeToken,
  authError,
  passkeyEnabled,
}: ConfigAdminProps) {
  const styles = useStyles();

  const {
    filesState,
    readState,
    writeState,
    historyState,
    versionState,
    filesError,
    readError,
    writeError,
    historyError,
    versionError,
    files,
    selectedFile,
    fileContent,
    allConfigs,
    history,
    selectedVersion,
    loadFiles,
    loadFileContent,
    saveFileContent,
    loadHistory,
    loadVersion,
    validateContent,
    validateContentWithSchema,
    clearSelectedVersion,
  } = useConfigAdmin(configToolUrl, privilegeGrantId, conversationId, authToken);

  const {
    secretFilesState,
    secretsState,
    upsertState,
    secretFilesError,
    secretsError,
    upsertError,
    secretFiles,
    secrets,
    loadSecretFiles,
    loadSecrets,
    revealSecret,
    saveSecret,
  } = useSecrets(adminApiUrl, privilegeGrantId, conversationId, authToken);

  const [editorTab, setEditorTab] = useState<EditorTab>("raw");
  const [wordWrap, setWordWrap] = useState(false);
  const [draftContent, setDraftContent] = useState<string>("");
  const [isDirty, setIsDirty] = useState(false);
  const [validationIssues, setValidationIssues] = useState<ConfigValidationIssue[]>([]);
  const [showValidation, setShowValidation] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [checkDialogOpen, setCheckDialogOpen] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [systemPromptDialogOpen, setSystemPromptDialogOpen] = useState(false);
  const [editorRef, setEditorRef] = useState<any>(null);
  const [cursorOnSystemPrompt, setCursorOnSystemPrompt] = useState(false);
  const [dialogSystemPrompt, setDialogSystemPrompt] = useState("");
  const [dialogTargetAgentKey, setDialogTargetAgentKey] = useState<string | null>(null);

  // Secondary navigation — selected item key within the config file
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  // Secrets panel visibility
  const [showSecretsPanel, setShowSecretsPanel] = useState(false);
  // Add item dialog
  const [addItemDialogOpen, setAddItemDialogOpen] = useState(false);

  const hasPrivilege = Boolean(privilegeGrantId) && Boolean(conversationId);

  // Load files and secrets on open when privilege is available
  useEffect(() => {
    if (open && hasPrivilege) {
      void loadFiles();
      void loadSecrets();
      void loadSecretFiles();
    }
  }, [open, hasPrivilege, loadFiles, loadSecrets, loadSecretFiles]);

  // When a file is selected or fileContent changes, update draft
  useEffect(() => {
    setDraftContent(fileContent);
    setIsDirty(false);
    setValidationIssues([]);
    setShowValidation(false);
    setSaveNotice(null);
    // Reset cursor position state when switching files
    setCursorOnSystemPrompt(false);
    setDialogSystemPrompt("");
    setDialogTargetAgentKey(null);
    // Reset item selection when file changes
    setSelectedItemKey(null);
  }, [fileContent]);

  // Live validation — run with debounce on every draft change to keep Monaco
  // markers up-to-date without blocking keystrokes.
  const liveValidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!selectedFile) return;
    if (liveValidationTimerRef.current !== null) {
      clearTimeout(liveValidationTimerRef.current);
    }
    liveValidationTimerRef.current = setTimeout(() => {
      const issues = validateContent(selectedFile, draftContent);
      setValidationIssues(issues);
    }, 400);
    return () => {
      if (liveValidationTimerRef.current !== null) {
        clearTimeout(liveValidationTimerRef.current);
      }
    };
  }, [selectedFile, draftContent, validateContent]);

  const handleSelectFile = useCallback(
    (filename: string) => {
      if (isDirty) {
        // TODO: could add a confirmation dialog here — for now just navigate away
      }
      void loadFileContent(filename);
      const prefs = getFilePrefs(filename);
      setEditorTab(prefs.tab);
      setWordWrap(prefs.wordWrap);
    },
    [loadFileContent, isDirty],
  );

  // Friendly editor: parse the draft content and allow editing
  const parsedConfig = useMemo(() => {
    try {
      return JSON.parse(draftContent) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [draftContent]);

  // Navigate to a specific file and item key (used by DependentsPanel)
  const handleNavigateTo = useCallback(
    (filename: string, itemKey: string) => {
      if (selectedFile !== filename) {
        void loadFileContent(filename).then(() => {
          setSelectedItemKey(itemKey);
        });
        const prefs = getFilePrefs(filename);
        setEditorTab(prefs.tab);
        setWordWrap(prefs.wordWrap);
      } else {
        setSelectedItemKey(itemKey);
      }
    },
    [selectedFile, loadFileContent],
  );

  // Handle adding a new item key to the config
  const handleAddItem = useCallback(
    (key: string) => {
      if (!selectedFile || !parsedConfig) return;
      const updated = { ...parsedConfig, [key]: {} };
      const newContent = JSON.stringify(updated, null, 2);
      setDraftContent(newContent);
      setIsDirty(true);
      setSaveNotice(null);
      setSelectedItemKey(key);
    },
    [selectedFile, parsedConfig],
  );

  const handleEditorChange = useCallback((value: string) => {
    setDraftContent(value);
    setIsDirty(true);
    setSaveNotice(null);
  }, []);

  const handleSetEditorTab = useCallback((tab: EditorTab) => {
    setEditorTab(tab);
    if (selectedFile) saveFilePrefs(selectedFile, { tab, wordWrap });
  }, [selectedFile, wordWrap]);

  const handleToggleWordWrap = useCallback(() => {
    const newWrap = !wordWrap;
    setWordWrap(newWrap);
    if (selectedFile) saveFilePrefs(selectedFile, { tab: editorTab, wordWrap: newWrap });
  }, [selectedFile, editorTab, wordWrap]);

  const handleReloadFile = useCallback(async () => {
    if (!selectedFile || !isDirty) return;
    const latestContent = await loadFileContent(selectedFile);
    if (typeof latestContent === "string") {
      setDraftContent(latestContent);
      setIsDirty(false);
      setValidationIssues([]);
      setShowValidation(false);
      setSaveNotice(null);
    }
  }, [selectedFile, isDirty, loadFileContent]);

  const handleCheck = useCallback(async () => {
    if (!selectedFile) return;
    setIsChecking(true);
    try {
      // Validate against canonical backend Zod schema for this config file.
      const issues = await validateContentWithSchema(selectedFile, draftContent);
      setValidationIssues(issues);
    } catch (err) {
      setValidationIssues([
        {
          path: "(root)",
          message: `Validation request failed: ${err instanceof Error ? err.message : String(err)}`,
          severity: "error",
        },
      ]);
    } finally {
      setShowValidation(true);
      setCheckDialogOpen(true);
      setIsChecking(false);
    }
  }, [selectedFile, draftContent, validateContentWithSchema]);

  const handleSave = useCallback(async () => {
    if (!selectedFile) return;
    const ok = await saveFileContent(selectedFile, draftContent);
    if (ok) {
      setIsDirty(false);
      setSaveNotice(`Saved ${selectedFile} successfully.`);
    }
  }, [selectedFile, draftContent, saveFileContent]);

  const handleShowHistory = useCallback(async () => {
    if (!selectedFile) return;
    await loadHistory(selectedFile);
    setHistoryDialogOpen(true);
  }, [selectedFile, loadHistory]);

  const handleLoadVersion = useCallback(
    async (versionId: string) => {
      await loadVersion(versionId);
    },
    [loadVersion],
  );

  const handleRestoreVersion = useCallback(() => {
    if (!selectedVersion) return;
    setDraftContent(selectedVersion.content);
    setIsDirty(true);
    setHistoryDialogOpen(false);
    clearSelectedVersion();
  }, [selectedVersion, clearSelectedVersion]);

  const handleRestart = useCallback(async () => {
    if (!onRestartService) return;
    setIsRestarting(true);
    setRestartResult(null);
    try {
      await onRestartService();
      setRestartResult("Service restart initiated successfully.");
    } catch (err) {
      setRestartResult(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRestarting(false);
    }
  }, [onRestartService]);

  // System Prompt Dialog functions

  // Helper function to check if cursor is on a systemPrompt line
  const isOnSystemPromptLine = useCallback((model: any, position: any, agentBoundary: any) => {
    const currentLine = model.getLineContent(position.lineNumber);
    const trimmedLine = currentLine.trim();

    // Direct check: is the current line a systemPrompt key or value?
    if (trimmedLine.includes('"systemPrompt"') || trimmedLine.includes('systemPrompt')) {
      return true;
    }

    // For multi-line systemPrompt values, we need to find the systemPrompt field
    // and determine if the cursor is within its value range
    let systemPromptKeyLine = -1;
    let systemPromptValueStart = -1;
    let systemPromptValueEnd = -1;

    // Search within the agent boundary for the systemPrompt key
    for (let lineNum = agentBoundary.startLine; lineNum <= agentBoundary.endLine; lineNum++) {
      const line = model.getLineContent(lineNum);
      const trimmed = line.trim();

      // Found the systemPrompt key
      if (trimmed.includes('"systemPrompt"') && trimmed.includes(':')) {
        systemPromptKeyLine = lineNum;

        // Check if the value starts on the same line
        const colonIndex = line.indexOf(':');
        const afterColon = line.substring(colonIndex + 1).trim();

        if (afterColon.startsWith('"')) {
          // Value starts on this line
          systemPromptValueStart = lineNum;

          // Now find where the value ends
          let searchLine = lineNum;
          let inString = false;
          let escapeNext = false;

          // Start searching from after the opening quote
          const openQuoteIndex = line.indexOf('"', colonIndex);
          let startCol = openQuoteIndex + 1;

          while (searchLine <= agentBoundary.endLine) {
            const searchLineContent = model.getLineContent(searchLine);
            const searchStart = searchLine === lineNum ? startCol : 0;

            for (let col = searchStart; col < searchLineContent.length; col++) {
              const char = searchLineContent[col];

              if (escapeNext) {
                escapeNext = false;
                continue;
              }

              if (char === '\\') {
                escapeNext = true;
                continue;
              }

              if (char === '"') {
                // Found the closing quote
                systemPromptValueEnd = searchLine;
                break;
              }
            }

            if (systemPromptValueEnd !== -1) break;
            searchLine++;
          }

          // If we couldn't find the end, assume it goes to the next field
          if (systemPromptValueEnd === -1) {
            // Look for the next field in this agent
            for (let nextLine = lineNum + 1; nextLine <= agentBoundary.endLine; nextLine++) {
              const nextLineContent = model.getLineContent(nextLine);
              const nextTrimmed = nextLineContent.trim();

              // If we find another JSON field, the systemPrompt value ends before this line
              if (nextTrimmed.match(/^"[^"]+"\s*:/) && !nextTrimmed.includes('systemPrompt')) {
                systemPromptValueEnd = nextLine - 1;
                break;
              }
            }

            // If still not found, go to end of agent
            if (systemPromptValueEnd === -1) {
              systemPromptValueEnd = agentBoundary.endLine;
            }
          }

          break;
        }
      }
    }

    // Check if cursor is within the systemPrompt range
    if (systemPromptKeyLine !== -1 && systemPromptValueStart !== -1 && systemPromptValueEnd !== -1) {
      const cursorLine = position.lineNumber;

      // Cursor is within the systemPrompt value range
      if (cursorLine >= systemPromptValueStart && cursorLine <= systemPromptValueEnd) {
        return true;
      }
    }

    return false;
  }, []);

  // Helper function to find which agent the cursor is positioned in
  const findAgentAtCursorPosition = useCallback((model: any, position: any, config: Record<string, unknown>) => {
    const totalLines = model.getLineCount();
    const currentLineNumber = position.lineNumber;

    // Find agent boundaries by looking for top-level keys in the JSON
    const agentBoundaries: Array<{ agentKey: string; startLine: number; endLine: number }> = [];
    const agentKeys = Object.keys(config);

    let currentAgent: string | null = null;
    let agentStartLine = 0;
    let braceDepth = 0;

    for (let lineNum = 1; lineNum <= totalLines; lineNum++) {
      const line = model.getLineContent(lineNum);
      const trimmedLine = line.trim();

      // Track brace depth to understand JSON structure
      for (const char of line) {
        if (char === '{') braceDepth++;
        if (char === '}') {
          braceDepth--;

          // If we're closing an agent's brace (back to depth 1), end current agent
          if (braceDepth === 1 && currentAgent) {
            agentBoundaries.push({
              agentKey: currentAgent,
              startLine: agentStartLine,
              endLine: lineNum
            });
            currentAgent = null;
          }
        }
      }

      // Look for agent keys at the top level (depth 1, inside main object)
      if (braceDepth >= 1 && trimmedLine.includes('"') && trimmedLine.includes(':')) {
        // Extract potential agent key - handle various quote styles
        const keyMatches = [
          ...trimmedLine.matchAll(/"([^"]+)":/g),
          ...trimmedLine.matchAll(/'([^']+)':/g)
        ];

        for (const keyMatch of keyMatches) {
          const potentialKey = keyMatch[1];
          if (agentKeys.includes(potentialKey)) {
            // Close previous agent if exists
            if (currentAgent) {
              agentBoundaries.push({
                agentKey: currentAgent,
                startLine: agentStartLine,
                endLine: lineNum - 1
              });
            }

            // Start new agent
            currentAgent = potentialKey;
            agentStartLine = lineNum;
            break;
          }
        }
      }
    }

    // Close the last agent
    if (currentAgent) {
      agentBoundaries.push({
        agentKey: currentAgent,
        startLine: agentStartLine,
        endLine: totalLines
      });
    }

    // Find which agent boundary contains the cursor
    for (const boundary of agentBoundaries) {
      if (currentLineNumber >= boundary.startLine && currentLineNumber <= boundary.endLine) {
        // Check if cursor is specifically on a systemPrompt line within this agent
        const isOnSystemPrompt = isOnSystemPromptLine(model, position, boundary);

        return {
          agentKey: boundary.agentKey,
          isOnSystemPrompt,
          boundary
        };
      }
    }

    return null;
  }, [isOnSystemPromptLine]);

  const extractSystemPromptAtCursor = useCallback(() => {
    if (!selectedFile || !parsedConfig || !editorRef) {
      setCursorOnSystemPrompt(false);
      return "";
    }

    // For agents.json, look for systemPrompt in the selected agent
    if (selectedFile === "agents.json") {
      try {
        const editor = editorRef.current;
        if (editor) {
          const position = editor.getPosition();
          const model = editor.getModel();
          if (position && model) {
            // Find which agent block the cursor is currently in
            const agentAtCursor = findAgentAtCursorPosition(model, position, parsedConfig);

            if (agentAtCursor) {
              const { agentKey, isOnSystemPrompt } = agentAtCursor;
              setCursorOnSystemPrompt(isOnSystemPrompt);

              if (isOnSystemPrompt) {
                const agentConfig = parsedConfig[agentKey];
                if (typeof agentConfig === "object" && agentConfig && "systemPrompt" in agentConfig) {
                  return String(agentConfig.systemPrompt || "");
                }
              }
            } else {
              setCursorOnSystemPrompt(false);
            }
          }
        }
      } catch (err) {
        console.warn("Failed to extract system prompt:", err);
      }
    }

    setCursorOnSystemPrompt(false);
    return "";
  }, [selectedFile, parsedConfig, editorRef]);

  const getAgentAtCurrentCursor = useCallback(() => {
    if (selectedFile !== "agents.json" || !parsedConfig || !editorRef?.current) {
      return null;
    }

    const editor = editorRef.current;
    const position = editor.getPosition();
    const model = editor.getModel();
    if (!position || !model) {
      return null;
    }

    return findAgentAtCursorPosition(model, position, parsedConfig);
  }, [selectedFile, parsedConfig, editorRef, findAgentAtCursorPosition]);

  // Monitor cursor position changes to update system prompt detection
  useEffect(() => {
    const editor = editorRef?.current;
    if (!editor || selectedFile !== "agents.json") return;

    const disposable = editor.onDidChangeCursorPosition(() => {
      // Debounce cursor position changes using a ref so the timer can be cleared
      if (cursorDebounceTimerRef.current !== null) {
        clearTimeout(cursorDebounceTimerRef.current);
      }
      cursorDebounceTimerRef.current = setTimeout(() => {
        cursorDebounceTimerRef.current = null;
        extractSystemPromptAtCursor();
      }, 100);
    });

    return () => {
      disposable?.dispose();
      if (cursorDebounceTimerRef.current !== null) {
        clearTimeout(cursorDebounceTimerRef.current);
        cursorDebounceTimerRef.current = null;
      }
    };
  }, [editorRef, selectedFile, extractSystemPromptAtCursor]);

  // Extract system prompt when editor or content changes
  useEffect(() => {
    if (editorRef?.current && selectedFile === "agents.json" && parsedConfig) {
      // Small delay to ensure editor is fully initialized
      const timeoutId = setTimeout(() => {
        extractSystemPromptAtCursor();
      }, 200);

      return () => clearTimeout(timeoutId);
    }
  }, [editorRef, selectedFile, parsedConfig, extractSystemPromptAtCursor]);

  const parseAvailableGraphs = useCallback(() => {
    try {
      const graphsContent = allConfigs["graphs.json"];
      if (graphsContent) {
        const graphs = JSON.parse(graphsContent);
        return Object.keys(graphs);
      }
    } catch (err) {
      console.warn("Failed to parse graphs.json:", err);
    }
    return [];
  }, [allConfigs]);

  const parseAvailableAgents = useCallback(() => {
    try {
      const agentsContent = allConfigs["agents.json"];
      if (agentsContent) {
        const agents = JSON.parse(agentsContent);
        return Object.entries(agents).map(([key, value]) => ({
          key,
          description: typeof value === "object" && value && "description" in value ?
            String(value.description) : "No description"
        }));
      }
    } catch (err) {
      console.warn("Failed to parse agents.json:", err);
    }
    return [];
  }, [allConfigs]);

  const parseAvailableTools = useCallback(() => {
    try {
      const toolsContent = allConfigs["tools.json"];
      if (toolsContent) {
        const tools = JSON.parse(toolsContent);
        return Object.keys(tools);
      }
    } catch (err) {
      console.warn("Failed to parse tools.json:", err);
    }
    return [];
  }, [allConfigs]);

  const handleOpenSystemPromptDialog = useCallback(() => {
    const agentAtCursor = getAgentAtCurrentCursor();
    const agentKey = agentAtCursor?.agentKey ?? null;
    const agentConfig = agentKey ? parsedConfig?.[agentKey] : null;
    const prompt =
      agentConfig && typeof agentConfig === "object" && "systemPrompt" in agentConfig
        ? String(agentConfig.systemPrompt || "")
        : "";

    setDialogTargetAgentKey(agentKey);
    setDialogSystemPrompt(prompt);
    setSystemPromptDialogOpen(true);
  }, [getAgentAtCurrentCursor, parsedConfig]);

  const handleCloseSystemPromptDialog = useCallback(() => {
    setSystemPromptDialogOpen(false);
    setDialogSystemPrompt("");
    setDialogTargetAgentKey(null);
  }, []);

  const handleApplySystemPrompt = useCallback((newPrompt: string) => {
    if (!selectedFile || !parsedConfig || !dialogTargetAgentKey) {
      return;
    }

    if (selectedFile === "agents.json") {
      try {
        const agentConfig = parsedConfig[dialogTargetAgentKey];
        if (typeof agentConfig === "object" && agentConfig) {
          const updatedConfig = { ...parsedConfig };
          updatedConfig[dialogTargetAgentKey] = { ...agentConfig, systemPrompt: newPrompt };
          const newContent = JSON.stringify(updatedConfig, null, 2);
          setDraftContent(newContent);
          setIsDirty(true);
          setSaveNotice(null);
          setDialogSystemPrompt(newPrompt);
        }
      } catch (err) {
        console.warn("Failed to apply system prompt:", err);
      }
    }
  }, [selectedFile, parsedConfig, dialogTargetAgentKey]);

  const [currentSystemPrompt, setCurrentSystemPrompt] = useState("");

  useEffect(() => {
    setCurrentSystemPrompt(extractSystemPromptAtCursor());
  }, [extractSystemPromptAtCursor]);
  const availableGraphs = useMemo(() => parseAvailableGraphs(), [parseAvailableGraphs]);
  const availableAgents = useMemo(() => parseAvailableAgents(), [parseAvailableAgents]);
  const availableTools = useMemo(() => parseAvailableTools(), [parseAvailableTools]);

  const modelKeys = useMemo(() => {
    if (selectedFile === "models.json" && parsedConfig) {
      return Object.keys(parsedConfig);
    }
    return parseModelKeys(allConfigs["models.json"]);
  }, [allConfigs, parsedConfig, selectedFile]);

  // Compute item keys for secondary navigation
  const itemKeys = useMemo(() => {
    if (!parsedConfig) return [];
    return Object.keys(parsedConfig);
  }, [parsedConfig]);

  // Compute secret names referenced in the currently-selected item
  const activeSecretNames = useMemo(() => {
    if (!selectedItemKey || !parsedConfig) return [];
    const itemValue = parsedConfig[selectedItemKey];
    return extractSecretRefs(itemValue);
  }, [selectedItemKey, parsedConfig]);

  // Compute dependents for the selected item
  const dependents = useMemo(() => {
    if (!selectedFile || !selectedItemKey) return [];
    return computeDependents(selectedFile, selectedItemKey, allConfigs);
  }, [selectedFile, selectedItemKey, allConfigs]);

  const handleFriendlyChange = useCallback(
    (key: string, value: unknown) => {
      if (!parsedConfig) return;
      const updated = { ...parsedConfig, [key]: value };
      const newContent = JSON.stringify(updated, null, 2);
      setDraftContent(newContent);
      setIsDirty(true);
      setSaveNotice(null);
    },
    [parsedConfig],
  );

  const renderEditorContent = () => {
    if (!selectedFile) {
      return (
        <div className={styles.emptyState}>
          <DocumentEdit24Regular style={{ fontSize: "48px" }} />
          <Text size={400}>Select a config file to edit</Text>
          <Text size={200}>Choose a file from the left panel</Text>
        </div>
      );
    }

    if (readState === "loading") {
      return (
        <div className={styles.emptyState}>
          <Spinner size="large" />
          <Text>Loading {selectedFile}…</Text>
        </div>
      );
    }

    if (readError) {
      return (
        <div className={styles.emptyState}>
          <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{readError}</Text>
        </div>
      );
    }

    if (editorTab === "raw") {
      return (
        <div className={styles.monacoWrapper}>
          <Suspense fallback={<div className={styles.emptyState}><Spinner size="large" /><Text>Loading editor…</Text></div>}>
            <MonacoJsonEditor
              value={draftContent}
              onChange={handleEditorChange}
              validationIssues={validationIssues}
              filename={selectedFile}
              wordWrap={wordWrap}
              onMount={(editor) => setEditorRef({ current: editor })}
            />
          </Suspense>
        </div>
      );
    }

    // Friendly editor
    if (!parsedConfig) {
      return (
        <div className={styles.emptyState}>
          <ErrorCircle24Regular style={{ color: tokens.colorPaletteRedForeground1 }} />
          <Text>Invalid JSON — switch to Raw mode to fix syntax errors</Text>
        </div>
      );
    }

    // Show single item if selected via secondary nav, otherwise show all
    const entriesToShow = selectedItemKey
      ? Object.entries(parsedConfig).filter(([k]) => k === selectedItemKey)
      : Object.entries(parsedConfig);

    return (
      <div className={styles.friendlyEditorScroll}>
        {entriesToShow.map(([key, value]) => (
          <FriendlyEntryEditor
            key={key}
            filename={selectedFile}
            entryKey={key}
            value={value}
            modelKeys={modelKeys}
            activeSecretNames={activeSecretNames}
            onChange={handleFriendlyChange}
          />
        ))}
        {Object.keys(parsedConfig).length === 0 && (
          <Text>No entries — use the + button to add an item.</Text>
        )}
        {selectedItemKey && dependents.length > 0 && (
          <DependentsPanel
            dependents={dependents}
            onNavigateTo={handleNavigateTo}
          />
        )}
      </div>
    );
  };

  if (!hasPrivilege) {
    return (
      <OverlayDrawer
        open={open}
        onOpenChange={(_, data) => { if (!data.open) onClose(); }}
        position="end"
        size="large"
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <PrivilegedAccessButton
                  privilegedAccessActive={privilegedAccessActive}
                  privilegedAccessExpiresAt={privilegedAccessExpiresAt}
                  onEnablePrivilegedAccessWithToken={onEnablePrivilegedAccessWithToken}
                  onEnablePrivilegedAccessWithPasskey={onEnablePrivilegedAccessWithPasskey}
                  onDisablePrivilegedAccess={onDisablePrivilegedAccess}
                  privilegeTokenRegistered={privilegeTokenRegistered}
                  onRegisterPrivilegeToken={onRegisterPrivilegeToken}
                  authError={authError}
                  passkeyEnabled={passkeyEnabled}
                />
                <Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} aria-label="Close" />
              </div>
            }
          >
            Config Editor
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className={styles.noPrivileged}>
            <Text size={500} weight="semibold">Privileged access required</Text>
            <Text>
              Enable privileged access from the header to use the config editor.
              All config operations require a valid privilege grant.
            </Text>
          </div>
        </DrawerBody>
      </OverlayDrawer>
    );
  }

  return (
    <>
      <OverlayDrawer
        open={open}
        onOpenChange={(_, data) => { if (!data.open) onClose(); }}
        position="end"
        size="large"
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <PrivilegedAccessButton
                  privilegedAccessActive={privilegedAccessActive}
                  privilegedAccessExpiresAt={privilegedAccessExpiresAt}
                  onEnablePrivilegedAccessWithToken={onEnablePrivilegedAccessWithToken}
                  onEnablePrivilegedAccessWithPasskey={onEnablePrivilegedAccessWithPasskey}
                  onDisablePrivilegedAccess={onDisablePrivilegedAccess}
                  privilegeTokenRegistered={privilegeTokenRegistered}
                  onRegisterPrivilegeToken={onRegisterPrivilegeToken}
                  authError={authError}
                  passkeyEnabled={passkeyEnabled}
                />
                <Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} aria-label="Close" />
              </div>
            }
          >
            Config Editor
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className={styles.drawerBody}>
            {/* File Browser */}
            <div className={styles.fileBrowser}>
              <Text className={styles.fileBrowserTitle} size={200}>Config Files</Text>
              <Divider />
              {filesState === "loading" && (
                <div style={{ padding: tokens.spacingHorizontalM, display: "flex", gap: tokens.spacingHorizontalS, alignItems: "center" }}>
                  <Spinner size="tiny" />
                  <Text size={200}>Loading…</Text>
                </div>
              )}
              {filesError && (
                <Text size={200} style={{ padding: tokens.spacingHorizontalM, color: tokens.colorPaletteRedForeground1 }}>
                  {filesError}
                </Text>
              )}
              <div className={styles.fileList}>
                {files.map((file: ConfigFileSummary) => (
                  <div
                    key={file.name}
                    className={mergeClasses(styles.fileItem, selectedFile === file.name && styles.fileItemSelected)}
                    onClick={() => handleSelectFile(file.name)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleSelectFile(file.name); }}
                    aria-selected={selectedFile === file.name}
                    aria-label={file.name}
                  >
                    <Text size={200}>{file.name}</Text>
                    <ChevronRight24Regular style={{ width: "14px", height: "14px", opacity: 0.5 }} />
                  </div>
                ))}
                {files.length === 0 && filesState === "idle" && (
                  <Text size={200} style={{ padding: tokens.spacingHorizontalM, color: tokens.colorNeutralForeground3 }}>
                    No files found
                  </Text>
                )}
              </div>
              {onRestartService && (
                <>
                  <Divider />
                  <div style={{ padding: tokens.spacingHorizontalS }}>
                    <Button
                      appearance="subtle"
                      icon={<ArrowReset24Regular />}
                      size="small"
                      onClick={() => setRestartDialogOpen(true)}
                      style={{ width: "100%" }}
                    >
                      Restart service
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* Secondary Navigation — items within the selected file */}
            {selectedFile && parsedConfig && editorTab === "friendly" && (
              <ConfigItemNav
                filename={selectedFile}
                itemKeys={itemKeys}
                selectedKey={selectedItemKey}
                onSelectKey={setSelectedItemKey}
                onAddItem={() => setAddItemDialogOpen(true)}
              />
            )}

            {/* Editor Pane */}
            <div className={styles.editorPane}>
              {selectedFile && (
                <div className={styles.editorToolbar}>
                  <div style={{ display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS }}>
                    <Text weight="semibold" size={300}>{selectedFile}</Text>
                    {selectedItemKey && editorTab === "friendly" && (
                      <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                        › {selectedItemKey}
                      </Text>
                    )}
                    {isDirty && (
                      <Text size={100} style={{ color: tokens.colorPaletteYellowForeground1 }}>
                        (modified)
                      </Text>
                    )}
                  </div>
                  <div className={styles.editorToolbarRight}>
                    <Button
                      appearance="subtle"
                      icon={<ArrowReset24Regular />}
                      size="small"
                      title="Reload file"
                      aria-label="Reload file"
                      onClick={() => { void handleReloadFile(); }}
                      disabled={!isDirty}
                    />
                    {editorTab === "raw" && (
                      <Button
                        appearance="subtle"
                        icon={wordWrap ? <TextWrapOff24Regular /> : <TextWrap24Regular />}
                        size="small"
                        title={wordWrap ? "Disable word wrap" : "Enable word wrap"}
                        onClick={handleToggleWordWrap}
                      />
                    )}
                    <Button
                      appearance={cursorOnSystemPrompt ? "primary" : "subtle"}
                      icon={<BotSparkle24Regular />}
                      size="small"
                      title={cursorOnSystemPrompt ? "System Prompt Editor (cursor on system prompt)" : "System Prompt Editor"}
                      aria-label="System Prompt Editor"
                      onClick={handleOpenSystemPromptDialog}
                      disabled={selectedFile !== "agents.json"}
                    />
                    <Button
                      appearance={showSecretsPanel ? "primary" : "subtle"}
                      icon={<KeyMultiple24Regular />}
                      size="small"
                      title={showSecretsPanel ? "Hide secrets panel" : "Show secrets panel"}
                      onClick={() => setShowSecretsPanel((v) => !v)}
                    />
                    <TabList
                      size="small"
                      selectedValue={editorTab}
                      onTabSelect={(_, data) => handleSetEditorTab(data.value as EditorTab)}
                    >
                      <Tab value="raw">Raw JSON</Tab>
                      <Tab value="friendly">Friendly</Tab>
                    </TabList>
                    <Button
                      appearance="subtle"
                      icon={<History24Regular />}
                      size="small"
                      onClick={() => { void handleShowHistory(); }}
                    >
                      History
                    </Button>
                  </div>
                </div>
              )}

              <div className={styles.editorContent}>
                <div className={styles.editorMain}>
                  {renderEditorContent()}
                </div>
                {showSecretsPanel && selectedFile && (
                  <SecretsPanel
                    secrets={secrets}
                    secretFiles={secretFiles}
                    secretsLoading={secretsState === "loading"}
                    secretsError={secretsError}
                    upsertError={upsertError}
                    upsertLoading={upsertState === "loading"}
                    activeSecretNames={activeSecretNames}
                    onRevealSecret={revealSecret}
                    onSaveSecret={saveSecret}
                  />
                )}
              </div>

              {selectedFile && (
                <div className={styles.editorBottomBar}>
                  <div>
                    {saveNotice && (
                      <Text size={200} style={{ color: tokens.colorPaletteGreenForeground1 }}>
                        {saveNotice}
                      </Text>
                    )}
                    {writeError && (
                      <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                        {writeError}
                      </Text>
                    )}
                  </div>
                  <div className={styles.editorBottomBarRight}>
                    <Button
                      appearance="secondary"
                      icon={isChecking ? <Spinner size="tiny" /> : <CheckmarkCircle24Regular />}
                      size="small"
                      onClick={() => { void handleCheck(); }}
                      disabled={!draftContent || isChecking}
                    >
                      Check
                    </Button>
                    <Button
                      appearance="primary"
                      icon={writeState === "loading" ? <Spinner size="tiny" /> : <Save24Regular />}
                      size="small"
                      onClick={() => { void handleSave(); }}
                      disabled={!draftContent || writeState === "loading"}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DrawerBody>
      </OverlayDrawer>

      {/* Check / Validation dialog */}
      <Dialog open={checkDialogOpen} onOpenChange={(_, data) => { if (!data.open) setCheckDialogOpen(false); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Validation Results — {selectedFile}</DialogTitle>
            <DialogContent>
              {validationIssues.length === 0 ? (
                <MessageBar intent="success">
                  <MessageBarBody>Config file is valid — no issues found.</MessageBarBody>
                </MessageBar>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS }}>
                  <Text>Found {validationIssues.length} issue{validationIssues.length !== 1 ? "s" : ""}:</Text>
                  {validationIssues.map((issue, i) => (
                    <MessageBar key={i} intent={issue.severity === "error" ? "error" : "warning"}>
                      <MessageBarBody>
                        <strong>{issue.path}</strong>: {issue.message}
                      </MessageBarBody>
                    </MessageBar>
                  ))}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setCheckDialogOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* History dialog */}
      <HistoryDialog
        open={historyDialogOpen}
        selectedFile={selectedFile}
        history={history}
        historyState={historyState}
        historyError={historyError}
        selectedVersion={selectedVersion}
        versionState={versionState}
        versionError={versionError}
        onClose={() => {
          setHistoryDialogOpen(false);
          clearSelectedVersion();
        }}
        onLoadVersion={handleLoadVersion}
        onRestoreVersion={handleRestoreVersion}
      />

      {/* Restart service dialog */}
      <Dialog
        open={restartDialogOpen}
        onOpenChange={(_, data) => {
          if (!data.open) {
            setRestartDialogOpen(false);
            setRestartResult(null);
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Restart Core Service</DialogTitle>
            <DialogContent>
              <Text>
                This will restart the core gateway process. Active connections will be dropped and
                reconnected automatically. Are you sure?
              </Text>
              {restartResult && (
                <MessageBar
                  intent={restartResult.startsWith("Restart failed") ? "error" : "success"}
                  style={{ marginTop: tokens.spacingVerticalM }}
                >
                  <MessageBarBody>{restartResult}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => {
                  setRestartDialogOpen(false);
                  setRestartResult(null);
                }}
                disabled={isRestarting}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                icon={isRestarting ? <Spinner size="tiny" /> : <ArrowReset24Regular />}
                onClick={() => { void handleRestart(); }}
                disabled={isRestarting || Boolean(restartResult)}
              >
                {isRestarting ? "Restarting…" : "Restart"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* System Prompt Dialog */}
      <SystemPromptDialog
        open={systemPromptDialogOpen}
        onClose={handleCloseSystemPromptDialog}
        currentSystemPrompt={dialogSystemPrompt}
        onApplyPrompt={handleApplySystemPrompt}
        availableGraphs={availableGraphs}
        availableAgents={availableAgents}
        availableTools={availableTools}
        configToolUrl={configToolUrl}
        privilegeGrantId={privilegeGrantId}
        conversationId={conversationId}
        authToken={authToken}
      />

      {/* Add Item Dialog */}
      <AddItemDialog
        open={addItemDialogOpen}
        filename={selectedFile ?? ""}
        existingKeys={itemKeys}
        onClose={() => setAddItemDialogOpen(false)}
        onAdd={handleAddItem}
      />
    </>
  );
}
