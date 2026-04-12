import React, { lazy, Suspense, useCallback, useEffect, useState, useMemo } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Spinner,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Field,
  Textarea,
  Dropdown,
  Option,
  Checkbox,
  Divider,
} from "@fluentui/react-components";

// Monaco editor is large — lazy-load it so it doesn't bloat the initial bundle
const MonacoJsonEditor = lazy(() =>
  import("./MonacoJsonEditor").then((m) => ({ default: m.MonacoJsonEditor })),
);

import {
  DocumentEdit24Regular,
  Send24Regular,
  Dismiss24Regular,
} from "@fluentui/react-icons";

const useStyles = makeStyles({
  dialogContainer: {
    minWidth: "80vw",
    maxWidth: "90vw",
    minHeight: "60vh",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
  },
  dialogBodyContent: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minHeight: 0,
  },
  scrollableContent: {
    flex: 1,
    overflowY: "auto",
    paddingRight: tokens.spacingHorizontalS, // Add padding for scrollbar
  },
  editorSection: {
    display: "flex",
    gap: tokens.spacingHorizontalM,
    height: "250px", // Reduced from 300px
    marginTop: tokens.spacingVerticalM,
    flexShrink: 0,
  },
  editorPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
  },
  editorHeader: {
    padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    textAlign: "center",
  },
  editorContent: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  promptSection: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    marginBottom: tokens.spacingVerticalM,
  },
  agentsToolsSection: {
    display: "flex",
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalM,
  },
  selectionColumn: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  checkboxList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    maxHeight: "200px",
    overflowY: "auto",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: tokens.spacingVerticalS,
  },
  loadingState: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: tokens.spacingHorizontalS,
  },
});

import { createUuid } from "../uuid";

interface SystemPromptDialogProps {
  open: boolean;
  onClose: () => void;
  currentSystemPrompt: string;
  onApplyPrompt: (newPrompt: string) => void;
  availableGraphs: string[];
  availableAgents: Array<{ key: string; description: string }>;
  availableTools: string[];
  // API access props
  configToolUrl?: string;
  privilegeGrantId?: string;
  conversationId?: string;
  authToken?: string;
}

async function generateSystemPrompt(
  request: GenerateRequest,
  configToolUrl?: string,
  privilegeGrantId?: string,
  conversationId?: string,
  authToken?: string,
): Promise<string> {
  // Build the prompt construction message
  const promptRequest = `Please create a system prompt with the following requirements:

User Request: ${request.userRequest}

Available Agents: ${request.selectedAgents.join(", ") || "none selected"}
Available Tools: ${request.selectedTools.join(", ") || "none selected"}

Please generate a clear, concise system prompt that accomplishes the user's goals while being appropriate for an AI assistant.`;

  // For now, we'll use a mock implementation
  // In a real implementation, this would send the message to the specified graph
  // via the WebSocket connection or a dedicated RPC endpoint

  if (!configToolUrl || !privilegeGrantId || !conversationId) {
    throw new Error("API configuration required for prompt generation");
  }

  // This is a placeholder - in the real implementation, you would:
  // 1. Send a message to the selected graph via WebSocket or RPC
  // 2. Wait for the response
  // 3. Extract the generated system prompt from the response

  // Mock API call delay
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Generate a more realistic mock response
  const mockPrompt = `You are a specialized AI assistant designed to ${request.userRequest.toLowerCase().replace(/[.!?]+$/, "")}.

${request.selectedAgents.length > 0 ? `You have access to the following specialized agents for delegation:
${request.selectedAgents.map(agent => `- ${agent}`).join("\n")}

When appropriate, delegate tasks to the relevant specialized agents rather than attempting to handle everything yourself.` : ""}

${request.selectedTools.length > 0 ? `You have access to the following tools:
${request.selectedTools.map(tool => `- ${tool}`).join("\n")}

Use these tools when they are relevant to the user's requests.` : ""}

Always be helpful, accurate, and concise in your responses. If you're uncertain about something, acknowledge the uncertainty rather than providing potentially incorrect information.`;

  return mockPrompt;
}

