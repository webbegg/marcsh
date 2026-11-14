# Keybinds

marcsh has a command palette, a leader key, and a file that changes the keys for them. This page lists the defaults, the file's format, and what happens when the file has a mistake.

## The command palette

Press `Ctrl+P` to open the palette. It lists every command you can run where you are: marcsh's own, your [custom commands](commands.md#custom-commands) and the engine's. The commands that work on the open session (`/undo`, `/rename`, …) are listed only inside a session, as in the `/` menu.

- Type to filter. The letters must appear in the command name in that order, so `mdl` finds `/models`. Better matches come first.
- `Up` and `Down` move the highlight. `Enter` or a click runs the command. `Esc` closes the palette.
- The right-hand column shows the keys that run the command, for example `ctrl+x n`.
- A command runs the same way as when you type it. A command that needs text after its name (`/rename`, `/export`, a custom or engine command) puts `/name ` in the prompt for you to finish. That needs an empty prompt: with text in it, marcsh says "Clear the prompt, then pick /name again" and leaves your text alone. Commands that run at once keep your draft.
- `Ctrl+P` does nothing while a dialog, a menu, a permission question or another prompt has the keys, while the prompt is off for a Claude turn, and on the screen that opens a new session.

## The leader key

Press `Ctrl+X`, then within 2 seconds press one more key to run its command. The status line shows `ctrl+x: …` and the first keys while marcsh waits.

- `Esc`, or any key that is not bound, ends the wait. The key is not typed.
- After 2 seconds with no key the wait ends, and typing goes on as usual.

| After `Ctrl+X` | Command |
| --- | --- |
| `n` | `/new` |
| `m` | `/models` |
| `a` | `/agents` |
| `s` | `/sessions` |
| `t` | `/theme` |
| `e` | `/engine` |
| `p` | `/permissions` |
| `u` | `/undo` |
| `r` | `/redo` |
| `d` | `/diff` |
| `c` | `/compact` |
| `y` | `/copy` |
| `f` | `/fork` |
| `x` | `/export` (puts `/export ` in the prompt) |
| `q` | `/exit` |

On the home screen, the commands that need a session say "/name works inside a session. Open one first."

## Changing the keys

Put the keys in `~/.marcsh/keybinds.json`. To read the file from somewhere else, set `MARCSH_KEYBINDS_PATH`. The file is read once, when marcsh starts, so restart to apply a change. With no file, the defaults apply.

```json
{
  "palette": ["ctrl+p", "ctrl+k"],
  "leader": ["ctrl+x"],
  "models": ["<leader>o", "alt+m"],
  "theme": []
}
```

Each name is an action, and its value is a key or a list of keys.

### Actions

| Action | What it does | Default |
| --- | --- | --- |
| `palette` | Opens the command palette. | `ctrl+p` |
| `leader` | Starts the leader wait. Keys pressed on their own only. | `ctrl+x` |
| a command name: `new`, `agents`, `models`, `login`, `logout`, `trust`, `engine`, `permissions`, `sessions`, `rename`, `fork`, `export`, `undo`, `redo`, `diff`, `compact`, `copy`, `theme`, `exit` | Runs that command. | the table above |

Only marcsh's own commands can be bound. Custom and engine commands are in the palette, and are not bindable.

The keys you give for an action replace its defaults. An empty list, `[]`, unbinds it: `"palette": []` turns the palette off, and `"leader": []` turns the leader off.

### Writing a key

- Modifiers and a key name, joined with `+`: `ctrl+p`, `alt+m`, `ctrl+shift+k`. The modifiers are `ctrl`, `alt` (`meta` and `option` mean the same) and `shift`. Case does not matter.
- The key name is a letter, a digit, one of `` ` - = [ ] \ ; ' , . / ``, `space`, or `f1` to `f12`.
- `<leader>n` is `n` pressed after the leader. After the leader no modifier is needed. A modifier can still be added: `<leader>ctrl+n`.
- A key pressed on its own needs `ctrl` or `alt`, or is a function key, so that typing is never taken. A plain `p` is only accepted as `<leader>p`.
- `ctrl+c` (quit) and `ctrl+i`, `ctrl+m`, `ctrl+j`, `ctrl+[` (the terminal sends these as Tab, Enter and Esc) cannot be bound.
- Keys that edit the prompt (`ctrl+a`, `ctrl+e`, `ctrl+k`, `ctrl+w`, …) can be bound, and then do the command instead of editing.

The input keys (`Enter`, `Shift+Enter`, `Alt+Enter`, `Tab`, `Esc`, `Ctrl+C`, `Up` and `Down` for history) are fixed in this version and cannot be changed.

If two actions in the file use the same key, the first in the file's order wins (`palette` and `leader` come before the commands), and one warning names the loser. A key you set beats a default of another command: setting `"models": ["<leader>n"]` takes `n` from `/new`.

### When the file has a mistake

marcsh shows one warning toast at start and goes on.

| Mistake | Result |
| --- | --- |
| The file is not valid JSON, or not an object | "Invalid keybinds file: …. Using the default keys." No key from the file applies. |
| An action name marcsh does not have | `Keybinds: unknown action "name" ignored.` The rest applies. |
| A key that cannot be read (`ctrl+`, `hyper+p`, a plain `p`) | That key is ignored with a reason. If no key of the action is left, it keeps its defaults. |
| A value that is not a key or a list of keys | The action is ignored and keeps its defaults. |
| The file exists but cannot be read | "Could not read the keybinds file: …. Using the default keys." |

A file that does not exist is not a mistake.
