import { launchToolServer } from "@langgraph-glove/tool-server";
import { openToolMetadata, handleOpen } from "./tools/OpenTool";
import { getFieldsToolMetadata, handleGetFields } from "./tools/GetFieldsTool";
import { submitFormToolMetadata, handleSubmitForm } from "./tools/SubmitFormTool";
import { closeToolMetadata, handleClose } from "./tools/CloseTool";
import { checkSessionBrowserHealth, sessionManager } from "./SessionManager";

const server = await launchToolServer({
  toolKey: "browse-session",
  healthCheck: () => checkSessionBrowserHealth(),
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
