"use client";

import { createContext, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";

/** The one explicit action a home authorization card may ask the shell to take. */
export interface HomeRefreshController {
  /** Start a refresh and settle when the refreshed server props reach the client. */
  refresh: () => Promise<void>;
  /** Called by the client surface after the server-provided loan state commits. */
  settle: () => void;
}

export const HomeRefreshContext = createContext<HomeRefreshController | null>(null);

/** Keep router ownership at the App Router boundary, outside the bank surface. */
export function HomeRefreshBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pending = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => {
    // `router.refresh()` deliberately returns void. Keep the Continue action
    // pending until LoanFilesView receives and commits the new server props, so
    // a rapid second click cannot start another homeSurface attempt.
    const settled = new Promise<void>((resolve) => {
      pending.current = resolve;
    });
    router.refresh();
    return settled;
  }, [router]);
  const settle = useCallback(() => {
    const resolve = pending.current;
    pending.current = null;
    resolve?.();
  }, []);

  const controller = useMemo(() => ({ refresh, settle }), [refresh, settle]);
  return <HomeRefreshContext.Provider value={controller}>{children}</HomeRefreshContext.Provider>;
}
