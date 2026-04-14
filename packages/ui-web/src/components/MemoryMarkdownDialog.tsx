import React from "react";
import {
  makeStyles,
  tokens,
  Button,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@fluentui/react-components";
import { MarkdownContent } from "./chat/content/MarkdownContent";

const useStyles = makeStyles({
  dialogSurface: {
    width: "92vw",
    maxWidth: "92vw",
    height: "88vh",
    maxHeight: "88vh",
    display: "flex",
    flexDirection: "column",
  },
  dialogBody: {
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    flex: 1,
  },
  dialogContent: {
    minHeight: 0,
    flex: 1,
    overflowY: "auto",
    paddingRight: tokens.spacingHorizontalS,
  },
});

interface MemoryMarkdownDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  content: string;
}

export function MemoryMarkdownDialog({
  open,
  onClose,
  title,
  content,
}: MemoryMarkdownDialogProps) {
  const styles = useStyles();

  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
      <DialogSurface className={styles.dialogSurface}>
        <DialogBody className={styles.dialogBody}>
          {/* <DialogTitle>{title}</DialogTitle> */}
          <DialogContent className={styles.dialogContent}>
            <MarkdownContent content={content} />
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}