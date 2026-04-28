import {
  ExecuteToolScope,
  InferenceOperationType,
  InferenceScope,
  InvokeAgentScope,
  OutputScope,
  type AgentDetails,
  type Channel,
  type Request,
  type UserDetails,
} from "@microsoft/agents-a365-observability";
import type { ObserveSendPayload } from "@langgraph-glove/observe-server";

interface EndableScope {
  setEndTime: (endTime: number) => void;
  dispose: () => void;
}

interface ErrorRecordableScope extends EndableScope {
  recordError: (error: Error) => void;
}

interface InvokeScope extends ErrorRecordableScope {
  recordResponse: (response: string) => void;
}

interface ToolScope extends ErrorRecordableScope {
  recordResponse: (response: Record<string, unknown> | string) => void;
}

interface InferenceRecordableScope extends ErrorRecordableScope {
  recordInputMessages: (messages: string) => void;
  recordOutputMessages: (messages: string) => void;
  recordInputTokens: (inputTokens: number) => void;
  recordOutputTokens: (outputTokens: number) => void;
}

interface TrackedScope<T extends EndableScope> {
  scope: T;
  startedAtMs?: number;
}

export interface Agent365SdkBindings {
  startInvokeAgentScope: (
    request: Request,
    agentDetails: AgentDetails,
    userDetails: UserDetails | undefined,
    startTimeMs: number | undefined,
  ) => InvokeScope;
  startExecuteToolScope: (
    request: Request,
    toolName: string,
    toolCallId: string | undefined,
    args: Record<string, unknown> | string,
    agentDetails: AgentDetails,
    userDetails: UserDetails | undefined,
    startTimeMs: number | undefined,
  ) => ToolScope;
  startInferenceScope: (
    request: Request,
    model: string,
    providerName: string | undefined,
    agentDetails: AgentDetails,
    userDetails: UserDetails | undefined,
    startTimeMs: number | undefined,
  ) => InferenceRecordableScope;
  startOutputScope: (
    request: Request,
    messages: Record<string, unknown> | string,
    agentDetails: AgentDetails,
    userDetails: UserDetails | undefined,
    startTimeMs: number | undefined,
  ) => EndableScope;
}

interface InvokeAgentStartScope {
  scopeId?: string;
  phase?: string;
  input?: unknown;
  startedAt?: string;
  timestamp?: string;
  sourceChannel?: string;
}

interface InvokeAgentEndScope {
  scopeId?: string;
  phase?: string;
  output?: unknown;
  completedAt?: string;
  timestamp?: string;
}

interface InvokeAgentErrorScope {
  scopeId?: string;
  phase?: string;
  error?: unknown;
  timestamp?: string;
}

interface ExecuteToolStartScope {
  phase?: string;
  runId?: string;
  toolCallId?: string;
  arguments?: unknown;
  timestamp?: string;
}

interface ExecuteToolEndScope {
  phase?: string;
  runId?: string;
  result?: unknown;
  durationMs?: number;
  timestamp?: string;
}

interface ExecuteToolErrorScope {
  phase?: string;
  runId?: string;
  error?: unknown;
  durationMs?: number;
  timestamp?: string;
}

interface InferenceRequestScope {
  phase?: string;
  request?: unknown;
  timestamp?: string;
}

interface InferenceResponseScope {
  phase?: string;
  response?: unknown;
  timestamp?: string;
}

interface OutputScopePayload {
  output?: unknown;
  messages?: unknown;
  timestamp?: string;
}

export interface Agent365SdkIdentityConfig {
  tenantId: string;
  agentId: string;
  agentName?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
}

export class Agent365SdkIngressTranslator {
  private readonly invokeScopes = new Map<string, TrackedScope<InvokeScope>>();
  private readonly toolScopes = new Map<string, TrackedScope<ToolScope>>();
  private readonly inferenceScopes = new Map<string, TrackedScope<InferenceRecordableScope>>();
  private readonly agentDetails: AgentDetails;
  private readonly userDetails: UserDetails | undefined;

  constructor(
    private readonly identity: Agent365SdkIdentityConfig,
    private readonly bindings: Agent365SdkBindings = createDefaultSdkBindings(),
  ) {
    this.agentDetails = {
      agentId: identity.agentId,
      agentName: identity.agentName,
      tenantId: identity.tenantId,
      providerName: "az.ai.agent365",
    };

    this.userDetails = (identity.userId || identity.userName || identity.userEmail)
      ? {
          userId: identity.userId,
          userName: identity.userName,
          userEmail: identity.userEmail,
          tenantId: identity.tenantId,
        }
      : undefined;
  }

  ingest(payload: ObserveSendPayload): void {
    const { event } = payload;
    if (!event.scopeType || event.scope === undefined || event.scope === null) {
      return;
    }

    switch (event.scopeType) {
      case "InvokeAgent":
        this.handleInvokeAgent(event.conversationId, event.source, event.scope);
        break;
      case "ExecuteTool":
        this.handleExecuteTool(event.conversationId, event.source, event.toolName, event.scope);
        break;
      case "Inference":
        this.handleInference(event.conversationId, event.source, event.scope);
        break;
      case "Output":
        this.handleOutput(event.conversationId, event.source, event.scope);
        break;
      default:
        break;
    }
  }

