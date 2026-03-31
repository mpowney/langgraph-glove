import React from "react";
import {
  Tooltip,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Button,
  makeStyles,
  tokens,
  mergeClasses,
} from "@fluentui/react-components";
import {
  MoreVertical20Regular,
  Open20Regular,
  Copy20Regular,
} from "@fluentui/react-icons";

const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

function isSafeHref(href: string): boolean {
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

const useStyles = makeStyles({
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
    verticalAlign: "middle",
  },
  link: {
    display: "inline-block",
    maxWidth: "140px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    textDecoration: "none",
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    border: `1px solid ${tokens.colorBrandStroke2}`,
    ":hover": {
      backgroundColor: tokens.colorBrandBackground2Hover,
      textDecoration: "underline",
    },
  },
  menuButton: {
    minWidth: "unset",
    width: "20px",
    height: "20px",
    padding: 0,
  },
  unsafeLink: {
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
    fontSize: tokens.fontSizeBase200,
  },
});

interface LinkPillProps {
  href: string;
  children: React.ReactNode;
}

export function LinkPill({ href, children }: LinkPillProps) {
  const styles = useStyles();

  if (!isSafeHref(href)) {
    // Render as plain text for non-http(s) hrefs to prevent XSS
    return <span className={styles.unsafeLink}>{children}</span>;
  }

  const openInNewTab = () => window.open(href, "_blank", "noopener,noreferrer");
  const copyLink = () => navigator.clipboard.writeText(href);

  return (
    <span className={styles.pill}>
      <Tooltip content={href} relationship="label" withArrow>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.link}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </a>
      </Tooltip>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Tooltip content="Link options" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<MoreVertical20Regular />}
              className={styles.menuButton}
              aria-label="Link options"
            />
          </Tooltip>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<Open20Regular />} onClick={openInNewTab}>
              Open in new tab
            </MenuItem>
            <MenuItem icon={<Copy20Regular />} onClick={copyLink}>
              Copy link URL
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    </span>
  );
}
