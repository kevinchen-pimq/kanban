import { Loader2 } from "lucide-react";

import { AuthProvider, useAuth } from "@/components/AuthProvider";
import { BoardApp } from "@/BoardApp";
import { LoginScreen, PendingApprovalScreen } from "@/components/LoginScreen";
import { UpdateNotice } from "@/components/UpdateNotice";
import type { ReactNode } from "react";

/**
 * The gate in front of the board.
 *
 * Four states, one of which is the board (`src/BoardApp.tsx`). Keeping them
 * apart at this level is deliberate: the board's queries all carry a credential
 * and reject a bad one, so the board must not be mounted unless there is a
 * working session — a revoked credential then unmounts it here instead of
 * throwing somewhere inside it.
 */
export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

function AuthGate() {
  const auth = useAuth();

  switch (auth.status) {
    case "loading":
      // A stored credential is being checked. Brief, and worth showing: the
      // alternative is the login form flashing at someone who is signed in.
      return (
        <div className="flex min-h-dvh items-center justify-center bg-slate-50 text-slate-400">
          <Loader2 className="size-5 animate-spin" aria-hidden />
          <span className="sr-only">載入中</span>
        </div>
      );
    case "anonymous":
      return (
        <FrontDoor>
          <LoginScreen />
        </FrontDoor>
      );
    case "pending":
      return (
        <FrontDoor>
          <PendingApprovalScreen account={auth.account} />
        </FrontDoor>
      );
    case "authenticated":
      return <BoardApp />;
  }
}

/**
 * A screen for someone who is not on the board yet — with the update notice.
 *
 * `staticHosting:getCurrentDeployment` is the one query that takes no
 * credentials, precisely so that a tab left open here across a deploy is still
 * told to reload. `relative` gives the notice something to position against.
 */
function FrontDoor({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <UpdateNotice />
      {children}
    </div>
  );
}
