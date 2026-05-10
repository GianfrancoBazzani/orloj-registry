"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Btn,
  Divider,
  Field,
  Input,
  Select,
  StainedPanel,
} from "./ornaments";
import { LaunchModal, type RegisterResult } from "./launch-modal";
import { useT, useLocale } from "./i18n-context";

const CHAIN_IDS: Record<string, number> = {
  Ethereum: 1,
  Optimism: 10,
  Base: 8453,
  Arbitrum: 42161,
  Gnosis: 100,
  Polygon: 137,
};

export const Register = () => {
  const router = useRouter();
  const locale = useLocale();
  const t = useT();
  const [address, setAddress] = useState("");
  const [chain, setChain] = useState("Ethereum");
  const [rpcUrl, setRpcUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterResult | null>(null);

  const validAddress = /^0x[a-fA-F0-9]{40}$/.test(address);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          chainId: CHAIN_IDS[chain] ?? 1,
          rpcUrl: rpcUrl || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setResult(data as RegisterResult);
      } else {
        setError(String((data as { error?: string }).error ?? "Registration failed"));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <main className="page-pad" style={{ padding: "40px 32px 80px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          {/* Header */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              flexWrap: "wrap",
              gap: 16,
              marginBottom: 24,
            }}
          >
            <div>
              <h1
                className="display"
                style={{
                  fontSize: "clamp(36px, 5vw, 56px)",
                  margin: 0,
                  lineHeight: 1,
                }}
              >
                {t("register.title")}
              </h1>
              <p
                className="poetic"
                style={{
                  fontSize: 20,
                  color: "var(--ink-soft)",
                  marginTop: 8,
                  marginBottom: 0,
                }}
              >
                {t("register.subtitle")}
              </p>
            </div>
            <Btn kind="ghost" onClick={() => router.push(`/${locale}/explore`)}>
              {t("register.backToRegistry")}
            </Btn>
          </div>

          <Divider />

          <div
            className="register-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr 1fr",
              gap: 32,
              marginTop: 28,
              alignItems: "flex-start",
            }}
          >
            {/* Form panel */}
            <div
              className="register-form-panel"
              style={{
                padding: 32,
                background: "rgba(241,233,212,0.5)",
                border: "1px solid var(--line)",
              }}
            >
              <div style={{ display: "grid", gap: 20 }}>
                <div
                  className="register-form-row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 180px",
                    gap: 12,
                  }}
                >
                  <Field label={t("register.contractAddress")}>
                    <Input
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="0x…"
                      style={{ fontFamily: "var(--font-mono)" }}
                    />
                  </Field>
                  <Field label={t("register.chain")}>
                    <Select
                      value={chain}
                      onChange={setChain}
                      options={Object.keys(CHAIN_IDS)}
                    />
                  </Field>
                </div>

                <Field
                  label={t("register.rpcUrl")}
                  hint={t("register.rpcHint")}
                >
                  <Input
                    value={rpcUrl}
                    onChange={(e) => setRpcUrl(e.target.value)}
                    placeholder="https://…"
                    style={{ fontFamily: "var(--font-mono)" }}
                  />
                </Field>
              </div>

              {/* Error */}
              {error && (
                <div
                  style={{
                    marginTop: 20,
                    padding: "12px 14px",
                    background: "rgba(139,37,50,0.08)",
                    border: "1px solid var(--wine)",
                    borderLeft: "3px solid var(--wine)",
                    fontSize: 13,
                    color: "var(--wine)",
                  }}
                >
                  {error}
                </div>
              )}

              {/* Submit */}
              <div
                style={{
                  marginTop: 28,
                  paddingTop: 24,
                  borderTop: "1px dashed var(--line)",
                  display: "flex",
                  justifyContent: "flex-end",
                }}
              >
                <Btn
                  kind="brass"
                  size="lg"
                  disabled={!validAddress || submitting}
                  onClick={submit}
                >
                  {submitting ? t("register.submitting") : t("register.submit")}
                </Btn>
              </div>
            </div>

            {/* Side panel */}
            <div className="register-side" style={{ position: "sticky", top: 24 }}>
              <div
                style={{
                  border: "1px solid var(--line)",
                  background: "rgba(241,233,212,0.4)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: 64,
                    background: "var(--ink)",
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ position: "absolute", inset: 0, opacity: 0.3 }}>
                    <StainedPanel
                      seed={address.length || 1}
                      width={400}
                      height={64}
                    />
                  </div>
                </div>
                <div style={{ padding: 20 }}>
                  <div
                    className="smallcaps"
                    style={{
                      fontSize: 11,
                      color: "var(--ink-soft)",
                      marginBottom: 12,
                    }}
                  >
                    {t("register.checksLabel")}
                  </div>
                  {[
                    [t("register.checkAddress"), validAddress],
                    [t("register.checkChain"), true],
                    [t("register.checkCustomRpc"), rpcUrl.startsWith("http")],
                  ].map(([label, ok]) => (
                    <div
                      key={String(label)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 13,
                        padding: "5px 0",
                        color: ok
                          ? "var(--verdigris-deep)"
                          : "var(--ink-soft)",
                      }}
                    >
                      <span>
                        {ok ? "✓" : "○"} {label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div
                style={{
                  marginTop: 16,
                  padding: "16px 18px",
                  background: "rgba(241,233,212,0.4)",
                  border: "1px solid var(--line)",
                  fontSize: 13,
                  color: "var(--ink-soft)",
                  lineHeight: 1.6,
                }}
              >
                <span
                  className="smallcaps"
                  style={{
                    fontSize: 10,
                    color: "var(--brass-deep)",
                    display: "block",
                    marginBottom: 6,
                  }}
                >
                  {t("register.howItWorks")}
                </span>
                {t("register.howItWorksDesc")}
              </div>
            </div>
          </div>
        </div>
      </main>

      {result && (
        <LaunchModal result={result} onCloseAction={() => setResult(null)} />
      )}
    </>
  );
};
