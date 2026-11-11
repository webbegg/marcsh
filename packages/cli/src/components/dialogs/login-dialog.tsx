import { useCallback, useEffect, useMemo, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";
import { MaskedInput } from "../masked-input";
import { TextField } from "./text-field";
import {
  listLoginProviders,
  runLogin,
  type AuthRuntime,
  type LoginNotice,
  type LoginPrompt,
  type LoginProvider,
  type LoginUi,
} from "../../lib/engine/pi-auth";

const MAX_NOTICES = 6;
const CANCELLED = "Login cancelled";
const FAILURE_TOAST_MS = 8000;

type Props = {
  runtime: AuthRuntime;
  /** The id some logins send to the provider (pi keeps it in its settings). */
  getDeviceId?: () => Promise<string>;
  /** Called after a login succeeded, so the caller can check which pi model to use now. */
  onLoggedIn?: () => void;
};

const providerKey = (provider: LoginProvider) => `${provider.id}:${provider.authType}`;

const kindName = (provider: LoginProvider) => (provider.authType === "api_key" ? "API key" : provider.subscription ? "subscription" : "sign in");

const stateOf = (provider: LoginProvider) => (provider.source === "stored" || !provider.source ? "logged in" : provider.source);

function kindOf(provider: LoginProvider): string {
  const kind = kindName(provider);
  return provider.loggedIn ? `${kind} · ${stateOf(provider)}` : kind;
}

/** What a row shows after its label: the auth type unless the label already names it ("Cerebras API key"), then the login state. */
function badgeOf(provider: LoginProvider): string {
  if (!provider.label.toLowerCase().includes(kindName(provider).toLowerCase())) return kindOf(provider);
  return provider.loggedIn ? stateOf(provider) : "";
}

export const LoginDialogContent = ({ runtime, getDeviceId, onLoggedIn }: Props) => {
  const dialog = useDialog();
  const providers = useMemo(() => listLoginProviders(runtime), [runtime]);

  const handleSelect = useCallback(
    (provider: LoginProvider) => {
      dialog.open({
        title: `Log in to ${provider.name}`,
        children: <LoginFlow runtime={runtime} provider={provider} getDeviceId={getDeviceId} onLoggedIn={onLoggedIn} />,
      });
    },
    [dialog, runtime, getDeviceId, onLoggedIn],
  );

  return (
    <DialogSearchList
      items={providers}
      onSelect={handleSelect}
      filterFn={(provider, query) =>
        `${provider.name} ${provider.label} ${provider.id} ${kindOf(provider)}`.toLowerCase().includes(query.toLowerCase())
      }
      renderItem={(provider, isSelected) => (
        <box flexDirection="row" gap={1} overflow="hidden">
          <text selectable={false} fg={isSelected ? "black" : "white"}>
            {provider.loggedIn ? " ✓ " : "   "}
            {provider.label}
          </text>
          <text selectable={false} fg={isSelected ? "black" : "gray"} attributes={TextAttributes.DIM}>
            {badgeOf(provider)}
          </text>
        </box>
      )}
      getKey={providerKey}
      placeholder="Search providers"
      emptyText="No matching providers"
    />
  );
};

type ActivePrompt = { prompt: LoginPrompt; answer: (value: string) => void };

type FlowProps = Props & { provider: LoginProvider };

const SUBSCRIPTION_NOTE =
  "Subscription sign-in: make sure your plan's terms allow use with other apps.";
const ANTHROPIC_NOTE = "Anthropic bills third-party app use of a Claude plan as extra usage, per token.";

/**
 * One login, shown in the dialog: the sign-in URL or device code, the field for a pasted code or API key
 * (dots, never the text), and what the flow reports. Closing the dialog (Esc) cancels the flow.
 */
function LoginFlow({ runtime, provider, getDeviceId, onLoggedIn }: FlowProps) {
  const dialog = useDialog();
  const toast = useToast();
  const [notices, setNotices] = useState<LoginNotice[]>([]);
  const [active, setActive] = useState<ActivePrompt | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    const ui: LoginUi = {
      notify: (notice) =>
        // A newer progress line replaces the older one.
        setNotices((prev) => [...prev.filter((n) => n.type !== "progress" || notice.type !== "progress"), notice].slice(-MAX_NOTICES)),
      prompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          const clear = () => setActive((current) => (current?.prompt === prompt ? null : current));
          prompt.signal?.addEventListener(
            "abort",
            () => {
              clear();
              reject(new Error(CANCELLED));
            },
            { once: true },
          );
          setActive({
            prompt,
            answer: (value) => {
              clear();
              resolve(value);
            },
          });
        }),
    };

    const finish = (show: () => void) => {
      if (disposed) return;
      disposed = true;
      show();
      dialog.close();
    };

    void (async () => {
      const deviceId = await getDeviceId?.().catch(() => undefined);
      const outcome = await runLogin(runtime, provider, ui, { signal: controller.signal, deviceId });
      if (outcome.status === "success") {
        const done = provider.authType === "oauth" ? `Logged in to ${provider.name}` : `Saved API key for ${provider.name}`;
        finish(() => toast.show({ variant: "success", message: outcome.warning ? `${done}. ${outcome.warning}` : done }));
        onLoggedIn?.();
      } else if (outcome.status === "failed") {
        finish(() =>
          toast.show({ variant: "error", message: `Failed to log in to ${provider.name}: ${outcome.message}`, duration: FAILURE_TOAST_MS }),
        );
      } else {
        finish(() => toast.show({ variant: "info", message: `Login to ${provider.name} cancelled` }));
      }
    })();

    return () => {
      // Closed before the flow ended: Esc, a click outside, or Ctrl+C cancels it.
      if (disposed) return;
      disposed = true;
      controller.abort();
      toast.show({ variant: "info", message: `Login to ${provider.name} cancelled` });
    };
    // One flow per mount; the props do not change while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const note = provider.authType === "oauth" && provider.subscription ? (provider.id === "anthropic" ? `${SUBSCRIPTION_NOTE} ${ANTHROPIC_NOTE}` : SUBSCRIPTION_NOTE) : undefined;

  return (
    <box flexDirection="column" gap={1}>
      {note ? (
        <text attributes={TextAttributes.DIM} wrapMode="word" width="100%">
          {note}
        </text>
      ) : null}
      {notices.map((notice, index) => (
        <NoticeView key={index} notice={notice} />
      ))}
      {active ? (
        <PromptView key={active.prompt.message} active={active} />
      ) : (
        <text attributes={TextAttributes.DIM}>Waiting...</text>
      )}
      <text attributes={TextAttributes.DIM}>esc to cancel</text>
    </box>
  );
}

