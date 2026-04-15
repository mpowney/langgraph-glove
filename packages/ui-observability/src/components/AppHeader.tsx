import React from "react";
import { Badge, Button, makeStyles, Text, tokens } from "@fluentui/react-components";

interface AppHeaderProps {
  title: string;
  subtitle: string;
  generatedAt?: string;
  onRefresh: () => void;
  onLogout: () => void;
  loading: boolean;
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background:
      "linear-gradient(120deg, rgba(255,122,0,0.18) 0%, rgba(255,91,79,0.22) 45%, rgba(0,166,161,0.2) 100%)",
  },
  left: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
  },
  right: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
  },
});

export function AppHeader(props: AppHeaderProps) {
  const styles = useStyles();

  return (
    <header className={styles.root}>
      <div className={styles.left}>
        <Text size={500} weight="semibold">{props.title}</Text>
        <Text>{props.subtitle}</Text>
      </div>
      <div className={styles.right}>
        {props.generatedAt ? <Badge>Updated {new Date(props.generatedAt).toLocaleTimeString()}</Badge> : null}
        <Button appearance="primary" onClick={props.onRefresh} disabled={props.loading}>
          Refresh Map
        </Button>
        <Button onClick={props.onLogout}>Log Out</Button>
      </div>
    </header>
  );
}
