export async function POST(request: Request) {
  const registryUrl = process.env.REGISTRY_URL;
  if (!registryUrl) {
    return Response.json({ error: "REGISTRY_URL not configured" }, { status: 500 });
  }
  const publicRegistryUrl = process.env.PUBLIC_REGISTRY_URL ?? registryUrl;
  try {
    const body = await request.json();
    const res = await fetch(`${registryUrl}/register-native`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok && typeof data.url === "string") {
      data.mcpUrl = `${publicRegistryUrl}${data.url}`;
    }
    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
