import { launchToolServer } from "@langgraph-glove/tool-server";
import { openToolMetadata, handleOpen } from "./tools/OpenTool.js";
import { getFieldsToolMetadata, handleGetFields } from "./tools/GetFieldsTool.js";
import { submitFormToolMetadata, handleSubmitForm } from "./tools/SubmitFormTool.js";
import { closeToolMetadata, handleClose } from "./tools/CloseTool.js";
import { sessionManager } from "./SessionManager.js";

const server = await launchToolServer({
  toolKey: "browse-session",
  register(server) {
    server.register(openToolMetadata, handleOpen);
    server.register(getFieldsToolMetadata, handleGetFields);
    server.register(submitFormToolMetadata, handleSubmitForm);
    server.register(closeToolMetadata, handleClose);
  },
});

// Ensure all sessions and the browser are cleaned up on shutdown
const origStop = server.stop.bind(server);
server.stop = async () => {
  await sessionManager.closeAll();
  await origStop();
};
