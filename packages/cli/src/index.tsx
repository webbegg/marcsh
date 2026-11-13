import cliPackage from "../package.json";
import { parseCliArgs, USAGE } from "./cli-args";

// `--version` and `--help` only print. The app below is imported after this check: importing it opens the storage and
// the renderer, which these options must not do.
const args = parseCliArgs(process.argv.slice(2));
if (args.kind === "version") {
  console.log(`marcsh ${cliPackage.version}`);
  process.exit(0);
}
if (args.kind === "help") {
  console.log(USAGE.trimEnd());
  process.exit(0);
}
if (args.kind === "error") {
  console.error(`marcsh: ${args.message}\n\n${USAGE.trimEnd()}`);
  process.exit(2);
}

const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("./layouts/root-layout");
const { Home } = await import("./screens/home");
const { NewSession } = await import("./screens/new-session");
const { Session } = await import("./screens/session");
const { warmUpEngineCommands } = await import("./lib/engine");
const { getDefaultEngine } = await import("./lib/preferences");
const { installQuitSignals } = await import("./lib/quit");

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
