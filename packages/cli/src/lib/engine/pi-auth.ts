import { spawn } from "node:child_process";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

/**
 * Logins for the pi engine, driven by pi's own auth API (`ModelRuntime.login` / `logout` / `listCredentials`).
 * pi stores the credentials, in `auth.json` under marcsh's agent dir; nothing here writes, logs or keeps a secret.
 * Only pi's types are imported, so this file is safe to load before pi is (see AGENT_DIR_ENV in pi.ts).
 */
export type AuthRuntime = Pick<
  ModelRuntime,
  "getProviders" | "getProvider" | "getProviderAuthStatus" | "isUsingOAuth" | "login" | "logout" | "listCredentials"
>;

/** One way to log in to a provider: its OAuth/subscription flow, or an API key. */
export type LoginProvider = {
  id: string;
  /** The provider's name, e.g. "Anthropic". */
  name: string;
  /** The login's own name, e.g. "Anthropic (Claude Pro/Max)" or "Anthropic API key". */
  label: string;
  authType: AuthType;
  subscription: boolean;
  /** This is the kind of credential the provider currently uses. */
  loggedIn: boolean;
  /** Where the credential comes from when `loggedIn`: "stored", "environment", ... */
  source?: string;
};

export function listLoginProviders(runtime: AuthRuntime): LoginProvider[] {
  const options: LoginProvider[] = [];
  for (const provider of runtime.getProviders()) {
    const status = runtime.getProviderAuthStatus(provider.id);
    const usesOAuth = runtime.isUsingOAuth(provider.id);
    const entry = (authType: AuthType, label: string, subscription: boolean): LoginProvider => {
      const loggedIn = status.configured && usesOAuth === (authType === "oauth");
      return { id: provider.id, name: provider.name, label, authType, subscription, loggedIn, ...(loggedIn && status.source ? { source: status.source } : {}) };
    };
    if (provider.auth.oauth) options.push(entry("oauth", provider.auth.oauth.name, provider.auth.oauth.isSubscription === true));
    // Providers configured only from the environment have nothing to log in to.
    if (provider.auth.apiKey?.login) options.push(entry("api_key", provider.auth.apiKey.name, false));
  }
  const rank = (option: LoginProvider) => (option.authType === "oauth" ? 0 : 1);
  return options.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.label.localeCompare(b.label));
}

/** `signal` aborts when the flow no longer needs the answer (a callback server won the race against a pasted code). */
export type LoginPrompt =
  | { kind: "text" | "secret" | "manual_code"; message: string; placeholder?: string; signal?: AbortSignal }
  | { kind: "select"; message: string; options: readonly { id: string; label: string; description?: string }[]; signal?: AbortSignal };

export type LoginNotice =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "progress"; message: string };

/** What a login flow shows and asks. `prompt` rejects (or never settles, until the signal aborts) when the user backs out. */
export type LoginUi = {
  notify(notice: LoginNotice): void;
  prompt(prompt: LoginPrompt): Promise<string>;
};

export type LoginOutcome =
  | { status: "success"; warning?: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

const CANCELLED = "Login cancelled";

function openWithPlatform(url: string) {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  // Best effort and no shell: a missing launcher only emits "error", and the URL is shown to the user anyway.
  spawn(command, args, { stdio: "ignore", detached: true, cwd: "/" })
    .on("error", () => {})
    .unref();
}

let opener: (url: string) => void = openWithPlatform;

/** Replaces the browser launcher (tests); `undefined` restores the platform one. */
export function setUrlOpener(open: ((url: string) => void) | undefined) {
  opener = open ?? openWithPlatform;
}

/** Opens a web URL in the browser without waiting for it. Anything but http(s), and any failure, is ignored. */
function openUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    opener(parsed.href);
  } catch {}
}

const MASK = "•••";
const MAX_ERROR_LENGTH = 300;

/** Hides what the user typed, bearer tokens, `sk-` API keys, JWTs and other long token-like strings in a message that may be shown. */
export function redactSecrets(text: string, secrets: Iterable<string> = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join(MASK);
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, MASK)
    .replace(/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]*/g, MASK)
    .replace(/[A-Za-z0-9_-]{32,}/g, MASK);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** pi's CredentialSynchronizationError: the credential change was saved, only pi's in-memory view could not follow. */
const isSynchronizationError = (error: unknown) =>
  error instanceof Error && error.name === "CredentialSynchronizationError";

function toLoginPrompt(prompt: AuthPrompt): LoginPrompt {
  const signal = prompt.signal ? { signal: prompt.signal } : {};
  if (prompt.type === "select") return { kind: "select", message: prompt.message, options: prompt.options, ...signal };
  return {
    kind: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
    ...signal,
  };
}

