import { catalogPayload } from "@/lib/session/skill-catalog";

// Unauthenticated like GET /api/mcps: the catalog is public data published to 0G, and the
// picker needs it before any agent is chosen.
export async function GET() {
  try {
    return Response.json(await catalogPayload(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    console.error("[skills] catalog unavailable", err);
    return Response.json(
      { error: "0G Storage unreachable", code: "zg_unreachable" },
      { status: 502 },
    );
  }
}
