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
  Condensed type is the vernacular of team sheets and scoreboards, and it
  solves a practical problem: "Wolverhampton Wanderers" has to fit on one line.
*/
const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-barlow-condensed",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PitchIQ — Premier League forecasts",
  description:
    "Probabilistic match forecasts for the Premier League, built on a Dixon-Coles model over four seasons of data.",
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
