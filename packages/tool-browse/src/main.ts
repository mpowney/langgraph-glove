import { launchToolServer } from "@langgraph-glove/tool-server";
import { screenshotToolMetadata, handleScreenshot } from "./tools/ScreenshotTool";
import { getContentToolMetadata, handleGetContent } from "./tools/GetContentTool";
import { checkBrowserHealth, closeBrowser } from "./browser";

const server = await launchToolServer({
  toolKey: "browse",
  healthCheck: () => checkBrowserHealth(),
  register(server) {
    server.register(screenshotToolMetadata, handleScreenshot);
    server.register(getContentToolMetadata, handleGetContent);
  },
});

// Ensure browser is cleaned up on shutdown
const origStop = server.stop.bind(server);
server.stop = async () => {
  await closeBrowser();
  await origStop();
};
