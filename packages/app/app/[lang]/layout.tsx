import { notFound } from "next/navigation";
import { getDictionary, isLocale } from "./dictionaries";
import { I18nProvider } from "@/components/i18n-context";
import { AuthProvider } from "@/components/auth-context";
import { Shell } from "@/components/shell";

export async function generateStaticParams() {
  return [
    { lang: "en" },
    { lang: "cs" },
    { lang: "de" },
    { lang: "fr" },
    { lang: "es" },
    { lang: "zh" },
  ];
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  return (
    <I18nProvider dict={dict} locale={lang}>
      <AuthProvider>
        <Shell>{children}</Shell>
      </AuthProvider>
    </I18nProvider>
  );
}
