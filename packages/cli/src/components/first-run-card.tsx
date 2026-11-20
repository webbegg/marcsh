import { TextAttributes } from "@opentui/core";

/** What Enter says on the home screen while no model is available (pi with no provider signed in). */
export const NO_MODEL_MESSAGE = "No model yet: type /login to sign in to a provider";

/**
 * A quiet card for the home screen when no model is available. It leads with pi's way forward (sign in, then pick a model) and
 * names the Claude engine after it, for Claude Code users. The caller shows it only while pi has no model, so it goes away by
 * itself once a provider is signed in.
 */
export function FirstRunCard() {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text attributes={TextAttributes.DIM}>No model yet. To start:</text>
      <text attributes={TextAttributes.DIM}>  /login   sign in to a provider</text>
      <text attributes={TextAttributes.DIM}>  /models  then pick a model</text>
      <text attributes={TextAttributes.DIM}>  Using Claude Code? /engine switches to the Claude engine.</text>
    </box>
  );
}
