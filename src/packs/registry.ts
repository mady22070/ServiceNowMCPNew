import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceNowClient } from "../servicenow/client.js";
import type { Pack } from "./types.js";

import { AdminPack } from "./admin/index.js";
import { DevelopmentPack } from "./development/index.js";
import { ItsmPack } from "./itsm/index.js";
import { ItomPack } from "./itom/index.js";
import { TroubleshootingPack } from "./troubleshooting/index.js";

const ALL_PACKS: Pack[] = [
  new AdminPack(),
  new DevelopmentPack(),
  new ItsmPack(),
  new ItomPack(),
  new TroubleshootingPack(),
];

export function registerPacks(
  server: McpServer,
  client: ServiceNowClient,
  enabledPackNames: string[]
): void {
  const enabled = new Set(enabledPackNames.map((n) => n.toLowerCase()));

  for (const pack of ALL_PACKS) {
    if (enabled.has(pack.name.toLowerCase())) {
      pack.register(server, client);
      console.error(`[MCP] Registered pack: ${pack.name} — ${pack.description}`);
    } else {
      console.error(`[MCP] Skipped pack: ${pack.name} (not enabled)`);
    }
  }
}

export function listPacks(): Array<{ name: string; description: string }> {
  return ALL_PACKS.map((p) => ({ name: p.name, description: p.description }));
}
