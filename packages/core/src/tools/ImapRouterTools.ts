import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RpcClient } from "../rpc/RpcClient";
import type { ToolDefinition, ToolMetadata } from "../rpc/RpcProtocol";
import { jsonSchemaToZodObject } from "./RemoteTool.js";

export interface ImapRouterInstanceConfig {
  key: string;
  displayName?: string;
  transport: "http" | "unix-socket";
  crawlMode?: string;
  indexingStrategy?: string;
  indexDbPath?: string;
  client: RpcClient;
  metadata: ToolMetadata[];
}

interface ImapRouterBuildResult {
  tools: StructuredToolInterface[];
  toolDefinitions: ToolDefinition[];
  toolNames: string[];
}

const IMAP_INSTANCE_LIST_TOOL_NAME = "imap_list_instances";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripInstanceSuffix(description: string): string {
  return description.replace(/\s+IMAP instance:\s+.+\.$/, "").trim();
}

function buildInstanceDescription(instances: ImapRouterInstanceConfig[]): string {
  return instances
    .map((instance) => instance.displayName?.trim()
      ? `${instance.key} (${instance.displayName.trim()})`
      : instance.key)
    .join(", ");
}

function buildInstanceSchema(instances: ImapRouterInstanceConfig[]): z.ZodEnum<[string, ...string[]]> {
  const values = instances.map((instance) => instance.key) as [string, ...string[]];
  return z.enum(values).describe(
    `Configured IMAP instance key. Available instances: ${buildInstanceDescription(instances)}.`,
  );
}

function augmentJsonSchemaWithInstance(
  parameters: Record<string, unknown>,
  instances: ImapRouterInstanceConfig[],
): Record<string, unknown> {
  const properties = isRecord(parameters.properties) ? parameters.properties : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];

  return {
    ...parameters,
    type: "object",
    properties: {
      ...properties,
      instance: {
        type: "string",
        enum: instances.map((instance) => instance.key),
        description: `Configured IMAP instance key. Available instances: ${buildInstanceDescription(instances)}.`,
      },
    },
    required: required.includes("instance") ? required : ["instance", ...required],
  };
}

function decorateEmailRecord(
  value: unknown,
  instance: ImapRouterInstanceConfig,
): Record<string, unknown> | unknown {
  if (!isRecord(value)) return value;
  const id = typeof value.id === "string" ? value.id : undefined;
  return {
    ...value,
    instance: instance.key,
    toolKey: instance.key,
    displayName: instance.displayName,
    ...(id ? { qualifiedId: `${instance.key}:${id}` } : {}),
  };
}

function decorateImapResult(
  method: string,
  instance: ImapRouterInstanceConfig,
  result: unknown,
): unknown {
  if (!isRecord(result)) {
    return {
      instance: instance.key,
      toolKey: instance.key,
      displayName: instance.displayName,
      value: result,
    };
  }

  if (method === "imap_search" && Array.isArray(result.results)) {
    return {
      ...result,
      instance: instance.key,
      toolKey: instance.key,
      displayName: instance.displayName,
      results: result.results.map((entry) => {
        if (!isRecord(entry)) return entry;
        return {
          ...entry,
          instance: instance.key,
          displayName: instance.displayName,
          email: decorateEmailRecord(entry.email, instance),
        };
      }),
    };
  }

  if (method === "imap_get_thread" && Array.isArray(result.emails)) {
    return {
      ...result,
      instance: instance.key,
      toolKey: instance.key,
      displayName: instance.displayName,
      emails: result.emails.map((entry) => decorateEmailRecord(entry, instance)),
    };
  }

  return {
    ...result,
    instance: instance.key,
    toolKey: instance.key,
    displayName: instance.displayName,
    ...(typeof result.id === "string" ? { qualifiedId: `${instance.key}:${result.id}` } : {}),
  };
}

function buildListInstancesToolDefinition(instances: ImapRouterInstanceConfig[]): ToolDefinition {
  return {
    name: IMAP_INSTANCE_LIST_TOOL_NAME,
    description:
      "List the configured IMAP instances and their display names before using instance-specific IMAP tools.",
    parameters: {
      type: "object",
      properties: {},
    },
  };
}

function buildRoutedToolDefinition(
  metadata: ToolMetadata,
  instances: ImapRouterInstanceConfig[],
): ToolDefinition {
  return {
    ...metadata,
    description:
      `${stripInstanceSuffix(metadata.description)} Use the instance parameter to select the mailbox backend.`,
    parameters: augmentJsonSchemaWithInstance(metadata.parameters, instances),
  };
}

export function createImapRouterTools(
  instances: ImapRouterInstanceConfig[],
): ImapRouterBuildResult {
  if (instances.length === 0) {
    return { tools: [], toolDefinitions: [], toolNames: [] };
  }

  const instanceSchema = buildInstanceSchema(instances);
  const instanceByKey = new Map(instances.map((instance) => [instance.key, instance]));
  const metadataByName = new Map<string, ToolMetadata>();

  for (const instance of instances) {
    for (const metadata of instance.metadata) {
      if (metadata.name === IMAP_INSTANCE_LIST_TOOL_NAME) continue;
      if (!metadata.name.startsWith("imap_")) continue;
      if (!metadataByName.has(metadata.name)) {
        metadataByName.set(metadata.name, metadata);
      }
    }
  }

  const routedDefinitions = [...metadataByName.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((metadata) => buildRoutedToolDefinition(metadata, instances));

  const routedTools = routedDefinitions.map((definition) => {
    const baseSchema = jsonSchemaToZodObject(definition.parameters);
    const schema = baseSchema.extend({
      instance: instanceSchema,
    });

    const routedTool = tool(
      async (input) => {
        const rawInput = input as Record<string, unknown>;
        const instanceKey = typeof rawInput.instance === "string" ? rawInput.instance : "";
        const instance = instanceByKey.get(instanceKey);
        if (!instance) {
          throw new Error(`Unknown IMAP instance \"${String(instanceKey)}\"`);
        }

        const args = { ...rawInput };
        delete args.instance;
        const result = await instance.client.call(definition.name, args);
        return decorateImapResult(definition.name, instance, result);
      },
      {
        name: definition.name,
        description: definition.description,
        schema,
      },
    );

    // Preserve non-schema tool capability flags used by runtime arg injection.
    const capabilityTarget = routedTool as StructuredToolInterface & {
      supportsContentUpload?: boolean;
      requiresPrivilegedAccess?: boolean;
    };
    capabilityTarget.supportsContentUpload = definition.supportsContentUpload === true;
    capabilityTarget.requiresPrivilegedAccess = definition.requiresPrivilegedAccess === true;

    return routedTool;
  });

  const listInstancesTool = tool(
    async () => ({
      count: instances.length,
      instances: instances.map((instance) => ({
        key: instance.key,
        displayName: instance.displayName,
        transport: instance.transport,
        crawlMode: instance.crawlMode ?? "continuous-sync",
        indexingStrategy: instance.indexingStrategy ?? "immediate",
        indexDbPath: instance.indexDbPath,
      })),
    }),
    {
      name: IMAP_INSTANCE_LIST_TOOL_NAME,
      description:
        "List the configured IMAP instances and their display names before using instance-specific IMAP tools.",
      schema: z.object({}),
    },
  );

  const toolDefinitions = [buildListInstancesToolDefinition(instances), ...routedDefinitions];
  const toolNames = toolDefinitions.map((definition) => definition.name);

  return {
    tools: [listInstancesTool, ...routedTools],
    toolDefinitions,
    toolNames,
  };
}
