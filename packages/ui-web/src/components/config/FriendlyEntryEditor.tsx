import React from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Field,
  Input,
  Dropdown,
  Option,
  Switch,
  Textarea,
} from "@fluentui/react-components";
import { Add24Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  friendlyEntry: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} 0`,
  },
  friendlyEntryKey: {
    fontWeight: tokens.fontWeightSemibold,
    fontFamily: "Consolas, 'Courier New', monospace",
  },
  friendlyField: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  listEditor: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  listRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  listInput: {
    flex: 1,
  },
  secretHighlight: {
    fontFamily: "Consolas, 'Courier New', monospace",
    color: tokens.colorPaletteGreenForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
});

const MODEL_PROVIDER_OPTIONS = [
  "openai",
  "anthropic",
  "google",
  "ollama",
  "openai-compatible",
] as const;

function toDisplayLabel(fieldKey: string): string {
  return fieldKey.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

function updateObjectField(
  onChange: (key: string, newValue: unknown) => void,
  entryKey: string,
  obj: Record<string, unknown>,
  fieldKey: string,
  newValue: unknown,
): void {
  onChange(entryKey, { ...obj, [fieldKey]: newValue });
}

function AgentModelKeyField({
  entryKey,
  obj,
  modelKeys,
  onChange,
}: {
  entryKey: string;
  obj: Record<string, unknown>;
  modelKeys: string[];
  onChange: (key: string, newValue: unknown) => void;
}) {
  const currentValue = typeof obj.modelKey === "string" ? obj.modelKey : "";
  const hasKnownValue = currentValue !== "" && modelKeys.includes(currentValue);
  const selectedValue = hasKnownValue ? currentValue : "__custom__";

  return (
    <Field label="Model key">
      <div style={{ display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS }}>
        <Dropdown
          placeholder="Select model key"
          value={selectedValue === "__custom__" ? "Custom value" : currentValue}
          selectedOptions={selectedValue ? [selectedValue] : []}
          onOptionSelect={(_, data) => {
            const value = data.optionValue;
            if (!value || value === "__custom__") return;
            updateObjectField(onChange, entryKey, obj, "modelKey", value);
          }}
        >
          {modelKeys.map((modelKey) => (
            <Option key={modelKey} value={modelKey}>
              {modelKey}
            </Option>
          ))}
          <Option value="__custom__">Custom value</Option>
        </Dropdown>
        {selectedValue === "__custom__" && (
          <Input
            value={currentValue}
            placeholder="Enter custom model key"
            onChange={(_, data) =>
              updateObjectField(onChange, entryKey, obj, "modelKey", data.value)
            }
          />
        )}
      </div>
    </Field>
  );
}

function AgentToolsField({
  entryKey,
  obj,
  onChange,
}: {
  entryKey: string;
  obj: Record<string, unknown>;
  onChange: (key: string, newValue: unknown) => void;
}) {
  const styles = useStyles();
  const tools = Array.isArray(obj.tools)
    ? obj.tools.map((tool) => (typeof tool === "string" ? tool : String(tool)))
    : [];

  const setTools = (nextTools: string[]) => {
    updateObjectField(onChange, entryKey, obj, "tools", nextTools);
  };

  return (
    <Field label="Tools">
      <div className={styles.listEditor}>
        {tools.map((tool, index) => (
          <div key={`${entryKey}-tool-${index}`} className={styles.listRow}>
            <Input
              className={styles.listInput}
              value={tool}
              placeholder="Tool name"
              onChange={(_, data) => {
                const nextTools = [...tools];
                nextTools[index] = data.value;
                setTools(nextTools);
              }}
            />
            <Button
              appearance="subtle"
              aria-label={`Remove tool ${index + 1}`}
              onClick={() => setTools(tools.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          appearance="secondary"
          icon={<Add24Regular />}
          onClick={() => setTools([...tools, ""])}
        >
          Add tool
        </Button>
      </div>
    </Field>
  );
}

function ModelProviderField({
  entryKey,
  obj,
  onChange,
}: {
  entryKey: string;
  obj: Record<string, unknown>;
  onChange: (key: string, newValue: unknown) => void;
}) {
  const currentValue = typeof obj.provider === "string" ? obj.provider : "";

  return (
    <Field label="Provider">
      <Dropdown
        placeholder="Select provider"
        value={currentValue}
        selectedOptions={currentValue ? [currentValue] : []}
        onOptionSelect={(_, data) => {
          if (data.optionValue) {
            updateObjectField(onChange, entryKey, obj, "provider", data.optionValue);
          }
        }}
      >
        {MODEL_PROVIDER_OPTIONS.map((provider) => (
          <Option key={provider} value={provider}>
            {provider}
          </Option>
        ))}
      </Dropdown>
    </Field>
  );
}

function ModelThinkField({
  entryKey,
  obj,
  onChange,
}: {
  entryKey: string;
  obj: Record<string, unknown>;
  onChange: (key: string, newValue: unknown) => void;
}) {
  const checked = Boolean(obj.think);

  return (
    <Field label="Think">
      <Switch
        checked={checked}
        label={checked ? "Enabled" : "Disabled"}
        onChange={(_, data) =>
          updateObjectField(onChange, entryKey, obj, "think", data.checked)
        }
      />
    </Field>
  );
}

function ModelBaseUrlField({
  entryKey,
  obj,
  onChange,
}: {
  entryKey: string;
  obj: Record<string, unknown>;
  onChange: (key: string, newValue: unknown) => void;
}) {
  const currentValue = typeof obj.baseUrl === "string" ? obj.baseUrl : "";

  return (
    <Field label="Base Url">
      <Input
        value={currentValue}
        placeholder="https://example.com"
        onChange={(_, data) =>
          updateObjectField(onChange, entryKey, obj, "baseUrl", data.value)
        }
      />
    </Field>
  );
}

interface FriendlyEntryEditorProps {
  filename: string;
  entryKey: string;
  value: unknown;
  modelKeys: string[];
  /** Names of active secrets (used to highlight {SECRET:name} placeholders) */
  activeSecretNames?: string[];
  onChange: (key: string, newValue: unknown) => void;
}

/** Render a field value string, highlighting {SECRET:name} references in green. */
function HighlightedSecretValue({
  value,
  activeSecretNames,
}: {
  value: string;
  activeSecretNames: string[];
}) {
  const styles = useStyles();
  if (activeSecretNames.length === 0) return <>{value}</>;

  // Split on {SECRET:name} references
  const parts: React.ReactNode[] = [];
  let remaining = value;
  let idx = 0;
  const pattern = /\{SECRET:([a-zA-Z0-9_-]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const before = value.slice(idx, match.index);
    if (before) parts.push(before);
    const secretName = match[1] ?? "";
    const isActive = activeSecretNames.includes(secretName);
    parts.push(
      <span key={match.index} className={isActive ? styles.secretHighlight : undefined}>
        {match[0]}
      </span>,
    );
    idx = match.index + match[0].length;
  }

  const after = value.slice(idx);
  if (after) parts.push(after);

  return <>{parts}</>;
}

/** Simple friendly view for a single config entry. */
export function FriendlyEntryEditor({
  filename,
  entryKey,
  value,
  modelKeys,
  activeSecretNames = [],
  onChange,
}: FriendlyEntryEditorProps) {
  const styles = useStyles();

  if (typeof value !== "object" || value === null) {
    return (
      <div className={styles.friendlyEntry}>
        <Text className={styles.friendlyEntryKey}>{entryKey}</Text>
        <Field label={entryKey}>
          <Textarea
            value={String(value)}
            onChange={(_, data) => onChange(entryKey, data.value)}
            rows={1}
          />
        </Field>
      </div>
    );
  }

  const obj = value as Record<string, unknown>;

  const renderTypedField = (fieldKey: string) => {
    if (filename === "agents.json" && fieldKey === "modelKey") {
      return (
        <AgentModelKeyField
          entryKey={entryKey}
          obj={obj}
          modelKeys={modelKeys}
          onChange={onChange}
        />
      );
    }
    if (filename === "agents.json" && fieldKey === "tools") {
      return <AgentToolsField entryKey={entryKey} obj={obj} onChange={onChange} />;
    }
    if (filename === "models.json" && fieldKey === "provider") {
      return <ModelProviderField entryKey={entryKey} obj={obj} onChange={onChange} />;
    }
    if (filename === "models.json" && fieldKey === "think") {
      return <ModelThinkField entryKey={entryKey} obj={obj} onChange={onChange} />;
    }
    if (filename === "models.json" && fieldKey === "baseUrl") {
      return <ModelBaseUrlField entryKey={entryKey} obj={obj} onChange={onChange} />;
    }
    return null;
  };

  return (
    <div className={styles.friendlyEntry}>
      <Text className={styles.friendlyEntryKey}>{entryKey}</Text>
      {Object.entries(obj).map(([fieldKey, fieldValue]) => {
        const typedField = renderTypedField(fieldKey);
        if (typedField) {
          return (
            <div key={fieldKey} className={styles.friendlyField}>
              {typedField}
            </div>
          );
        }

        const fieldLabel = toDisplayLabel(fieldKey);
        const stringValue =
          typeof fieldValue === "string"
            ? fieldValue
            : typeof fieldValue === "number" || typeof fieldValue === "boolean"
              ? String(fieldValue)
              : JSON.stringify(fieldValue, null, 2);

        const isLong =
          typeof fieldValue === "object" ||
          (typeof fieldValue === "string" && fieldValue.length > 80);

        return (
          <div key={fieldKey} className={styles.friendlyField}>
            <Field
              label={
                <span>
                  {fieldLabel}
                </span>
              }
            >
              <Textarea
                value={stringValue}
                rows={isLong ? 4 : 1}
                onChange={(_, data) => {
                  let parsed: unknown = data.value;
                  if (typeof fieldValue === "number") {
                    parsed = Number(data.value);
                  } else if (typeof fieldValue === "boolean") {
                    parsed = data.value === "true";
                  } else if (typeof fieldValue === "object") {
                    try {
                      parsed = JSON.parse(data.value);
                    } catch {
                      parsed = data.value;
                    }
                  }
                  onChange(entryKey, { ...obj, [fieldKey]: parsed });
                }}
              />
              {typeof fieldValue === "string" && activeSecretNames.length > 0 && (
                <span style={{ fontSize: tokens.fontSizeBase100, marginTop: tokens.spacingVerticalXXS }}>
                  <HighlightedSecretValue
                    value={fieldValue}
                    activeSecretNames={activeSecretNames}
                  />
                </span>
              )}
            </Field>
          </div>
        );
      })}
    </div>
  );
}
