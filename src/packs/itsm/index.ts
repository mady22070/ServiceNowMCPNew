import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceNowClient } from "../../servicenow/client.js";
import { type Pack, toolResult, jsonResult, errorResult } from "../types.js";

export class ItsmPack implements Pack {
  name = "itsm";
  description =
    "IT Service Management — incidents, changes, problems, service requests, knowledge management, CMDB, and SLAs";

  register(server: McpServer, client: ServiceNowClient): void {
    this.registerIncidents(server, client);
    this.registerChanges(server, client);
    this.registerProblems(server, client);
    this.registerRequests(server, client);
    this.registerKnowledge(server, client);
    this.registerCMDB(server, client);
    this.registerSLA(server, client);
  }

  // ── Incidents ────────────────────────────────────────────────────────

  private registerIncidents(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itsm_incidents",
      `Manage ServiceNow incidents (incident).
Actions: list, get, create, update, resolve, close, add_comment, add_work_note.
Best practices:
- Impact + Urgency = Priority (auto-calculated). Don't override priority directly.
- Always set assignment_group before assigned_to.
- Use work notes (visible to IT) vs comments (visible to caller) appropriately.
- Close incidents via resolve first, then close — don't skip to closed.
- Mandatory for resolution: close_code, close_notes.
- Link related incidents to problems when patterns emerge.
- Use incident templates for recurring issue types.

Priority Matrix:
  Impact 1 (High) + Urgency 1 (High) = Priority 1 (Critical)
  Impact 1 + Urgency 2 (Medium) = Priority 2 (High)
  Impact 2 + Urgency 1 = Priority 2 (High)
  Impact 2 + Urgency 2 = Priority 3 (Moderate)
  Impact 3 + Urgency 3 = Priority 5 (Planning)`,
      {
        action: z.enum(["list", "get", "create", "update", "resolve", "close", "add_comment", "add_work_note"]),
        sys_id: z.string().optional().describe("Incident sys_id"),
        number: z.string().optional().describe("Incident number (e.g. INC0012345)"),
        query: z.string().optional(),
        data: z
          .object({
            short_description: z.string().optional(),
            description: z.string().optional(),
            caller_id: z.string().optional().describe("Caller sys_id or user_name"),
            category: z.string().optional(),
            subcategory: z.string().optional(),
            impact: z.enum(["1", "2", "3"]).optional().describe("1=High, 2=Medium, 3=Low"),
            urgency: z.enum(["1", "2", "3"]).optional().describe("1=High, 2=Medium, 3=Low"),
            assignment_group: z.string().optional(),
            assigned_to: z.string().optional(),
            contact_type: z.string().optional().describe("phone, email, walk-in, self-service, chat"),
            cmdb_ci: z.string().optional().describe("Configuration item"),
            close_code: z.string().optional(),
            close_notes: z.string().optional(),
          })
          .optional(),
        comment: z.string().optional().describe("Comment or work note text"),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          // Resolve by number if provided
          let sysId = args.sys_id;
          if (!sysId && args.number) {
            const found = await client.getRecords("incident", {
              sysparm_query: `number=${args.number}`,
              sysparm_fields: "sys_id",
              sysparm_limit: 1,
            });
            if (found.length === 0) return errorResult(`Incident ${args.number} not found`);
            sysId = found[0].sys_id;
          }

          switch (args.action) {
            case "list": {
              const records = await client.getRecords("incident", {
                sysparm_query: args.query || "active=true^ORDERBYDESCsys_created_on",
                sysparm_fields:
                  "sys_id,number,short_description,state,priority,impact,urgency,assignment_group,assigned_to,caller_id,category,sys_created_on,sys_updated_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} incidents`);
            }
            case "get": {
              if (!sysId) return errorResult("sys_id or number required");
              const record = await client.getRecord("incident", sysId, { sysparm_display_value: "all" });
              return jsonResult(record, "Incident details");
            }
            case "create": {
              if (!args.data?.short_description) return errorResult("data.short_description required");
              if (!args.data.caller_id) return errorResult("data.caller_id required — who is reporting this?");
              const created = await client.createRecord("incident", {
                ...args.data,
                contact_type: args.data.contact_type || "self-service",
              });
              return jsonResult(created, "Incident created");
            }
            case "update": {
              if (!sysId || !args.data) return errorResult("sys_id/number and data required");
              const updated = await client.updateRecord("incident", sysId, args.data);
              return jsonResult(updated, "Incident updated");
            }
            case "resolve": {
              if (!sysId) return errorResult("sys_id or number required");
              if (!args.data?.close_code || !args.data?.close_notes) {
                return errorResult("data.close_code and data.close_notes required for resolution");
              }
              const resolved = await client.updateRecord("incident", sysId, {
                state: 6, // Resolved
                close_code: args.data.close_code,
                close_notes: args.data.close_notes,
              });
              return jsonResult(resolved, "Incident resolved");
            }
            case "close": {
              if (!sysId) return errorResult("sys_id or number required");
              const resolved = await client.updateRecord("incident", sysId, { state: 7 }); // Closed
              return jsonResult(resolved, "Incident closed");
            }
            case "add_comment": {
              if (!sysId || !args.comment) return errorResult("sys_id/number and comment required");
              const updated = await client.updateRecord("incident", sysId, { comments: args.comment });
              return jsonResult(updated, "Comment added (visible to caller)");
            }
            case "add_work_note": {
              if (!sysId || !args.comment) return errorResult("sys_id/number and comment required");
              const updated = await client.updateRecord("incident", sysId, { work_notes: args.comment });
              return jsonResult(updated, "Work note added (visible to IT only)");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Change Requests ──────────────────────────────────────────────────

  private registerChanges(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itsm_changes",
      `Manage ServiceNow change requests (change_request).
Actions: list, get, create, update, add_work_note, list_tasks, create_task.
Best practices:
- Types: Normal (CAB review), Standard (pre-approved), Emergency (expedited approval).
- Always associate CIs (cmdb_ci) to track what is changing.
- Include rollback plan in the backout_plan field.
- Risk assessment: set risk + impact to auto-calculate risk score.
- Follow change windows — avoid changes during peak business hours.
- Change tasks break the work into assignable steps.
- Document test results in the test_plan field.`,
      {
        action: z.enum(["list", "get", "create", "update", "add_work_note", "list_tasks", "create_task"]),
        sys_id: z.string().optional(),
        number: z.string().optional().describe("Change number (e.g. CHG0012345)"),
        query: z.string().optional(),
        data: z
          .object({
            short_description: z.string().optional(),
            description: z.string().optional(),
            type: z.enum(["normal", "standard", "emergency"]).optional(),
            category: z.string().optional(),
            priority: z.enum(["1", "2", "3", "4"]).optional(),
            risk: z.enum(["1", "2", "3", "4"]).optional().describe("1=Very High, 2=High, 3=Moderate, 4=Low"),
            impact: z.enum(["1", "2", "3"]).optional(),
            assignment_group: z.string().optional(),
            assigned_to: z.string().optional(),
            cmdb_ci: z.string().optional(),
            start_date: z.string().optional(),
            end_date: z.string().optional(),
            justification: z.string().optional(),
            implementation_plan: z.string().optional(),
            backout_plan: z.string().optional(),
            test_plan: z.string().optional(),
          })
          .optional(),
        task_data: z
          .object({
            short_description: z.string(),
            assignment_group: z.string().optional(),
            assigned_to: z.string().optional(),
            planned_start_date: z.string().optional(),
            planned_end_date: z.string().optional(),
            description: z.string().optional(),
          })
          .optional()
          .describe("Change task data for create_task"),
        comment: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          let sysId = args.sys_id;
          if (!sysId && args.number) {
            const found = await client.getRecords("change_request", {
              sysparm_query: `number=${args.number}`,
              sysparm_fields: "sys_id",
              sysparm_limit: 1,
            });
            if (found.length === 0) return errorResult(`Change ${args.number} not found`);
            sysId = found[0].sys_id;
          }

          switch (args.action) {
            case "list": {
              const records = await client.getRecords("change_request", {
                sysparm_query: args.query || "active=true^ORDERBYDESCsys_created_on",
                sysparm_fields:
                  "sys_id,number,short_description,type,state,priority,risk,impact,assignment_group,assigned_to,start_date,end_date",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} change requests`);
            }
            case "get": {
              if (!sysId) return errorResult("sys_id or number required");
              const record = await client.getRecord("change_request", sysId, { sysparm_display_value: "all" });
              return jsonResult(record, "Change request details");
            }
            case "create": {
              if (!args.data?.short_description) return errorResult("data.short_description required");
              if (!args.data.type) return errorResult("data.type required (normal, standard, emergency)");
              const missingFields: string[] = [];
              if (!args.data.implementation_plan) missingFields.push("implementation_plan");
              if (!args.data.backout_plan) missingFields.push("backout_plan");
              if (!args.data.test_plan) missingFields.push("test_plan");
              const warnings =
                missingFields.length > 0
                  ? `\nWarning: Missing recommended fields: ${missingFields.join(", ")}. These are critical for change approval.`
                  : "";
              const created = await client.createRecord("change_request", args.data);
              return jsonResult(created, `Change request created.${warnings}`);
            }
            case "update": {
              if (!sysId || !args.data) return errorResult("sys_id/number and data required");
              const updated = await client.updateRecord("change_request", sysId, args.data);
              return jsonResult(updated, "Change request updated");
            }
            case "add_work_note": {
              if (!sysId || !args.comment) return errorResult("sys_id/number and comment required");
              const updated = await client.updateRecord("change_request", sysId, { work_notes: args.comment });
              return jsonResult(updated, "Work note added");
            }
            case "list_tasks": {
              if (!sysId) return errorResult("sys_id or number required");
              const tasks = await client.getRecords("change_task", {
                sysparm_query: `change_request=${sysId}^ORDERBYorder`,
                sysparm_fields: "sys_id,number,short_description,state,assignment_group,assigned_to,order",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(tasks, `Found ${tasks.length} change tasks`);
            }
            case "create_task": {
              if (!sysId || !args.task_data) return errorResult("sys_id/number and task_data required");
              const task = await client.createRecord("change_task", {
                change_request: sysId,
                ...args.task_data,
              });
              return jsonResult(task, "Change task created");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Problems ─────────────────────────────────────────────────────────

  private registerProblems(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itsm_problems",
      `Manage ServiceNow problems (problem).
Actions: list, get, create, update, create_known_error, link_incident.
Best practices:
- Problems represent the root cause of one or more incidents.
- Use Root Cause Analysis (RCA) — document findings in cause_notes.
- Create Known Errors when workaround is found but permanent fix is pending.
- Link all related incidents to the problem for impact tracking.
- Set fix_notes when the permanent resolution is implemented.
- Use problem_state: 101=New, 102=Assess, 103=RCA, 104=Fix, 106=Resolved, 107=Closed.`,
      {
        action: z.enum(["list", "get", "create", "update", "create_known_error", "link_incident"]),
        sys_id: z.string().optional(),
        number: z.string().optional(),
        query: z.string().optional(),
        data: z
          .object({
            short_description: z.string().optional(),
            description: z.string().optional(),
            category: z.string().optional(),
            impact: z.enum(["1", "2", "3"]).optional(),
            urgency: z.enum(["1", "2", "3"]).optional(),
            assignment_group: z.string().optional(),
            assigned_to: z.string().optional(),
            cmdb_ci: z.string().optional(),
            cause_notes: z.string().optional(),
            fix_notes: z.string().optional(),
            workaround: z.string().optional(),
            known_error: z.boolean().optional(),
            problem_state: z.string().optional(),
          })
          .optional(),
        incident_sys_id: z.string().optional().describe("Incident sys_id for link_incident"),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          let sysId = args.sys_id;
          if (!sysId && args.number) {
            const found = await client.getRecords("problem", {
              sysparm_query: `number=${args.number}`,
              sysparm_fields: "sys_id",
              sysparm_limit: 1,
            });
            if (found.length === 0) return errorResult(`Problem ${args.number} not found`);
            sysId = found[0].sys_id;
          }

          switch (args.action) {
            case "list": {
              const records = await client.getRecords("problem", {
                sysparm_query: args.query || "active=true^ORDERBYDESCsys_created_on",
                sysparm_fields:
                  "sys_id,number,short_description,problem_state,priority,impact,urgency,assignment_group,known_error,cmdb_ci",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} problems`);
            }
            case "get": {
              if (!sysId) return errorResult("sys_id or number required");
              const record = await client.getRecord("problem", sysId, { sysparm_display_value: "all" });
              return jsonResult(record, "Problem details");
            }
            case "create": {
              if (!args.data?.short_description) return errorResult("data.short_description required");
              const created = await client.createRecord("problem", {
                ...args.data,
                problem_state: args.data?.problem_state || "101",
              });
              return jsonResult(created, "Problem created");
            }
            case "update": {
              if (!sysId || !args.data) return errorResult("sys_id/number and data required");
              const updated = await client.updateRecord("problem", sysId, args.data);
              return jsonResult(updated, "Problem updated");
            }
            case "create_known_error": {
              if (!sysId) return errorResult("sys_id or number required");
              if (!args.data?.workaround) return errorResult("data.workaround required for known errors");
              const updated = await client.updateRecord("problem", sysId, {
                known_error: true,
                workaround: args.data.workaround,
                problem_state: "104", // Fix in Progress
              });
              return jsonResult(updated, "Problem marked as Known Error with workaround documented");
            }
            case "link_incident": {
              if (!sysId || !args.incident_sys_id) return errorResult("sys_id/number and incident_sys_id required");
              const updated = await client.updateRecord("incident", args.incident_sys_id, {
                problem_id: sysId,
              });
              return jsonResult(updated, "Incident linked to problem");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Service Requests ─────────────────────────────────────────────────

  private registerRequests(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itsm_requests",
      `Manage ServiceNow service requests (sc_request) and requested items (sc_req_item).
Actions: list_requests, get_request, list_items, get_item, update_item, add_comment.
Best practices:
- Requests are created from the service catalog — use catalog items for standardized fulfillment.
- Track fulfillment via requested items (sc_req_item), not the parent request.
- Each item follows its own approval and fulfillment workflow.
- Use catalog tasks (sc_task) for multi-step fulfillment of a single item.`,
      {
        action: z.enum(["list_requests", "get_request", "list_items", "get_item", "update_item", "add_comment"]),
        sys_id: z.string().optional(),
        number: z.string().optional(),
        query: z.string().optional(),
        data: z
          .object({
            state: z.string().optional(),
            assignment_group: z.string().optional(),
            assigned_to: z.string().optional(),
          })
          .optional(),
        comment: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list_requests": {
              const records = await client.getRecords("sc_request", {
                sysparm_query: args.query || "active=true^ORDERBYDESCsys_created_on",
                sysparm_fields:
                  "sys_id,number,short_description,request_state,requested_for,opened_by,sys_created_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} requests`);
            }
            case "get_request": {
              const id = args.sys_id || (args.number ? (await this.resolveNumber(client, "sc_request", args.number)) : undefined);
              if (!id) return errorResult("sys_id or number required");
              const record = await client.getRecord("sc_request", id, { sysparm_display_value: "all" });
              return jsonResult(record, "Request details");
            }
            case "list_items": {
              const id = args.sys_id || (args.number ? (await this.resolveNumber(client, "sc_request", args.number)) : undefined);
              if (!id) return errorResult("sys_id or number required (parent request)");
              const items = await client.getRecords("sc_req_item", {
                sysparm_query: `request=${id}`,
                sysparm_fields: "sys_id,number,short_description,state,cat_item,quantity,assignment_group,assigned_to",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(items, `Found ${items.length} requested items`);
            }
            case "get_item": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sc_req_item", args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "Requested item details");
            }
            case "update_item": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord("sc_req_item", args.sys_id, args.data);
              return jsonResult(updated, "Requested item updated");
            }
            case "add_comment": {
              if (!args.sys_id || !args.comment) return errorResult("sys_id and comment required");
              const updated = await client.updateRecord("sc_req_item", args.sys_id, { comments: args.comment });
              return jsonResult(updated, "Comment added to requested item");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Knowledge Management ─────────────────────────────────────────────

  private registerKnowledge(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itsm_knowledge",
      `Manage ServiceNow knowledge articles (kb_knowledge).
Actions: list, get, create, update, publish, retire, search.
Best practices:
- Use knowledge bases and categories for organization.
- Follow the article lifecycle: Draft → Review → Published → Retired.
- Include metadata: valid_to date, article_type, category.
- Write clear titles and use keywords for searchability.
- Link related articles for cross-referencing.
- Set ownership (author, kb_knowledge_base) for governance.
- Use workflow_state for lifecycle management.`,
      {
        action: z.enum(["list", "get", "create", "update", "publish", "retire", "search"]),
        sys_id: z.string().optional(),
        number: z.string().optional(),
        search_term: z.string().optional().describe("Full-text search for articles"),
        query: z.string().optional(),
        data: z
          .object({
            short_description: z.string().optional(),
            text: z.string().optional().describe("Article body (HTML)"),
            kb_knowledge_base: z.string().optional(),
            kb_category: z.string().optional(),
            article_type: z.string().optional().describe("text, wiki, html"),
            author: z.string().optional(),
            valid_to: z.string().optional(),
            keywords: z.string().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("kb_knowledge", {
                sysparm_query: args.query || "workflow_state=published^ORDERBYDESCsys_updated_on",
                sysparm_fields:
                  "sys_id,number,short_description,workflow_state,kb_knowledge_base,kb_category,author,sys_view_count,sys_updated_on",
                sysparm_limit: args.limit || 30,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} knowledge articles`);
            }
            case "get": {
              const id = args.sys_id || (args.number ? (await this.resolveNumber(client, "kb_knowledge", args.number)) : undefined);
              if (!id) return errorResult("sys_id or number required");
              const record = await client.getRecord("kb_knowledge", id, { sysparm_display_value: "all" });
              return jsonResult(record, "Knowledge article details");
            }
            case "search": {
              if (!args.search_term) return errorResult("search_term required");
              const records = await client.getRecords("kb_knowledge", {
                sysparm_query: `workflow_state=published^short_descriptionLIKE${args.search_term}^ORtextLIKE${args.search_term}^ORkeywordsLIKE${args.search_term}`,
                sysparm_fields: "sys_id,number,short_description,workflow_state,kb_category,sys_view_count",
                sysparm_limit: args.limit || 20,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} articles matching '${args.search_term}'`);
            }
            case "create": {
              if (!args.data?.short_description || !args.data?.text) {
                return errorResult("data.short_description and data.text required");
              }
              const created = await client.createRecord("kb_knowledge", {
                ...args.data,
                workflow_state: "draft",
                article_type: args.data.article_type || "html",
              });
              return jsonResult(created, "Knowledge article created as Draft. Use 'publish' when ready.");
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord("kb_knowledge", args.sys_id, args.data);
              return jsonResult(updated, "Knowledge article updated");
            }
            case "publish": {
              if (!args.sys_id) return errorResult("sys_id required");
              const published = await client.updateRecord("kb_knowledge", args.sys_id, {
                workflow_state: "published",
              });
              return jsonResult(published, "Knowledge article published");
            }
            case "retire": {
              if (!args.sys_id) return errorResult("sys_id required");
              const retired = await client.updateRecord("kb_knowledge", args.sys_id, {
                workflow_state: "retired",
              });
              return jsonResult(retired, "Knowledge article retired");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── CMDB ─────────────────────────────────────────────────────────────

  private registerCMDB(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itsm_cmdb",
      `Manage ServiceNow CMDB Configuration Items (cmdb_ci and subtypes).
Actions: list, get, create, update, list_relationships, create_relationship, search.
Best practices:
- Use specific CI classes (cmdb_ci_server, cmdb_ci_app_server, cmdb_ci_db_instance) not generic cmdb_ci.
- Maintain CI relationships (runs on, depends on, used by) for service mapping.
- Set operational_status and install_status accurately.
- Use discovery or service mapping for automated CI population.
- Track CI ownership (managed_by, owned_by, support_group) for accountability.
- Regular CMDB health checks ensure data quality.`,
      {
        action: z.enum(["list", "get", "create", "update", "list_relationships", "create_relationship", "search"]),
        table: z.string().optional().describe("CI class table (default: cmdb_ci). Use specific: cmdb_ci_server, cmdb_ci_app_server, cmdb_ci_db_instance, etc."),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        search_term: z.string().optional(),
        data: z
          .object({
            name: z.string().optional(),
            sys_class_name: z.string().optional(),
            operational_status: z.enum(["1", "2", "3", "4", "5", "6"]).optional().describe("1=Operational, 2=Non-Operational, 3=Repair, 4=Retired, 5=Pipeline, 6=DR Standby"),
            install_status: z.string().optional(),
            ip_address: z.string().optional(),
            dns_domain: z.string().optional(),
            managed_by: z.string().optional(),
            owned_by: z.string().optional(),
            support_group: z.string().optional(),
            environment: z.string().optional(),
            category: z.string().optional(),
            subcategory: z.string().optional(),
            short_description: z.string().optional(),
          })
          .optional(),
        relationship: z
          .object({
            parent: z.string().describe("Parent CI sys_id"),
            child: z.string().describe("Child CI sys_id"),
            type: z.string().describe("Relationship type sys_id or name (e.g. 'Runs on::Runs')"),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          const ciTable = args.table || "cmdb_ci";

          switch (args.action) {
            case "list": {
              const records = await client.getRecords(ciTable, {
                sysparm_query: args.query || "operational_status=1^ORDERBYname",
                sysparm_fields: "sys_id,name,sys_class_name,operational_status,install_status,ip_address,environment,support_group",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} CIs in ${ciTable}`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord(ciTable, args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "CI details");
            }
            case "search": {
              if (!args.search_term) return errorResult("search_term required");
              const records = await client.getRecords(ciTable, {
                sysparm_query: `nameLIKE${args.search_term}^ORip_addressLIKE${args.search_term}`,
                sysparm_fields: "sys_id,name,sys_class_name,operational_status,ip_address,environment",
                sysparm_limit: args.limit || 20,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} CIs matching '${args.search_term}'`);
            }
            case "create": {
              if (!args.data?.name) return errorResult("data.name required");
              if (ciTable === "cmdb_ci") {
                return toolResult(
                  "Warning: Creating a generic cmdb_ci. Best practice is to use a specific class like cmdb_ci_server, cmdb_ci_app_server, cmdb_ci_db_instance. Specify the 'table' parameter with the appropriate class."
                );
              }
              const created = await client.createRecord(ciTable, {
                ...args.data,
                operational_status: args.data.operational_status || "1",
              });
              return jsonResult(created, "CI created");
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord(ciTable, args.sys_id, args.data);
              return jsonResult(updated, "CI updated");
            }
            case "list_relationships": {
              if (!args.sys_id) return errorResult("sys_id required");
              const rels = await client.getRecords("cmdb_rel_ci", {
                sysparm_query: `parent=${args.sys_id}^ORchild=${args.sys_id}`,
                sysparm_fields: "sys_id,parent,child,type",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(rels, `Found ${rels.length} CI relationships`);
            }
            case "create_relationship": {
              if (!args.relationship) return errorResult("relationship object required");
              const rel = await client.createRecord("cmdb_rel_ci", {
                parent: args.relationship.parent,
                child: args.relationship.child,
                type: args.relationship.type,
              });
              return jsonResult(rel, "CI relationship created");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── SLA ──────────────────────────────────────────────────────────────

  private registerSLA(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "itsm_sla",
      `Query ServiceNow SLA definitions and task SLA status.
Actions: list_definitions, get_definition, list_task_slas, get_task_sla.
Best practices:
- Monitor breached SLAs with query: has_breached=true.
- Track SLA percentage via percentage field on task_sla.
- SLA stages: In Progress, Paused, Breached, Completed, Cancelled.
- Use SLA workflows for escalation and notification automation.`,
      {
        action: z.enum(["list_definitions", "get_definition", "list_task_slas", "get_task_sla"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        task_number: z.string().optional().describe("Task number to find SLAs for (e.g. INC0012345)"),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list_definitions": {
              const records = await client.getRecords("contract_sla", {
                sysparm_query: args.query || "active=true",
                sysparm_fields: "sys_id,name,collection,flow_condition,duration,active",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} SLA definitions`);
            }
            case "get_definition": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("contract_sla", args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "SLA definition details");
            }
            case "list_task_slas": {
              let query = args.query || "active=true^ORDERBYDESCsys_updated_on";
              if (args.task_number) {
                query = `task.number=${args.task_number}`;
              }
              const records = await client.getRecords("task_sla", {
                sysparm_query: query,
                sysparm_fields: "sys_id,task,sla,stage,has_breached,percentage,start_time,end_time,business_percentage",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} task SLAs`);
            }
            case "get_task_sla": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("task_sla", args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "Task SLA details");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Helper ───────────────────────────────────────────────────────────

  private async resolveNumber(client: ServiceNowClient, table: string, number: string): Promise<string | undefined> {
    const found = await client.getRecords(table, {
      sysparm_query: `number=${number}`,
      sysparm_fields: "sys_id",
      sysparm_limit: 1,
    });
    return found.length > 0 ? found[0].sys_id : undefined;
  }
}
