"use client";

import { createContext, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";

/** The one explicit action a home authorization card may ask the shell to take. */
export const HomeRefreshContext = createContext<(() => void) | null>(null);

/** Keep router ownership at the App Router boundary, outside the bank surface. */
export function HomeRefreshBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);

  return <HomeRefreshContext.Provider value={refresh}>{children}</HomeRefreshContext.Provider>;
}
