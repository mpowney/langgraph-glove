import blessed from "blessed";
import { spawnSync } from "node:child_process";
import type { ToolProcessSupervisor } from "../supervisor/ToolProcessSupervisor.js";
import type { ToolRuntimeState } from "../supervisor/types.js";

const STATUS_ICON: Record<ToolRuntimeState["status"], string> = {
  idle: "○",
  starting: "◔",
  running: "●",
  stopping: "◑",
  stopped: "◌",
  failed: "✖",
};

const STATUS_COLOR: Record<ToolRuntimeState["status"], string> = {
  idle: "gray",
  starting: "yellow",
  running: "green",
  stopping: "yellow",
  stopped: "gray",
  failed: "red",
};

const FOOTER_CONTENT = [
  "Arrows: Navigate | Enter: Actions | R: Restart | S: Stop | L: Logs | Ctrl+D: Shutdown",
  "Dev-only manager. Production intent: run tools as Docker containers.",
].join("\n");

export class ToolManagerScreen {
  private readonly supervisor: ToolProcessSupervisor;
  private readonly screen: blessed.Widgets.Screen;
  private readonly list: blessed.Widgets.ListElement;
  private readonly summary: blessed.Widgets.BoxElement;
  private readonly footer: blessed.Widgets.BoxElement;
  private selectedToolKey = "";
  private shuttingDown = false;

  private isListFocused(): boolean {
    return this.screen.focused === this.list;
  }

