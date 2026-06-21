import { type Metadata } from "next";

import "./globals.css";

import { Providers } from "./providers";

import { NavBar } from "@/components/common/NavBar";

export const metadata: Metadata = {
  title: "dopamine",
  description: "Search anything. If it doesn't exist yet, we'll summon it.",
};

/**
 * Root layout (doc 03 §3). Wraps the app in the client `Providers` (one
 * QueryClient + the anonymous identity bootstrap), then the nav chrome (with the
 * live cart badge) and the page content.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <NavBar />
          <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
