import type { Metadata } from "next";
import { Fraunces, Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";

import AppShell from "../components/AppShell";
import { ToastProvider } from "../lib/toast/toast";

// Type stack ported from the marketing site (streamcheats-marketing/
// app-v2): Fraunces for display + occasional eyebrows, JetBrains Mono
// for all chrome (labels, code, version strings, sidebar tooltips),
// Inter Tight for dense panels and the body fallback. See the
// marketing repo's DESIGN.md for the full rationale.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
  axes: ["SOFT", "opsz"],
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "StreamCheats Core",
  description: "StreamCheats Core — HID bridge daemon control surface",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${jetBrainsMono.variable} ${interTight.variable}`}
    >
      <body>
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
