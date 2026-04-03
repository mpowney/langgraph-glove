import React, { useEffect, useMemo, useState } from "react";
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Input,
  Textarea,
  Spinner,
  Divider,
  Badge,
  Field,
  Dropdown,
  Option,
  Switch,
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@fluentui/react-components";
import { Dismiss24Regular, ArrowClockwise24Regular, MoreHorizontal24Regular, Delete24Regular } from "@fluentui/react-icons";
import type { MemoryDocument, MemorySummary } from "../types";
import { useMemoryAdmin } from "../hooks/useMemoryAdmin";

const useStyles = makeStyles({
  layout: {
    display: "grid",
    gridTemplateColumns: "320px 1fr",
    gap: tokens.spacingHorizontalM,
    minHeight: 0,
    height: "100%",
    "@media (max-width: 900px)": {
      gridTemplateColumns: "1fr",
    },
  },
  column: {
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  listHeader: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS,
  },
  list: {
    overflowY: "auto",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  listItem: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  listItemSelected: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
  },
  listItemHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalXS,
  },
  itemTitle: {
    flexGrow: 1,
  },
  menuButton: {
    flexShrink: 0,
  },
  listMeta: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
  },
  listId: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    wordBreak: "break-all",
  },
  excerpt: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground2,
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflow: "hidden",
  },
  panel: {
    minHeight: 0,
    overflowY: "auto",
    paddingRight: tokens.spacingHorizontalS,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  formRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: tokens.spacingHorizontalS,
    "@media (max-width: 900px)": {
      gridTemplateColumns: "1fr",
    },
  },
  readOnlyBlock: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground2,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
  },
  readOnlyLine: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground2,
    wordBreak: "break-all",
  },
  actions: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    textAlign: "center",
    padding: tokens.spacingVerticalL,
  },
  deleteMessage: {
    marginTop: tokens.spacingVerticalS,
  },
});

interface MemoryAdminProps {
  open: boolean;
  onClose: () => void;
  memoryToolUrl?: string;
  /** Personal token for encrypted memory operations. Empty string = no token set. */
  personalToken?: string;
}

interface EditFormState {
  title: string;
  scope: string;
  tagsCsv: string;
  status: string;
  retentionTier: "hot" | "warm" | "cold";
  personal: boolean;
  content: string;
}

function toFormState(memory: MemoryDocument): EditFormState {
  return {
    title: memory.title,
    scope: memory.scope,
    tagsCsv: memory.tags.join(", "),
    status: memory.status,
    retentionTier: memory.retentionTier,
    personal: memory.personal,
    content: memory.content,
  };
}

function tagsFromCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function MemoryAdmin({ open, onClose, memoryToolUrl = "", personalToken = "" }: MemoryAdminProps) {
  const styles = useStyles();
  const {
    health,
    healthState,
    listState,
    searchState,
    detailState,
    saveState,
    deleteState,
    listError,
    searchError,
    detailError,
    saveError,
    deleteError,
    canDeleteMemory,
    memories,
    searchResults,
    selectedMemory,
    checkHealth,
    loadMemories,
    searchMemories,
    loadMemory,
    saveMemory,
    deleteMemory,
    clearSelection,
  } = useMemoryAdmin(memoryToolUrl);

  const [query, setQuery] = useState("");
  const [form, setForm] = useState<EditFormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemorySummary | null>(null);

  const hasToken = personalToken.trim().length > 0;

  useEffect(() => {
    if (!open) return;
    clearSelection();
    setForm(null);
    void (async () => {
      const available = await checkHealth();
      if (available) {
        await loadMemories();
      }
    })();
  }, [open, checkHealth, loadMemories, clearSelection]);

  useEffect(() => {
    if (selectedMemory) {
      setForm(toFormState(selectedMemory));
    }
  }, [selectedMemory]);

  const visibleMemories = useMemo(() => {
    if (!searchResults) return memories;
    return searchResults.results.map((result) => result.memory);
  }, [memories, searchResults]);

  const excerptsByMemoryId = useMemo(() => {
    const map = new Map<string, string>();
    for (const result of searchResults?.results ?? []) {
      const firstExcerpt = result.excerpts[0];
      if (firstExcerpt) {
        map.set(result.memory.id, firstExcerpt);
      }
    }
    return map;
  }, [searchResults]);

  const handleSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      await loadMemories();
      return;
    }
    await searchMemories(trimmed, personalToken);
  };

  const handleSelectMemory = async (memory: MemorySummary) => {
    await loadMemory(memory.id, personalToken);
  };

  const handleSave = async () => {
    if (!selectedMemory || !form) return;
    const saved = await saveMemory(selectedMemory.id, {
      title: form.title,
      scope: form.scope,
      tags: tagsFromCsv(form.tagsCsv),
      status: form.status,
      retentionTier: form.retentionTier,
      personal: form.personal,
      content: form.content,
    }, personalToken);
    if (saved) {
      setForm(toFormState(saved));
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const deletedMemoryId = deleteTarget.id;
    const ok = await deleteMemory(deletedMemoryId);
    if (ok) {
      if (selectedMemory?.id === deletedMemoryId) {
        setForm(null);
      }
      setDeleteTarget(null);
    }
  };

  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
      position="end"
      size="large"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={(
            <>
              <Button
                appearance="subtle"
                icon={<ArrowClockwise24Regular />}
                onClick={() => {
                  void checkHealth();
                  if (health.available) {
                    void loadMemories();
                  }
                }}
                aria-label="Refresh memory admin"
              />
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                onClick={onClose}
                aria-label="Close memory admin"
              />
            </>
          )}
        >
          Memory Admin
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {healthState === "loading" && <Spinner label="Checking memory tool availability…" />}
        {healthState !== "loading" && !health.available && (
          <Text className={styles.errorText}>
            Memory tool unavailable{health.reason ? `: ${health.reason}` : "."}
          </Text>
        )}

        {health.available && (
          <div className={styles.layout}>
            <div className={styles.column}>
              <div className={styles.listHeader}>
                <Input
                  value={query}
                  onChange={(_, data) => setQuery(data.value)}
                  placeholder="Search memories"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void handleSearch();
                    }
                  }}
                />
                <Button onClick={() => void handleSearch()} appearance="secondary">Search</Button>
              </div>
              {!hasToken && (
                <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                  Set a personal token (lock icon in the header) to access encrypted personal memories.
                </Text>
              )}
              {searchState === "error" && searchError && <Text className={styles.errorText}>{searchError}</Text>}
              {listState === "error" && listError && <Text className={styles.errorText}>{listError}</Text>}
              {(listState === "loading" || searchState === "loading") && <Spinner label="Loading memories…" />}
              <div className={styles.list}>
                {visibleMemories.length === 0 && listState === "idle" && searchState === "idle" && (
                  <Text className={styles.empty}>No memories found.</Text>
                )}
                {visibleMemories.map((memory, index) => (
                  <React.Fragment key={memory.id}>
                    {index > 0 && <Divider />}
                    <div
                      className={`${styles.listItem} ${selectedMemory?.id === memory.id ? styles.listItemSelected : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => void handleSelectMemory(memory)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          void handleSelectMemory(memory);
                        }
                      }}
                    >
                      <div className={styles.listItemHeader}>
                        <Text weight="semibold" className={styles.itemTitle}>{memory.title}</Text>
                        <Menu>
                          <MenuTrigger disableButtonEnhancement>
                            <Button
                              appearance="subtle"
                              icon={<MoreHorizontal24Regular />}
                              className={styles.menuButton}
                              aria-label={`Actions for ${memory.title}`}
                              onClick={(event) => event.stopPropagation()}
                            />
                          </MenuTrigger>
                          <MenuPopover>
                            <MenuList>
                              <MenuItem
                                icon={<Delete24Regular />}
                                disabled={!canDeleteMemory}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setDeleteTarget(memory);
                                }}
                              >
                                Delete
                              </MenuItem>
                            </MenuList>
                          </MenuPopover>
                        </Menu>
                      </div>
                      <Text className={styles.listId}>{memory.slug}</Text>
                      <div className={styles.listMeta}>
                        <Badge appearance="tint" size="small">{memory.scope}</Badge>
                        <Badge appearance="filled" size="small">{memory.retentionTier}</Badge>
                        {memory.personal && <Badge appearance="outline" size="small">personal</Badge>}
                      </div>
                      {excerptsByMemoryId.has(memory.id) && (
                        <Text className={styles.excerpt}>{excerptsByMemoryId.get(memory.id)}</Text>
                      )}
                    </div>
                  </React.Fragment>
                ))}
              </div>
            </div>

            <div className={styles.column}>
              {!selectedMemory && (
                <Text className={styles.empty}>Select a memory to inspect and edit its markdown attributes.</Text>
              )}
              {detailState === "loading" && <Spinner label="Loading memory…" />}
              {detailState === "error" && detailError && <Text className={styles.errorText}>{detailError}</Text>}

              {selectedMemory && form && (
                <div className={styles.panel}>
                  <div className={styles.readOnlyBlock}>
                    <Text className={styles.readOnlyLine}>id: {selectedMemory.id}</Text>
                    <Text className={styles.readOnlyLine}>slug: {selectedMemory.slug}</Text>
                    <Text className={styles.readOnlyLine}>storagePath: {selectedMemory.storagePath}</Text>
                    <Text className={styles.readOnlyLine}>createdAt: {selectedMemory.createdAt}</Text>
                    <Text className={styles.readOnlyLine}>updatedAt: {selectedMemory.updatedAt}</Text>
                    <Text className={styles.readOnlyLine}>revision: {selectedMemory.revision}</Text>
                  </div>

                  <div className={styles.formRow}>
                    <Field label="Title" required>
                      <Input
                        value={form.title}
                        onChange={(_, data) => setForm((prev) => prev ? { ...prev, title: data.value } : prev)}
                      />
                    </Field>
                    <Field label="Scope" required>
                      <Input
                        value={form.scope}
                        onChange={(_, data) => setForm((prev) => prev ? { ...prev, scope: data.value } : prev)}
                      />
                    </Field>
                  </div>

                  <div className={styles.formRow}>
                    <Field label="Tags (comma-separated)">
                      <Input
                        value={form.tagsCsv}
                        onChange={(_, data) => setForm((prev) => prev ? { ...prev, tagsCsv: data.value } : prev)}
                      />
                    </Field>
                    <Field label="Status">
                      <Input
                        value={form.status}
                        onChange={(_, data) => setForm((prev) => prev ? { ...prev, status: data.value } : prev)}
                      />
                    </Field>
                  </div>

                  <Field label="Retention tier">
                    <Dropdown
                      value={form.retentionTier}
                      selectedOptions={[form.retentionTier]}
                      onOptionSelect={(_, data) => {
                        const value = data.optionValue;
                        if (value === "hot" || value === "warm" || value === "cold") {
                          setForm((prev) => prev ? { ...prev, retentionTier: value } : prev);
                        }
                      }}
                    >
                      <Option value="hot">hot</Option>
                      <Option value="warm">warm</Option>
                      <Option value="cold">cold</Option>
                    </Dropdown>
                  </Field>

                  <Field label="Privacy">
                    <Switch
                      checked={form.personal}
                      label={form.personal ? "Personal (encrypted at rest)" : "Standard (unencrypted)"}
                      disabled={!hasToken}
                      onChange={(_, data) => setForm((prev) => prev ? { ...prev, personal: data.checked } : prev)}
                    />
                    {!hasToken && (
                      <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                        Set a personal token via the lock icon in the header to enable this.
                      </Text>
                    )}
                  </Field>

                  <Field label="Markdown content" required>
                    <Textarea
                      value={form.content}
                      onChange={(_, data) => setForm((prev) => prev ? { ...prev, content: data.value } : prev)}
                      rows={4}
                    />
                  </Field>

                  <div className={styles.actions}>
                    <Text className={styles.errorText}>{saveState === "error" ? saveError : ""}</Text>
                    <Button
                      appearance="primary"
                      disabled={saveState === "loading"}
                      onClick={() => void handleSave()}
                    >
                      {saveState === "loading" ? "Saving…" : "Save memory"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </DrawerBody>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(_, data) => {
          if (!data.open) {
            setDeleteTarget(null);
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete memory?</DialogTitle>
            <DialogContent>
              This will permanently delete
              {deleteTarget ? ` "${deleteTarget.title}"` : " this memory"}
              and remove its index entries.
              {deleteError && <Text className={`${styles.errorText} ${styles.deleteMessage}`}>{deleteError}</Text>}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setDeleteTarget(null)}
                disabled={deleteState === "loading"}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => void handleConfirmDelete()}
                disabled={deleteState === "loading" || !canDeleteMemory}
              >
                {deleteState === "loading" ? "Deleting..." : "Delete"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </OverlayDrawer>
  );
}
