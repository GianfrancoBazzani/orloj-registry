import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import {
  getAgentBranding,
  saveAgentBranding,
  validateAppName,
  validatePng,
} from "@/lib/agent-branding";

async function authorize(id: string): Promise<true | Response> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return assertAgentOwner(id, session.user.id);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownership = await authorize(id);
  if (ownership !== true) return ownership;
  const branding = await getAgentBranding(id);
  return Response.json(
    {
      appName: branding.appName,
      hasCustomIcon: Boolean(branding.iconPng),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownership = await authorize(id);
  if (ownership !== true) return ownership;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Invalid form data" }, { status: 400 });
  }

  const current = await getAgentBranding(id);
  let appName = current.appName;
  let iconPng = current.iconPng;
  let iconWidth = current.iconWidth;
  let iconHeight = current.iconHeight;

  const rawName = form.get("appName");
  if (typeof rawName === "string") {
    try {
      appName = rawName.trim() ? validateAppName(rawName) : null;
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid app name" },
        { status: 400 },
      );
    }
  }

  if (form.get("clearIcon") === "true") {
    iconPng = null;
    iconWidth = null;
    iconHeight = null;
  }

  const icon = form.get("icon");
  if (icon instanceof File && icon.size > 0) {
    try {
      const validated = validatePng(
        Buffer.from(await icon.arrayBuffer()),
        icon.type,
      );
      iconPng = validated.bytes;
      iconWidth = validated.width;
      iconHeight = validated.height;
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid PNG icon" },
        { status: 400 },
      );
    }
  }

  await saveAgentBranding(id, {
    appName,
    iconPng,
    iconWidth,
    iconHeight,
  });
  return Response.json(
    {
      appName,
      hasCustomIcon: Boolean(iconPng),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