interface GenerateRequest {
  userRequest: string;
  selectedGraph: string;
  selectedAgents: string[];
  selectedTools: string[];
}

export function SystemPromptDialog({
  open,
  onClose,
  currentSystemPrompt,
  onApplyPrompt,
  availableGraphs,
  availableAgents,
  availableTools,
  configToolUrl,
  privilegeGrantId,
  conversationId,
  authToken,
}: SystemPromptDialogProps) {
  const styles = useStyles();

  const [userRequest, setUserRequest] = useState("");
  const [selectedGraph, setSelectedGraph] = useState(availableGraphs[0] || "");
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [generatedPrompt, setGeneratedPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setUserRequest("");
      setSelectedGraph(availableGraphs[0] || "");
      setSelectedAgents(new Set());
      setSelectedTools(new Set());
      setGeneratedPrompt("");
      setError(null);
    }
  }, [open, availableGraphs]);

  const handleAgentToggle = useCallback((agentKey: string) => {
    setSelectedAgents(prev => {
      const newSet = new Set(prev);
      if (newSet.has(agentKey)) {
        newSet.delete(agentKey);
      } else {
        newSet.add(agentKey);
      }
      return newSet;
    });
  }, []);

  const handleToolToggle = useCallback((toolKey: string) => {
    setSelectedTools(prev => {
      const newSet = new Set(prev);
      if (newSet.has(toolKey)) {
        newSet.delete(toolKey);
      } else {
        newSet.add(toolKey);
      }
      return newSet;
    });
  }, []);

  const handleGeneratePrompt = useCallback(async () => {
    if (!userRequest.trim()) {
      setError("Please enter a request for the system prompt");
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      const generateRequest: GenerateRequest = {
        userRequest: userRequest.trim(),
        selectedGraph,
        selectedAgents: Array.from(selectedAgents),
        selectedTools: Array.from(selectedTools),
      };

      const generated = await generateSystemPrompt(
        generateRequest,
        configToolUrl,
        privilegeGrantId,
        conversationId,
        authToken
      );

      setGeneratedPrompt(generated);
    } catch (err) {
      setError(`Failed to generate prompt: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsGenerating(false);
    }
  }, [userRequest, selectedGraph, selectedAgents, selectedTools, configToolUrl, privilegeGrantId, conversationId, authToken]);

  const handleApplyPrompt = useCallback(() => {
    if (generatedPrompt.trim()) {
      onApplyPrompt(generatedPrompt.trim());
      onClose();
    }
  }, [generatedPrompt, onApplyPrompt, onClose]);

  const canGenerate = userRequest.trim() && selectedGraph;

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => { if (!data.open) onClose(); }}
    >
      <DialogSurface className={styles.dialogContainer}>
        <DialogBody className={styles.dialogBodyContent}>
          <DialogTitle>System Prompt Editor</DialogTitle>
          <DialogContent className={styles.scrollableContent}>
            {/* User Request Section */}
            <div className={styles.promptSection}>
              <Field label="Describe what you want the system prompt to accomplish">
                <Textarea
                  value={userRequest}
                  onChange={(_, data) => setUserRequest(data.value)}
                  placeholder="e.g. Create a prompt for an assistant that helps with code reviews and documentation..."
                  rows={3}
                />
              </Field>
            </div>

            {/* Graph Selection */}
            <Field label="Select graph to use for generation">
              <Dropdown
                placeholder="Select a graph"
                value={selectedGraph}
                selectedOptions={selectedGraph ? [selectedGraph] : []}
                onOptionSelect={(_, data) => {
                  if (data.optionValue) {
                    setSelectedGraph(data.optionValue);
                  }
                }}
              >
                {availableGraphs.map((graph) => (
                  <Option key={graph} value={graph}>
                    {graph}
                  </Option>
                ))}
              </Dropdown>
            </Field>

            {/* Agents and Tools Selection */}
            <div className={styles.agentsToolsSection}>
              <div className={styles.selectionColumn}>
                <Text weight="semibold">Available Agents</Text>
                <div className={styles.checkboxList}>
                  {availableAgents.map((agent) => (
                    <Checkbox
                      key={agent.key}
                      label={`${agent.key} - ${agent.description}`}
                      checked={selectedAgents.has(agent.key)}
                      onChange={() => handleAgentToggle(agent.key)}
                    />
                  ))}
                </div>
              </div>

              <div className={styles.selectionColumn}>
                <Text weight="semibold">Available Tools</Text>
                <div className={styles.checkboxList}>
                  {availableTools.map((tool) => (
                    <Checkbox
                      key={tool}
                      label={tool}
                      checked={selectedTools.has(tool)}
                      onChange={() => handleToolToggle(tool)}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* Generate Button */}
            <div style={{ marginTop: tokens.spacingVerticalM, display: "flex", justifyContent: "center" }}>
              <Button
                appearance="primary"
                icon={isGenerating ? <Spinner size="tiny" /> : <Send24Regular />}
                onClick={handleGeneratePrompt}
                disabled={!canGenerate || isGenerating}
              >
                {isGenerating ? "Generating..." : "Generate System Prompt"}
              </Button>
            </div>

            {/* Error Display */}
            {error && (
              <Text style={{ color: tokens.colorPaletteRedForeground1, marginTop: tokens.spacingVerticalS }}>
                {error}
              </Text>
            )}

            {/* Editor Section - Current vs Generated */}
            {(currentSystemPrompt || generatedPrompt) && (
              <div className={styles.editorSection}>
                {/* Current Prompt */}
                <div className={styles.editorPane}>
                  <div className={styles.editorHeader}>
                    <Text weight="semibold">Current System Prompt</Text>
                  </div>
                  <div className={styles.editorContent}>
                    {currentSystemPrompt ? (
                      <Suspense fallback={
                        <div className={styles.loadingState}>
                          <Spinner size="small" />
                          <Text>Loading editor...</Text>
                        </div>
                      }>
                        <MonacoJsonEditor
                          value={`"${currentSystemPrompt}"`}
                          onChange={() => {}} // Read-only
                          validationIssues={[]}
                          filename="current-prompt.txt"
                          wordWrap={true}
                        />
                      </Suspense>
                    ) : (
                      <div className={styles.loadingState}>
                        <Text style={{ color: tokens.colorNeutralForeground3 }}>
                          No current system prompt
                        </Text>
                      </div>
                    )}
                  </div>
                </div>

                {/* Generated Prompt */}
                <div className={styles.editorPane}>
                  <div className={styles.editorHeader}>
                    <Text weight="semibold">Generated System Prompt</Text>
                  </div>
                  <div className={styles.editorContent}>
                    {generatedPrompt ? (
                      <Suspense fallback={
                        <div className={styles.loadingState}>
                          <Spinner size="small" />
                          <Text>Loading editor...</Text>
                        </div>
                      }>
                        <MonacoJsonEditor
                          value={`"${generatedPrompt}"`}
                          onChange={(value) => {
                            // Extract the string content (remove quotes)
                            try {
                              const parsed = JSON.parse(value);
                              if (typeof parsed === "string") {
                                setGeneratedPrompt(parsed);
                              }
                            } catch {
                              // If it's not valid JSON, treat as raw string
                              setGeneratedPrompt(value.replace(/^"|"$/g, ''));
                            }
                          }}
                          validationIssues={[]}
                          filename="generated-prompt.txt"
                          wordWrap={true}
                        />
                      </Suspense>
                    ) : (
                      <div className={styles.loadingState}>
                        <Text style={{ color: tokens.colorNeutralForeground3 }}>
                          Generated prompt will appear here
                        </Text>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </DialogContent>

          <DialogActions>
            <Button
              appearance="secondary"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={handleApplyPrompt}
              disabled={!generatedPrompt.trim()}
            >
              Apply Generated Prompt
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}