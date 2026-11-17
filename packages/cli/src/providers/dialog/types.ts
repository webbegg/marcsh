import type { ReactNode } from "react";

export type DialogConfig = {
  title: string;
  children: ReactNode;
  /** `wide`: up to 100 columns, for long lists such as the command palette. Unset: up to 60. */
  width?: "wide";
};
