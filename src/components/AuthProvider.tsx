import type { FunctionReturnType } from "convex/server";
import { useConvex, useQuery } from "convex/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "@/lib/auth";
import { api } from "../../convex/_generated/api";

/**
 * Who is signed in, and what they may do.
 *
 * The credential pair kept here is passed as an argument to every board query
 * and mutation, so this context is the one place it comes from. It is also kept
 * *subscribed*: `auth:login` is a reactive query, so an account that is deleted,
 * re-seeded with a new password, or granted write access changes what the board
 * offers without a reload — and a credential that stops working lands on the
 * login screen instead of throwing through the middle of the board.
 *
 * That is why the board itself is mounted only in the `authenticated` state (see
 * `App.tsx`): `board:get` rejects a bad credential with an error, and a query
 * that errors would otherwise take the page down with it. Unmounting the board
 * in the same render that the session goes bad means the error never surfaces.
 */

/** What the signed-in account can do. `permRead` is implied by being here. */
export type Session = {
  credentials: Credentials;
  account: string;
  /** `permWrite`: edits land immediately, and this account reviews requests. */
  canWrite: boolean;
  /** `permApproveRegister`: sees the pending-registration inbox. */
  canApprove: boolean;
  /**
   * `permEditRequest`: the editing affordances are all offered, but each one
   * proposes the change instead of making it. Independent of `canWrite`, which
   * wins when both are set — a direct writer never proposes anything.
   */
  canRequest: boolean;
};

type AuthState =
  /** Checking a stored credential against the server. */
  | { status: "loading" }
  /** Nobody signed in. `notice` explains an involuntary sign-out. */
  | { status: "anonymous"; notice: string | null }
  /** Correct password, registration not approved yet. */
  | { status: "pending"; account: string }
  | { status: "authenticated"; session: Session };

/** What `auth:login` answers: invalid, pending approval, or in. */
export type LoginResult = FunctionReturnType<typeof api.auth.login>;

type Auth = AuthState & {
  /** Check a credential pair without storing it; used by the login form. */
  verify: (credentials: Credentials) => Promise<LoginResult>;
  /** Remember a verified credential pair and enter the board. */
  signIn: (credentials: Credentials) => void;
  signOut: () => void;
};

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Read once at mount: this is a plain value, not a subscription.
  const [credentials, setCredentials] = useState<Credentials | null>(() =>
    loadCredentials(),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const convex = useConvex();

  const result = useQuery(
    api.auth.login,
    credentials ? { auth: credentials } : "skip",
  );

  // A stored credential the server no longer recognises is dropped rather than
  // retried: the account was deleted or its password changed, and there is
  // nothing this tab can do about it except ask again.
  useEffect(() => {
    if (!credentials || result === undefined) return;
    if (result.status !== "invalid") return;
    clearCredentials();
    setCredentials(null);
    setNotice("登入資訊已失效（帳號被移除或密碼已更改），請重新登入。");
  }, [credentials, result]);

  const verify = useCallback(
    (next: Credentials) => convex.query(api.auth.login, { auth: next }),
    [convex],
  );

  const signIn = useCallback((next: Credentials) => {
    saveCredentials(next);
    setNotice(null);
    setCredentials(next);
  }, []);

  const signOut = useCallback(() => {
    clearCredentials();
    setNotice(null);
    setCredentials(null);
  }, []);

  const state = useMemo<AuthState>(() => {
    if (!credentials) return { status: "anonymous", notice };
    // `invalid` is transitional — the effect above is about to clear it, and
    // showing the login screen for one frame first would flash.
    if (result === undefined || result.status === "invalid") {
      return { status: "loading" };
    }
    if (result.status === "pending") {
      return { status: "pending", account: result.account };
    }
    return {
      status: "authenticated",
      session: {
        credentials,
        account: result.account,
        canWrite: result.permWrite,
        canApprove: result.permApproveRegister,
        canRequest: result.permEditRequest,
      },
    };
  }, [credentials, notice, result]);

  const value = useMemo<Auth>(
    () => ({ ...state, verify, signIn, signOut }),
    [state, verify, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth 必須在 AuthProvider 裡使用");
  return auth;
}

/**
 * The session, for components that only ever render inside the board. Being
 * mounted there already means somebody is signed in, so this saves every one of
 * them a null check.
 */
export function useSession(): Session {
  const auth = useAuth();
  if (auth.status !== "authenticated") {
    throw new Error("useSession 只能在登入後的看板裡使用");
  }
  return auth.session;
}
