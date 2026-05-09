export async function POST(request: Request) {
  const registryUrl = process.env.REGISTRY_URL;
  if (!registryUrl) {
    return Response.json({ error: "REGISTRY_URL not configured" }, { status: 500 });
  }
  try {
    const body = await request.json();
    const res = await fetch(`${registryUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok && typeof data.url === "string") {
      data.mcpUrl = `${registryUrl}${data.url}`;
    }
    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
