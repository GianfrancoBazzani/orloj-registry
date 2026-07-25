import { createElement } from "react";
import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { assertAgentOwner } from "@/lib/agent-ownership";
import { getAgentBranding } from "@/lib/agent-branding";
import { listMcpsForAgent } from "@/lib/agent-mcps";

const COLORS = ["#287a78", "#b8893a", "#8c1e28", "#315f7d"];
const POSITIONS = [
  { left: "8%", top: "8%" },
  { right: "8%", top: "8%" },
  { left: "8%", bottom: "8%" },
  { right: "8%", bottom: "8%" },
];

function initials(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "M";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; size: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Not found", { status: 404 });
  const { id, size: rawSize } = await params;
  const ownership = await assertAgentOwner(id, session.user.id);
  if (ownership !== true) return new Response("Not found", { status: 404 });

  const size = Number(rawSize);
  if (size !== 192 && size !== 512) {
    return new Response("Unsupported icon size", { status: 400 });
  }

  const [branding, assignedMcps] = await Promise.all([
    getAgentBranding(id),
    listMcpsForAgent(id),
  ]);
  const customImage = branding.iconPng
    ? `data:image/png;base64,${branding.iconPng.toString("base64")}`
    : null;

  const subIcons = (assignedMcps.length > 0 ? assignedMcps : ["agent"])
    .slice(0, 4)
    .map((mcpName, index) =>
      createElement(
        "div",
        {
          key: mcpName,
          style: {
            position: "absolute",
            ...POSITIONS[index],
            width: "20%",
            height: "20%",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: COLORS[index],
            color: "#fff8e7",
            border: `${Math.max(2, Math.round(size / 96))}px solid #f1e9d4`,
            fontSize: Math.round(size * 0.07),
            fontWeight: 700,
          },
        },
        initials(mcpName),
      ),
    );

  const center = customImage
    ? createElement("img", {
        src: customImage,
        alt: "",
        width: Math.round(size * 0.62),
        height: Math.round(size * 0.62),
        style: {
          width: "62%",
          height: "62%",
          borderRadius: "22%",
          objectFit: "cover",
          border: `${Math.max(4, Math.round(size / 64))}px solid #1a1612`,
        },
      })
    : createElement(
        "div",
        {
          style: {
            width: "62%",
            height: "62%",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#1a1612",
            color: "#d4a84f",
            border: `${Math.max(4, Math.round(size / 64))}px solid #b8893a`,
            fontSize: Math.round(size * 0.24),
            fontWeight: 700,
          },
        },
        "O",
      );

  return new ImageResponse(
    createElement(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f1e9d4",
          borderRadius: "22%",
          border: `${Math.max(5, Math.round(size / 48))}px solid #b8893a`,
          overflow: "hidden",
        },
      },
      center,
      ...subIcons,
      customImage
        ? createElement(
            "div",
            {
              style: {
                position: "absolute",
                right: "7%",
                bottom: "7%",
                width: "22%",
                height: "22%",
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#1a1612",
                color: "#d4a84f",
                border: `${Math.max(2, Math.round(size / 128))}px solid #f1e9d4`,
                fontSize: Math.round(size * 0.1),
                fontWeight: 700,
              },
            },
            "O",
          )
        : null,
    ),
    {
      width: size,
      height: size,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:",
        "Content-Type": "image/png",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
