"use client";
import { createContext, useContext, useMemo, useState } from "react";
import { authClient } from "@/lib/auth-client";

type Provider = "wallet" | "github" | "google" | "farcaster" | "email";

interface UiUser {
  name: string;
  email: string;
  address: string;
  plan: string;
  joined: string;
  provider: string;
}

interface AuthContextValue {
  user: UiUser | null;
  loading: boolean;
  showLogin: boolean;
  setShowLogin: (v: boolean) => void;
  signIn: (provider: Provider) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ADDRESS_FROM_EMAIL = /^(0x[a-fA-F0-9]{40})@/;

const shortAddr = (a: string) =>
  a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

const formatJoined = (d: string | Date | null | undefined) => {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
};

type EthProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

const getInjectedEthereum = (): EthProvider | null => {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: EthProvider }).ethereum ?? null;
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const session = authClient.useSession();
  const [showLogin, setShowLogin] = useState(false);

  const user = useMemo<UiUser | null>(() => {
    const u = session.data?.user;
    if (!u) return null;
    const match = u.email?.match(ADDRESS_FROM_EMAIL);
    const rawAddress = match ? match[1] : "";
    const isWallet = !!rawAddress;
    return {
      name:
        u.name && u.name.length > 0
          ? u.name
          : isWallet
            ? shortAddr(rawAddress)
            : (u.email ?? ""),
      email: u.email ?? "",
      address: rawAddress,
      plan: "Studio",
      joined: formatJoined(u.createdAt),
      provider: isWallet ? "siwe" : "email",
    };
  }, [session.data?.user]);

  const signIn = async (provider: Provider) => {
    if (provider !== "wallet") {
      throw new Error(
        `Provider "${provider}" is not wired yet — only Ethereum wallet (SIWE) is implemented.`,
      );
    }
    const eth = getInjectedEthereum();
    if (!eth) {
      throw new Error(
        "No Ethereum wallet detected. Install MetaMask (or another EIP-1193 wallet) and try again.",
      );
    }

    const accounts = (await eth.request({
      method: "eth_requestAccounts",
    })) as string[];
    const walletAddress = accounts[0];
    if (!walletAddress) throw new Error("No account selected");

    const chainHex = (await eth.request({ method: "eth_chainId" })) as string;
    const chainId = Number.parseInt(chainHex, 16);

    const { createSiweMessage } = await import("viem/siwe");

    const { data: nonceData, error: nonceErr } = await authClient.siwe.nonce({
      walletAddress,
      chainId,
    });
    if (nonceErr) throw new Error(nonceErr.message ?? "Failed to fetch nonce");
    if (!nonceData) throw new Error("Failed to fetch nonce");

    const message = createSiweMessage({
      domain: window.location.host,
      address: walletAddress as `0x${string}`,
      statement: "Sign in to ORLOJ — the registry for smart interfaces.",
      uri: window.location.origin,
      version: "1",
      chainId,
      nonce: nonceData.nonce,
      issuedAt: new Date(),
    });

    const signature = (await eth.request({
      method: "personal_sign",
      params: [message, walletAddress],
    })) as string;

    const { error: verifyErr } = await authClient.siwe.verify({
      message,
      signature,
      walletAddress,
      chainId,
    });
    if (verifyErr)
      throw new Error(verifyErr.message ?? "Signature verification failed");

    await session.refetch?.();
  };

  const signOut = async () => {
    await authClient.signOut();
    await session.refetch?.();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading: session.isPending,
        showLogin,
        setShowLogin,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};
