import { makeStyles, tokens } from "@fluentui/react-components";

export const useConversationBrowserStyles = makeStyles({
  headerActions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalM} 0`,
    overflowY: "auto",
  },
  conversationItem: {
    display: "flex",
    flexDirection: "column",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  conversationId: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    wordBreak: "break-all",
  },
  conversationTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    lineHeight: tokens.lineHeightBase300,
    wordBreak: "break-word",
  },
  conversationMeta: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    marginTop: tokens.spacingVerticalXXS,
  },
  messageItem: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    borderLeft: `3px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  roleUser: {
    borderLeftColor: tokens.colorBrandBackground,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  roleAgent: {
    borderLeftColor: tokens.colorNeutralStrokeAccessible,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rolePrompt: {
    borderLeftColor: tokens.colorNeutralStroke2,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  roleToolCall: {
    borderLeftColor: tokens.colorPaletteYellowBorder1,
    backgroundColor: tokens.colorPaletteYellowBackground1,
  },
  roleToolResult: {
    borderLeftColor: tokens.colorPaletteGreenBorder1,
    backgroundColor: tokens.colorPaletteGreenBackground1,
  },
  roleAgentTransfer: {
    borderLeftColor: tokens.colorPaletteBerryBorder1,
    backgroundColor: tokens.colorPaletteBerryBackground1,
  },
  roleModelCall: {
    borderLeftColor: tokens.colorPaletteDarkOrangeBorder1,
    backgroundColor: tokens.colorPaletteDarkOrangeBackground1,
  },
  roleModelResponse: {
    borderLeftColor: tokens.colorPaletteMarigoldBorder1,
    backgroundColor: tokens.colorPaletteMarigoldBackground1,
  },
  roleGraphDefinition: {
    borderLeftColor: tokens.colorPaletteLightGreenBorder1,
    backgroundColor: tokens.colorPaletteLightGreenBackground1,
  },
  roleSystem: {
    borderLeftColor: tokens.colorNeutralStroke1,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  roleError: {
    borderLeftColor: tokens.colorPaletteRedBorder1,
    backgroundColor: tokens.colorPaletteRedBackground1,
  },
  messageRole: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: tokens.colorNeutralForeground3,
  },
  messageContent: {
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    color: tokens.colorNeutralForeground1,
    maxHeight: "220px",
    overflowY: "auto",
  },
  messageTimestamp: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    fontStyle: "italic",
  },
  toolCallChip: {
    display: "inline-block",
    padding: `1px ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground4,
    fontSize: tokens.fontSizeBase100,
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground2,
    marginRight: tokens.spacingHorizontalXS,
  },
  empty: {
    padding: tokens.spacingVerticalL,
    textAlign: "center",
    color: tokens.colorNeutralForeground3,
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  threadTitle: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    wordBreak: "break-all",
    padding: `0 ${tokens.spacingHorizontalM}`,
  },
  feedbackRow: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS,
  },
});
