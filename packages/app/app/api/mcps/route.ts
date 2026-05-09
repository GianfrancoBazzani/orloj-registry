import { fetchMcps } from "@/lib/registry-mcps";

export async function GET() {
  const mcps = await fetchMcps();
  return Response.json({ mcps });
}
