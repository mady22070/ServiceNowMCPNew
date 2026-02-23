import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceNowClient } from "../servicenow/client.js";

export interface Pack {
  name: string;
  description: string;
  register(server: McpServer, client: ServiceNowClient): void;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function toolResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function jsonResult(data: unknown, label?: string): ToolResult {
  const prefix = label ? `${label}:\n` : "";
  return toolResult(prefix + JSON.stringify(data, null, 2));
}

export function errorResult(message: string): ToolResult {
  return toolResult(`Error: ${message}`, true);
}
