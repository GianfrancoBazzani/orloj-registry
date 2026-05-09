import { timingSafeEqual } from "node:crypto";
import { getPool } from "./db.mjs";

const BEARER_RE = /^Bearer\s+(.+)$/i;
const REALM = 'Bearer realm="orloj-registry"';
const REALM_INVALID = 'Bearer realm="orloj-registry", error="invalid_token"';

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function lookupToken(token) {
  const { rows } = await getPool().query(
    `SELECT agent_id, token
       FROM mcp_api_key
      WHERE token = $1
        AND revoked_at IS NULL
      LIMIT 1`,
    [token],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!constantTimeEquals(row.token, token)) return null;
  return { agentId: row.agent_id };
}

export async function requireBearer(req, res, next) {
  const header = req.headers.authorization;
  if (!header) {
    res
      .set("WWW-Authenticate", REALM)
      .status(401)
      .json({ error: "unauthorized" });
    return;
  }
  const match = BEARER_RE.exec(header);
  if (!match) {
    res
      .set("WWW-Authenticate", REALM_INVALID)
      .status(401)
      .json({ error: "invalid_token" });
    return;
  }
  const token = match[1].trim();
  let result;
  try {
    result = await lookupToken(token);
  } catch (err) {
    console.error("[auth] lookup failed:", err);
    res.status(500).json({ error: "internal error" });
    return;
  }
  if (!result) {
    res
      .set("WWW-Authenticate", REALM_INVALID)
      .status(401)
      .json({ error: "invalid_token" });
    return;
  }
  req.auth = { agentId: result.agentId };
  next();
}
