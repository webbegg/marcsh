import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { normalizeClaudeCommands, type ClaudeCommand } from "./claude-commands";
import { marcshPluginPath } from "./plugin";

const DEFAULT_TIMEOUT_MS = 20_000;

type WarmUpOptions = {
  cwd: string;
  save: (commands: ClaudeCommand[]) => void;
  /** How long to wait for the CLI's command list. */
  timeoutMs?: number;
};

// A streaming prompt that never yields a message, so the CLI starts without running a model turn.
function idlePrompt() {
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  async function* messages(): AsyncGenerator<SDKUserMessage, void> {
    await ended;
  }
  return { messages: messages(), end };
}

/**
 * Fetches Claude Code's full command list in the background and hands it to `save`, without a model call:
 * `query()` on an idle streaming prompt, `supportedCommands()`, `close()`. Failures and timeouts are ignored.
 */
export async function warmUpClaudeCommands({ cwd, save, timeoutMs = DEFAULT_TIMEOUT_MS }: WarmUpOptions): Promise<void> {
  const prompt = idlePrompt();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chat: ReturnType<typeof query> | undefined;
  try {
    const pluginPath = marcshPluginPath();
    chat = query({
      prompt: prompt.messages,
      options: {
        cwd,
        persistSession: false,
        settingSources: ["user", "project", "local"],
        ...(pluginPath ? { plugins: [{ type: "local" as const, path: pluginPath }] } : {}),
      },
    });

    // The CLI's messages (hooks starting, and so on) are not needed, but the stream has to be read.
    const stream = chat;
    void (async () => {
      try {
        for await (const _ of stream) {
          // drained
        }
      } catch {
        // closed or failed: nothing to report
      }
    })();

    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const commands = normalizeClaudeCommands(await Promise.race([stream.supportedCommands(), timeout]));
    if (commands.length > 0) save(commands);
  } catch {
    // warming up is best effort
  } finally {
    clearTimeout(timer);
    prompt.end();
    try {
      chat?.close();
    } catch {
      // already closed
    }
  }
}
