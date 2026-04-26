import React from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
} from "@fluentui/react-components";
import { ChevronRight24Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  root: {
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    flexShrink: 0,
  },
  title: {
    marginBottom: tokens.spacingVerticalXS,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  depItem: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
});

export interface DependentItem {
  label: string;
  file: string;
  key: string;
}

interface DependentsPanelProps {
  dependents: DependentItem[];
  onNavigateTo: (file: string, key: string) => void;
}

export function DependentsPanel({ dependents, onNavigateTo }: DependentsPanelProps) {
  const styles = useStyles();

  if (dependents.length === 0) return null;

  return (
    <div className={styles.root}>
      <Text size={100} weight="semibold" className={styles.title} style={{ color: tokens.colorNeutralForeground3 }}>
        Used by
      </Text>
      <div className={styles.list}>
        {dependents.map((dep) => (
          <div
            key={`${dep.file}:${dep.key}`}
            className={styles.depItem}
            onClick={() => onNavigateTo(dep.file, dep.key)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onNavigateTo(dep.file, dep.key);
            }}
          >
            <ChevronRight24Regular style={{ width: "12px", height: "12px", opacity: 0.5 }} />
            <Text size={100}>{dep.label}</Text>
            <Text size={100} style={{ color: tokens.colorNeutralForeground3, fontFamily: "Consolas, 'Courier New', monospace" }}>
              {dep.file}
            </Text>
          </div>
        ))}
      </div>
    </div>
  );
}
