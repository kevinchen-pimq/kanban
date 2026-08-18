/**
 * The browser's half of the login: hashing, and remembering the result.
 *
 * The password is turned into `sha256("kanban:<account>:<password>")` here, with
 * Web Crypto, and only the hash is ever sent. Nothing on the server sees, stores
 * or logs the password itself. What is stored — in localStorage and in every
 * request — is `{ account, tokenHash }`, which is the whole credential: a fixed,
 * non-expiring token. That is the deliberately small design; see
 * `docs/data-model.md` for what it does and does not buy.
 */

/** Bump the suffix when the stored shape changes; old keys are then ignored. */
const STORAGE_KEY = "kanban.auth.v1";

export type Credentials = {
  account: string;
  tokenHash: string;
};

/**
 * Same normalisation the server applies. It runs *before* hashing, so
 * "Kevin " and "kevin" are the same account with the same token rather than one
 * account that can only be reached by typing it exactly as it was registered.
 */
export function normalizeAccount(account: string): string {
  return account.trim().toLowerCase();
}

const encoder = new TextEncoder();

/** `sha256("kanban:<account>:<password>")`, lowercase hex. */
export async function computeTokenHash(
  account: string,
  password: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`kanban:${normalizeAccount(account)}:${password}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * The stored credential, or null.
 *
 * Anything unreadable is treated as "not signed in" rather than an error: a
 * broken storage entry must land on the login screen, not on a blank page.
 */
export function loadCredentials(): Credentials | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { account, tokenHash } = parsed as Partial<Credentials>;
    if (typeof account !== "string" || typeof tokenHash !== "string") return null;
    if (!HEX_64.test(tokenHash)) return null;

    return { account: normalizeAccount(account), tokenHash };
  } catch {
    return null;
  }
}

export function saveCredentials(credentials: Credentials): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  } catch {
    // Private mode or a full quota: this session still works, it just will not
    // be remembered on the next visit.
  }
}

export function clearCredentials(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the in-memory state is cleared either way.
  }
}

/**
 * Denials from `convex/auth.ts` carry this marker, so a credential that has
 * stopped working can be told apart from a validation complaint.
 */
export function isAuthDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("AUTH_DENIED");
}

/** Convex prefixes thrown server errors; the readable part is what to show. */
export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^\[.*?\]\s*/, "")
    .replace(/^Uncaught Error:\s*/, "")
    .replace(/\s*at handler.*$/s, "")
    .replace(/^AUTH_DENIED:\s*/, "")
    .trim();
}
