import { describe, expect, it, vi } from "vitest";
import type { ObserveSendPayload } from "@langgraph-glove/observe-server";
import {
  Agent365SdkIngressTranslator,
  type Agent365SdkBindings,
} from "../../../packages/observe-agent365/src/sdkIngressTranslator.js";

function buildPayload(scopeType: "InvokeAgent" | "ExecuteTool" | "Inference" | "Output", scope: unknown): ObserveSendPayload {
  return {
    moduleKey: "agent365-http",
    event: {
      eventId: "evt-1",
      timestamp: "2026-04-28T00:00:00.000Z",
      conversationId: "conv-1",
      role: "system-event",
      source: "agent",
      text: "scope",
      scopeType,
      scope,
    },
  };
}

describe("Agent365SdkIngressTranslator", () => {
  it("maps InvokeAgent start/end into SDK scope lifecycle", () => {
    const invoke = createInvokeScope();
    const translator = new Agent365SdkIngressTranslator({
      tenantId: "tenant-1",
      agentId: "agent-1",
      agentName: "orchestrator",
      userId: "user-1",
    }, createBindings({ invoke }));

    translator.ingest(buildPayload("InvokeAgent", {
      scopeId: "invoke-1",
      phase: "start",
      input: "Hello",
      startedAt: "2026-04-28T00:00:00.000Z",
      sourceChannel: "web",
    }));

    translator.ingest(buildPayload("InvokeAgent", {
      scopeId: "invoke-1",
      phase: "end",
      output: "Done",
      completedAt: "2026-04-28T00:00:01.000Z",
    }));

    expect(invoke.recordResponse).toHaveBeenCalledWith("Done");
    expect(invoke.setEndTime).toHaveBeenCalledTimes(1);
    expect(invoke.dispose).toHaveBeenCalledTimes(1);
  });

  it("maps ExecuteTool start/error into SDK scope lifecycle", () => {
    const tool = createToolScope();
    const translator = new Agent365SdkIngressTranslator({
      tenantId: "tenant-1",
      agentId: "agent-1",
    }, createBindings({ tool }));

    const startPayload = buildPayload("ExecuteTool", {
      phase: "start",
      runId: "tool-run-1",
      toolCallId: "call-1",
      arguments: { q: "weather" },
      timestamp: "2026-04-28T00:00:00.000Z",
    });
    startPayload.event.toolName = "search";

    translator.ingest(startPayload);

    translator.ingest(buildPayload("ExecuteTool", {
      phase: "error",
      runId: "tool-run-1",
      error: "tool failed",
      timestamp: "2026-04-28T00:00:01.000Z",
    }));

    expect(tool.recordError).toHaveBeenCalledTimes(1);
    expect(tool.dispose).toHaveBeenCalledTimes(1);
  });

  it("maps Inference request/response and records usage", () => {
    const inference = createInferenceScope();
    const translator = new Agent365SdkIngressTranslator({
      tenantId: "tenant-1",
      agentId: "agent-1",
    }, createBindings({ inference }));

    translator.ingest(buildPayload("Inference", {
      phase: "request",
      request: {
        model: "gpt-5.3-codex",
        provider: "openai",
        messages: [{ role: "user", content: "hello" }],
      },
      timestamp: "2026-04-28T00:00:00.000Z",
    }));

    translator.ingest(buildPayload("Inference", {
      phase: "response",
      response: {
        content: "hi",
        usage: {
          input_tokens: 12,
          output_tokens: 8,
        },
      },
      timestamp: "2026-04-28T00:00:01.000Z",
    }));

    expect(inference.recordInputMessages).toHaveBeenCalledTimes(1);
    expect(inference.recordOutputMessages).toHaveBeenCalledTimes(1);
    expect(inference.recordInputTokens).toHaveBeenCalledWith(12);
    expect(inference.recordOutputTokens).toHaveBeenCalledWith(8);
    expect(inference.dispose).toHaveBeenCalledTimes(1);
  });

  it("maps Output scope as single-span output emission", () => {
    const output = createOutputScope();
    const translator = new Agent365SdkIngressTranslator({
      tenantId: "tenant-1",
      agentId: "agent-1",
    }, createBindings({ output }));

    translator.ingest(buildPayload("Output", {
      messages: "final answer",
      timestamp: "2026-04-28T00:00:00.000Z",
    }));

    expect(output.setEndTime).toHaveBeenCalledTimes(1);
    expect(output.dispose).toHaveBeenCalledTimes(1);
  });
});

function createInvokeScope() {
  return {
    recordResponse: vi.fn(),
    recordError: vi.fn(),
    setEndTime: vi.fn(),
    dispose: vi.fn(),
  };
}

function createToolScope() {
  return {
    recordResponse: vi.fn(),
    recordError: vi.fn(),
    setEndTime: vi.fn(),
    dispose: vi.fn(),
  };
}

function createInferenceScope() {
  return {
    recordInputMessages: vi.fn(),
    recordOutputMessages: vi.fn(),
    recordInputTokens: vi.fn(),
    recordOutputTokens: vi.fn(),
    recordError: vi.fn(),
    setEndTime: vi.fn(),
    dispose: vi.fn(),
  };
}

function createOutputScope() {
  return {
    setEndTime: vi.fn(),
    dispose: vi.fn(),
  };
}

function createBindings(scopes: {
  invoke?: ReturnType<typeof createInvokeScope>;
  tool?: ReturnType<typeof createToolScope>;
  inference?: ReturnType<typeof createInferenceScope>;
  output?: ReturnType<typeof createOutputScope>;
}): Agent365SdkBindings {
  return {
    startInvokeAgentScope: () => scopes.invoke ?? createInvokeScope(),
    startExecuteToolScope: () => scopes.tool ?? createToolScope(),
    startInferenceScope: () => scopes.inference ?? createInferenceScope(),
    startOutputScope: () => scopes.output ?? createOutputScope(),
  };
}
