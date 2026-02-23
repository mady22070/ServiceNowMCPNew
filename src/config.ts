export interface ServiceNowConfig {
  instanceUrl: string;
  auth:
    | { type: "basic"; username: string; password: string }
    | { type: "oauth2"; clientId: string; clientSecret: string; username: string; password: string };
  enabledPacks: string[];
  apiTimeout: number;
  pageSize: number;
}

export function loadConfig(): ServiceNowConfig {
  const instanceUrl = requiredEnv("SERVICENOW_INSTANCE_URL").replace(/\/+$/, "");

  const oauthClientId = process.env.SERVICENOW_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.SERVICENOW_OAUTH_CLIENT_SECRET;
  const username = requiredEnv("SERVICENOW_USERNAME");
  const password = requiredEnv("SERVICENOW_PASSWORD");

  const auth =
    oauthClientId && oauthClientSecret
      ? { type: "oauth2" as const, clientId: oauthClientId, clientSecret: oauthClientSecret, username, password }
      : { type: "basic" as const, username, password };

  const enabledPacks = (process.env.SERVICENOW_ENABLED_PACKS || "admin,development,itsm,itom,troubleshooting")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  const apiTimeout = parseInt(process.env.SERVICENOW_API_TIMEOUT || "30000", 10);
  const pageSize = parseInt(process.env.SERVICENOW_PAGE_SIZE || "100", 10);

  return { instanceUrl, auth, enabledPacks, apiTimeout, pageSize };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
