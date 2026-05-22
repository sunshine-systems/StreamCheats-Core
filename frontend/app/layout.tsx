import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

import { ToastProvider } from "../lib/toast/toast";

// Distinctive, characterful fonts — avoiding the generic Inter/Geist
// default the skill calls out. Space Grotesk has more personality in
// its curves (the "a", the "g"), JetBrains Mono brings true mono
// numerics for the PID/port/uptime readouts.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "StreamCheats Core",
  description: "StreamCheats Core — KMBox Net protocol bridge",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${jetBrainsMono.variable}`}
    >
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
