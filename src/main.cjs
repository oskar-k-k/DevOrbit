const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { associate } = require('./model.cjs');
let win, tray, quitting = false, config, configFile, scanning = false;
let inventory = [], scanError = null, scannedAt = null;
const owned = new Map(), logs = new Map(), branches = new Map();
const ps = script => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
const id = () => crypto.randomUUID();
function save() { const temporary = configFile + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(config, null, 2)); fs.renameSync(temporary, configFile); }
function addLog(serviceId, chunk) { logs.set(serviceId, ((logs.get(serviceId) || '') + chunk.toString()).slice(-100000)); }
function serviceState(project, service) {
  const managed = [...owned.values()].find(x => x.serviceId === service.id);
  const found = inventory.filter(p => p.serviceId === service.id || (p.projectId === project.id && service.ports.some(port => p.ports.includes(port))));
  return { ...service, running: !!managed || found.length > 0, managed: !!managed, pids: [...new Set(found.map(p => p.pid).concat(managed ? [managed.child.pid] : []))] };
}
function state() { return { projects: config.projects.map(p => ({ ...p, branch: branches.get(p.id) || '—', services: p.services.map(s => serviceState(p, s)) })), processes: inventory, scanError, scannedAt, autoStart: app.getLoginItemSettings().openAtLogin }; }
function publish() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state());
  if (tray) {
    const current = state();
    tray.setToolTip(`Dev Orbit · ${inventory.filter(p => p.ports.length).length} Prozesse mit Ports`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '🪐 Dev Orbit öffnen', click: show }, { type: 'separator' },
      ...current.projects.map(p => ({ label: `${p.name}  ${p.services.filter(s => s.running).length}/${p.services.length}`, submenu: [
        { label: `Branch: ${p.branch}`, enabled: false },
        ...p.services.map(s => ({ label: `${s.running ? '●' : '○'} ${s.name}`, submenu: [
          { label: 'Starten', enabled: !s.running, click: () => start(p.id, s.id).catch(report) },
          { label: 'Stoppen', enabled: s.managed, click: () => stop(p.id, s.id).catch(report) },
          ...(s.url ? [{ label: 'Im Browser öffnen', click: () => openUrl(s.url).catch(report) }] : [])
        ] })) ] })),
      { type: 'separator' }, { label: `${inventory.filter(p => !p.projectId).length} nicht zugeordnete Prozesse`, enabled: false },
      { label: 'Dev Orbit beenden', click: quit }
    ]));
  }
}
function report(error) { dialog.showErrorBox('Dev Orbit', error.message); }
async function scan() {
  if (scanning) return; scanning = true;
  try {
    const { stdout } = await ps("$ErrorActionPreference='Stop'; $ports=@{}; Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { $key=[string]$_.OwningProcess; if(!$ports.ContainsKey($key)){$ports[$key]=@()}; $ports[$key]+=$_.LocalPort }; $items=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;command=$_.CommandLine;created=$_.CreationDate.ToUniversalTime().ToString('o');ports=@($ports[[string]$_.ProcessId] | Sort-Object -Unique)} }); ConvertTo-Json -InputObject $items -Depth 4 -Compress");
    const all = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    const assigned = associate(all, config.projects, owned);
    inventory = assigned.filter(p => p.pid !== process.pid && (p.ports.length || p.projectId));
    for (const p of inventory) {
      const assignment = config.assignments[String(p.pid)];
      if (assignment && assignment.created === p.created && config.projects.some(x => x.id === assignment.projectId)) { p.projectId = assignment.projectId; p.reason = 'Manuell zugewiesen'; }
    }
    await Promise.all(config.projects.map(async p => { try { const result = await exec('git', ['-C', p.directory, 'branch', '--show-current'], { windowsHide: true, timeout: 5000 }); branches.set(p.id, result.stdout.trim() || 'Detached HEAD'); } catch { branches.set(p.id, 'Kein Git-Repository'); } }));
    scanError = null; scannedAt = new Date().toISOString();
  } catch (error) { scanError = 'Windows-Erkennung fehlgeschlagen: ' + error.message; }
  finally { scanning = false; publish(); }
}
function find(projectId, serviceId) { const project = config.projects.find(p => p.id === projectId); const service = project?.services.find(s => s.id === serviceId); if (!service) throw new Error('Service nicht gefunden.'); return { project, service }; }
async function start(projectId, serviceId) {
  const { project, service } = find(projectId, serviceId);
  if (serviceState(project, service).running) throw new Error('Service läuft bereits.');
  if (!fs.existsSync(service.directory || project.directory)) throw new Error('Arbeitsverzeichnis existiert nicht.');
  addLog(serviceId, `\n[${new Date().toLocaleString()}] Start: ${service.command}\n`);
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', service.command], { cwd: service.directory || project.directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.set(child.pid, { projectId, serviceId, child });
  child.stdout.on('data', chunk => addLog(serviceId, chunk)); child.stderr.on('data', chunk => addLog(serviceId, chunk));
  child.on('error', error => { addLog(serviceId, error.message); owned.delete(child.pid); publish(); });
  child.on('exit', code => { addLog(serviceId, `\nProzess beendet (Code ${code})\n`); owned.delete(child.pid); scan(); });
  publish(); setTimeout(scan, 1200);
}
async function stop(projectId, serviceId) {
  const { project, service } = find(projectId, serviceId);
  const entry = [...owned.entries()].find(([, v]) => v.serviceId === serviceId);
  if (!entry) throw new Error('Dieser Service wurde extern gestartet. Nutze die Prozessansicht zum kontrollierten Beenden.');
  if (service.stopCommand) {
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', service.stopCommand], { cwd: service.directory || project.directory, windowsHide: true, timeout: 10000 });
    addLog(serviceId, result.stdout + result.stderr);
  }
  if (owned.has(entry[0])) await exec('taskkill.exe', ['/PID', String(entry[0]), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  owned.delete(entry[0]); await scan();
}
async function openUrl(url) { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Nur lokale HTTP/HTTPS-Adressen sind erlaubt.'); await shell.openExternal(parsed.toString()); }
function show() { win.show(); win.focus(); }
async function quit() {
  if (owned.size) { const response = await dialog.showMessageBox({ type: 'question', message: 'Dev Orbit beenden?', detail: 'Die gestarteten Services laufen weiter. Du kannst sie vor dem Beenden in der App stoppen.', buttons: ['Abbrechen', 'Beenden'], defaultId: 0, cancelId: 0 }); if (response.response !== 1) return; }
  quitting = true; app.quit();
}
ipcMain.handle('orbit', async (_, action, data = {}) => {
  try {
    if (action === 'state') return { ok: true, value: state() };
    if (action === 'scan') await scan();
    else if (action === 'pickDirectory') { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return { ok: true, value: result.canceled ? null : result.filePaths[0] }; }
    else if (action === 'saveProject') {
      if (!data.name?.trim() || !path.isAbsolute(data.directory || '') || !fs.existsSync(data.directory)) throw new Error('Name und gültiger absoluter Projektpfad sind erforderlich.');
      const existing = config.projects.find(p => p.id === data.id);
      if (existing) { existing.name = data.name.trim(); existing.directory = data.directory; }
      else config.projects.push({ id: id(), name: data.name.trim(), directory: data.directory, services: [] });
      save(); await scan();
    } else if (action === 'deleteProject') {
      if ([...owned.values()].some(x => x.projectId === data.id)) throw new Error('Stoppe zuerst die von Dev Orbit gestarteten Services.');
      config.projects = config.projects.filter(p => p.id !== data.id); save(); await scan();
    } else if (action === 'saveService') {
      const project = config.projects.find(p => p.id === data.projectId); if (!project) throw new Error('Projekt fehlt.');
      if (!data.name?.trim() || !data.command?.trim()) throw new Error('Name und Startbefehl sind erforderlich.');
      const ports = String(data.ports || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
      if (ports.some(n => !Number.isInteger(n) || n < 1 || n > 65535)) throw new Error('Ports müssen zwischen 1 und 65535 liegen.');
      if (data.url) { const u = new URL(data.url); if (!['http:', 'https:'].includes(u.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('URL muss eine lokale HTTP/HTTPS-Adresse sein.'); }
      if (data.directory && (!path.isAbsolute(data.directory) || !fs.existsSync(data.directory))) throw new Error('Ungültiges Service-Verzeichnis.');
      const service = { id: data.id || id(), name: data.name.trim(), type: data.type || 'Custom', command: data.command.trim(), stopCommand: data.stopCommand?.trim() || '', directory: data.directory || '', ports: [...new Set(ports)], url: data.url || '' };
      const index = project.services.findIndex(s => s.id === service.id);
      if ([...owned.values()].some(x => x.serviceId === service.id)) throw new Error('Stoppe den Service vor dem Bearbeiten.');
      if (index < 0) project.services.push(service); else project.services[index] = service;
      save(); publish();
    } else if (action === 'deleteService') { const { project, service } = find(data.projectId, data.serviceId); if ([...owned.values()].some(x => x.serviceId === service.id)) throw new Error('Service zuerst stoppen.'); project.services = project.services.filter(s => s.id !== service.id); save(); publish(); }
    else if (action === 'start') await start(data.projectId, data.serviceId);
    else if (action === 'stop') await stop(data.projectId, data.serviceId);
    else if (action === 'restart') { await stop(data.projectId, data.serviceId); await start(data.projectId, data.serviceId); }
    else if (action === 'logs') return { ok: true, value: logs.get(data.serviceId) || 'Für extern gestartete Prozesse sind keine Logs verfügbar.' };
    else if (action === 'open') await openUrl(data.url);
    else if (action === 'assign') { const p = inventory.find(p => p.pid === data.pid); if (!p || !config.projects.some(x => x.id === data.projectId)) throw new Error('Prozess oder Projekt fehlt.'); config.assignments[String(p.pid)] = { created: p.created, projectId: data.projectId }; save(); await scan(); }
    else if (action === 'kill') {
      const p = inventory.find(p => p.pid === data.pid); if (!p || p.managed || !p.ports.length) throw new Error('Nur externe Prozesse mit offenen Ports können hier beendet werden.');
      const answer = await dialog.showMessageBox(win, { type: 'warning', message: `${p.name} (PID ${p.pid}) beenden?`, detail: `Ports: ${p.ports.join(', ')}\n${p.command || 'Befehlszeile nicht verfügbar'}\n\nDer Prozess wird zwangsweise beendet. Ungespeicherte Daten können verloren gehen.`, buttons: ['Abbrechen', 'Prozess beenden'], defaultId: 0, cancelId: 0 });
      if (answer.response === 1) {
        const result = await ps(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${p.pid}"; if($p){$p.CreationDate.ToUniversalTime().ToString('o')}`);
        if (result.stdout.trim() !== p.created) throw new Error('Prozess hat sich geändert. Bitte Erkennung aktualisieren.');
        await exec('taskkill.exe', ['/PID', String(p.pid), '/F'], { windowsHide: true }); await scan();
      }
    } else if (action === 'autoStart') { app.setLoginItemSettings({ openAtLogin: !!data.enabled }); publish(); }
    else if (action !== 'scan') throw new Error('Unbekannte Aktion.');
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) show(); });
  app.whenReady().then(() => {
    configFile = path.join(app.getPath('userData'), 'projects.json');
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); if (!Array.isArray(config.projects)) throw new Error('Ungültige Konfiguration'); config.assignments ||= {}; }
    catch (error) { config = { projects: [], assignments: {} }; if (fs.existsSync(configFile)) { fs.copyFileSync(configFile, configFile + `.backup-${Date.now()}`); dialog.showErrorBox('Konfiguration wiederhergestellt', 'Die beschädigte Konfiguration wurde als Backup gesichert.'); } }
    win = new BrowserWindow({ width: 1280, height: 850, minWidth: 940, minHeight: 640, backgroundColor: '#10131b', title: 'Dev Orbit', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.loadFile(path.join(__dirname, 'index.html'));
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    const pixels = Buffer.alloc(32 * 32 * 4); for (let y=0;y<32;y++) for(let x=0;x<32;x++){ const d=Math.hypot(x-16,y-16); const i=(y*32+x)*4; if(d<8 || (d>12 && d<14)){pixels[i]=148;pixels[i+1]=128;pixels[i+2]=255;pixels[i+3]=255;} }
    tray = new Tray(nativeImage.createFromBuffer(pixels, { width: 32, height: 32 })); tray.on('click', show); publish();
    if (process.argv.includes('--smoke-test')) {
      win.webContents.once('did-finish-load', async () => {
        await scan();
        const rendered = await win.webContents.executeJavaScript("({title:document.title,heading:document.querySelector('h1').textContent,bridge:typeof window.orbit.call,node:typeof require})");
        let lifecycle = false;
        const smokeProject = { id: id(), name: 'Smoke test', directory: __dirname, services: [{ id: id(), name: 'Lifecycle', command: "Write-Output 'ORBIT_SMOKE'; Start-Sleep -Seconds 30", ports: [], directory: '', url: '' }] };
        config.projects.push(smokeProject);
        try {
          await start(smokeProject.id, smokeProject.services[0].id);
          await new Promise(resolve => setTimeout(resolve, 1500));
          const started = serviceState(smokeProject, smokeProject.services[0]).managed;
          await stop(smokeProject.id, smokeProject.services[0].id);
          lifecycle = started && !serviceState(smokeProject, smokeProject.services[0]).managed && (logs.get(smokeProject.services[0].id) || '').includes('ORBIT_SMOKE');
        } catch (error) { console.error(error.message); }
        config.projects = config.projects.filter(p => p.id !== smokeProject.id);
        console.log(JSON.stringify({ rendered, lifecycle, processes: inventory.length, scanError }));
        quitting = true; app.exit(scanError || !lifecycle || rendered.bridge !== 'function' || rendered.node !== 'undefined' ? 1 : 0);
      });
    } else { scan(); setInterval(scan, 6000); }
  });
  app.on('before-quit', () => { quitting = true; });
}
