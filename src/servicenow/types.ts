export interface ServiceNowRecord {
  sys_id: string;
  [key: string]: unknown;
}

export interface TableApiResponse {
  result: ServiceNowRecord | ServiceNowRecord[];
}

export interface TableApiErrorResponse {
  error: {
    message: string;
    detail?: string;
  };
}

export interface QueryParams {
  sysparm_query?: string;
  sysparm_fields?: string;
  sysparm_limit?: number;
  sysparm_offset?: number;
  sysparm_display_value?: "true" | "false" | "all";
  sysparm_exclude_reference_link?: "true" | "false";
  sysparm_suppress_pagination_header?: "true" | "false";
  [key: string]: string | number | undefined;
}

export interface ScriptExecutionRequest {
  script: string;
  scope?: string;
}

export interface ScriptExecutionResponse {
  result: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expires_in: number;
}
