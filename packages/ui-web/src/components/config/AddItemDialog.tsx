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
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";

interface AddItemDialogProps {
  open: boolean;
  filename: string;
  existingKeys: string[];
  onClose: () => void;
  onAdd: (key: string) => void;
}

export function AddItemDialog({
  open,
  filename,
  existingKeys,
  onClose,
  onAdd,
}: AddItemDialogProps) {
  const [key, setKey] = useState("");

  useEffect(() => {
    if (open) setKey("");
  }, [open]);

  const isDuplicate = existingKeys.includes(key);
  const isValid = key.trim().length > 0 && !isDuplicate;

  const handleAdd = () => {
    if (!isValid) return;
    onAdd(key.trim());
    onClose();
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
          <DialogTitle>Add Item — {filename}</DialogTitle>
          <DialogContent>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <Field
                label="Item key"
                validationMessage={isDuplicate ? `Key "${key}" already exists` : undefined}
                validationState={isDuplicate ? "error" : "none"}
              >
                <Input
                  value={key}
                  placeholder="e.g. my-agent"
                  onChange={(_, data) => setKey(data.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isValid) handleAdd();
                  }}
                />
              </Field>
              {isDuplicate && (
                <MessageBar intent="error">
                  <MessageBarBody>Key already exists in this file.</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={handleAdd} disabled={!isValid}>
              Add
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
