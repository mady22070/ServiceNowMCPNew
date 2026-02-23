import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServiceNowConfig } from "./config.js";
import { ServiceNowClient } from "./servicenow/client.js";
import { registerPacks, listPacks } from "./packs/registry.js";
import { jsonResult } from "./packs/types.js";

export function createServer(config: ServiceNowConfig): McpServer {
  const server = new McpServer({
    name: "servicenow-mcp-server",
    version: "1.0.0",
  });

  const client = new ServiceNowClient(config);

  // ── Meta tool: list available packs ──────────────────────────────────

  server.tool(
    "snow_list_packs",
    `List all available ServiceNow MCP tool packs and their enabled status.
Use this to discover what capabilities are available.`,
    {},
    async () => {
      const all = listPacks();
      const enabled = new Set(config.enabledPacks.map((p) => p.toLowerCase()));
      const packInfo = all.map((p) => ({
        ...p,
        enabled: enabled.has(p.name.toLowerCase()),
      }));
      return jsonResult(packInfo, "Available ServiceNow MCP Tool Packs");
    }
  );

  // ── Meta tool: generic table query ───────────────────────────────────

  server.tool(
    "snow_query_table",
    `Generic ServiceNow table query. Use when no specific pack tool covers your use case.
Performs a direct Table API query with full control over parameters.
Best practices:
- Always use sysparm_fields to limit returned fields (performance).
- Use sysparm_limit to avoid pulling too much data.
- Use encoded queries for complex filters.`,
    {
      table: z.string().describe("Table name (e.g. sys_user, incident, cmdb_ci)"),
      action: z.enum(["list", "get", "create", "update", "delete"]).describe("CRUD operation"),
      sys_id: z.string().optional().describe("Record sys_id for get/update/delete"),
      query: z.string().optional().describe("Encoded query string"),
      fields: z.string().optional().describe("Comma-separated field list"),
      display_value: z.enum(["true", "false", "all"]).optional(),
      data: z.record(z.unknown()).optional().describe("Record data for create/update"),
      limit: z.number().optional(),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "list": {
            const records = await client.getRecords(args.table, {
              sysparm_query: args.query,
              sysparm_fields: args.fields,
              sysparm_limit: args.limit || client.pageSize,
              sysparm_display_value: args.display_value || "true",
              sysparm_exclude_reference_link: "true",
            });
            return jsonResult(records, `Found ${records.length} records in ${args.table}`);
          }
          case "get": {
            if (!args.sys_id) return jsonResult(null, "Error: sys_id required for get");
            const record = await client.getRecord(args.table, args.sys_id, {
              sysparm_display_value: args.display_value || "all",
            });
            return jsonResult(record, `${args.table} record`);
          }
          case "create": {
            if (!args.data) return jsonResult(null, "Error: data required for create");
            const created = await client.createRecord(args.table, args.data as Record<string, unknown>);
            return jsonResult(created, `Record created in ${args.table}`);
          }
          case "update": {
            if (!args.sys_id || !args.data) return jsonResult(null, "Error: sys_id and data required for update");
            const updated = await client.updateRecord(args.table, args.sys_id, args.data as Record<string, unknown>);
            return jsonResult(updated, `Record updated in ${args.table}`);
          }
          case "delete": {
            if (!args.sys_id) return jsonResult(null, "Error: sys_id required for delete");
            await client.deleteRecord(args.table, args.sys_id);
            return jsonResult({ deleted: true, sys_id: args.sys_id }, `Record deleted from ${args.table}`);
          }
        }
      } catch (e) {
        return jsonResult({ error: e instanceof Error ? e.message : String(e) }, "Error");
      }
    }
  );

  // ── Meta tool: execute background script ─────────────────────────────

  server.tool(
    "snow_execute_script",
    `Execute a server-side background script on the ServiceNow instance.
Requires admin or script execution role.
Use with caution — this runs arbitrary server-side JavaScript.
Always test in sub-production first.`,
    {
      script: z.string().describe("Server-side JavaScript to execute"),
    },
    async (args) => {
      try {
        const result = await client.executeScript(args.script);
        return jsonResult({ output: result }, "Script execution result");
      } catch (e) {
        return jsonResult({ error: e instanceof Error ? e.message : String(e) }, "Script execution failed");
      }
    }
  );

  // ── Register enabled packs ───────────────────────────────────────────

  registerPacks(server, client, config.enabledPacks);

  return server;
}
