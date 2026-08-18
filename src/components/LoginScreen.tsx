import { useMutation } from "convex/react";
import { LayoutGrid, Loader2 } from "lucide-react";
import { useState } from "react";

import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { computeTokenHash, normalizeAccount, readableError } from "@/lib/auth";
import { api } from "../../convex/_generated/api";

/**
 * The board's front door: sign in, or ask for an account.
 *
 * Both paths hash the password here and send only the hash (`src/lib/auth.ts`).
 * Signing in is two steps on purpose — verify first, store second — so a wrong
 * password never leaves a credential behind in localStorage, and the three
 * outcomes can be told apart: in, waiting for approval, or wrong.
 *
 * A fresh registration has no permissions at all, so it lands on the same
 * "waiting for approval" message rather than a half-open board.
 */

const FIELD = "flex flex-col gap-1.5";
const LABEL = "text-[11px] font-semibold text-slate-500";

type Mode = "login" | "register";

export function LoginScreen() {
  const auth = useAuth();
  const register = useMutation(api.auth.register);

  const [mode, setMode] = useState<Mode>("login");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set after a successful registration, and by a pending sign-in attempt. */
  const [waiting, setWaiting] = useState<string | null>(null);

  const notice = auth.status === "anonymous" ? auth.notice : null;
  const ready = normalizeAccount(account) !== "" && password !== "";

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setWaiting(null);
    setPassword("");
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setWaiting(null);
    try {
      const credentials = {
        account: normalizeAccount(account),
        tokenHash: await computeTokenHash(account, password),
      };

      if (mode === "register") {
        await register({
          account: credentials.account,
          tokenHash: credentials.tokenHash,
        });
        setWaiting(credentials.account);
        setMode("login");
        setPassword("");
        return;
      }

      const result = await auth.verify(credentials);
      if (result.status === "ok") {
        // Only now does the credential get written to storage.
        auth.signIn(credentials);
        return;
      }
      if (result.status === "pending") {
        setWaiting(result.account);
        return;
      }
      setError("帳號或密碼錯誤。");
    } catch (caught: unknown) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-indigo-600 p-1.5 text-white shadow-sm">
            <LayoutGrid className="size-[18px]" aria-hidden />
          </div>
          <h1 className="text-lg font-bold tracking-tight text-slate-900">
            Epic × Checkpoint 看板
          </h1>
        </div>

        <p className="mt-2 text-xs text-slate-500">
          {mode === "login"
            ? "請先登入才能看到看板內容。"
            : "註冊後需要管理員審核，通過後才能看到看板。"}
        </p>

        <div className="mt-4 flex gap-1 rounded-lg bg-slate-100 p-1">
          {(["login", "register"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => switchMode(value)}
              aria-current={mode === value}
              className={
                mode === value
                  ? "flex-1 rounded-md bg-white py-1.5 text-xs font-semibold text-slate-800 shadow-sm"
                  : "flex-1 rounded-md py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
              }
            >
              {value === "login" ? "登入" : "註冊"}
            </button>
          ))}
        </div>

        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || busy) return;
            void submit();
          }}
        >
          <div className={FIELD}>
            <label className={LABEL} htmlFor="auth-account">
              帳號
            </label>
            <Input
              id="auth-account"
              value={account}
              autoComplete="username"
              autoFocus
              onChange={(event) => setAccount(event.target.value)}
              placeholder="英數字、點、減號、底線"
              className="h-9 text-xs md:text-xs"
            />
          </div>

          <div className={FIELD}>
            <label className={LABEL} htmlFor="auth-password">
              密碼
            </label>
            <Input
              id="auth-password"
              type="password"
              value={password}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              onChange={(event) => setPassword(event.target.value)}
              className="h-9 text-xs md:text-xs"
            />
          </div>

          {notice && !error && !waiting && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
              {notice}
            </p>
          )}

          {waiting && (
            <p className="rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-[11px] text-indigo-700">
              帳號 <span className="font-mono font-semibold">{waiting}</span>{" "}
              正在等待管理員審核，通過之後就能登入看板。
            </p>
          )}

          {error && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
              {error}
            </p>
          )}

          <Button
            type="submit"
            disabled={!ready || busy}
            className="mt-1 h-9 gap-1.5 bg-indigo-600 text-xs hover:bg-indigo-700"
          >
            {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
            {mode === "login" ? "登入" : "送出註冊"}
          </Button>
        </form>
      </div>
    </div>
  );
}

/**
 * Shown to an account whose registration has not been approved yet: the password
 * is right, so this is not the login form again — it is a waiting room with a way
 * back out.
 */
export function PendingApprovalScreen({ account }: { account: string }) {
  const { signOut } = useAuth();

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-base font-bold text-slate-900">等待審核</h1>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          帳號 <span className="font-mono font-semibold">{account}</span>{" "}
          已經註冊，還在等管理員通過。通過之後重新整理這一頁就會看到看板。
        </p>
        <Button
          variant="outline"
          onClick={signOut}
          className="mt-4 h-8 border-slate-300 text-xs"
        >
          登出
        </Button>
      </div>
    </div>
  );
}
