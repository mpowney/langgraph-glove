import React, { useState, useRef, type KeyboardEvent } from "react";
import {
  makeStyles,
  tokens,
  Textarea,
  Button,
} from "@fluentui/react-components";
import { Send20Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "flex-end",
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXL}`,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    flexShrink: 0,
  },
  textarea: {
    flex: "1 1 auto",
    resize: "none",
  },
  sendButton: {
    flexShrink: 0,
    alignSelf: "flex-end",
  },
});

interface InputBarProps {
  onSend: (text: string) => void;
  disabled: boolean;
}

export function InputBar({ onSend, disabled }: InputBarProps) {
  const styles = useStyles();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={styles.root}>
      <Textarea
        ref={textareaRef}
        className={styles.textarea}
        value={value}
        onChange={(_, data) => setValue(data.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
        disabled={disabled}
        rows={1}
        aria-label="Message input"
        resize="vertical"
      />
      <Button
        className={styles.sendButton}
        appearance="primary"
        icon={<Send20Regular />}
        onClick={handleSend}
        disabled={disabled || !value.trim()}
        aria-label="Send message"
      >
        Send
      </Button>
    </div>
  );
}
