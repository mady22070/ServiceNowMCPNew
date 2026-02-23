import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceNowClient } from "../../servicenow/client.js";
import { type Pack, toolResult, jsonResult, errorResult } from "../types.js";

export class ItomPack implements Pack {
  name = "itom";
  description =
    "IT Operations Management — events, alerts, MID server management, discovery, CMDB health, and service mapping";

  register(server: McpServer, client: ServiceNowClient): void {
    this.registerEvents(server, client);
    this.registerAlerts(server, client);
    this.registerMIDServers(server, client);
    this.registerDiscovery(server, client);
    this.registerCMDBHealth(server, client);
    this.registerServiceMapping(server, client);
    this.registerAgentClientCollector(server, client);
  }

  // ── Events ───────────────────────────────────────────────────────────

  private registerEvents(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itom_events",
      `Manage ServiceNow events (em_event).
Actions: list, get, create, close.
Best practices:
- Events are raw data; alerts are deduplicated/correlated events.
- Use event rules for automated alert creation and enrichment.
- Set proper severity: 1=Critical, 2=Major, 3=Minor, 4=Warning, 5=OK/Clear.
- Include CI information (node, ci_identifier) for CMDB correlation.
- Use event_class to categorize by source (Nagios, SCOM, Datadog, custom).
- Send Clear (severity=5) events to auto-close corresponding alerts.
- Include resolution_state for event deduplication.`,
      {
        action: z.enum(["list", "get", "create", "close"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        data: z
          .object({
            source: z.string().optional().describe("Event source system"),
            node: z.string().optional().describe("Hostname or IP of the affected CI"),
            event_class: z.string().optional().describe("Event classification"),
            resource: z.string().optional().describe("Specific resource affected"),
            metric_name: z.string().optional(),
            type: z.string().optional().describe("Event type"),
            severity: z.enum(["1", "2", "3", "4", "5"]).optional().describe("1=Critical, 2=Major, 3=Minor, 4=Warning, 5=Clear"),
            description: z.string().optional(),
            additional_info: z.string().optional().describe("JSON string with extra event data"),
            ci_identifier: z.string().optional().describe("CI lookup identifier"),
            message_key: z.string().optional().describe("Deduplication key"),
            resolution_state: z.string().optional().describe("New or Closing"),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("em_event", {
                sysparm_query: args.query || "state=ready^ORDERBYDESCsys_created_on",
                sysparm_fields:
                  "sys_id,source,node,event_class,resource,severity,description,state,alert,sys_created_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} events`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("em_event", args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "Event details");
            }
            case "create": {
              if (!args.data?.source || !args.data?.node) {
                return errorResult("data.source and data.node required");
              }
              const created = await client.createRecord("em_event", {
                ...args.data,
                severity: args.data.severity || "4",
                resolution_state: args.data.resolution_state || "New",
              });
              return jsonResult(created, "Event created. Event rules will process and potentially create an alert.");
            }
            case "close": {
              if (!args.sys_id) return errorResult("sys_id required");
              const updated = await client.updateRecord("em_event", args.sys_id, { state: "closing" });
              return jsonResult(updated, "Event set to closing state");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Alerts ───────────────────────────────────────────────────────────

  private registerAlerts(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itom_alerts",
      `Manage ServiceNow alerts (em_alert).
Actions: list, get, acknowledge, close, create_incident, list_secondary_events.
Best practices:
- Alerts are correlated/deduplicated events — manage alerts, not raw events.
- Acknowledge alerts to indicate someone is working on them.
- Use alert management rules for automated remediation.
- Link alerts to incidents for ITSM integration.
- Monitor alert flapping (repeated open/close cycles) — indicates unstable CIs.
- Group related alerts using alert correlation rules.
- Set maintenance schedules to suppress expected alerts during maintenance windows.`,
      {
        action: z.enum(["list", "get", "acknowledge", "close", "create_incident", "list_secondary_events"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        data: z
          .object({
            acknowledged_by: z.string().optional(),
            close_notes: z.string().optional(),
          })
          .optional(),
        incident_data: z
          .object({
            short_description: z.string().optional(),
            assignment_group: z.string().optional(),
            impact: z.enum(["1", "2", "3"]).optional(),
            urgency: z.enum(["1", "2", "3"]).optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("em_alert", {
                sysparm_query: args.query || "active=true^ORDERBYDESCseverity",
                sysparm_fields:
                  "sys_id,number,source,node,cmdb_ci,severity,state,acknowledged,description,group_source,maintenance_schedule,sys_created_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} alerts`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("em_alert", args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "Alert details");
            }
            case "acknowledge": {
              if (!args.sys_id) return errorResult("sys_id required");
              const updated = await client.updateRecord("em_alert", args.sys_id, {
                acknowledged: true,
              });
              return jsonResult(updated, "Alert acknowledged");
            }
            case "close": {
              if (!args.sys_id) return errorResult("sys_id required");
              const updated = await client.updateRecord("em_alert", args.sys_id, {
                state: "Closed",
                close_notes: args.data?.close_notes || "Closed via MCP",
              });
              return jsonResult(updated, "Alert closed");
            }
            case "create_incident": {
              if (!args.sys_id) return errorResult("sys_id required");
              // Get alert details first
              const alert = await client.getRecord("em_alert", args.sys_id);
              const incidentData = {
                short_description: args.incident_data?.short_description || `Alert: ${alert.description || alert.source}`,
                assignment_group: args.incident_data?.assignment_group || "",
                impact: args.incident_data?.impact || "2",
                urgency: args.incident_data?.urgency || "2",
                cmdb_ci: alert.cmdb_ci as string || "",
                caller_id: "system",
                description: `Auto-created from alert ${alert.number || args.sys_id}\n\nNode: ${alert.node}\nSource: ${alert.source}\nSeverity: ${alert.severity}\nDescription: ${alert.description}`,
              };
              const incident = await client.createRecord("incident", incidentData);
              // Link alert to incident
              await client.updateRecord("em_alert", args.sys_id, {
                incident: incident.sys_id,
              });
              return jsonResult(incident, "Incident created from alert and linked");
            }
            case "list_secondary_events": {
              if (!args.sys_id) return errorResult("sys_id required");
              const events = await client.getRecords("em_event", {
                sysparm_query: `alert=${args.sys_id}`,
                sysparm_fields: "sys_id,source,node,severity,description,state,sys_created_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(events, `Found ${events.length} events for this alert`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── MID Servers ──────────────────────────────────────────────────────

  private registerMIDServers(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itom_mid_servers",
      `Manage ServiceNow MID Servers (ecc_agent).
Actions: list, get, check_status, list_issues, validate.
Best practices:
- Monitor MID server status regularly — Down status blocks discovery and integrations.
- Keep MID servers updated to match instance version.
- Use MID server clusters for high availability.
- Monitor ECC queue for stuck messages (ecc_queue).
- Check MID server logs for Java heap issues and connectivity problems.
- Use IP ranges to distribute workload across multiple MID servers.`,
      {
        action: z.enum(["list", "get", "check_status", "list_issues", "validate"]),
        sys_id: z.string().optional(),
        name: z.string().optional().describe("MID server name"),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("ecc_agent", {
                sysparm_query: args.query || "ORDERBYname",
                sysparm_fields: "sys_id,name,status,validated,host_name,ip_address,version,router,sys_updated_on",
                sysparm_limit: args.limit || 30,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} MID servers`);
            }
            case "get": {
              const id = args.sys_id || (args.name ? await this.resolveMidByName(client, args.name) : undefined);
              if (!id) return errorResult("sys_id or name required");
              const record = await client.getRecord("ecc_agent", id, { sysparm_display_value: "all" });
              return jsonResult(record, "MID server details");
            }
            case "check_status": {
              const query = args.name ? `name=${args.name}` : "status!=Up";
              const records = await client.getRecords("ecc_agent", {
                sysparm_query: query,
                sysparm_fields: "sys_id,name,status,validated,host_name,last_refreshed,sys_updated_on",
                sysparm_limit: args.limit || 30,
                sysparm_display_value: "true",
              });
              const down = records.filter((r) => r.status !== "Up");
              const summary = down.length > 0
                ? `WARNING: ${down.length} MID server(s) not in Up status: ${down.map((r) => `${r.name} (${r.status})`).join(", ")}`
                : `All ${records.length} queried MID servers are Up`;
              return jsonResult({ summary, servers: records }, summary);
            }
            case "list_issues": {
              const issues = await client.getRecords("ecc_agent_issue", {
                sysparm_query: args.query || "ORDERBYDESCsys_created_on",
                sysparm_fields: "sys_id,mid_server,issue_type,description,severity,sys_created_on",
                sysparm_limit: args.limit || 30,
                sysparm_display_value: "true",
              });
              return jsonResult(issues, `Found ${issues.length} MID server issues`);
            }
            case "validate": {
              if (!args.sys_id && !args.name) return errorResult("sys_id or name required");
              const id = args.sys_id || (await this.resolveMidByName(client, args.name!));
              if (!id) return errorResult("MID server not found");
              // Trigger validation by updating validated field
              const result = await client.updateRecord("ecc_agent", id, { validated: "revalidating" });
              return jsonResult(result, "MID server validation triggered. Check status after a few minutes.");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Discovery ────────────────────────────────────────────────────────

  private registerDiscovery(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itom_discovery",
      `Manage ServiceNow Discovery schedules and results.
Actions: list_schedules, get_schedule, list_results, list_devices, check_status.
Best practices:
- Schedule discovery during off-peak hours to reduce impact.
- Use discovery ranges (IP ranges) to scope appropriately.
- Monitor discovery logs for credential failures and unreachable hosts.
- Review classification results — miscategorized CIs affect CMDB quality.
- Use patterns for application discovery (horizontal/top-down).
- Separate network and server discovery schedules.`,
      {
        action: z.enum(["list_schedules", "get_schedule", "list_results", "list_devices", "check_status"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list_schedules": {
              const records = await client.getRecords("discovery_schedule", {
                sysparm_query: args.query || "ORDERBYname",
                sysparm_fields: "sys_id,name,discover,dscheduler_type,active,mid_server,sys_updated_on",
                sysparm_limit: args.limit || 30,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} discovery schedules`);
            }
            case "get_schedule": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("discovery_schedule", args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "Discovery schedule details");
            }
            case "list_results": {
              const records = await client.getRecords("discovery_status", {
                sysparm_query: args.query || "ORDERBYDESCsys_created_on",
                sysparm_fields: "sys_id,dscheduler,state,started,completed,issues,devices_found,devices_classified",
                sysparm_limit: args.limit || 20,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} discovery results`);
            }
            case "list_devices": {
              if (!args.sys_id) return errorResult("sys_id required (discovery status sys_id)");
              const devices = await client.getRecords("discovery_device_history", {
                sysparm_query: `status=${args.sys_id}`,
                sysparm_fields: "sys_id,source,name,ci,classification_status,ip_address",
                sysparm_limit: args.limit || 100,
                sysparm_display_value: "true",
              });
              return jsonResult(devices, `Found ${devices.length} discovered devices`);
            }
            case "check_status": {
              // Get the most recent running discovery
              const running = await client.getRecords("discovery_status", {
                sysparm_query: "state=Active^ORstate=Starting",
                sysparm_fields: "sys_id,dscheduler,state,started,devices_found",
                sysparm_limit: 5,
                sysparm_display_value: "true",
              });
              if (running.length === 0) return toolResult("No discovery currently running.");
              return jsonResult(running, `${running.length} active discovery process(es)`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── CMDB Health ──────────────────────────────────────────────────────

  private registerCMDBHealth(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itom_cmdb_health",
      `Check CMDB data quality and health metrics.
Actions: orphan_cis, stale_cis, duplicate_check, class_distribution, relationship_stats.
Best practices:
- Monitor orphan CIs (no relationships) — they indicate incomplete discovery.
- Identify stale CIs (not updated in 90+ days) for cleanup.
- Check for duplicates by name, IP address, or serial number.
- Review class distribution to ensure proper CI classification.
- Healthy CMDB has well-connected CIs with relationships.`,
      {
        action: z.enum(["orphan_cis", "stale_cis", "duplicate_check", "class_distribution", "relationship_stats"]),
        table: z.string().optional().describe("CI class table (default: cmdb_ci)"),
        days_stale: z.number().optional().describe("Days since last update to consider stale (default: 90)"),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          const ciTable = args.table || "cmdb_ci";

          switch (args.action) {
            case "orphan_cis": {
              // Find CIs with no relationships
              const cis = await client.getRecords(ciTable, {
                sysparm_query: `operational_status=1^${args.query || ""}^ORDERBYDESCsys_updated_on`,
                sysparm_fields: "sys_id,name,sys_class_name,operational_status,sys_updated_on",
                sysparm_limit: args.limit || 50,
              });

              const orphans: unknown[] = [];
              for (const ci of cis.slice(0, 20)) {
                const rels = await client.getRecords("cmdb_rel_ci", {
                  sysparm_query: `parent=${ci.sys_id}^ORchild=${ci.sys_id}`,
                  sysparm_limit: 1,
                });
                if (rels.length === 0) orphans.push(ci);
              }
              return jsonResult(
                orphans,
                `Found ${orphans.length} orphan CIs (checked first 20). These CIs have no relationships — review and connect them.`
              );
            }
            case "stale_cis": {
              const days = args.days_stale || 90;
              const cutoffDate = new Date();
              cutoffDate.setDate(cutoffDate.getDate() - days);
              const cutoff = cutoffDate.toISOString().slice(0, 19).replace("T", " ");
              const records = await client.getRecords(ciTable, {
                sysparm_query: `operational_status=1^sys_updated_on<${cutoff}^ORDERBYsys_updated_on`,
                sysparm_fields: "sys_id,name,sys_class_name,operational_status,sys_updated_on,discovery_source",
                sysparm_limit: args.limit || 50,
              });
              return jsonResult(
                records,
                `Found ${records.length} CIs not updated in ${days}+ days. Consider re-running discovery or retiring these CIs.`
              );
            }
            case "duplicate_check": {
              // Check for CIs with the same name
              const agg = await client.getAggregate(ciTable, {
                sysparm_query: "operational_status=1",
                sysparm_group_by: "name",
                sysparm_count: "true",
              });
              return jsonResult(agg, "CI name distribution — look for counts > 1 indicating potential duplicates");
            }
            case "class_distribution": {
              const agg = await client.getAggregate(ciTable, {
                sysparm_query: "operational_status=1",
                sysparm_group_by: "sys_class_name",
                sysparm_count: "true",
              });
              return jsonResult(agg, "CI class distribution — review for proper classification");
            }
            case "relationship_stats": {
              const agg = await client.getAggregate("cmdb_rel_ci", {
                sysparm_group_by: "type",
                sysparm_count: "true",
              });
              return jsonResult(agg, "CMDB relationship type distribution");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Service Mapping ──────────────────────────────────────────────────

  private registerServiceMapping(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itom_service_mapping",
      `Query ServiceNow service maps and application services.
Actions: list_services, get_service, list_entries, list_connections.
Best practices:
- Application Services represent business services composed of CIs.
- Service maps show CI dependencies — critical for impact analysis.
- Use top-down discovery patterns for automatic service mapping.
- Entry points define how traffic enters the service.
- Monitor service health via operational status rollup.`,
      {
        action: z.enum(["list_services", "get_service", "list_entries", "list_connections"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list_services": {
              const records = await client.getRecords("cmdb_ci_service_auto", {
                sysparm_query: args.query || "operational_status=1^ORDERBYname",
                sysparm_fields: "sys_id,name,operational_status,owned_by,managed_by,support_group,sys_class_name",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} application services`);
            }
            case "get_service": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("cmdb_ci_service_auto", args.sys_id, {
                sysparm_display_value: "all",
              });
              return jsonResult(record, "Application service details");
            }
            case "list_entries": {
              if (!args.sys_id) return errorResult("sys_id required (application service)");
              const entries = await client.getRecords("sa_m2m_service_entry_point", {
                sysparm_query: `service=${args.sys_id}`,
                sysparm_fields: "sys_id,entry_point,service,port,protocol",
                sysparm_limit: args.limit || 30,
                sysparm_display_value: "true",
              });
              return jsonResult(entries, `Found ${entries.length} service entry points`);
            }
            case "list_connections": {
              if (!args.sys_id) return errorResult("sys_id required (application service)");
              // Get CIs connected to this service
              const rels = await client.getRecords("cmdb_rel_ci", {
                sysparm_query: `parent=${args.sys_id}^ORchild=${args.sys_id}`,
                sysparm_fields: "sys_id,parent,child,type",
                sysparm_limit: args.limit || 100,
                sysparm_display_value: "true",
              });
              return jsonResult(rels, `Found ${rels.length} service connections/relationships`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Agent Client Collector (ACC) ─────────────────────────────────────

  private registerAgentClientCollector(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itom_acc",
      `Manage ServiceNow Agent Client Collector (ACC) monitoring.
Actions: list_agents, get_agent, list_policies, check_health.
Best practices:
- ACC replaces legacy MID-based monitoring with agent-based collection.
- Monitor agent check-in status — stale agents need investigation.
- Use ACC policies for configuring what data agents collect.
- ACC agents report directly to the instance, reducing MID server load.`,
      {
        action: z.enum(["list_agents", "get_agent", "list_policies", "check_health"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list_agents": {
              const records = await client.getRecords("sn_agent_cmdb_ci_agent", {
                sysparm_query: args.query || "ORDERBYname",
                sysparm_fields: "sys_id,name,status,ip_address,os,agent_version,last_checkin,cmdb_ci",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} ACC agents`);
            }
            case "get_agent": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sn_agent_cmdb_ci_agent", args.sys_id, {
                sysparm_display_value: "all",
              });
              return jsonResult(record, "ACC agent details");
            }
            case "list_policies": {
              const records = await client.getRecords("sn_agent_policy", {
                sysparm_query: args.query || "active=true",
                sysparm_fields: "sys_id,name,active,description,os_type,sys_updated_on",
                sysparm_limit: args.limit || 30,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} ACC policies`);
            }
            case "check_health": {
              // Find agents that haven't checked in recently
              const cutoff = new Date();
              cutoff.setHours(cutoff.getHours() - 1);
              const cutoffStr = cutoff.toISOString().slice(0, 19).replace("T", " ");
              const stale = await client.getRecords("sn_agent_cmdb_ci_agent", {
                sysparm_query: `last_checkin<${cutoffStr}^status=Up`,
                sysparm_fields: "sys_id,name,status,ip_address,last_checkin",
                sysparm_limit: args.limit || 50,
              });
              const healthy = stale.length === 0
                ? "All ACC agents are checking in within the last hour."
                : `WARNING: ${stale.length} agent(s) with stale check-ins detected.`;
              return jsonResult({ summary: healthy, stale_agents: stale }, healthy);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Helper ───────────────────────────────────────────────────────────

  private async resolveMidByName(client: ServiceNowClient, name: string): Promise<string | undefined> {
    const found = await client.getRecords("ecc_agent", {
      sysparm_query: `name=${name}`,
      sysparm_fields: "sys_id",
      sysparm_limit: 1,
    });
    return found.length > 0 ? found[0].sys_id : undefined;
  }
}