  private handleInvokeAgent(
    conversationId: string,
    source: "agent" | "gateway",
    rawScope: unknown,
  ): void {
    if (!isRecord(rawScope)) return;
    const phase = asString(rawScope["phase"]);
    const scopeId = asString(rawScope["scopeId"]) || `invoke_${conversationId}_${Date.now()}`;

    if (phase === "start") {
      const scope = rawScope as InvokeAgentStartScope;
      const request = this.buildRequest(
        conversationId,
        scope.sourceChannel || source,
        normalizeMessageContent(scope.input),
      );
      const startTimeMs = parseTimestamp(scope.startedAt) ?? parseTimestamp(scope.timestamp);
      const invokeScope = this.bindings.startInvokeAgentScope(
        request,
        this.agentDetails,
        this.userDetails,
        startTimeMs,
      );
      this.invokeScopes.set(scopeId, {
        scope: invokeScope,
        startedAtMs: startTimeMs,
      });
      return;
    }

    const tracked = this.invokeScopes.get(scopeId);
    if (!tracked) {
      return;
    }

    if (phase === "end") {
      const scope = rawScope as InvokeAgentEndScope;
      if (scope.output !== undefined) {
        tracked.scope.recordResponse(normalizeMessageContent(scope.output));
      }
      this.endTrackedScope(tracked, scope.completedAt ?? scope.timestamp);
      this.invokeScopes.delete(scopeId);
      return;
    }

    if (phase === "error") {
      const scope = rawScope as InvokeAgentErrorScope;
      tracked.scope.recordError(new Error(stringifyUnknown(scope.error)));
      this.endTrackedScope(tracked, scope.timestamp);
      this.invokeScopes.delete(scopeId);
    }
  }

  private handleExecuteTool(
    conversationId: string,
    source: "agent" | "gateway",
    toolName: string | undefined,
    rawScope: unknown,
  ): void {
    if (!isRecord(rawScope)) return;
    const phase = asString(rawScope["phase"]);
    const runId = asString(rawScope["runId"]);
    if (!runId) return;

    if (phase === "start") {
      const scope = rawScope as ExecuteToolStartScope;
      const request = this.buildRequest(conversationId, source);
      const startTimeMs = parseTimestamp(scope.timestamp);
      const toolScope = this.bindings.startExecuteToolScope(
        request,
        toolName || "unknown-tool",
        scope.toolCallId,
        normalizeObjectOrString(scope.arguments),
        this.agentDetails,
        this.userDetails,
        startTimeMs,
      );
      this.toolScopes.set(runId, {
        scope: toolScope,
        startedAtMs: startTimeMs,
      });
      return;
    }

    const tracked = this.toolScopes.get(runId);
    if (!tracked) {
      return;
    }

    if (phase === "end") {
      const scope = rawScope as ExecuteToolEndScope;
      if (scope.result !== undefined) {
        tracked.scope.recordResponse(normalizeObjectOrString(scope.result));
      }
      this.endTrackedScope(tracked, scope.timestamp, scope.durationMs);
      this.toolScopes.delete(runId);
      return;
    }

    if (phase === "error") {
      const scope = rawScope as ExecuteToolErrorScope;
      tracked.scope.recordError(new Error(stringifyUnknown(scope.error)));
      this.endTrackedScope(tracked, scope.timestamp, scope.durationMs);
      this.toolScopes.delete(runId);
    }
  }

  private handleInference(
    conversationId: string,
    source: "agent" | "gateway",
    rawScope: unknown,
  ): void {
    if (!isRecord(rawScope)) return;
    const phase = asString(rawScope["phase"]);
    const key = `${conversationId}:${source}`;

    if (phase === "request") {
      const scope = rawScope as InferenceRequestScope;
      const request = this.buildRequest(conversationId, source);
      const model = extractModelName(scope.request);
      const providerName = extractProviderName(scope.request);
      const startTimeMs = parseTimestamp(scope.timestamp);

      const inferenceScope = this.bindings.startInferenceScope(
        request,
        model,
        providerName,
        this.agentDetails,
        this.userDetails,
        startTimeMs,
      );

      if (scope.request !== undefined) {
        inferenceScope.recordInputMessages(normalizeMessageContent(scope.request));
      }

      this.inferenceScopes.set(key, {
        scope: inferenceScope,
        startedAtMs: startTimeMs,
      });
      return;
    }

    const tracked = this.inferenceScopes.get(key);
    if (!tracked) {
      return;
    }

    if (phase === "response") {
      const scope = rawScope as InferenceResponseScope;
      if (scope.response !== undefined) {
        tracked.scope.recordOutputMessages(normalizeMessageContent(scope.response));
        const usage = extractUsage(scope.response);
        if (typeof usage.inputTokens === "number") {
          tracked.scope.recordInputTokens(usage.inputTokens);
        }
        if (typeof usage.outputTokens === "number") {
          tracked.scope.recordOutputTokens(usage.outputTokens);
        }
      }
      this.endTrackedScope(tracked, scope.timestamp);
      this.inferenceScopes.delete(key);
      return;
    }

    if (phase === "error") {
      tracked.scope.recordError(new Error(stringifyUnknown(rawScope["error"])));
      this.endTrackedScope(tracked, asString(rawScope["timestamp"]));
      this.inferenceScopes.delete(key);
    }
  }

