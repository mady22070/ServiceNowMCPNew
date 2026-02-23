import type { ServiceNowConfig } from "../config.js";
import type { OAuthTokenResponse } from "./types.js";

export class AuthManager {
  private config: ServiceNowConfig;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: ServiceNowConfig) {
    this.config = config;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.config.auth.type === "basic") {
      const credentials = Buffer.from(
        `${this.config.auth.username}:${this.config.auth.password}`
      ).toString("base64");
      return { Authorization: `Basic ${credentials}` };
    }

    const token = await this.getOAuthToken();
    return { Authorization: `Bearer ${token}` };
  }

  private async getOAuthToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    if (this.config.auth.type !== "oauth2") {
      throw new Error("OAuth2 configuration not available");
    }

    const { clientId, clientSecret, username, password } = this.config.auth;
    const tokenUrl = `${this.config.instanceUrl}/oauth_token.do`;

    const body = new URLSearchParams({
      grant_type: "password",
      client_id: clientId,
      client_secret: clientSecret,
      username,
      password,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth2 token request failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as OAuthTokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }
}
