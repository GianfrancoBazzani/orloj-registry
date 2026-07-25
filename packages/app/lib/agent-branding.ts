import "server-only";

import { getPool } from "@/lib/db";

const MAX_APP_NAME = 40;
const MAX_ICON_BYTES = 1024 * 1024;
const MIN_ICON_SIZE = 192;
const MAX_ICON_SIZE = 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const UNSAFE_NAME_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_NAME_CHARS_GLOBAL =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

export interface AgentBranding {
  appName: string | null;
  iconPng: Buffer | null;
  iconWidth: number | null;
  iconHeight: number | null;
}

export interface ValidatedPng {
  bytes: Buffer;
  width: number;
  height: number;
}

export function validateAppName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_APP_NAME || UNSAFE_NAME_CHARS.test(trimmed)) {
    throw new Error(`App name must be 1–${MAX_APP_NAME} safe characters`);
  }
  return trimmed;
}

export function manifestAppName(agentName: string, customName: string | null): string {
  const base =
    (customName || agentName)
      .replace(UNSAFE_NAME_CHARS_GLOBAL, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_APP_NAME) || "Agent";
  return base.toLocaleLowerCase().endsWith("orloj")
    ? base
    : `${base} · Orloj`;
}

export function defaultAppDescription(
  agentName: string,
  mcpNames: string[],
): string {
  const safeAgentName =
    agentName
      .replace(UNSAFE_NAME_CHARS_GLOBAL, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80) || "This agent";
  if (mcpNames.length === 0) {
    return `${safeAgentName} is an Orloj blockchain agent ready for MCP assignments.`;
  }
  const names = mcpNames.slice(0, 3).join(", ");
  const suffix = mcpNames.length > 3 ? ` +${mcpNames.length - 3}` : "";
  return `${safeAgentName} uses ${names}${suffix} through Orloj.`;
}

export function validatePng(bytes: Buffer, contentType: string): ValidatedPng {
  if (contentType !== "image/png") throw new Error("Only PNG icons are allowed");
  if (bytes.length < 33 || bytes.length > MAX_ICON_BYTES) {
    throw new Error("PNG icon must be no larger than 1 MiB");
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid PNG signature");
  }
  if (
    bytes.readUInt32BE(8) !== 13 ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("Invalid PNG header");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (
    width !== height ||
    width < MIN_ICON_SIZE ||
    width > MAX_ICON_SIZE
  ) {
    throw new Error(
      `PNG icon must be square and ${MIN_ICON_SIZE}–${MAX_ICON_SIZE}px`,
    );
  }
  if (bytes.indexOf(Buffer.from("acTL", "ascii")) !== -1) {
    throw new Error("Animated PNG icons are not allowed");
  }
  return { bytes, width, height };
}

export async function getAgentBranding(agentId: string): Promise<AgentBranding> {
  const pool = await getPool();
  const { rows } = await pool.query<{
    app_name: string | null;
    icon_png: Buffer | null;
    icon_width: number | null;
    icon_height: number | null;
  }>(
    `SELECT app_name, icon_png, icon_width, icon_height
       FROM agent_app_branding
      WHERE agent_id = $1`,
    [agentId],
  );
  const row = rows[0];
  return {
    appName: row?.app_name ?? null,
    iconPng: row?.icon_png ?? null,
    iconWidth: row?.icon_width ?? null,
    iconHeight: row?.icon_height ?? null,
  };
}

export async function saveAgentBranding(
  agentId: string,
  branding: AgentBranding,
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO agent_app_branding
       (agent_id, app_name, icon_png, icon_width, icon_height, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (agent_id) DO UPDATE SET
       app_name = EXCLUDED.app_name,
       icon_png = EXCLUDED.icon_png,
       icon_width = EXCLUDED.icon_width,
       icon_height = EXCLUDED.icon_height,
       updated_at = now()`,
    [
      agentId,
      branding.appName,
      branding.iconPng,
      branding.iconWidth,
      branding.iconHeight,
    ],
  );
}
