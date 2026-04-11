import { useCallback, useState } from "react";
import type {
  ConfigFileSummary,
  ConfigVersion,
  ConfigVersionSummary,
  ConfigValidationIssue,
} from "../types";
import {
  listConfigFiles,
  readConfigFile,
  writeConfigFile,
  listConfigHistory,
  getConfigVersion,
  validateConfigFile,
} from "./configRpcClient";

type LoadingState = "idle" | "loading" | "error";

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Perform basic cross-reference validation on a parsed config JSON.
 * Returns a list of issues found.
 */
function validateConfigJson(
  filename: string,
  content: string,
  allConfigs: Record<string, string>,
): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    issues.push({
      path: "(root)",
      message: `Invalid JSON: ${(err as Error).message}`,
      severity: "error",
    });
    return issues;
  }

  // Parse other config files for cross-reference checks
  let models: Record<string, unknown> = {};
  let secrets: string[] = [];

  if (allConfigs["models.json"]) {
    try {
      models = JSON.parse(allConfigs["models.json"]) as Record<string, unknown>;
    } catch {
      // ignore
    }
  }

  // Extract defined secret keys from all configs by scanning for {SECRET:xxx} patterns
  const secretPattern = /\{SECRET:([^}]+)\}/g;
  for (const cfg of Object.values(allConfigs)) {
    let m: RegExpExecArray | null;
    while ((m = secretPattern.exec(cfg)) !== null) {
      // We can't validate secrets from here, just collect referenced ones
      secrets.push(m[1]);
    }
  }

  if (filename === "agents.json" && typeof parsed === "object" && parsed !== null) {
    // Validate modelKey references in agents.json
    for (const [agentKey, agentValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof agentValue === "object" && agentValue !== null) {
        const agent = agentValue as Record<string, unknown>;
        if (typeof agent["modelKey"] === "string") {
          const modelKey = agent["modelKey"];
          if (Object.keys(models).length > 0 && !(modelKey in models)) {
            issues.push({
              path: `${agentKey}.modelKey`,
              message: `Model key '${modelKey}' is not defined in models.json`,
              severity: "error",
            });
          }
        }
      }
    }
  }

  // Check for {SECRET:xxx} references in the current file
  const contentStr = JSON.stringify(parsed, null, 2);
  const refPattern = /\{SECRET:([^}]+)\}/g;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = refPattern.exec(contentStr)) !== null) {
    const secretKey = refMatch[1];
    // We flag these as warnings since we can't verify secrets existence from the UI
    issues.push({
      path: `(secret reference)`,
      message: `References secret '{SECRET:${secretKey}}' — ensure this secret is defined`,
      severity: "warning",
    });
  }

  return issues;
}

