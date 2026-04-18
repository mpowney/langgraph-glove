import React, { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Spinner,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type {
  ImprovePromptResponse,
  PromptDiagnosisItem,
} from "../../types";

const useStyles = makeStyles({
  block: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingHorizontalM,
    whiteSpace: "pre-wrap",
    maxHeight: "180px",
    overflowY: "auto",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  resultBlock: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingHorizontalM,
    whiteSpace: "pre-wrap",
    maxHeight: "220px",
    overflowY: "auto",
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

interface PromptImproveDialogProps {
  open: boolean;
  onClose: () => void;
  selectedItem: PromptDiagnosisItem | null;
  conversationId?: string;
  improveState: "idle" | "loading" | "success" | "error";
  improveError: string;
  onImprove: (input: {
    conversationId?: string;
    promptText: string;
    dislikedMessageText: string;
    userRequest: string;
  }) => Promise<ImprovePromptResponse>;
}

export function PromptImproveDialog({
  open,
  onClose,
  selectedItem,
  conversationId,
  improveState,
  improveError,
  onImprove,
}: PromptImproveDialogProps) {
  const styles = useStyles();
  const [userRequest, setUserRequest] = useState("");
  const [improvedPrompt, setImprovedPrompt] = useState("");

  useEffect(() => {
    if (!open) return;
    setUserRequest("");
    setImprovedPrompt("");
  }, [open, selectedItem?.promptResolvedHash]);

  const handleSubmit = async (): Promise<void> => {
    if (!selectedItem) return;
    const response = await onImprove({
      conversationId,
      promptText: selectedItem.promptText,
      dislikedMessageText: selectedItem.latestDislikedMessage,
      userRequest: userRequest.trim(),
    });
    setImprovedPrompt(response.improvedPrompt);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Improve Prompt</DialogTitle>
          <DialogContent>
            <Field label="Current prompt">
              <div className={styles.block}>{selectedItem?.promptText ?? ""}</div>
            </Field>

            <Field label="Disliked message context">
              <div className={styles.block}>{selectedItem?.latestDislikedMessage ?? ""}</div>
            </Field>

            <Field label="How should we improve this prompt?">
              <Textarea
                value={userRequest}
                onChange={(_, data) => setUserRequest(data.value)}
                placeholder="Describe the improvement you want."
                rows={4}
              />
            </Field>

            {improveError ? <Text className={styles.error}>{improveError}</Text> : null}

            {improvedPrompt ? (
              <Field label="Suggested improved prompt">
                <div className={styles.resultBlock}>{improvedPrompt}</div>
              </Field>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              appearance="primary"
              onClick={() => { void handleSubmit(); }}
              disabled={!selectedItem || !selectedItem.latestDislikedMessage || improveState === "loading"}
              icon={improveState === "loading" ? <Spinner size="tiny" /> : undefined}
            >
              {improveState === "loading" ? "Improving..." : "Improve with system-prompt-engineering"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
