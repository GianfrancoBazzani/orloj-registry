import { headers } from "next/headers";
import { randomBytes } from "node:crypto";
import { auth } from "@/lib/auth";
import type { Vault } from "@/components/data";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");

const mockAddress = () =>
  "0x" + randomHex(4) + "..." + randomHex(2);

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const { name, description } = body as Record<string, unknown>;

  if (typeof name !== "string" || typeof description !== "string") {
    return Response.json(
      { error: "`name` and `description` must be strings" },
      { status: 400 },
    );
  }

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();

  if (trimmedName.length === 0 || trimmedName.length > NAME_MAX) {
    return Response.json(
      { error: `\`name\` must be 1–${NAME_MAX} characters` },
      { status: 400 },
    );
  }

  if (trimmedDescription.length > DESCRIPTION_MAX) {
    return Response.json(
      { error: `\`description\` must be ≤ ${DESCRIPTION_MAX} characters` },
      { status: 400 },
    );
  }

  const vault: Vault = {
    id: "v-" + randomHex(6),
    name: trimmedName,
    description: trimmedDescription,
    address: mockAddress(),
    kms: "Turnkey",
    policy: "no policy",
    keys: 1,
    lastUsed: "just now",
    color: "brass",
  };

  return Response.json({ vault }, { status: 201 });
}
