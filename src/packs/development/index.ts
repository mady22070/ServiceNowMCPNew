import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceNowClient } from "../../servicenow/client.js";
import { type Pack, toolResult, jsonResult, errorResult } from "../types.js";

// ── Best-practice code templates ────────────────────────────────────────

const CLIENT_SCRIPT_TEMPLATES: Record<string, string> = {
  onChange: `function onChange(control, oldValue, newValue, isLoading, isTemplate) {
    if (isLoading || newValue === '') {
        return;
    }

    // TODO: Add your onChange logic here
    // Best practices:
    // - Always check isLoading to avoid running on form load
    // - Use g_form.setValue(), g_form.setVisible(), g_form.setMandatory()
    // - Avoid GlideRecord calls — use GlideAjax instead for server data
    // - Keep client scripts lightweight for performance
}`,
  onLoad: `function onLoad() {
    // TODO: Add your onLoad logic here
    // Best practices:
    // - Minimize DOM manipulation
    // - Use g_form API (setValue, setVisible, setMandatory, setReadOnly)
    // - Avoid synchronous GlideRecord — use GlideAjax for server calls
    // - Consider UI Policies for simple show/hide/mandatory logic instead
}`,
  onSubmit: `function onSubmit() {
    // TODO: Add your validation/submit logic here
    // Best practices:
    // - Return false to abort submission, true to continue
    // - Use g_form.addErrorMessage() for user feedback
    // - Avoid heavy processing — keep submissions fast
    // - Validate required fields with g_form.getValue()

    var value = g_form.getValue('field_name');
    if (!value) {
        g_form.addErrorMessage('Field is required');
        return false;
    }
    return true;
}`,
  onCellEdit: `function onCellEdit(sysIDs, table, oldValues, newValue, callback) {
    // TODO: Add cell edit validation
    // Best practices:
    // - callback(true) to accept, callback(false) to reject
    // - sysIDs is an array — handle bulk edits
    // - Validate newValue before accepting

    callback(true);
}`,
};

const BUSINESS_RULE_TEMPLATES: Record<string, string> = {
  before: `(function executeRule(current, previous /*null when async*/) {

    // Before business rules run before the database operation
    // Best practices:
    // - Use for data validation and field manipulation
    // - Modify current object fields directly (no update() call needed)
    // - Use current.setAbortAction(true) to prevent the operation
    // - Avoid GlideRecord queries in before rules on high-volume tables
    // - Never use current.update() in a before rule (causes recursion)

    // Example: Auto-set a field
    // current.setValue('priority', 1);

})(current, previous);`,
  after: `(function executeRule(current, previous /*null when async*/) {

    // After business rules run after the database operation
    // Best practices:
    // - Use for related record operations (create child tasks, notifications)
    // - current.update() is safe here but creates another DB transaction
    // - Use GlideRecord for querying/updating related records
    // - Consider async rules if the work is non-blocking

    // Example: Create a related task
    // var task = new GlideRecord('task');
    // task.initialize();
    // task.short_description = 'Follow-up for ' + current.number;
    // task.insert();

})(current, previous);`,
  async: `(function executeRule(current, previous /*null when async*/) {

    // Async business rules run in the background after the transaction
    // Best practices:
    // - Use for heavy processing, notifications, integrations
    // - Does NOT block the user's transaction
    // - Cannot abort the operation (already committed)
    // - previous object is null in async rules
    // - Use for email notifications, event generation, third-party API calls

    // Example: Send event for integration
    // gs.eventQueue('custom.event.name', current, current.getValue('field1'), current.getValue('field2'));

})(current, previous);`,
};

