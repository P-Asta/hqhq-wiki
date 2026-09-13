import "./globals.css";

import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import { Providers } from "@/components/providers";
import { htmlLang, LOCALE_HEADER } from "@/lib/locale-path";

export const metadata: Metadata = {
  // Matches the {{SITENAME}} spec, the seeded site registry, and the header
  // wordmark (dict.common.siteName) — one name everywhere.
  title: {
    default: "HQHQ Wiki",
    template: "%s · HQHQ Wiki",
  },
  description:
    "Community-maintained reference for high-quota Lethal Company play: moons, entities, scrap, and version-scoped strategy.",
};

/**
 * `<html lang>` must name the locale the URL addresses — this is a bilingual
 * wiki, and a Korean page announcing `lang="en"` misinforms screen readers and
 * search engines. The root layout renders above `[locale]` and cannot read the
 * segment, so `src/middleware.ts` stamps it onto the request (decisions-v2
 * O12); `htmlLang` validates the header and falls back to English.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = htmlLang((await headers()).get(LOCALE_HEADER));

  return (
    <html
      lang={lang}
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="bg-canvas font-sans text-body antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
