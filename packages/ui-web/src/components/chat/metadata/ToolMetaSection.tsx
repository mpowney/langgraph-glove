import React from "react";
import { makeStyles, tokens, Text } from "@fluentui/react-components";
import type { ToolEventMetadata } from "../../../types";
import { ParameterTable } from "../accordions/ParameterTable";

const useStyles = makeStyles({
  toolMetaSection: {
    marginTop: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  toolMetaLabel: {
    marginBottom: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
  },
  toolMetaDesc: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    marginBottom: tokens.spacingVerticalXS,
  },
});

interface ToolMetaSectionProps {
  meta: ToolEventMetadata;
}

export function ToolMetaSection({ meta }: ToolMetaSectionProps) {
  const styles = useStyles();
  const hasParams = meta.tool.parameters != null && typeof meta.tool.parameters === "object";

  return (
    <div className={styles.toolMetaSection}>
      <Text block className={styles.toolMetaLabel}>Parameter instructions</Text>
      {meta.tool.description && (
        <Text block className={styles.toolMetaDesc}>{meta.tool.description}</Text>
      )}
      {hasParams ? (
        <ParameterTable parameters={meta.tool.parameters as Record<string, unknown>} />
      ) : (
        <Text block className={styles.toolMetaDesc} style={{ fontStyle: "italic" }}>
          No parameter schema available
        </Text>
      )}
    </div>
  );
}
