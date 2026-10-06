# Dev Orbit

Windows-first desktop companion for local development. Projects are the central unit; each has services with commands, ports, URLs and logs.

## Run

Requires Windows 10/11, Node.js 22+ and npm. Git is optional for branch detection.

```powershell
npm.cmd install
npm.cmd start
```

Dev Orbit starts as an icon in the Windows notification area, without a taskbar window. Left-click the icon to toggle a compact panel at the bottom-right of that monitor. Clicking outside or pressing Escape hides the panel. Click a project to expand its services. Right-click the tray icon for service actions and Exit. Windows may initially put the icon under the notification area's hidden-icons arrow.

Create a project, choose its existing directory and add services. For npm services use `npm.cmd run dev` as the PowerShell command. Services can use a separate absolute working directory.

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run dist
```

The Windows installer is written to `dist/`. Project configuration is stored in `%APPDATA%/dev-orbit/projects.json`. Activity and captured stdout/stderr are persisted in `activity.jsonl` with one rotated archive (4 MiB each); the UI retains the latest 3000 events in memory.

## Shared process and console

The hierarchy is Project → Frontend / Backend / Databases → Apps → script actions. Script aliases for an app stay under one app. The Activity tab shows actions, outcomes, process/port changes and captured process output. Individual Logs also update live and include stop outcomes for externally started services. History survives app restarts. External changes are observed while Dev Orbit is running, on the six-second scan cadence; their caller and exit code are not known. Short-lived processes between scans can be missed. Earlier actions before logging was introduced cannot be reconstructed.

For a full shared console, keep Dev Orbit running in the tray and start through the included CLI. From a packaged `win-unpacked` directory:

```powershell
.\dev-orbit.cmd list
.\dev-orbit.cmd start "OskarLab" "frontend · dev" --follow
.\dev-orbit.cmd logs "OskarLab" "frontend · dev" --follow
```

During development the equivalent is `node src/orbit-cli.cjs ...`. IntelliJ can use this as a run command; coding agents and terminals can invoke the same CLI. Start reuses an already running instance instead of launching another. The app owns the process, captures its stdout/stderr, and streams the same captured entries to the tool and CLI. Ctrl+C in the CLI only disconnects the viewer; Stop in the tool manages the actual process. Stop is also available via the CLI and retains native confirmation for external processes.

The local named-pipe connection authenticates with a random token stored in the user's app-data profile. The CLI only controls existing configured services and does not accept arbitrary commands. Node.js is required for the CLI launcher. The CLI reports when an existing externally started process has no captured console. Its old terminal stdout/stderr cannot be attached retrospectively; to capture that output, deliberately restart through Dev Orbit once. Logs are stored as emitted by the process. The app must remain running to capture ongoing output.

## Discovery and process safety

Adding a project automatically scans its root and subfolders (up to six levels / 1200 directories). Dev Orbit recognizes `dev`, `start`, `serve`, `watch`, `preview` scripts and their colon variants in `package.json`, choosing npm/pnpm/yarn/bun from project metadata and lockfiles. Executable .NET projects and Project launch profiles, Compose services, and conventional Django / Flask / FastAPI entry points are also supported. Build/test/lint scripts and dependency/build directories are excluded. Files are read as data; discovery never executes scripts or installs dependencies.

Detected services show their start command and source file. Project files are rescanned every 30 seconds or via the project's “Erkennen” button. Editing a detected service creates a persistent local override; deleting it hides that discovery without changing project files. Existing manual services with the same directory and start command are enriched rather than duplicated.

Running project listeners appear as service cards automatically. A unique script/process match uses actual ports and PIDs, with optional npm ancestor script information to distinguish `dev` from `start`. Ambiguous listeners remain separate runtime cards; their start command must be configured before restarting. External Stop always asks for native confirmation and rechecks process creation time. HTTP URLs for web services are inferred from listening ports; the protocol cannot be verified from a TCP listener alone.

Recognition is best-effort: relative external commands without a project path, arbitrary custom launchers and nonstandard Python layouts can require manual configuration. Compose definitions provide start/stop commands and configured ports; detached container status is not inspected. Docker's shared Windows listener is never assigned solely by port. Existing and detected services still require their development runtimes and dependencies to be installed.

Monorepo listeners are matched to individual apps using configured ports within an already identified project and the most specific available directory evidence. Ancestor launchers retain an overview of their children. Alternative scripts for the same app/port show “App bereits aktiv” and cannot start another instance. The header counts actual listeners, not every script alias. Before starting, Dev Orbit refreshes discovery and process state, blocks occupied ports (including unrelated processes), and prevents concurrent start requests for a project. Workspace launchers are blocked when child apps are already running. This protects starts through Dev Orbit; it cannot intercept commands executed directly by IntelliJ, Codex or a terminal.

Every six seconds Dev Orbit queries `Win32_Process` and `Get-NetTCPConnection` internally to identify project services. Only processes associated with configured projects are exposed in the panel, tray counts and port counts. Unrelated Windows processes and unassigned listeners are excluded. Command lines with an unambiguous full project path can be assigned automatically. Owned descendants inherit the project and service association. Ports alone never assign a project. Previously saved manual assignments are tied to PID and process creation time to prevent reuse errors.

Windows does not expose arbitrary process working directories through CIM. Relative commands started outside Dev Orbit can therefore remain unassigned. Restricted processes may have no readable command line. UDP endpoints and Docker container metadata are not yet integrated; published Docker TCP ports appear as Windows listeners.

Start executes the configured PowerShell command with the current user's permissions. Stop/restart kills the process tree started by Dev Orbit. External project processes can be terminated from their service or process view after native confirmation and creation-time checks; selected PIDs are terminated. No automatic process termination or administrator elevation is performed. Service status for externally launched processes uses project ownership, process lineage and configured ports. Console output is captured for services started by Dev Orbit; actions and observed lifecycle changes are logged for external services as well.

An optional PowerShell stop command runs first (10-second timeout), followed by termination of any remaining owned process tree. This is useful for `docker compose down` when a service was started with `docker compose up` in the foreground. Detached containers require a later Docker integration.

Exiting does not explicitly terminate services, but closes console capture and the CLI connection. Surviving services are discovered as external processes after restarting Dev Orbit. Stop services before exiting if ongoing capture is needed; a separate always-running broker is not implemented.

## Structure

- `src/main.cjs`: Windows discovery, persistent configuration, lifecycle, tray and validated IPC.
- `src/model.cjs`: conservative project association, independent of Electron.
- `src/preload.cjs`: isolated IPC bridge.
- `src/renderer.js`: local dashboard, project/service editors and process controls.

The renderer has no Node.js access, uses a restrictive content security policy, escapes user-provided text and only opens loopback HTTP/HTTPS URLs.
