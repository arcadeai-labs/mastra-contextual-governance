import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

import { Frame } from "./Frame.tsx";

export const metadata: Metadata = {
  title: "Contextual Governance — Mastra × Arcade",
  description:
    "An agent doing real work in a real business system, with Arcade enforcing deterministic control on every tool call.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

/**
 * The co-branded frame wraps every surface from here (#177).
 *
 * Here rather than in each page, because `/`, `/loans` and `/panel` have to
 * carry the same marks and none of them may know about them: the bank is
 * deliberately a fifteen-year-old system of record and the panel is
 * unmistakably Arcade, and the frame is the one place that is neither.
 * `app/Frame.tsx` has the rest of the argument.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Frame>{children}</Frame>
      </body>
    </html>
  );
}
