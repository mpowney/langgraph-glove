import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Field,
  Input,
  Dropdown,
  Option,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";

interface SecretDialogProps {
  open: boolean;
  onClose: () => void;
  /** Pre-filled secret name (for edit mode) */
  initialName?: string;
  /** Pre-filled file (for edit mode) */
  initialFile?: string;
  /** Available secret files to select from */
  secretFiles: Array<{ name: string }>;
  /** Whether the dialog is saving */
  isSaving: boolean;
  /** Error message from a failed save attempt */
  saveError?: string | null;
  onSave: (file: string, name: string, value: string) => Promise<boolean>;
}

export function SecretDialog({
  open,
  onClose,
  initialName = "",
  initialFile,
  secretFiles,
  isSaving,
  saveError,
  onSave,
}: SecretDialogProps) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState("");
  const [selectedFile, setSelectedFile] = useState(
    initialFile ?? (secretFiles[0]?.name ?? "secrets.json"),
  );

  useEffect(() => {
    if (open) {
      setName(initialName);
      setValue("");
      setSelectedFile(initialFile ?? (secretFiles[0]?.name ?? "secrets.json"));
    }
  }, [open, initialName, initialFile, secretFiles]);

  const isEditMode = Boolean(initialName);

  const handleSave = async () => {
    if (!name || !selectedFile) return;
    const ok = await onSave(selectedFile, name, value);
    if (ok) {
      onClose();
    }
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
          <DialogTitle>{isEditMode ? "Edit Secret" : "Add Secret"}</DialogTitle>
          <DialogContent>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
            >
              <Field label="Secrets file">
                <Dropdown
                  placeholder="Select secrets file"
                  value={selectedFile}
                  selectedOptions={selectedFile ? [selectedFile] : []}
                  onOptionSelect={(_, data) => {
                    if (data.optionValue) setSelectedFile(data.optionValue);
                  }}
                >
                  {secretFiles.map((f) => (
                    <Option key={f.name} value={f.name}>
                      {f.name}
                    </Option>
                  ))}
                  {secretFiles.length === 0 && (
                    <Option value="secrets.json">secrets.json (new)</Option>
                  )}
                </Dropdown>
              </Field>
              <Field label="Secret name">
                <Input
                  value={name}
                  placeholder="e.g. openai-key"
                  disabled={isEditMode}
                  onChange={(_, data) => setName(data.value)}
                />
              </Field>
              <Field label="Secret value">
                <Input
                  type="password"
                  value={value}
                  placeholder={isEditMode ? "Enter new value" : "Enter secret value"}
                  onChange={(_, data) => setValue(data.value)}
                />
              </Field>
              {saveError && (
                <MessageBar intent="error">
                  <MessageBarBody>{saveError}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              icon={isSaving ? <Spinner size="tiny" /> : undefined}
              onClick={() => {
                void handleSave();
              }}
              disabled={isSaving || !name || !selectedFile || !value}
            >
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
