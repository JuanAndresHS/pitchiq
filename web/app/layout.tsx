import type { Metadata } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";

const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-barlow",
  display: "swap",
});

/*
  Condensed type is the vernacular of team sheets and scoreboards, and it solves
  a practical problem: "Borussia Mönchengladbach" has to fit on one line.
*/
const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-barlow-condensed",
  display: "swap",
});

const SITE_URL = "https://pitchiq-football.vercel.app";
const TITLE = "PitchIQ — Football forecasts for Europe's five biggest leagues";
const DESCRIPTION =
  "Probabilistic match forecasts for the Premier League, LaLiga, Serie A, Bundesliga and Ligue 1. Dixon-Coles models retrained twice a day, with an assistant you can ask in plain language.";

/*
  metadataBase makes the relative image path resolve to an absolute URL. Without
  it, link previews on LinkedIn and elsewhere silently fall back to no image at
  all.

  Individual league pages override title and description in their own
  generateMetadata, so a shared LaLiga link previews as LaLiga rather than as
  the site index.
*/
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s — PitchIQ",
  },
  description: DESCRIPTION,
  applicationName: "PitchIQ",
  keywords: [
    "football forecasts",
    "Dixon-Coles",
    "Premier League",
    "LaLiga",
    "Serie A",
    "Bundesliga",
    "Ligue 1",
    "match prediction",
    "football analytics",
  ],
  authors: [{ name: "Juan Andrés Hurtado", url: "https://github.com/JuanAndresHS" }],
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "PitchIQ",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_GB",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "PitchIQ — a football fixture shown as win, draw and away-win probabilities",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${barlow.variable} ${barlowCondensed.variable}`}>
      <body className="bg-pitch-void text-pitch-text antialiased">
        {children}
      </body>
    </html>
  );
}
