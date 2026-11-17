import type { CommandContext } from "../command-menu/types";

/** Opens the help dialog: the active keys and the commands (S12). Seam stub: the dialog itself comes with tier 3's U1. */
export function openHelp(ctx: CommandContext): void {
  ctx.dialog.open({ title: "Help", children: <text>Keys and commands</text> });
}
