import React from "react";
import { makeStyles, tokens, Text } from "@fluentui/react-components";

const useStyles = makeStyles({
  paramTable: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: tokens.fontSizeBase200,
    marginTop: tokens.spacingVerticalXS,
  },
  paramTh: {
    textAlign: "left",
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    verticalAlign: "top",
  },
  paramTd: {
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    verticalAlign: "top",
    color: tokens.colorNeutralForeground1,
  },
  paramName: {
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorBrandForeground1,
  },
  paramTypeCell: {
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
  },
  paramRequired: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
  },
  paramDesc: {
    color: tokens.colorNeutralForeground2,
  },
  noParams: {
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
    fontSize: tokens.fontSizeBase200,
    marginTop: tokens.spacingVerticalXS,
  },
});

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type?: string };
}

function resolveType(prop: JsonSchemaProperty): string {
  if (prop.enum) return prop.enum.map((v) => `"${v}"`).join(" | ");
  if (prop.type === "array") {
    const itemType = prop.items?.type ?? "unknown";
    return `${itemType}[]`;
  }
  return prop.type ?? "unknown";
}

interface ParameterRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

function extractParams(parameters: Record<string, unknown>): ParameterRow[] {
  const props = parameters["properties"] as Record<string, JsonSchemaProperty> | undefined;
  if (!props) return [];
  const required = new Set((parameters["required"] as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, prop]) => ({
    name,
    type: resolveType(prop),
    required: required.has(name),
    description: prop.description ?? "",
  }));
}

export function ParameterTable({ parameters }: { parameters: Record<string, unknown> }) {
  const styles = useStyles();
  const rows = extractParams(parameters);
  if (rows.length === 0) {
    return <Text className={styles.noParams}>No parameters</Text>;
  }
  return (
    <table className={styles.paramTable}>
      <thead>
        <tr>
          <th className={styles.paramTh}>Parameter</th>
          <th className={styles.paramTh}>Type</th>
          <th className={styles.paramTh}>Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <td className={styles.paramTd}>
              <span className={styles.paramName}>{row.name}</span>
              {row.required && (
                <span className={styles.paramRequired}> *</span>
              )}
            </td>
            <td className={`${styles.paramTd} ${styles.paramTypeCell}`}>{row.type}</td>
            <td className={`${styles.paramTd} ${styles.paramDesc}`}>{row.description || <em>—</em>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