  private handleOutput(
    conversationId: string,
    source: "agent" | "gateway",
    rawScope: unknown,
  ): void {
    if (!isRecord(rawScope)) return;
    const scope = rawScope as OutputScopePayload;
    const responsePayload = scope.messages ?? scope.output;
    if (responsePayload === undefined) return;

    const outputScope = this.bindings.startOutputScope(
      this.buildRequest(conversationId, source),
      normalizeResponseMessages(responsePayload),
      this.agentDetails,
      this.userDetails,
      parseTimestamp(scope.timestamp),
    );
    outputScope.setEndTime(parseTimestamp(scope.timestamp) ?? Date.now());
    outputScope.dispose();
  }

  private buildRequest(
    conversationId: string,
    channelName: string,
    content?: string,
  ): Request {
    const channel: Channel = {
      name: channelName,
    };

    return {
      conversationId,
      channel,
      ...(content !== undefined ? { content } : {}),
    };
  }

  private endTrackedScope(
    tracked: TrackedScope<EndableScope>,
    timestamp: string | undefined,
    durationMs?: number,
  ): void {
    const endTimeMs = parseTimestamp(timestamp)
      ?? (typeof durationMs === "number" && tracked.startedAtMs !== undefined
        ? tracked.startedAtMs + Math.max(0, durationMs)
        : Date.now());

    tracked.scope.setEndTime(endTimeMs);
    tracked.scope.dispose();
  }
}

function createDefaultSdkBindings(): Agent365SdkBindings {
  return {
    startInvokeAgentScope: (request, agentDetails, userDetails, startTimeMs) => InvokeAgentScope.start(
      request,
      {},
      agentDetails,
      userDetails ? { userDetails } : undefined,
      {
        startTime: startTimeMs,
      },
    ),
    startExecuteToolScope: (
      request,
      toolName,
      toolCallId,
      args,
      agentDetails,
      userDetails,
      startTimeMs,
    ) => ExecuteToolScope.start(
      request,
      {
        toolName,
        toolCallId,
        arguments: args,
      },
      agentDetails,
      userDetails,
      {
        startTime: startTimeMs,
      },
    ),
    startInferenceScope: (
      request,
      model,
      providerName,
      agentDetails,
      userDetails,
      startTimeMs,
    ) => InferenceScope.start(
      request,
      {
        operationName: InferenceOperationType.CHAT,
        model,
        providerName,
      },
      agentDetails,
      userDetails,
      {
        startTime: startTimeMs,
      },
    ),
    startOutputScope: (
      request,
      messages,
      agentDetails,
      userDetails,
      startTimeMs,
    ) => OutputScope.start(
      request,
      {
        messages,
      },
      agentDetails,
      userDetails,
      {
        startTime: startTimeMs,
      },
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function normalizeMessageContent(value: unknown): string {
  if (typeof value === "string") return value;
  return stringifyUnknown(value);
}

function normalizeObjectOrString(value: unknown): Record<string, unknown> | string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return value;
  return stringifyUnknown(value);
}

function normalizeResponseMessages(value: unknown): Record<string, unknown> | string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return value;
  return stringifyUnknown(value);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractModelName(requestPayload: unknown): string {
  if (!isRecord(requestPayload)) return "unknown-model";
  const fromModel = asString(requestPayload["model"]);
  if (fromModel) return fromModel;
  const fromModelName = asString(requestPayload["modelName"]);
  if (fromModelName) return fromModelName;
  const metadata = requestPayload["metadata"];
  if (isRecord(metadata)) {
    return asString(metadata["model"]) || asString(metadata["modelName"]) || "unknown-model";
  }
  return "unknown-model";
}

function extractProviderName(requestPayload: unknown): string | undefined {
  if (!isRecord(requestPayload)) return undefined;
  const fromProvider = asString(requestPayload["provider"]);
  if (fromProvider) return fromProvider;
  const metadata = requestPayload["metadata"];
  if (isRecord(metadata)) {
    return asString(metadata["provider"]);
  }
  return undefined;
}

function extractUsage(responsePayload: unknown): {
  inputTokens?: number;
  outputTokens?: number;
} {
  if (!isRecord(responsePayload)) return {};

  const usage = responsePayload["usage"];
  if (!isRecord(usage)) return {};

  const inputTokens = numberMaybe(usage["input_tokens"]) ?? numberMaybe(usage["prompt_tokens"]);
  const outputTokens = numberMaybe(usage["output_tokens"]) ?? numberMaybe(usage["completion_tokens"]);

  return {
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
  };
}

function numberMaybe(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}