import { parsePackSpec } from "./packs";

export const PACK_USAGE = "Usage: /agents install <owner/repo[@ref]> | update [<owner/repo>] | remove <owner/repo>";

/** What a typed `/agents <verb> <args>` asks for. `usage` carries the error text to show; the others are ready to run. */
export type PackCommand =
  | { kind: "picker"; action: "update" }
  | { kind: "install"; spec: string }
  | { kind: "update"; id: string }
  | { kind: "remove"; id: string }
  | { kind: "usage"; message: string };

const usage = (why?: string): PackCommand => ({ kind: "usage", message: why ? `${why} ${PACK_USAGE}` : PACK_USAGE });

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `install <owner/repo[@ref]>`, `update [<owner/repo>]` and `remove <owner/repo>`, typed instead of picked. Pure: nothing is looked
 * up or run, so whether the pack is installed is for the caller to check.
 */
export function parsePackCommand(args: string): PackCommand {
  const [verb, operand, ...extra] = args.trim().split(/\s+/);
  if (extra.length > 0 || (verb !== "install" && verb !== "update" && verb !== "remove")) return usage();

  if (verb === "install") {
    if (!operand) return usage();
    try {
      parsePackSpec(operand);
    } catch (error) {
      return usage(reason(error));
    }
    return { kind: "install", spec: operand };
  }

  if (!operand) return verb === "remove" ? usage() : { kind: "picker", action: "update" };
  try {
    const spec = parsePackSpec(operand);
    if (spec.ref !== undefined) return usage(`${operand} names a ref; ${verb} takes owner/repo.`);
    return { kind: verb, id: spec.id };
  } catch (error) {
    return usage(reason(error));
  }
}
