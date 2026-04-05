import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getToolPayload } from "../agent/toolPayloadCache";

const MAX_CHARS_CAP = 200_000;

export const getToolPayloadRefTool = tool(
  async ({ payloadRef, start, maxChars }) => {
    const payload = getToolPayload(payloadRef);
    if (!payload) {
      return {
        found: false,
        payloadRef,
        reason: "payload_ref_not_found",
      };
    }

    const safeStart = Math.max(0, start ?? 0);
    const requestedMax = maxChars ?? 20_000;
    const safeMax = Math.min(MAX_CHARS_CAP, Math.max(1, requestedMax));

    const chunk = payload.slice(safeStart, safeStart + safeMax);
    const end = safeStart + chunk.length;

    return {
      found: true,
      payloadRef,
      totalChars: payload.length,
      start: safeStart,
      end,
      hasMore: end < payload.length,
      chunk,
    };
  },
  {
    name: "glove_get_tool_payload",
    description:
      "Resolve a payloadRef from summarized tool output and return the original payload text in chunks.",
    schema: z.object({
      payloadRef: z.string().describe("Reference id from summarized tool output (e.g. tool_payload_...)."),
      start: z.number().int().nonnegative().optional().describe("Optional start index in characters. Default 0."),
      maxChars: z
        .number()
        .int()
        .positive()
        .max(MAX_CHARS_CAP)
        .optional()
        .describe("Maximum characters to return. Default 20000, hard cap 200000."),
    }),
  },
);
