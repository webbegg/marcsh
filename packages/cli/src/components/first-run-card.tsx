import { TextAttributes } from "@opentui/core";

/** What Enter says on the home screen while no model is available (pi with no provider signed in). */
export const NO_MODEL_MESSAGE = "No model yet: run /login to sign in to a pi provider, or /engine to use Claude.";

/**
 * A quiet card for the home screen when no model is available: the two ways forward. The caller shows it only while it holds
 * (pi has no model), so it goes away by itself once a provider is signed in.
 */
export function FirstRunCard() {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text attributes={TextAttributes.DIM}>No model yet. Two ways to start:</text>
      <text attributes={TextAttributes.DIM}>  /login  sign in to a pi provider</text>
      <text attributes={TextAttributes.DIM}>  /engine → Claude  uses your existing Claude sign-in</text>
    </box>
  );
}
