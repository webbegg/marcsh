import { createContext, useContext } from "react";
import type { BackgroundHub } from "./hub";

/** The open session's background hub, for the status line and the dialogs that list background work. Absent outside a pi session. */
export const BackgroundContext = createContext<BackgroundHub | undefined>(undefined);

export const useBackgroundHub = () => useContext(BackgroundContext);
