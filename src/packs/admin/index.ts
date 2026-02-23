import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceNowClient } from "../../servicenow/client.js";
import { type Pack, toolResult, jsonResult, errorResult } from "../types.js";

export class AdminPack implements Pack {
  name = "admin";
  description = "ServiceNow administration — users, groups, roles, properties, update sets, scheduled jobs, and ACLs";

  register(server: McpServer, client: ServiceNowClient): void {
    this.registerManageUsers(server, client);
    this.registerManageGroups(server, client);
    this.registerManageRoles(server, client);
    this.registerManageProperties(server, client);
    this.registerManageUpdateSets(server, client);
    this.registerManageScheduledJobs(server, client);
    this.registerManageACLs(server, client);
  }

  // ── Users ────────────────────────────────────────────────────────────

  private registerManageUsers(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "admin_manage_users",
      `Manage ServiceNow users (sys_user).
Actions: list, get, create, update, deactivate.
Best practices:
- Never delete users — deactivate them instead to preserve audit trails.
- Assign roles via groups, not directly to users.
- Use employee number or email as unique identifiers, not user_name alone.
- Always set notification preferences and time zone on creation.`,
      {
        action: z.enum(["list", "get", "create", "update", "deactivate"]).describe("Operation to perform"),
        sys_id: z.string().optional().describe("User sys_id — required for get, update, deactivate"),
        query: z.string().optional().describe("Encoded query for list (e.g. active=true^departmentLIKEIT)"),
        fields: z.string().optional().describe("Comma-separated fields to return"),
        data: z
          .object({
            user_name: z.string().optional(),
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            email: z.string().optional(),
            employee_number: z.string().optional(),
            department: z.string().optional(),
            title: z.string().optional(),
            time_zone: z.string().optional(),
            active: z.boolean().optional(),
          })
          .optional()
          .describe("User data for create/update"),
        limit: z.number().optional().describe("Max records to return (default 50)"),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("sys_user", {
                sysparm_query: args.query || "active=true",
                sysparm_fields: args.fields || "sys_id,user_name,first_name,last_name,email,active,department,title",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} users`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id is required for get action");
              const record = await client.getRecord("sys_user", args.sys_id, {
                sysparm_display_value: "all",
              });
              return jsonResult(record, "User details");
            }
            case "create": {
              if (!args.data) return errorResult("data is required for create action");
              if (!args.data.user_name || !args.data.email) {
                return errorResult("user_name and email are required for creating a user");
              }
              const created = await client.createRecord("sys_user", {
                ...args.data,
                active: true,
                notification: 2, // Enable email notifications
              });
              return jsonResult(created, "User created. Remember: assign roles via groups, not directly");
            }
            case "update": {
              if (!args.sys_id) return errorResult("sys_id is required for update action");
              if (!args.data) return errorResult("data is required for update action");
              const updated = await client.updateRecord("sys_user", args.sys_id, args.data);
              return jsonResult(updated, "User updated");
            }
            case "deactivate": {
              if (!args.sys_id) return errorResult("sys_id is required for deactivate action");
              const deactivated = await client.updateRecord("sys_user", args.sys_id, { active: false });
              return jsonResult(deactivated, "User deactivated (not deleted — preserving audit trail)");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Groups ───────────────────────────────────────────────────────────

  private registerManageGroups(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "admin_manage_groups",
      `Manage ServiceNow groups (sys_user_group) and group membership (sys_user_grmember).
Actions: list, get, create, update, add_member, remove_member, list_members.
Best practices:
- Use groups for role assignment instead of assigning roles directly to users.
- Use hierarchical groups (parent field) for organizational structure.
- Set manager and email for notification routing.
- Prefix group names with a department/function code for clarity.`,
      {
        action: z.enum(["list", "get", "create", "update", "add_member", "remove_member", "list_members"]),
        sys_id: z.string().optional().describe("Group sys_id"),
        query: z.string().optional().describe("Encoded query for list"),
        user_sys_id: z.string().optional().describe("User sys_id for add_member/remove_member"),
        data: z
          .object({
            name: z.string().optional(),
            description: z.string().optional(),
            manager: z.string().optional(),
            email: z.string().optional(),
            parent: z.string().optional(),
            type: z.string().optional(),
            active: z.boolean().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("sys_user_group", {
                sysparm_query: args.query || "active=true",
                sysparm_fields: "sys_id,name,description,manager,email,parent,active",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} groups`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_user_group", args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "Group details");
            }
            case "create": {
              if (!args.data?.name) return errorResult("data.name required for create");
              const created = await client.createRecord("sys_user_group", { ...args.data, active: true });
              return jsonResult(created, "Group created");
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord("sys_user_group", args.sys_id, args.data);
              return jsonResult(updated, "Group updated");
            }
            case "add_member": {
              if (!args.sys_id || !args.user_sys_id) return errorResult("sys_id (group) and user_sys_id required");
              const member = await client.createRecord("sys_user_grmember", {
                group: args.sys_id,
                user: args.user_sys_id,
              });
              return jsonResult(member, "User added to group");
            }
            case "remove_member": {
              if (!args.sys_id || !args.user_sys_id) return errorResult("sys_id (group) and user_sys_id required");
              const members = await client.getRecords("sys_user_grmember", {
                sysparm_query: `group=${args.sys_id}^user=${args.user_sys_id}`,
                sysparm_limit: 1,
              });
              if (members.length === 0) return errorResult("Membership not found");
              await client.deleteRecord("sys_user_grmember", members[0].sys_id);
              return toolResult("User removed from group");
            }
            case "list_members": {
              if (!args.sys_id) return errorResult("sys_id required");
              const members = await client.getRecords("sys_user_grmember", {
                sysparm_query: `group=${args.sys_id}`,
                sysparm_fields: "sys_id,user",
                sysparm_display_value: "true",
                sysparm_limit: args.limit || 200,
              });
              return jsonResult(members, `Found ${members.length} members`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Roles ────────────────────────────────────────────────────────────

  private registerManageRoles(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "admin_manage_roles",
      `Manage ServiceNow role assignments.
Actions: list_roles, user_roles, group_roles, assign_to_user, assign_to_group, revoke_from_user, revoke_from_group.
Best practices:
- Prefer group-based role assignment over user-based (scalable, auditable).
- Avoid assigning admin role directly — use elevated privilege + time-limited access.
- Use role inheritance (contains roles) to build role hierarchies.
- Document role purpose in the description field.`,
      {
        action: z.enum([
          "list_roles",
          "user_roles",
          "group_roles",
          "assign_to_user",
          "assign_to_group",
          "revoke_from_user",
          "revoke_from_group",
        ]),
        role_name: z.string().optional().describe("Role name (e.g. itil, admin, catalog_admin)"),
        user_sys_id: z.string().optional(),
        group_sys_id: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list_roles": {
              const records = await client.getRecords("sys_user_role", {
                sysparm_query: args.query || "",
                sysparm_fields: "sys_id,name,description,suffix",
                sysparm_limit: args.limit || 100,
              });
              return jsonResult(records, `Found ${records.length} roles`);
            }
            case "user_roles": {
              if (!args.user_sys_id) return errorResult("user_sys_id required");
              const roles = await client.getRecords("sys_user_has_role", {
                sysparm_query: `user=${args.user_sys_id}^state=active`,
                sysparm_fields: "sys_id,role,user,state,inherited",
                sysparm_display_value: "true",
                sysparm_limit: args.limit || 200,
              });
              return jsonResult(roles, `User has ${roles.length} role assignments`);
            }
            case "group_roles": {
              if (!args.group_sys_id) return errorResult("group_sys_id required");
              const roles = await client.getRecords("sys_group_has_role", {
                sysparm_query: `group=${args.group_sys_id}`,
                sysparm_fields: "sys_id,role,group",
                sysparm_display_value: "true",
                sysparm_limit: args.limit || 200,
              });
              return jsonResult(roles, `Group has ${roles.length} roles`);
            }
            case "assign_to_user": {
              if (!args.user_sys_id || !args.role_name) return errorResult("user_sys_id and role_name required");
              const roleRecords = await client.getRecords("sys_user_role", {
                sysparm_query: `name=${args.role_name}`,
                sysparm_limit: 1,
              });
              if (roleRecords.length === 0) return errorResult(`Role '${args.role_name}' not found`);
              const result = await client.createRecord("sys_user_has_role", {
                user: args.user_sys_id,
                role: roleRecords[0].sys_id,
              });
              const warning =
                args.role_name === "admin"
                  ? "\n⚠ WARNING: admin role assigned directly. Best practice is to use group-based assignment with time-limited elevated access."
                  : "";
              return jsonResult(result, `Role '${args.role_name}' assigned to user.${warning}`);
            }
            case "assign_to_group": {
              if (!args.group_sys_id || !args.role_name) return errorResult("group_sys_id and role_name required");
              const roleRecords = await client.getRecords("sys_user_role", {
                sysparm_query: `name=${args.role_name}`,
                sysparm_limit: 1,
              });
              if (roleRecords.length === 0) return errorResult(`Role '${args.role_name}' not found`);
              const result = await client.createRecord("sys_group_has_role", {
                group: args.group_sys_id,
                role: roleRecords[0].sys_id,
              });
              return jsonResult(result, `Role '${args.role_name}' assigned to group`);
            }
            case "revoke_from_user": {
              if (!args.user_sys_id || !args.role_name) return errorResult("user_sys_id and role_name required");
              const assignments = await client.getRecords("sys_user_has_role", {
                sysparm_query: `user=${args.user_sys_id}^role.name=${args.role_name}`,
                sysparm_limit: 1,
              });
              if (assignments.length === 0) return errorResult("Role assignment not found");
              await client.deleteRecord("sys_user_has_role", assignments[0].sys_id);
              return toolResult(`Role '${args.role_name}' revoked from user`);
            }
            case "revoke_from_group": {
              if (!args.group_sys_id || !args.role_name) return errorResult("group_sys_id and role_name required");
              const assignments = await client.getRecords("sys_group_has_role", {
                sysparm_query: `group=${args.group_sys_id}^role.name=${args.role_name}`,
                sysparm_limit: 1,
              });
              if (assignments.length === 0) return errorResult("Role assignment not found");
              await client.deleteRecord("sys_group_has_role", assignments[0].sys_id);
              return toolResult(`Role '${args.role_name}' revoked from group`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── System Properties ────────────────────────────────────────────────

  private registerManageProperties(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "admin_manage_properties",
      `Manage ServiceNow system properties (sys_properties).
Actions: list, get, set, create.
Best practices:
- Use dot-separated naming convention (e.g. company.module.feature).
- Always document the purpose in the description field.
- Use sys_properties categories for organization.
- Be cautious changing glide.* properties — they affect core platform behavior.
- Test property changes in sub-production before applying to production.`,
      {
        action: z.enum(["list", "get", "set", "create"]),
        name: z.string().optional().describe("Property name (e.g. glide.ui.session_timeout)"),
        value: z.string().optional().describe("Property value for set/create"),
        description: z.string().optional().describe("Property description for create"),
        query: z.string().optional().describe("Encoded query for list"),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("sys_properties", {
                sysparm_query: args.query || "",
                sysparm_fields: "sys_id,name,value,description,type",
                sysparm_limit: args.limit || 50,
              });
              return jsonResult(records, `Found ${records.length} properties`);
            }
            case "get": {
              if (!args.name) return errorResult("name required");
              const records = await client.getRecords("sys_properties", {
                sysparm_query: `name=${args.name}`,
                sysparm_fields: "sys_id,name,value,description,type",
                sysparm_limit: 1,
              });
              if (records.length === 0) return errorResult(`Property '${args.name}' not found`);
              return jsonResult(records[0], `Property '${args.name}'`);
            }
            case "set": {
              if (!args.name || args.value === undefined) return errorResult("name and value required");
              const existing = await client.getRecords("sys_properties", {
                sysparm_query: `name=${args.name}`,
                sysparm_limit: 1,
              });
              if (existing.length === 0) return errorResult(`Property '${args.name}' not found. Use 'create' action.`);
              const warning = args.name.startsWith("glide.")
                ? "\nNote: This is a core platform property. Verify the change in sub-production first."
                : "";
              const updated = await client.updateRecord("sys_properties", existing[0].sys_id, { value: args.value });
              return jsonResult(updated, `Property '${args.name}' updated.${warning}`);
            }
            case "create": {
              if (!args.name || args.value === undefined) return errorResult("name and value required");
              if (!args.description) {
                return errorResult("description is required — always document property purpose");
              }
              const created = await client.createRecord("sys_properties", {
                name: args.name,
                value: args.value,
                description: args.description,
                type: "string",
              });
              return jsonResult(created, `Property '${args.name}' created`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Update Sets ──────────────────────────────────────────────────────

  private registerManageUpdateSets(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "admin_manage_update_sets",
      `Manage ServiceNow update sets (sys_update_set).
Actions: list, get, create, set_current, query_contents.
Best practices:
- Use descriptive names with ticket reference (e.g. STRY0012345 - Add email notification).
- Keep update sets focused — one feature/fix per update set.
- Never modify the Default update set directly.
- Review update set contents before promoting.
- Use batch parent update sets for multi-set deployments.`,
      {
        action: z.enum(["list", "get", "create", "set_current", "query_contents"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        data: z
          .object({
            name: z.string().optional(),
            description: z.string().optional(),
            parent: z.string().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("sys_update_set", {
                sysparm_query: args.query || "state=in progress^ORDERBYDESCsys_updated_on",
                sysparm_fields: "sys_id,name,description,state,application,sys_created_by,sys_updated_on",
                sysparm_limit: args.limit || 30,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} update sets`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_update_set", args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "Update set details");
            }
            case "create": {
              if (!args.data?.name) return errorResult("data.name required");
              const created = await client.createRecord("sys_update_set", {
                ...args.data,
                state: "in progress",
              });
              return jsonResult(created, "Update set created");
            }
            case "set_current": {
              if (!args.sys_id) return errorResult("sys_id required");
              const result = await client.restCall(
                "PATCH",
                `/api/now/table/sys_update_set/${args.sys_id}`,
                { state: "in progress" }
              );
              return jsonResult(
                result,
                "Update set set as current. Note: This sets the state to 'in progress'. Use the ServiceNow UI to actually switch context."
              );
            }
            case "query_contents": {
              if (!args.sys_id) return errorResult("sys_id required");
              const contents = await client.getRecords("sys_update_xml", {
                sysparm_query: `update_set=${args.sys_id}`,
                sysparm_fields: "sys_id,name,type,target_name,action",
                sysparm_limit: args.limit || 100,
              });
              return jsonResult(contents, `Update set contains ${contents.length} customer updates`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Scheduled Jobs ───────────────────────────────────────────────────

  private registerManageScheduledJobs(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "admin_manage_scheduled_jobs",
      `Manage ServiceNow scheduled jobs (sys_trigger).
Actions: list, get, enable, disable, list_running.
Best practices:
- Monitor long-running scheduled jobs — they consume scheduler worker threads.
- Stagger job schedules to avoid thundering-herd issues at midnight/top of hour.
- Use business rules or events instead of frequent polling jobs where possible.
- Document job purpose and expected runtime in the name/description.`,
      {
        action: z.enum(["list", "get", "enable", "disable", "list_running"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("sys_trigger", {
                sysparm_query: args.query || "ORDERBYDESCsys_updated_on",
                sysparm_fields: "sys_id,name,trigger_type,state,next_action,system_id,job_context",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} scheduled jobs`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_trigger", args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "Scheduled job details");
            }
            case "enable": {
              if (!args.sys_id) return errorResult("sys_id required");
              const updated = await client.updateRecord("sys_trigger", args.sys_id, { state: 0 });
              return jsonResult(updated, "Scheduled job enabled (state=Ready)");
            }
            case "disable": {
              if (!args.sys_id) return errorResult("sys_id required");
              const updated = await client.updateRecord("sys_trigger", args.sys_id, { state: 4 });
              return jsonResult(updated, "Scheduled job disabled");
            }
            case "list_running": {
              const records = await client.getRecords("sys_trigger", {
                sysparm_query: "state=1",
                sysparm_fields: "sys_id,name,trigger_type,state,claimed_by,sys_updated_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} currently executing jobs`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── ACLs ─────────────────────────────────────────────────────────────

  private registerManageACLs(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "admin_manage_acls",
      `Manage ServiceNow Access Control Lists (sys_security_acl).
Actions: list, get, create, update.
Best practices:
- Follow least-privilege principle — deny by default, grant explicitly.
- Use roles in ACLs, not individual users.
- Always test ACLs by impersonating users with different roles.
- Order matters: more specific ACLs (table.field) override broader ones (table.*).
- Document the business reason in the description field.
- Avoid using scripts in ACLs unless absolutely necessary (performance impact).`,
      {
        action: z.enum(["list", "get", "create", "update"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        data: z
          .object({
            name: z.string().optional(),
            operation: z.enum(["read", "write", "create", "delete"]).optional(),
            type: z.string().optional(),
            admin_overrides: z.boolean().optional(),
            active: z.boolean().optional(),
            description: z.string().optional(),
            condition: z.string().optional(),
            script: z.string().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("sys_security_acl", {
                sysparm_query: args.query || "active=true^ORDERBYname",
                sysparm_fields: "sys_id,name,operation,type,active,admin_overrides,description",
                sysparm_limit: args.limit || 50,
              });
              return jsonResult(records, `Found ${records.length} ACLs`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_security_acl", args.sys_id, {
                sysparm_display_value: "all",
              });
              return jsonResult(record, "ACL details");
            }
            case "create": {
              if (!args.data) return errorResult("data required");
              if (!args.data.description) {
                return errorResult("description is required — document why this ACL exists");
              }
              if (args.data.script) {
                return jsonResult(
                  null,
                  "Warning: Script-based ACLs have performance implications. Consider using condition-based ACLs instead. If you still want to proceed, confirm and resubmit."
                );
              }
              const created = await client.createRecord("sys_security_acl", { ...args.data, active: true });
              return jsonResult(created, "ACL created. Remember to test by impersonating affected users.");
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord("sys_security_acl", args.sys_id, args.data);
              return jsonResult(updated, "ACL updated. Verify by impersonating affected users.");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }
}
