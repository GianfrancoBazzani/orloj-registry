const COLORS = {
  parchment: "#f1e9d4",
  parchment2: "#ece2c7",
  parchment3: "#e3d6b3",
  ink: "#1a1612",
  inkSoft: "#4b4031",
  brass: "#b8893a",
  brassDeep: "#8a6420",
  brassBright: "#d4a449",
  verdigrisDeep: "#1d4a3f",
  line: "rgba(26,22,18,0.18)",
};

const escape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const renderMagicLinkEmail = (
  url: string,
): { html: string; text: string } => {
  const safeUrl = escape(url);
  const text = [
    "ORLOJ — sign-in link",
    "",
    "Step into the square. Click the link below to sign in:",
    "",
    url,
    "",
    "This link expires in 5 minutes and works only once.",
    "If you didn't request this, ignore the message — nothing happens until you click.",
    "",
    "Orloj · ETHPrague 2026",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Sign in to Orloj</title>
  </head>
  <body style="margin:0;padding:0;background:${COLORS.parchment2};font-family:Georgia,'Times New Roman',serif;color:${COLORS.ink};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">A signal from the tower — your sign-in link to Orloj. Expires in 5 minutes.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.parchment2};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;background:${COLORS.parchment};border:1px solid ${COLORS.line};box-shadow:6px 6px 0 ${COLORS.brass};">
            <!-- Header band -->
            <tr>
              <td style="background:${COLORS.verdigrisDeep};padding:22px 32px;color:${COLORS.parchment};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="left" style="font-family:Georgia,'Times New Roman',serif;font-size:20px;letter-spacing:0.22em;font-weight:600;color:${COLORS.parchment};">
                      ◐&nbsp;&nbsp;ORLOJ
                    </td>
                    <td align="right" style="font-size:11px;letter-spacing:0.18em;color:${COLORS.brassBright};font-variant:small-caps;font-family:Helvetica,Arial,sans-serif;">
                      registry · v0.4
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:40px 44px 8px 44px;">
                <div style="text-align:center;font-size:11px;letter-spacing:0.22em;color:${COLORS.brassDeep};font-variant:small-caps;font-family:Helvetica,Arial,sans-serif;margin-bottom:18px;">
                  ✦&nbsp;&nbsp;a signal from the tower&nbsp;&nbsp;✦
                </div>
                <h1 style="margin:0 0 18px 0;font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.15;font-weight:600;color:${COLORS.ink};letter-spacing:0.01em;text-align:center;">
                  Step into the square.
                </h1>
                <p style="margin:0 0 22px 0;font-style:italic;font-size:17px;line-height:1.5;color:${COLORS.inkSoft};text-align:center;font-family:Georgia,'Times New Roman',serif;">
                  &ldquo;When the noon bell strikes, the apostles parade — and your agent signs.&rdquo;
                </p>
                <p style="margin:0 0 28px 0;font-size:14px;line-height:1.6;color:${COLORS.ink};text-align:center;font-family:Helvetica,Arial,sans-serif;">
                  Click the bell below to sign in. This link expires in <strong>5 minutes</strong> and works only once.
                </p>
              </td>
            </tr>

            <!-- CTA button (with brass drop-shadow via wrapper cell) -->
            <tr>
              <td align="center" style="padding:0 44px 36px 44px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="background:${COLORS.brass};padding:0;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:-3px 0 3px -3px;">
                        <tr>
                          <td bgcolor="${COLORS.ink}" style="background:${COLORS.ink};border:1px solid ${COLORS.ink};">
                            <a href="${safeUrl}" style="display:inline-block;padding:16px 40px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.20em;text-transform:lowercase;font-variant:small-caps;color:${COLORS.parchment};text-decoration:none;">
                              ✦&nbsp;&nbsp;sign in to orloj&nbsp;&nbsp;→
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- URL fallback -->
            <tr>
              <td style="padding:0 44px 8px 44px;">
                <div style="font-size:11px;letter-spacing:0.18em;color:${COLORS.inkSoft};font-variant:small-caps;font-family:Helvetica,Arial,sans-serif;margin-bottom:8px;">
                  or paste this url
                </div>
                <div style="background:${COLORS.parchment3};border:1px solid ${COLORS.line};padding:12px 14px;font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:${COLORS.ink};word-break:break-all;">
                  <a href="${safeUrl}" style="color:${COLORS.brassDeep};text-decoration:none;">${safeUrl}</a>
                </div>
              </td>
            </tr>

            <!-- Divider -->
            <tr>
              <td style="padding:32px 44px 0 44px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td height="1" style="background:${COLORS.line};font-size:0;line-height:0;">&nbsp;</td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footnote -->
            <tr>
              <td style="padding:18px 44px 36px 44px;">
                <p style="margin:0;font-size:12.5px;line-height:1.55;color:${COLORS.inkSoft};font-family:Helvetica,Arial,sans-serif;font-style:italic;text-align:center;">
                  If you didn't request this, ignore the message. Nothing happens until you click.
                </p>
              </td>
            </tr>
          </table>

          <!-- Footer -->
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;margin-top:18px;">
            <tr>
              <td align="center" style="font-size:10px;letter-spacing:0.22em;color:${COLORS.inkSoft};font-variant:small-caps;font-family:Helvetica,Arial,sans-serif;">
                Orloj · ETHPrague 2026 · Staré Město
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { html, text };
};