  constructor(supervisor: ToolProcessSupervisor) {
    this.supervisor = supervisor;
    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: "Tool Manager",
    });

    this.summary = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      border: "line",
      label: " Tool Manager ",
      content: "Starting...",
    });

    this.list = blessed.list({
      parent: this.screen,
      top: 3,
      left: 0,
      width: "100%",
      height: "100%-7",
      border: "line",
      label: " Tools ",
      keys: true,
      mouse: true,
      tags: true,
      style: {
        selected: {
          bg: "blue",
          fg: "white",
        },
      },
      vi: true,
    });

    this.footer = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 4,
      border: "line",
      tags: true,
      content: FOOTER_CONTENT,
    });

    this.bindEvents();
  }

  async run(): Promise<void> {
    const disposeStatus = this.supervisor.onStatus(() => this.refresh());
    const disposeLogs = this.supervisor.onLog(() => this.refresh());
    this.refresh();
    this.list.focus();

    await new Promise<void>((resolve) => {
      const finish = async (): Promise<void> => {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        this.footer.setContent("Shutting down all tools...");
        this.screen.render();
        await this.supervisor.stopAll();
        disposeStatus();
        disposeLogs();
        this.screen.destroy();
        resolve();
      };

      this.screen.key(["C-c", "C-d"], () => {
        if (!this.isListFocused()) return;
        void finish();
      });

      this.screen.key(["q"], () => {
        if (!this.isListFocused()) return;
        void finish();
      });
    });
  }

  private bindEvents(): void {
    this.list.on("select", () => {
      const selected = this.getSelectedTool();
      if (!selected) return;
      this.selectedToolKey = selected.tool.key;
      this.refresh();
    });

    this.list.key(["up", "down", "j", "k"], () => {
      // Blessed updates list selection after key handling, so defer sync.
      setTimeout(() => {
        this.syncSelectionFromListCursor();
      }, 0);
    });

    this.screen.key(["enter"], () => {
      if (!this.isListFocused()) return;
      void this.openActionMenu();
    });

    this.screen.key(["l"], () => {
      if (!this.isListFocused()) return;
      void this.openLogViewer(this.getSelectedTool()?.tool.key);
    });

    this.screen.key(["s"], () => {
      if (!this.isListFocused()) return;
      const tool = this.getSelectedTool();
      if (!tool) return;
      void this.supervisor.stopTool(tool.tool.key);
    });

    this.screen.key(["r"], () => {
      if (!this.isListFocused()) return;
      const tool = this.getSelectedTool();
      if (!tool) return;
      void this.supervisor.restartTool(tool.tool.key);
    });
  }

  private refresh(): void {
    const states = this.supervisor.getStates().sort((a, b) => a.tool.key.localeCompare(b.tool.key));
    if (states.length === 0) {
      this.list.setItems(["No enabled tools found."]);
      this.screen.render();
      return;
    }

    if (!this.selectedToolKey || !states.some((state) => state.tool.key === this.selectedToolKey)) {
      this.selectedToolKey = states[0]?.tool.key ?? "";
    }

    const items = states.map((state) => {
      const color = STATUS_COLOR[state.status];
      const icon = STATUS_ICON[state.status];
      const pid = state.pid ? ` pid=${state.pid}` : "";
      const last = state.lastLine ? ` | ${state.lastLine.slice(0, 80)}` : "";
      return `{${color}-fg}${icon}{/${color}-fg} ${state.tool.key}${pid} [${state.status}]${last}`;
    });

    this.list.setItems(items);

    const selectedIndex = states.findIndex((state) => state.tool.key === this.selectedToolKey);
    if (selectedIndex >= 0) {
      this.list.select(selectedIndex);
    }

    const running = states.filter((state) => state.status === "running").length;
    const starting = states.filter((state) => state.status === "starting").length;
    const failed = states.filter((state) => state.status === "failed").length;
    const stopping = states.filter((state) => state.status === "stopping").length;

    this.summary.setContent(
      `Running: ${running}  Starting: ${starting}  Stopping: ${stopping}  Failed: ${failed}  Total: ${states.length}`,
    );

    this.screen.render();
  }

  private getSelectedTool(): ToolRuntimeState | undefined {
    const states = this.supervisor.getStates();
    if (states.length === 0) return undefined;

    const sorted = states.sort((a, b) => a.tool.key.localeCompare(b.tool.key));
    const selectedIndex = (this.list as unknown as { selected?: number }).selected;
    if (typeof selectedIndex === "number" && selectedIndex >= 0 && selectedIndex < sorted.length) {
      return sorted[selectedIndex];
    }

    const byKey = sorted.find((state) => state.tool.key === this.selectedToolKey);
    return byKey ?? sorted[0];
  }

  private syncSelectionFromListCursor(): void {
    const selected = this.getSelectedTool();
    if (!selected) return;
    if (selected.tool.key === this.selectedToolKey) return;

    this.selectedToolKey = selected.tool.key;
    this.refresh();
  }

  private async openActionMenu(): Promise<void> {
    const selected = this.getSelectedTool();
    if (!selected) return;

    const menu = blessed.list({
      parent: this.screen,
      width: 36,
      height: 8,
      top: "center",
      left: "center",
      border: "line",
      label: ` ${selected.tool.key} `,
      keys: true,
      mouse: true,
      style: {
        selected: {
          bg: "blue",
          fg: "white",
        },
      },
      items: ["View logs", "Stop process", "Restart process", "Cancel"],
    });

    menu.focus();
    this.screen.render();

    await new Promise<void>((resolve) => {
      const close = (): void => {
        menu.detach();
        this.list.focus();
        this.screen.render();
        resolve();
      };

      menu.once("select", (item) => {
        const action = item.getText();
        close();
        if (action.startsWith("View logs")) {
          void this.openLogViewer(selected.tool.key);
          return;
        }
        if (action.startsWith("Stop process")) {
          void this.supervisor.stopTool(selected.tool.key);
          return;
        }
        if (action.startsWith("Restart process")) {
          void this.supervisor.restartTool(selected.tool.key);
        }
      });

      menu.key(["escape", "q", "C-c"], () => close());
    });
  }

  private async openLogViewer(toolKey?: string): Promise<void> {
    if (!toolKey) return;
    const state = this.supervisor.getState(toolKey);
    if (!state) return;

    const box = blessed.box({
      parent: this.screen,
      top: 1,
      left: 1,
      width: "98%",
      height: "98%-2",
      border: "line",
      label: ` Logs: ${toolKey} `,
      keys: true,
      mouse: false,
      scrollable: true,
      alwaysScroll: true,
      tags: false,
      vi: true,
      content: state.logs.join("\n"),
    });

    let following = true;
    const footer = blessed.box({
      parent: box,
      bottom: 0,
      left: 0,
      width: "100%-2",
      height: 1,
      content: "Esc/Q close | Up/Down scroll | PgUp/PgDn | F follow | Y copy all logs",
    });

    // Temporarily disable terminal mouse reporting so macOS terminal text
    // selection and copy work naturally in the log viewer.
    this.screen.program.disableMouse();

    const unsubscribe = this.supervisor.onLog((nextTool, line) => {
      if (nextTool !== toolKey) return;
      box.setContent(`${box.getContent()}\n${line}`.trimStart());
      if (following) {
        box.setScrollPerc(100);
      }
      this.screen.render();
    });

    box.focus();
    box.setScrollPerc(100);
    this.screen.render();

    await new Promise<void>((resolve) => {
      const close = (): void => {
        unsubscribe();
        footer.detach();
        box.detach();
        this.screen.program.enableMouse();
        this.list.focus();
        this.screen.render();
        resolve();
      };

      box.key(["escape", "q"], () => close());
      box.key(["up"], () => {
        following = false;
        box.scroll(-1);
        this.screen.render();
      });
      box.key(["down"], () => {
        box.scroll(1);
        if (box.getScrollPerc() >= 99) {
          following = true;
        }
        this.screen.render();
      });
      box.key(["pageup"], () => {
        following = false;
        box.scroll(-15);
        this.screen.render();
      });
      box.key(["pagedown"], () => {
        box.scroll(15);
        if (box.getScrollPerc() >= 99) {
          following = true;
        }
        this.screen.render();
      });
      box.key(["f"], () => {
        following = !following;
        if (following) {
          box.setScrollPerc(100);
        }
        this.screen.render();
      });
      box.key(["y"], () => {
        const latestLogs = this.supervisor.getState(toolKey)?.logs.join("\n") ?? box.getContent();
        const copied = this.copyToClipboard(latestLogs);
        footer.setContent(copied ? "Copied all logs to clipboard" : "Clipboard unavailable (macOS uses pbcopy)");
        this.screen.render();
      });
    });
  }

  private copyToClipboard(text: string): boolean {
    if (!text) return false;

    if (process.platform === "darwin") {
      const result = spawnSync("pbcopy", { input: text, encoding: "utf8" });
      return !result.error && result.status === 0;
    }

    const linuxClipboardCommands = ["wl-copy", "xclip", "xsel"];
    for (const cmd of linuxClipboardCommands) {
      const whichResult = spawnSync("which", [cmd], { stdio: "ignore" });
      if (whichResult.status !== 0) continue;

      const args = cmd === "xclip" ? ["-selection", "clipboard"] : cmd === "xsel" ? ["--clipboard", "--input"] : [];
      const copyResult = spawnSync(cmd, args, { input: text, encoding: "utf8" });
      if (!copyResult.error && copyResult.status === 0) {
        return true;
      }
    }

    return false;
  }
}
