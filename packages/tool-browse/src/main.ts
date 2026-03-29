import { launchToolServer } from "@langgraph-glove/tool-server";
import { screenshotToolMetadata, handleScreenshot } from "./tools/ScreenshotTool.js";
import { getContentToolMetadata, handleGetContent } from "./tools/GetContentTool.js";
import { closeBrowser } from "./browser.js";

const server = await launchToolServer({
  toolKey: "browse",
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
