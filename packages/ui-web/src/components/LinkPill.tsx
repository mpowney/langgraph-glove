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
    padding: `2px ${tokens.spacingHorizontalXS} 2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke2}`,
    ":hover": {
      backgroundColor: tokens.colorBrandBackground2Hover,
    },
  },
  link: {
    display: "inline-block",
    maxWidth: "300px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorBrandForeground2,
    textDecoration: "none",
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    ":hover": {
      textDecoration: "underline",
    },
  },
  menuButton: {
    minWidth: "unset",
    width: "20px",
    height: "20px",
    padding: 0,
    color: tokens.colorBrandForeground2,
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
    <Tooltip content={href} relationship="label" withArrow>
      <span className={styles.pill}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.link}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </a>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button
              size="small"
              appearance="subtle"
              icon={<MoreVertical20Regular />}
              className={styles.menuButton}
              aria-label="Link options"
            />
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
    </Tooltip>
  );
}
