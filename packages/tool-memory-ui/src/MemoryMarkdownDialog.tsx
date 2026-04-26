import React from "react";
import {
  makeStyles,
  tokens,
  Button,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogContent,
  DialogActions,
} from "@fluentui/react-components";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

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
    flex: "1",
  },
  dialogContent: {
    minHeight: 0,
    flex: "1",
    overflowY: "auto",
    paddingRight: tokens.spacingHorizontalS,
    lineHeight: "1.6",
    wordBreak: "break-word",
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
  content,
}: MemoryMarkdownDialogProps) {
  const styles = useStyles();

  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
      <DialogSurface className={styles.dialogSurface}>
        <DialogBody className={styles.dialogBody}>
          <DialogContent className={styles.dialogContent}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {content}
            </ReactMarkdown>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