const SCRIPT_INCLUDE_TEMPLATE = `var {CLASS_NAME} = Class.create();
{CLASS_NAME}.prototype = Object.extendsObject(AbstractAjaxProcessor, {

    // Public methods callable from client via GlideAjax
    // Best practices:
    // - Extend AbstractAjaxProcessor for client-callable script includes
    // - Use this.getParameter('sysparm_param_name') to get client parameters
    // - Set client_callable = true only if needed from client scripts
    // - Use 'new global.{CLASS_NAME}()' pattern for cross-scope calls
    // - Keep methods focused — single responsibility principle
    // - Always validate input parameters

    /**
     * Example method callable from client
     * @returns {string} JSON result
     */
    getExampleData: function() {
        var param = this.getParameter('sysparm_param1');
        if (!param) {
            return JSON.stringify({ error: 'Missing required parameter' });
        }

        // Your logic here
        var result = { success: true, data: param };
        return JSON.stringify(result);
    },

    type: '{CLASS_NAME}'
});`;

export class DevelopmentPack implements Pack {
  name = "development";
  description =
    "ServiceNow development — client scripts, business rules, script includes, UI policies, UI actions, scripted REST APIs, background scripts, and fix scripts";

  register(server: McpServer, client: ServiceNowClient): void {
    this.registerClientScripts(server, client);
    this.registerBusinessRules(server, client);
    this.registerScriptIncludes(server, client);
    this.registerUIPolicy(server, client);
    this.registerUIActions(server, client);
    this.registerScriptedRestApi(server, client);
    this.registerExecuteScript(server, client);
    this.registerFixScripts(server, client);
    this.registerScheduledScripts(server, client);
    this.registerSearchScript(server, client);
  }

  // ── Client Scripts ───────────────────────────────────────────────────

