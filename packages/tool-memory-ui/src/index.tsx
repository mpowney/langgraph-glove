import type { ToolPanelMeta, ToolPanelProps } from "./types.js";
import { MemoryAdmin } from "./MemoryAdmin.js";

export const meta: ToolPanelMeta = {
  serverKey: "memory",
  matchStrategy: "exact",
  label: "Memory",
  description: "Manage stored memories",
};

function MemoryPanel(props: ToolPanelProps) {
  const memoryToolUrl = props.adminApiBaseUrl
    ? `${props.adminApiBaseUrl.replace(/\/$/, "")}/api/tools/_memory`
    : "/api/tools/_memory";

  return (
    <MemoryAdmin
      open={props.open}
      onClose={props.onClose}
      memoryToolUrl={memoryToolUrl}
      authToken={props.authToken}
      personalToken={props.personalToken}
    />
  );
}

export default MemoryPanel;
