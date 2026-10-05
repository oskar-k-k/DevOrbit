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

The Windows installer is written to `dist/`. Project configuration is stored in `%APPDATA%/dev-orbit/projects.json`; logs are bounded in-memory buffers for the current app session.

## Discovery and process safety

Every six seconds Dev Orbit queries `Win32_Process` and `Get-NetTCPConnection` internally to identify project services. Only processes associated with configured projects are exposed in the panel, tray counts and port counts. Unrelated Windows processes and unassigned listeners are excluded. Command lines with an unambiguous full project path can be assigned automatically. Owned descendants inherit the project and service association. Ports alone never assign a project. Previously saved manual assignments are tied to PID and process creation time to prevent reuse errors.

Windows does not expose arbitrary process working directories through CIM. Relative commands started outside Dev Orbit can therefore remain unassigned. Restricted processes may have no readable command line. UDP endpoints and Docker container metadata are not yet integrated; published Docker TCP ports appear as Windows listeners.

Start executes the configured PowerShell command with the current user's permissions. Stop/restart kills the process tree started by Dev Orbit. External processes can be terminated only through the process view, after a native confirmation and creation-time check; only that PID is terminated. No automatic process termination or administrator elevation is performed. Service status for externally launched processes uses the assigned project plus the service's configured ports. Logs are only captured for services started by Dev Orbit.

An optional PowerShell stop command runs first (10-second timeout), followed by termination of any remaining owned process tree. This is useful for `docker compose down` when a service was started with `docker compose up` in the foreground. Detached containers require a later Docker integration.

Exiting leaves services running. After restarting Dev Orbit, surviving services are discovered as external processes and can be manually assigned if their command line does not identify the project. Stop them before exiting if desired. Persistent log history is a future extension.

## Structure

- `src/main.cjs`: Windows discovery, persistent configuration, lifecycle, tray and validated IPC.
- `src/model.cjs`: conservative project association, independent of Electron.
- `src/preload.cjs`: isolated IPC bridge.
- `src/renderer.js`: local dashboard, project/service editors and process controls.

The renderer has no Node.js access, uses a restrictive content security policy, escapes user-provided text and only opens loopback HTTP/HTTPS URLs.