  private registerClientScripts(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "dev_client_scripts",
      `Manage ServiceNow client scripts (sys_script_client).
Actions: list, get, create, update, generate_template.
Best practices:
- Use UI Policies for simple field visibility/mandatory changes instead of client scripts.
- Always check isLoading in onChange to prevent running on form load.
- Use GlideAjax (not GlideRecord) for server-side data in client scripts.
- Keep client scripts lightweight — heavy scripts slow down form rendering.
- Use 'applies_to' wisely: target specific views to avoid running everywhere.
- Test on mobile/tablet — client scripts behave differently on Service Portal.`,
      {
        action: z.enum(["list", "get", "create", "update", "generate_template"]),
        sys_id: z.string().optional().describe("Record sys_id for get/update"),
        table: z.string().optional().describe("Target table (e.g. incident, change_request)"),
        query: z.string().optional(),
        script_type: z
          .enum(["onChange", "onLoad", "onSubmit", "onCellEdit"])
          .optional()
          .describe("Client script type for create/generate_template"),
        data: z
          .object({
            name: z.string().optional(),
            table: z.string().optional(),
            script: z.string().optional(),
            field_name: z.string().optional().describe("Field name for onChange scripts"),
            active: z.boolean().optional(),
            ui_type: z.enum(["0", "1", "10"]).optional().describe("0=Desktop, 1=Mobile, 10=Both"),
            description: z.string().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "generate_template": {
              const type = args.script_type || "onChange";
              const template = CLIENT_SCRIPT_TEMPLATES[type];
              return toolResult(
                `Template for ${type} client script on table '${args.table || "<table>"}':

${template}

Key reminders:
- Set 'ui_type' to 10 (All) unless you specifically need desktop/mobile only.
- For onChange: specify the field name in the 'field_name' parameter.
- For onSubmit: return false to prevent submission.
- Avoid direct DOM manipulation — use g_form API exclusively.`
              );
            }
            case "list": {
              const q = args.query || (args.table ? `table=${args.table}` : "active=true");
              const records = await client.getRecords("sys_script_client", {
                sysparm_query: q + "^ORDERBYname",
                sysparm_fields: "sys_id,name,table,type,field_name,active,ui_type,description",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} client scripts`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_script_client", args.sys_id);
              return jsonResult(record, "Client script details");
            }
            case "create": {
              if (!args.data?.name || !args.data?.table) return errorResult("data.name and data.table required");
              const type = args.script_type || "onChange";
              const script = args.data.script || CLIENT_SCRIPT_TEMPLATES[type];
              const created = await client.createRecord("sys_script_client", {
                ...args.data,
                type: type,
                script,
                active: args.data.active ?? true,
                ui_type: args.data.ui_type || "10",
              });
              return jsonResult(created, "Client script created");
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord("sys_script_client", args.sys_id, args.data);
              return jsonResult(updated, "Client script updated");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Business Rules ───────────────────────────────────────────────────

  private registerBusinessRules(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "dev_business_rules",
      `Manage ServiceNow business rules (sys_script).
Actions: list, get, create, update, generate_template.
Best practices:
- BEFORE rules: data validation and field manipulation. Never call current.update().
- AFTER rules: related record ops, events. current.update() is safe but creates another transaction.
- ASYNC rules: heavy processing, notifications, integrations. Cannot abort.
- DISPLAY rules: calculate values for form display. No DB ops.
- Use conditions (filter_condition) to limit when rules fire — more efficient than checking in script.
- Wrap logic in (function executeRule(current, previous){...})(current, previous); for scope isolation.
- Avoid recursive business rules — check current.operation() or use workflow flags.`,
      {
        action: z.enum(["list", "get", "create", "update", "generate_template"]),
        sys_id: z.string().optional(),
        table: z.string().optional().describe("Target table"),
        when: z.enum(["before", "after", "async", "display"]).optional().describe("When to run"),
        query: z.string().optional(),
        data: z
          .object({
            name: z.string().optional(),
            table: z.string().optional(),
            script: z.string().optional(),
            when: z.string().optional(),
            active: z.boolean().optional(),
            filter_condition: z.string().optional(),
            action_insert: z.boolean().optional(),
            action_update: z.boolean().optional(),
            action_delete: z.boolean().optional(),
            action_query: z.boolean().optional(),
            order: z.number().optional(),
            description: z.string().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "generate_template": {
              const when = args.when || "before";
              const template = BUSINESS_RULE_TEMPLATES[when] || BUSINESS_RULE_TEMPLATES.before;
              return toolResult(
                `Template for ${when} business rule on '${args.table || "<table>"}':

${template}

Execution order guide:
- order < 100: runs before default rules
- order = 100: default
- order > 100: runs after default rules
Use lower order for validation, higher for follow-up actions.`
              );
            }
            case "list": {
              const q = args.query || (args.table ? `collection=${args.table}` : "active=true");
              const records = await client.getRecords("sys_script", {
                sysparm_query: q + "^ORDERBYorder",
                sysparm_fields:
                  "sys_id,name,collection,when,active,action_insert,action_update,action_delete,order,description",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} business rules`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_script", args.sys_id);
              return jsonResult(record, "Business rule details");
            }
            case "create": {
              if (!args.data?.name || !args.data?.table) return errorResult("data.name and data.table required");
              const when = args.when || args.data.when || "before";
              const script = args.data.script || BUSINESS_RULE_TEMPLATES[when] || BUSINESS_RULE_TEMPLATES.before;

              const created = await client.createRecord("sys_script", {
                name: args.data.name,
                collection: args.data.table,
                when,
                script,
                active: args.data.active ?? true,
                action_insert: args.data.action_insert ?? true,
                action_update: args.data.action_update ?? false,
                action_delete: args.data.action_delete ?? false,
                action_query: args.data.action_query ?? false,
                order: args.data.order ?? 100,
                filter_condition: args.data.filter_condition || "",
                description: args.data.description || "",
              });
              return jsonResult(created, "Business rule created");
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updateData: Record<string, unknown> = { ...args.data };
              if (args.data.table) {
                updateData.collection = args.data.table;
                delete updateData.table;
              }
              const updated = await client.updateRecord("sys_script", args.sys_id, updateData);
              return jsonResult(updated, "Business rule updated");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Script Includes ──────────────────────────────────────────────────

  private registerScriptIncludes(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "dev_script_includes",
      `Manage ServiceNow script includes (sys_script_include).
Actions: list, get, create, update, generate_template.
Best practices:
- Use Class.create() + prototype pattern for reusable server-side code.
- Extend AbstractAjaxProcessor for client-callable script includes.
- Set client_callable=true ONLY if the script include is called from client scripts.
- Use 'api_name' for scoped apps to define the accessible name.
- Keep methods focused with single responsibility.
- Always validate input parameters before processing.
- Use JSDoc comments for documentation.`,
      {
        action: z.enum(["list", "get", "create", "update", "generate_template"]),
        sys_id: z.string().optional(),
        class_name: z.string().optional().describe("Class name for generate_template"),
        client_callable: z.boolean().optional().describe("Whether callable from client scripts"),
        query: z.string().optional(),
        data: z
          .object({
            name: z.string().optional(),
            script: z.string().optional(),
            client_callable: z.boolean().optional(),
            active: z.boolean().optional(),
            access: z.enum(["public", "package_private"]).optional(),
            api_name: z.string().optional(),
            description: z.string().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "generate_template": {
              const className = args.class_name || "MyScriptInclude";
              const template = SCRIPT_INCLUDE_TEMPLATE.replace(/{CLASS_NAME}/g, className);
              const clientNote = args.client_callable
                ? "This template extends AbstractAjaxProcessor for GlideAjax access."
                : 'For server-only usage, remove "Object.extendsObject(AbstractAjaxProcessor, ...)" and use a plain prototype.';
              return toolResult(
                `Template for script include '${className}':

${template}

${clientNote}

GlideAjax client-side usage:
  var ga = new GlideAjax('${className}');
  ga.addParam('sysparm_name', 'getExampleData');
  ga.addParam('sysparm_param1', 'value');
  ga.getXMLAnswer(function(answer) {
      var result = JSON.parse(answer);
      // handle result
  });`
              );
            }
            case "list": {
              const records = await client.getRecords("sys_script_include", {
                sysparm_query: args.query || "active=true^ORDERBYname",
                sysparm_fields: "sys_id,name,client_callable,active,access,api_name,description",
                sysparm_limit: args.limit || 50,
              });
              return jsonResult(records, `Found ${records.length} script includes`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_script_include", args.sys_id);
              return jsonResult(record, "Script include details");
            }
            case "create": {
              if (!args.data?.name) return errorResult("data.name required");
              const className = args.data.name;
              const script = args.data.script || SCRIPT_INCLUDE_TEMPLATE.replace(/{CLASS_NAME}/g, className);
              const created = await client.createRecord("sys_script_include", {
                name: className,
                script,
                client_callable: args.data.client_callable ?? args.client_callable ?? false,
                active: args.data.active ?? true,
                access: args.data.access || "public",
                api_name: args.data.api_name || "",
                description: args.data.description || "",
              });
              return jsonResult(created, "Script include created");
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord("sys_script_include", args.sys_id, args.data);
              return jsonResult(updated, "Script include updated");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── UI Policies ──────────────────────────────────────────────────────

  private registerUIPolicy(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "dev_ui_policies",
      `Manage ServiceNow UI policies (sys_ui_policy + sys_ui_policy_action).
Actions: list, get, create, update, add_action, list_actions.
Best practices:
- Prefer UI policies over client scripts for simple show/hide/mandatory/readonly changes.
- UI policies are easier to maintain and don't require scripting.
- Use 'Reverse if false' to automatically undo actions when conditions aren't met.
- Set execution order to control which policies take precedence.
- UI policies run on both desktop and mobile by default.
- Use script-based UI policies only when condition logic exceeds simple field comparisons.`,
      {
        action: z.enum(["list", "get", "create", "update", "add_action", "list_actions"]),
        sys_id: z.string().optional(),
        table: z.string().optional(),
        query: z.string().optional(),
        data: z
          .object({
            short_description: z.string().optional(),
            table: z.string().optional(),
            conditions: z.string().optional(),
            active: z.boolean().optional(),
            on_load: z.boolean().optional(),
            reverse_if_false: z.boolean().optional(),
            inherit: z.boolean().optional(),
            global: z.boolean().optional(),
            order: z.number().optional(),
            run_scripts: z.boolean().optional(),
            script_true: z.string().optional(),
            script_false: z.string().optional(),
          })
          .optional(),
        policy_action: z
          .object({
            field_name: z.string(),
            visible: z.enum(["true", "false", "ignore"]).optional(),
            mandatory: z.enum(["true", "false", "ignore"]).optional(),
            disabled: z.enum(["true", "false", "ignore"]).optional(),
          })
          .optional()
          .describe("Action to add to a UI policy"),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const q = args.query || (args.table ? `table=${args.table}` : "active=true");
              const records = await client.getRecords("sys_ui_policy", {
                sysparm_query: q + "^ORDERBYorder",
                sysparm_fields: "sys_id,short_description,table,active,on_load,reverse_if_false,order",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} UI policies`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_ui_policy", args.sys_id, { sysparm_display_value: "all" });
              return jsonResult(record, "UI policy details");
            }
            case "create": {
              if (!args.data?.short_description || !args.data?.table) {
                return errorResult("data.short_description and data.table required");
              }
              const created = await client.createRecord("sys_ui_policy", {
                ...args.data,
                active: args.data.active ?? true,
                on_load: args.data.on_load ?? true,
                reverse_if_false: args.data.reverse_if_false ?? true,
                order: args.data.order ?? 100,
              });
              return jsonResult(created, "UI policy created. Now add actions with 'add_action'");
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord("sys_ui_policy", args.sys_id, args.data);
              return jsonResult(updated, "UI policy updated");
            }
            case "add_action": {
              if (!args.sys_id || !args.policy_action) return errorResult("sys_id and policy_action required");
              const actionData: Record<string, unknown> = {
                ui_policy: args.sys_id,
                field: args.policy_action.field_name,
              };
              if (args.policy_action.visible && args.policy_action.visible !== "ignore")
                actionData.visible = args.policy_action.visible;
              if (args.policy_action.mandatory && args.policy_action.mandatory !== "ignore")
                actionData.mandatory = args.policy_action.mandatory;
              if (args.policy_action.disabled && args.policy_action.disabled !== "ignore")
                actionData.disabled = args.policy_action.disabled;
              const created = await client.createRecord("sys_ui_policy_action", actionData);
              return jsonResult(created, "UI policy action added");
            }
            case "list_actions": {
              if (!args.sys_id) return errorResult("sys_id required");
              const actions = await client.getRecords("sys_ui_policy_action", {
                sysparm_query: `ui_policy=${args.sys_id}`,
                sysparm_fields: "sys_id,field,visible,mandatory,disabled",
                sysparm_display_value: "true",
                sysparm_limit: 50,
              });
              return jsonResult(actions, `Found ${actions.length} policy actions`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── UI Actions ───────────────────────────────────────────────────────

  private registerUIActions(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "dev_ui_actions",
      `Manage ServiceNow UI actions (sys_ui_action) — form buttons, context menus, links, and list choices.
Actions: list, get, create, update.
Best practices:
- Set appropriate 'form_action' flag — form button, form context menu, form link, list button, list context, list choice.
- Use conditions to control visibility instead of hiding via script.
- For form buttons, set 'order' to control button placement (lower = left).
- Always include client-side confirmation for destructive actions.
- Use action_name to provide a consistent API name for the action.
- Isolate server-side logic in script includes, call from the UI action script.`,
      {
        action: z.enum(["list", "get", "create", "update"]),
        sys_id: z.string().optional(),
        table: z.string().optional(),
        query: z.string().optional(),
        data: z
          .object({
            name: z.string().optional(),
            table: z.string().optional(),
            action_name: z.string().optional(),
            script: z.string().optional(),
            client_script: z.string().optional(),
            condition: z.string().optional(),
            active: z.boolean().optional(),
            order: z.number().optional(),
            form_button: z.boolean().optional(),
            form_context_menu: z.boolean().optional(),
            form_link: z.boolean().optional(),
            list_button: z.boolean().optional(),
            list_context_menu: z.boolean().optional(),
            list_choice: z.boolean().optional(),
            client: z.boolean().optional().describe("true if runs client-side, false for server-side"),
            comments: z.string().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const q = args.query || (args.table ? `table=${args.table}` : "active=true");
              const records = await client.getRecords("sys_ui_action", {
                sysparm_query: q + "^ORDERBYorder",
                sysparm_fields:
                  "sys_id,name,table,action_name,active,order,form_button,list_button,client,condition",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} UI actions`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_ui_action", args.sys_id);
              return jsonResult(record, "UI action details");
            }
            case "create": {
              if (!args.data?.name || !args.data?.table) return errorResult("data.name and data.table required");
              const created = await client.createRecord("sys_ui_action", {
                ...args.data,
                active: args.data.active ?? true,
                order: args.data.order ?? 100,
              });
              return jsonResult(created, "UI action created");
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord("sys_ui_action", args.sys_id, args.data);
              return jsonResult(updated, "UI action updated");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Scripted REST APIs ───────────────────────────────────────────────

  private registerScriptedRestApi(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "dev_scripted_rest_api",
      `Manage ServiceNow Scripted REST APIs (sys_ws_definition + sys_ws_operation).
Actions: list_apis, get_api, create_api, list_resources, create_resource, update_resource.
Best practices:
- Always version your API (e.g. /api/x_myapp/v1/resource).
- Use proper HTTP methods: GET for reads, POST for creates, PUT/PATCH for updates, DELETE for deletes.
- Set 'Requires authentication' to true on all endpoints.
- Use request.body for POST/PUT body, request.queryParams for GET parameters.
- Return proper HTTP status codes (200, 201, 400, 404, 500).
- Use GlideRecordSecure instead of GlideRecord for ACL enforcement.
- Implement pagination for list endpoints.
- Document the API with ServiceNow API docs or Swagger.`,
      {
        action: z.enum(["list_apis", "get_api", "create_api", "list_resources", "create_resource", "update_resource"]),
        sys_id: z.string().optional(),
        api_sys_id: z.string().optional().describe("API definition sys_id for resource operations"),
        query: z.string().optional(),
        data: z
          .object({
            name: z.string().optional(),
            api_id: z.string().optional(),
            namespace: z.string().optional(),
            short_description: z.string().optional(),
            active: z.boolean().optional(),
          })
          .optional(),
        resource_data: z
          .object({
            name: z.string().optional(),
            http_method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
            relative_path: z.string().optional(),
            script: z.string().optional(),
            requires_authentication: z.boolean().optional(),
            short_description: z.string().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list_apis": {
              const records = await client.getRecords("sys_ws_definition", {
                sysparm_query: args.query || "active=true",
                sysparm_fields: "sys_id,name,api_id,namespace,active,short_description",
                sysparm_limit: args.limit || 50,
              });
              return jsonResult(records, `Found ${records.length} REST API definitions`);
            }
            case "get_api": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_ws_definition", args.sys_id);
              return jsonResult(record, "REST API definition");
            }
            case "create_api": {
              if (!args.data?.name) return errorResult("data.name required");
              const created = await client.createRecord("sys_ws_definition", {
                ...args.data,
                active: args.data.active ?? true,
              });
              return jsonResult(created, "REST API definition created. Now create resources with 'create_resource'");
            }
            case "list_resources": {
              if (!args.api_sys_id) return errorResult("api_sys_id required");
              const records = await client.getRecords("sys_ws_operation", {
                sysparm_query: `web_service_definition=${args.api_sys_id}`,
                sysparm_fields: "sys_id,name,http_method,relative_path,active,short_description",
                sysparm_limit: args.limit || 50,
              });
              return jsonResult(records, `Found ${records.length} REST API resources`);
            }
            case "create_resource": {
              if (!args.api_sys_id || !args.resource_data?.name) {
                return errorResult("api_sys_id and resource_data.name required");
              }
              const script =
                args.resource_data.script ||
                `(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {

    // Best practices:
    // - Use GlideRecordSecure for ACL-enforced queries
    // - Validate all input parameters
    // - Return proper HTTP status codes
    // - Implement pagination for collections

    var query = request.queryParams;
    var body = request.body ? request.body.data : null;

    try {
        // Your logic here
        response.setStatus(200);
        response.setBody({ result: 'success' });
    } catch (e) {
        response.setStatus(500);
        response.setBody({ error: { message: e.getMessage() } });
    }

})(request, response);`;
              const created = await client.createRecord("sys_ws_operation", {
                web_service_definition: args.api_sys_id,
                name: args.resource_data.name,
                http_method: args.resource_data.http_method || "GET",
                relative_path: args.resource_data.relative_path || "/",
                script,
                requires_authentication: args.resource_data.requires_authentication ?? true,
                active: true,
                short_description: args.resource_data.short_description || "",
              });
              return jsonResult(created, "REST API resource created");
            }
            case "update_resource": {
              if (!args.sys_id || !args.resource_data) return errorResult("sys_id and resource_data required");
              const updated = await client.updateRecord("sys_ws_operation", args.sys_id, args.resource_data);
              return jsonResult(updated, "REST API resource updated");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Background Script Execution ──────────────────────────────────────

  private registerExecuteScript(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "dev_execute_script",
      `Execute server-side JavaScript on the ServiceNow instance (background script).
Requires admin or script_eval role.
Best practices:
- Always test scripts in sub-production first.
- Use GlideRecord.setLimit() to prevent accidentally processing millions of records.
- Include gs.info() logging for audit trail.
- Wrap in try/catch for error handling.
- Never run DELETE operations without a WHERE clause equivalent (addQuery).
- Use GlideAggregate for counting instead of iterating records.`,
      {
        script: z.string().describe("Server-side JavaScript to execute"),
        confirm_production: z
          .boolean()
          .optional()
          .describe("Set to true to confirm execution on production instances"),
      },
      async (args) => {
        try {
          const result = await client.executeScript(args.script);
          return toolResult(`Script execution result:\n${result}`);
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Fix Scripts ──────────────────────────────────────────────────────

  private registerFixScripts(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "dev_fix_scripts",
      `Manage ServiceNow fix scripts (sys_script_fix).
Actions: list, get, create, update.
Best practices:
- Fix scripts are one-time execution scripts — use for data migrations, cleanup, bulk updates.
- Always include a record count / affected-rows summary in gs.info() output.
- Set setLimit() to process in batches for large data sets.
- Include rollback instructions in comments.
- Name fix scripts with ticket reference and purpose.
- Track in update sets for deployment.`,
      {
        action: z.enum(["list", "get", "create", "update"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        data: z
          .object({
            name: z.string().optional(),
            script: z.string().optional(),
            description: z.string().optional(),
            active: z.boolean().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("sys_script_fix", {
                sysparm_query: args.query || "ORDERBYDESCsys_updated_on",
                sysparm_fields: "sys_id,name,description,sys_created_by,sys_updated_on",
                sysparm_limit: args.limit || 30,
              });
              return jsonResult(records, `Found ${records.length} fix scripts`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sys_script_fix", args.sys_id);
              return jsonResult(record, "Fix script details");
            }
            case "create": {
              if (!args.data?.name || !args.data?.script) return errorResult("data.name and data.script required");
              const created = await client.createRecord("sys_script_fix", {
                ...args.data,
                active: true,
              });
              return jsonResult(created, "Fix script created. Run it from the ServiceNow UI or use dev_execute_script.");
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord("sys_script_fix", args.sys_id, args.data);
              return jsonResult(updated, "Fix script updated");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Scheduled Script Executions ──────────────────────────────────────

  private registerScheduledScripts(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "dev_scheduled_scripts",
      `Manage ServiceNow scheduled script executions (sysauto_script).
Actions: list, get, create, update.
Best practices:
- Stagger run times — avoid scheduling everything at midnight or top of hour.
- Use conditional_script to decide whether to run instead of checking in main script.
- Set run_as to a service account, not a personal admin account.
- Include logging (gs.info) for monitoring.
- Consider events + script actions instead of polling-based scheduled jobs.`,
      {
        action: z.enum(["list", "get", "create", "update"]),
        sys_id: z.string().optional(),
        query: z.string().optional(),
        data: z
          .object({
            name: z.string().optional(),
            script: z.string().optional(),
            active: z.boolean().optional(),
            run_type: z.string().optional().describe("daily, weekly, monthly, periodically, once, on_demand"),
            run_time: z.string().optional(),
            run_dayofweek: z.string().optional(),
            run_dayofmonth: z.string().optional(),
            time_zone: z.string().optional(),
          })
          .optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "list": {
              const records = await client.getRecords("sysauto_script", {
                sysparm_query: args.query || "ORDERBYname",
                sysparm_fields: "sys_id,name,active,run_type,run_time,sys_updated_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} scheduled scripts`);
            }
            case "get": {
              if (!args.sys_id) return errorResult("sys_id required");
              const record = await client.getRecord("sysauto_script", args.sys_id);
              return jsonResult(record, "Scheduled script details");
            }
            case "create": {
              if (!args.data?.name || !args.data?.script) return errorResult("data.name and data.script required");
              const created = await client.createRecord("sysauto_script", {
                ...args.data,
                active: args.data.active ?? false, // default inactive for safety
              });
              return jsonResult(
                created,
                "Scheduled script created (inactive by default). Review and activate when ready."
              );
            }
            case "update": {
              if (!args.sys_id || !args.data) return errorResult("sys_id and data required");
              const updated = await client.updateRecord("sysauto_script", args.sys_id, args.data);
              return jsonResult(updated, "Scheduled script updated");
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Search/Read Script Records ───────────────────────────────────────

  private registerSearchScript(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "dev_search_scripts",
      `Search across all script types in ServiceNow to find existing customizations.
Useful for auditing, finding duplicates, or understanding existing logic.
Searches: business rules, client scripts, script includes, fix scripts, UI actions.`,
      {
        search_term: z.string().describe("Text to search for in script bodies and names"),
        table: z.string().optional().describe("Limit search to scripts on a specific table"),
        script_type: z
          .enum(["business_rule", "client_script", "script_include", "fix_script", "ui_action", "all"])
          .optional()
          .describe("Limit to a specific script type (default: all)"),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          const results: Record<string, unknown[]> = {};
          const types = args.script_type === "all" || !args.script_type
            ? ["business_rule", "client_script", "script_include", "fix_script", "ui_action"]
            : [args.script_type];
          const limit = args.limit || 10;

          const tableMap: Record<string, { table: string; nameField: string; tableField?: string }> = {
            business_rule: { table: "sys_script", nameField: "name", tableField: "collection" },
            client_script: { table: "sys_script_client", nameField: "name", tableField: "table" },
            script_include: { table: "sys_script_include", nameField: "name" },
            fix_script: { table: "sys_script_fix", nameField: "name" },
            ui_action: { table: "sys_ui_action", nameField: "name", tableField: "table" },
          };

          for (const type of types) {
            const config = tableMap[type];
            if (!config) continue;
            let query = `scriptLIKE${args.search_term}^OR${config.nameField}LIKE${args.search_term}`;
            if (args.table && config.tableField) {
              query += `^${config.tableField}=${args.table}`;
            }
            const records = await client.getRecords(config.table, {
              sysparm_query: query,
              sysparm_fields: `sys_id,${config.nameField},active${config.tableField ? "," + config.tableField : ""}`,
              sysparm_limit: limit,
            });
            if (records.length > 0) {
              results[type] = records;
            }
          }

          const totalFound = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
          return jsonResult(results, `Found ${totalFound} scripts matching '${args.search_term}'`);
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }
}