export function useConfigAdmin(
  configToolUrl: string,
  privilegeGrantId: string,
  conversationId: string,
  authToken?: string,
) {
  const [filesState, setFilesState] = useState<LoadingState>("idle");
  const [readState, setReadState] = useState<LoadingState>("idle");
  const [writeState, setWriteState] = useState<LoadingState>("idle");
  const [historyState, setHistoryState] = useState<LoadingState>("idle");
  const [versionState, setVersionState] = useState<LoadingState>("idle");

  const [filesError, setFilesError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);

  const [files, setFiles] = useState<ConfigFileSummary[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [history, setHistory] = useState<ConfigVersionSummary[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<ConfigVersion | null>(null);

  // Cache of loaded file contents for cross-reference validation
  const [allConfigs, setAllConfigs] = useState<Record<string, string>>({});

  const loadFiles = useCallback(async () => {
    if (!privilegeGrantId || !conversationId) return;
    setFilesState("loading");
    setFilesError(null);
    try {
      const data = await listConfigFiles(
        configToolUrl,
        privilegeGrantId,
        conversationId,
        authToken,
      );
      setFiles(data);
      const preloadResults = await Promise.allSettled(
        data.map(async (file) => {
          const content = await readConfigFile(
            configToolUrl,
            file.name,
            privilegeGrantId,
            conversationId,
            authToken,
          );
          return [file.name, content] as const;
        }),
      );
      const preloadedConfigs: Record<string, string> = {};
      for (const result of preloadResults) {
        if (result.status === "fulfilled") {
          const [filename, content] = result.value;
          preloadedConfigs[filename] = content;
        }
      }
      setAllConfigs(preloadedConfigs);
      setFilesState("idle");
    } catch (err) {
      setFilesError(toErrorMessage(err));
      setFilesState("error");
    }
  }, [configToolUrl, privilegeGrantId, conversationId, authToken]);

  const loadFileContent = useCallback(
    async (filename: string) => {
      if (!privilegeGrantId || !conversationId) return;
      setReadState("loading");
      setReadError(null);
      try {
        const content = await readConfigFile(
          configToolUrl,
          filename,
          privilegeGrantId,
          conversationId,
          authToken,
        );
        setFileContent(content);
        setSelectedFile(filename);
        setAllConfigs((prev) => ({ ...prev, [filename]: content }));
        setReadState("idle");
        return content;
      } catch (err) {
        setReadError(toErrorMessage(err));
        setReadState("error");
        return undefined;
      }
    },
    [configToolUrl, privilegeGrantId, conversationId, authToken],
  );

  const saveFileContent = useCallback(
    async (filename: string, content: string, description?: string): Promise<boolean> => {
      if (!privilegeGrantId || !conversationId) return false;
      setWriteState("loading");
      setWriteError(null);
      try {
        await writeConfigFile(
          configToolUrl,
          filename,
          content,
          description,
          privilegeGrantId,
          conversationId,
          authToken,
        );
        setFileContent(content);
        setAllConfigs((prev) => ({ ...prev, [filename]: content }));
        setWriteState("idle");
        // Refresh file list to update modification time
        void loadFiles();
        return true;
      } catch (err) {
        setWriteError(toErrorMessage(err));
        setWriteState("error");
        return false;
      }
    },
    [configToolUrl, privilegeGrantId, conversationId, authToken, loadFiles],
  );

  const loadHistory = useCallback(
    async (filename: string) => {
      if (!privilegeGrantId || !conversationId) return;
      setHistoryState("loading");
      setHistoryError(null);
      try {
        const data = await listConfigHistory(
          configToolUrl,
          filename,
          privilegeGrantId,
          conversationId,
          authToken,
        );
        setHistory(data);
        setHistoryState("idle");
      } catch (err) {
        setHistoryError(toErrorMessage(err));
        setHistoryState("error");
      }
    },
    [configToolUrl, privilegeGrantId, conversationId, authToken],
  );

  const loadVersion = useCallback(
    async (versionId: string) => {
      if (!privilegeGrantId || !conversationId) return;
      setVersionState("loading");
      setVersionError(null);
      try {
        const data = await getConfigVersion(
          configToolUrl,
          versionId,
          privilegeGrantId,
          conversationId,
          authToken,
        );
        setSelectedVersion(data);
        setVersionState("idle");
      } catch (err) {
        setVersionError(toErrorMessage(err));
        setVersionState("error");
      }
    },
    [configToolUrl, privilegeGrantId, conversationId, authToken],
  );

  const validateContent = useCallback(
    (filename: string, content: string): ConfigValidationIssue[] => {
      return validateConfigJson(filename, content, allConfigs);
    },
    [allConfigs],
  );

  const validateContentWithSchema = useCallback(
    async (filename: string, content: string): Promise<ConfigValidationIssue[]> => {
      if (!privilegeGrantId || !conversationId) return [];
      return validateConfigFile(
        configToolUrl,
        filename,
        content,
        privilegeGrantId,
        conversationId,
        authToken,
      );
    },
    [configToolUrl, privilegeGrantId, conversationId, authToken],
  );

  const clearSelectedVersion = useCallback(() => {
    setSelectedVersion(null);
    setVersionError(null);
    setVersionState("idle");
  }, []);

  return {
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
  };
}
