#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  try {
    const config = loadConfig();

    console.error(`[ServiceNow MCP] Connecting to: ${config.instanceUrl}`);
    console.error(`[ServiceNow MCP] Auth method: ${config.auth.type}`);
    console.error(`[ServiceNow MCP] Enabled packs: ${config.enabledPacks.join(", ")}`);

    const server = createServer(config);
    const transport = new StdioServerTransport();

    await server.connect(transport);

    console.error("[ServiceNow MCP] Server started successfully");
  } catch (error) {
    console.error("[ServiceNow MCP] Fatal error:", error);
    process.exit(1);
  }
}

main();
