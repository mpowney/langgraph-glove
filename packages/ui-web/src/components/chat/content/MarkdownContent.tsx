import React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { makeStyles, tokens } from "@fluentui/react-components";
import { LinkPill } from "./LinkPill";

const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: [...(defaultSchema.protocols?.href ?? []), "sandbox"],
  },
};

function urlTransform(url: string): string {
  if (url.startsWith("sandbox:/mnt/data/")) {
    return url;
  }
  return defaultUrlTransform(url);
}

const useStyles = makeStyles({
  root: {
    lineHeight: "1.6",
    wordBreak: "break-word",
    "& p": {
      marginBottom: tokens.spacingVerticalS,
    },
    "& p:last-child": {
      marginBottom: 0,
    },
    "& h1, & h2, & h3, & h4, & h5, & h6": {
      fontWeight: tokens.fontWeightSemibold,
      marginTop: tokens.spacingVerticalM,
      marginBottom: tokens.spacingVerticalXS,
      lineHeight: "1.3",
    },
    "& h1": { fontSize: tokens.fontSizeBase600 },
    "& h2": { fontSize: tokens.fontSizeBase500 },
    "& h3": { fontSize: tokens.fontSizeBase400 },
    "& ul, & ol": {
      paddingLeft: tokens.spacingHorizontalXL,
      marginBottom: tokens.spacingVerticalS,
    },
    "& li": {
      marginBottom: tokens.spacingVerticalXXS,
    },
    "& code": {
      fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
      fontSize: "0.875em",
      backgroundColor: tokens.colorNeutralBackground3,
      padding: `1px ${tokens.spacingHorizontalXS}`,
      borderRadius: tokens.borderRadiusSmall,
    },
    "& pre": {
      backgroundColor: tokens.colorNeutralBackground3,
      padding: tokens.spacingVerticalM,
      borderRadius: tokens.borderRadiusMedium,
      overflowX: "auto",
      marginBottom: tokens.spacingVerticalS,
    },
    "& pre code": {
      backgroundColor: "transparent",
      padding: 0,
    },
    "& blockquote": {
      borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
      paddingLeft: tokens.spacingHorizontalM,
      marginLeft: 0,
      color: tokens.colorNeutralForeground3,
    },
    "& table": {
      borderCollapse: "collapse",
      width: "100%",
      marginBottom: tokens.spacingVerticalS,
    },
    "& th, & td": {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
      textAlign: "left",
    },
    "& th": {
      backgroundColor: tokens.colorNeutralBackground3,
      fontWeight: tokens.fontWeightSemibold,
    },
    "& hr": {
      border: "none",
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
      margin: `${tokens.spacingVerticalM} 0`,
    },
  },
});

interface MarkdownContentProps {
  content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        urlTransform={urlTransform}
        components={{
          // Replace standard <a> with LinkPill
          a({ href, children }) {
            return <LinkPill href={href ?? ""}>{children}</LinkPill>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