/** Settles with `promise`, or rejects as cancelled when any of the signals aborts first. */
function untilAborted<T>(promise: Promise<T>, ...signals: (AbortSignal | undefined)[]): Promise<T> {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.some((signal) => signal.aborted)) return Promise.reject(new Error(CANCELLED));
  let cleanup = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error(CANCELLED));
    for (const signal of active) signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => active.forEach((signal) => signal.removeEventListener("abort", onAbort));
  });
  return Promise.race([promise, aborted]).finally(cleanup);
}

/**
 * Runs pi's login for `provider` inside the host's UI. OAuth URLs and device codes go to `ui.notify` (and the
 * browser), pasted codes and API keys come from `ui.prompt`, and pi saves the credential. The outcome and
 * its message never contain what the user typed.
 */
export async function runLogin(
  runtime: AuthRuntime,
  provider: Pick<LoginProvider, "id" | "authType">,
  ui: LoginUi,
  { signal, deviceId }: { signal?: AbortSignal; deviceId?: string } = {},
): Promise<LoginOutcome> {
  const typed = new Set<string>();
  const show = (notice: LoginNotice) => {
    try {
      ui.notify(notice);
    } catch {}
  };
  const onEvent = (event: AuthEvent) => {
    if (event.type === "auth_url") {
      show({ type: "auth_url", url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) });
      openUrl(event.url);
    } else if (event.type === "device_code") {
      show({ type: "device_code", userCode: event.userCode, verificationUri: event.verificationUri });
      if (event.openBrowserOnConfirm !== false) openUrl(event.verificationUri);
    } else if (event.type === "info") {
      show({ type: "info", message: event.message, ...(event.links ? { links: event.links } : {}) });
    } else {
      show({ type: "progress", message: event.message });
    }
  };

  try {
    await runtime.login(
      provider.id,
      provider.authType,
      {
        ...(signal ? { signal } : {}),
        prompt: async (prompt) => {
          const answer = await untilAborted(ui.prompt(toLoginPrompt(prompt)), signal, prompt.signal);
          if (prompt.type !== "select") typed.add(answer);
          return answer;
        },
        notify: onEvent,
      },
      deviceId ? { getDeviceId: () => deviceId } : undefined,
    );
    return { status: "success" };
  } catch (error) {
    if (signal?.aborted || errorText(error) === CANCELLED) return { status: "cancelled" };
    if (isSynchronizationError(error)) {
      return { status: "success", warning: "The login was saved, but pi could not refresh its model list. Restart marcsh if no models show up." };
    }
    return { status: "failed", message: redactSecrets(errorText(error), typed).slice(0, MAX_ERROR_LENGTH) };
  }
}

export type StoredLogin = { id: string; name: string; authType: AuthType };

const AUTH_TIMEOUT_MS = 15_000;

/** The credentials pi holds in `auth.json`, by provider name. Environment variables and models.json keys are not listed. */
export async function listStoredLogins(runtime: AuthRuntime): Promise<StoredLogin[]> {
  const credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
  return credentials
    .map(({ providerId, type }) => ({ id: providerId, name: runtime.getProvider(providerId)?.name ?? providerId, authType: type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type LogoutOutcome = { status: "success"; message: string } | { status: "failed"; message: string };

export async function removeLogin(runtime: AuthRuntime, login: StoredLogin): Promise<LogoutOutcome> {
  try {
    await runtime.logout(login.id, { signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
  } catch (error) {
    // The credential is gone even when pi's in-memory view could not follow.
    if (!isSynchronizationError(error)) return { status: "failed", message: `Logout failed: ${redactSecrets(errorText(error)).slice(0, MAX_ERROR_LENGTH)}` };
  }
  return {
    status: "success",
    message:
      login.authType === "oauth"
        ? `Logged out of ${login.name}`
        : `Removed stored API key for ${login.name}. Environment variables are unchanged.`,
  };
}

/**
 * Rewrites pi's "no credentials" errors, which point at pi's own docs inside node_modules, to point at
 * marcsh's `/login`. Any other message is returned as is.
 */
export function friendlyPiError(message: string): string {
  const noKey = /^No API key(?: found| provided)? for (?:provider:? )?"?([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/.exec(message);
  if (noKey) {
    return `No API key for ${noKey[1]}. Run /login to sign in to a provider, or /models to pick a model that has one.`;
  }
  const hint = /\s*Use \/login to log into a provider via OAuth or API key\. See:[\s\S]*$/.exec(message);
  if (hint) return `${message.slice(0, hint.index).trimEnd()} Run /login to sign in to a provider.`.trim();
  return message;
}
