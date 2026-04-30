import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getLocale } from "next-intl/server";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Locale-aware metadata for the marketing page is provided by [locale]/layout.tsx.
// Auth/dashboard routes inherit this default.
export const metadata: Metadata = {
  title: "Klirs — Audit-ready AML screening",
  description:
    "Audit-ready AML/KYC screening for Latvian and EU compliance. Open-source engine, hosted at klirs.eu.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body
        style={{ fontFamily: 'var(--font-geist-sans), "Geist", sans-serif' }}
        className="min-h-full flex flex-col"
      >
        {children}
      </body>
    </html>
  );
}
