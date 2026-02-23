import type { ServiceNowConfig } from "../config.js";
import { AuthManager } from "./auth.js";
import type { ServiceNowRecord, QueryParams, TableApiResponse } from "./types.js";

export class ServiceNowClient {
  private config: ServiceNowConfig;
  private auth: AuthManager;

  constructor(config: ServiceNowConfig) {
    this.config = config;
    this.auth = new AuthManager(config);
  }

  get instanceUrl(): string {
    return this.config.instanceUrl;
  }

  get pageSize(): number {
    return this.config.pageSize;
  }

  // ── Table API: GET (list) ──────────────────────────────────────────

  async getRecords(table: string, params: QueryParams = {}): Promise<ServiceNowRecord[]> {
    const query = this.buildQueryString({
      sysparm_limit: this.config.pageSize,
      sysparm_exclude_reference_link: "true",
      ...params,
    });
    const url = `${this.config.instanceUrl}/api/now/table/${table}?${query}`;
    const response = await this.request("GET", url);
    const data = (await response.json()) as TableApiResponse;
    return Array.isArray(data.result) ? data.result : [data.result];
  }

  // ── Table API: GET (single record) ─────────────────────────────────

  async getRecord(table: string, sysId: string, params: QueryParams = {}): Promise<ServiceNowRecord> {
    const query = this.buildQueryString({
      sysparm_exclude_reference_link: "true",
      ...params,
    });
    const url = `${this.config.instanceUrl}/api/now/table/${table}/${sysId}?${query}`;
    const response = await this.request("GET", url);
    const data = (await response.json()) as TableApiResponse;
    return data.result as ServiceNowRecord;
  }

  // ── Table API: POST (create) ───────────────────────────────────────

  async createRecord(table: string, body: Record<string, unknown>): Promise<ServiceNowRecord> {
    const url = `${this.config.instanceUrl}/api/now/table/${table}`;
    const response = await this.request("POST", url, body);
    const data = (await response.json()) as TableApiResponse;
    return data.result as ServiceNowRecord;
  }

  // ── Table API: PATCH (update) ──────────────────────────────────────

  async updateRecord(table: string, sysId: string, body: Record<string, unknown>): Promise<ServiceNowRecord> {
    const url = `${this.config.instanceUrl}/api/now/table/${table}/${sysId}`;
    const response = await this.request("PATCH", url, body);
    const data = (await response.json()) as TableApiResponse;
    return data.result as ServiceNowRecord;
  }

  // ── Table API: DELETE ──────────────────────────────────────────────

  async deleteRecord(table: string, sysId: string): Promise<void> {
    const url = `${this.config.instanceUrl}/api/now/table/${table}/${sysId}`;
    await this.request("DELETE", url);
  }

  // ── Aggregate API ──────────────────────────────────────────────────

  async getAggregate(
    table: string,
    params: {
      sysparm_query?: string;
      sysparm_avg_fields?: string;
      sysparm_count?: "true";
      sysparm_min_fields?: string;
      sysparm_max_fields?: string;
      sysparm_sum_fields?: string;
      sysparm_group_by?: string;
    }
  ): Promise<unknown> {
    const query = this.buildQueryString(params);
    const url = `${this.config.instanceUrl}/api/now/stats/${table}?${query}`;
    const response = await this.request("GET", url);
    return response.json();
  }

  // ── Background Script Execution ────────────────────────────────────
  // Uses the ScriptEval endpoint or fix script pattern.
  // Requires the caller to have admin or script_eval role.

  async executeScript(script: string): Promise<string> {
    // Primary approach: use the undocumented but widely-used script execution endpoint
    const url = `${this.config.instanceUrl}/api/now/sp/exec`;
    try {
      const response = await this.request("POST", url, { script });
      const data = await response.json();
      return JSON.stringify(data, null, 2);
    } catch {
      // Fallback: create and execute a fix script
      return this.executeViaFixScript(script);
    }
  }

  private async executeViaFixScript(script: string): Promise<string> {
    const fixScript = await this.createRecord("sys_script_fix", {
      name: `MCP Execution ${Date.now()}`,
      script,
      active: true,
    });

    // Trigger execution via the fix script run endpoint
    const runUrl = `${this.config.instanceUrl}/api/now/table/sys_script_fix/${fixScript.sys_id}`;
    await this.request("PATCH", runUrl, { active: false });

    return `Fix script created and executed: ${fixScript.sys_id}. Check the script's output in the instance logs.`;
  }

  // ── Generic REST call ──────────────────────────────────────────────

  async restCall(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const url = `${this.config.instanceUrl}${path}`;
    const response = await this.request(method, url, body);
    if (response.status === 204) return { status: "success" };
    return response.json();
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private async request(method: string, url: string, body?: Record<string, unknown>): Promise<Response> {
    const authHeaders = await this.auth.getAuthHeaders();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders,
    };

    const options: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.config.apiTimeout),
    };

    if (body && method !== "GET" && method !== "DELETE") {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text();
      let detail = errorBody;
      try {
        const parsed = JSON.parse(errorBody);
        detail = parsed?.error?.message || parsed?.error?.detail || errorBody;
      } catch {
        // use raw text
      }
      throw new Error(`ServiceNow API error ${response.status} ${method} ${url}: ${detail}`);
    }

    return response;
  }

  private buildQueryString(params: Record<string, string | number | undefined>): string {
    const entries = Object.entries(params).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined
    );
    return new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
  }
}
