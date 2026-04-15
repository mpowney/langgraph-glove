import React from "react";
import {
  makeStyles,
  mergeClasses,
  tokens,
  Text,
  Button,
  Tooltip,
} from "@fluentui/react-components";
import { Add24Regular, ChevronRight24Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  root: {
    width: "180px",
    flexShrink: 0,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
  },
  list: {
    flex: 1,
    overflowY: "auto",
  },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    cursor: "pointer",
    gap: tokens.spacingHorizontalXS,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  itemSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    ":hover": {
      backgroundColor: tokens.colorBrandBackground2Hover,
    },
  },
  itemKey: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "Consolas, 'Courier New', monospace",
  },
  addButton: {
    margin: tokens.spacingHorizontalS,
  },
});

interface ConfigItemNavProps {
  filename: string;
  itemKeys: string[];
  selectedKey: string | null;
  onSelectKey: (key: string) => void;
  onAddItem: () => void;
}

export function ConfigItemNav({
  filename,
  itemKeys,
  selectedKey,
  onSelectKey,
  onAddItem,
}: ConfigItemNavProps) {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text size={100} weight="semibold" style={{ color: tokens.colorNeutralForeground3 }}>
          {filename}
        </Text>
        <Tooltip content="Add item" relationship="label">
          <Button
            appearance="subtle"
            icon={<Add24Regular />}
            size="small"
            onClick={onAddItem}
          />
        </Tooltip>
      </div>
      <div className={styles.list}>
        {itemKeys.map((key) => (
          <div
            key={key}
            className={mergeClasses(
              styles.item,
              selectedKey === key && styles.itemSelected,
            )}
            onClick={() => onSelectKey(key)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelectKey(key);
            }}
            aria-selected={selectedKey === key}
            aria-label={key}
          >
            <Text size={200} className={styles.itemKey}>
              {key}
            </Text>
            <ChevronRight24Regular
              style={{ width: "12px", height: "12px", opacity: 0.5, flexShrink: 0 }}
            />
          </div>
        ))}
      </div>
      <Button
        appearance="transparent"
        icon={<Add24Regular />}
        size="small"
        className={styles.addButton}
        onClick={onAddItem}
      >
        Add item
      </Button>
    </div>
  );
}