function NoticeView({ notice }: { notice: LoginNotice }) {
  switch (notice.type) {
    case "auth_url":
      return (
        <box flexDirection="column">
          <text wrapMode="word" width="100%">{notice.instructions ?? "Open this link to sign in:"}</text>
          <text wrapMode="char" width="100%" attributes={TextAttributes.UNDERLINE}>{notice.url}</text>
        </box>
      );
    case "device_code":
      return (
        <box flexDirection="column">
          <text wrapMode="char" width="100%">Open {notice.verificationUri} and enter the code:</text>
          <text attributes={TextAttributes.BOLD}>{notice.userCode}</text>
        </box>
      );
    case "info":
      return (
        <box flexDirection="column">
          <text wrapMode="word" width="100%">{notice.message}</text>
          {notice.links?.map((link) => (
            <text key={link.url} wrapMode="char" width="100%" attributes={TextAttributes.UNDERLINE}>{link.url}</text>
          ))}
        </box>
      );
    case "progress":
      return <text attributes={TextAttributes.DIM} wrapMode="word" width="100%">{notice.message}</text>;
  }
}

function PromptView({ active: { prompt, answer } }: { active: ActivePrompt }) {
  return (
    <box flexDirection="column" gap={1}>
      <text wrapMode="word" width="100%">{prompt.message}</text>
      {prompt.kind === "select" ? (
        <DialogSearchList
          items={[...prompt.options]}
          onSelect={(option) => answer(option.id)}
          filterFn={(option, query) => option.label.toLowerCase().includes(query.toLowerCase())}
          renderItem={(option, isSelected) => (
            <text selectable={false} fg={isSelected ? "black" : "white"}>
              {option.label}
            </text>
          )}
          getKey={(option) => option.id}
          placeholder="Search"
          emptyText="No matching options"
        />
      ) : prompt.kind === "text" ? (
        <TextField placeholder={prompt.placeholder ?? ""} onSubmit={answer} />
      ) : (
        // Keys and pasted codes show as dots.
        <MaskedInput placeholder={prompt.placeholder ?? "Paste here, then press enter"} onSubmit={answer} />
      )}
    </box>
  );
}
