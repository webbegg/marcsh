import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { RootLayout } from "./layouts/root-layout";
import { Home } from "./screens/home";
import { NewSession } from "./screens/new-session";
import { Session } from "./screens/session";
import { warmUpEngineCommands } from "./lib/engine";
import { getDefaultEngine } from "./lib/preferences";
import { installQuitSignals } from "./lib/quit";

const router = createMemoryRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: "sessions/new", element: <NewSession /> },
      { path: "sessions/:id", element: <Session /> },
    ]
  }
]);

function App() {
  return <RouterProvider router={router} />
}

const renderer = await createCliRenderer({
  targetFps: 60,
  exitOnCtrlC: false,
});
createRoot(renderer).render(<App />);

// SIGINT, SIGTERM and SIGHUP (a closed terminal) quit the same way as Ctrl+C: running turns are stopped first (exit codes 130, 143, 129).
installQuitSignals(renderer);

// Fills the `/` menu's command list of the default engine without waiting for a chat turn; never delays or breaks the
// first render. Only that engine: a Claude-only run never loads pi (pi is warmed when a pi session opens or becomes the default).
void warmUpEngineCommands(getDefaultEngine());
