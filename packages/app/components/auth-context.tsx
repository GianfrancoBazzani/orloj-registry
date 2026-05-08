"use client";
import { createContext, useContext, useState } from "react";

interface User {
  name: string;
  email: string;
  address: string;
  plan: string;
  joined: string;
  provider: string;
}

interface AuthContextValue {
  user: User | null;
  setUser: (u: User | null) => void;
  showLogin: boolean;
  setShowLogin: (v: boolean) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [showLogin, setShowLogin] = useState(false);

  return (
    <AuthContext.Provider value={{ user, setUser, showLogin, setShowLogin }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};
