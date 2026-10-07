const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { associate, annotateLineage } = require('./model.cjs');
const { panelBounds, projectProcesses } = require('./panel.cjs');
const { discoverProject, resolveServices, startConflict } = require('./discovery.cjs');
const { Journal, formatEntries } = require('./journal.cjs');
const { createBridge } = require('./bridge.cjs');
const { hierarchy } = require('./hierarchy.cjs');
const {localStatus,dockerInventory,dockerStatus}=require('./dev-project.cjs');
const standardStates=new Map(), projectLogOffsets=new Map();
if (process.argv.includes('--smoke-test')) app.setPath('userData', path.join(__dirname, '..', '.smoke-profile'));
let win, tray, quitting = false, config, configFile, scanning = false;
let nativeDialogOpen = 0, lastBlur = 0;
let inventory = [], scanError = null, scannedAt = null;
let allListeners = [], scanPromise = null;
const startingProjects = new Set();
const owned = new Map(), logs = new Map(), branches = new Map();
const discoveries = new Map();
let journal;
let bridge;
const sessionContexts = new Map();
const ps = script => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
const id = () => crypto.randomUUID();
function save() { const temporary = configFile + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(config, null, 2)); fs.renameSync(temporary, configFile); }
function record(data) { return journal?.add(data); }
function serviceContext(projectId, serviceId) {
  const project = config.projects.find(p=>p.id===projectId);
  const service = project && servicesFor(project).find(s=>s.id===serviceId);
  return {projectId,projectName:project?.name,serviceId,serviceName:service?.name};
}
function processContext(p) {
  const project = config.projects.find(project=>project.id===p.projectId);
  const services = project ? servicesFor(project).filter(s=>s.pids.includes(p.pid)) : [];
  return {projectId:p.projectId,projectName:project?.name,serviceIds:services.map(s=>s.id),serviceName:services.filter(s=>s.type!=='Launcher').map(s=>s.name).join(' / ') || p.name};
}
function addLog(serviceId, chunk, kind='stdout') {
  const text=chunk.toString(); logs.set(serviceId, ((logs.get(serviceId) || '') + text).slice(-100000));
  for(let offset=0;offset<text.length;offset+=12000) record({...sessionContexts.get(serviceId),kind,source:kind==='stdout' || kind==='stderr' ? 'Prozessausgabe' : 'Dev Orbit',message:text.slice(offset,offset+12000)});
}
async function serviceLog(serviceId) {
  for(const project of config.projects) {
    const service=servicesFor(project).find(s=>s.id===serviceId);
    if(!service?.projectStandard) continue;
    if(service.composeFile) {
      const status=standardStates.get(project.id+':'+serviceId);
      if(status?.containers?.length) {const result=await exec('docker.exe',['logs','--tail','300',status.containers[0]],{windowsHide:true,timeout:10000,maxBuffer:2*1024*1024});return result.stdout+result.stderr;}
      return status?.statusError || 'Kein zugehöriger Container vorhanden.';
    }
    const file=path.join(project.directory,'.dev/logs',service.key+'.log');
    if(fs.existsSync(file)){const handle=fs.openSync(file,'r');try{const size=fs.fstatSync(handle).size;const buffer=Buffer.alloc(Math.min(size,100000));fs.readSync(handle,buffer,0,buffer.length,size-buffer.length);return buffer.toString('utf8');}finally{fs.closeSync(handle);}}
  }
  const entries = journal.query({serviceId,limit:1000});
  const hasOutput=entries.some(e=>e.kind==='stdout' || e.kind==='stderr');
  return (hasOutput ? 'Prozessausgabe und Ereignisse.\n\n' : 'Ereignisprotokoll. Die stdout/stderr-Konsole extern gestarteter Prozesse wurde nicht erfasst. Für eine gemeinsame Konsole über Dev Orbit / den Orbit-CLI starten.\n\n') + (formatEntries(entries) || 'Noch keine Ereignisse aufgezeichnet. Frühere Aktionen vor dieser Version sind nicht rekonstruierbar.');
}
async function bridgeAction(request) {
  if(request.action==='list') return {value:state().projects.map(p=>({id:p.id,name:p.name,services:p.services.map(s=>({id:s.id,name:s.name,running:s.running,pids:s.pids}))}))};
  if(!['start','logs','stop'].includes(request.action)) throw Error('Unbekannter CLI-Aufruf.');
  await scan(); if(scanError) throw Error(scanError);
  const projects=config.projects.filter(p=>p.id===request.project || p.name===request.project);
  if(projects.length!==1) throw Error('Projekt nicht eindeutig gefunden. Nutze list für Namen und IDs.');
  const project=projects[0];
  const services=servicesFor(project).filter(s=>s.id===request.service || s.name===request.service);
  if(services.length!==1) throw Error('Service nicht eindeutig gefunden. Nutze list für Namen und IDs.');
  const service=services[0]; const context=serviceContext(project.id,service.id);
  const reused=service.running;
  record({...context,kind:'cli',source:'Orbit CLI',message:`CLI: ${request.action}${reused && request.action==='start' ? ' · vorhandene Instanz verwenden' : ''}`});
  if(request.action==='start' && !reused) await start(project.id,service.id);
  if(request.action==='stop') await stop(project.id,service.id);
  const captured=[...owned.values()].some(entry=>entry.serviceId===service.id);
  return {value:{project:project.name,service:service.name,reused:request.action==='start' && reused,consoleCaptured:captured,message:request.action==='start' && reused ? 'Vorhandene Instanz wird genutzt; kein weiterer Prozess gestartet.' : 'Aufruf abgeschlossen.',consoleInfo:captured ? 'Gemeinsame Prozessausgabe wird live erfasst.' : 'Externe stdout/stderr-Ausgabe ist nicht angebunden; Ereignisse sind verfügbar.'},filter:{projectId:project.id,serviceId:service.id}};
}
function serviceState(project, service) {
  return servicesFor(project).find(s => s.id === service.id) || service;
}
function servicesFor(project) { return resolveServices(project, discoveries.get(project.id)?.services || [], inventory, owned).map(service=>{
  if(!service.projectStandard)return service;
  const current=standardStates.get(project.id+':'+service.id);
  if(!current)return service;
  const ports=current.ports?.length ? current.ports : service.ports;
  return {...service,...current,ports,managed:false,activeElsewhere:false,url:['Frontend','Backend'].includes(service.type) && current.ports?.length ? 'http://localhost:'+current.ports[0] : '',startDisabled:!!current.statusError};
}); }
async function refreshDiscovery(project, force = false) {
  const cached = discoveries.get(project.id);
  if (!force && cached && cached.directory === project.directory && Date.now() - cached.scannedAt < 30000) return;
  discoveries.set(project.id, { ...await discoverProject(project.directory), directory: project.directory });
}
function state() { return { projects: config.projects.map(p => {const project={ ...p, branch: branches.get(p.id) || '—', discoveryNotes: discoveries.get(p.id)?.notes || [], services: servicesFor(p) }; return {...project,groups:hierarchy(project)};}), processes: inventory, journalError:journal?.error, scanError, scannedAt, autoStart: app.getLoginItemSettings().openAtLogin }; }
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
          { label: 'Starten', enabled: !s.running && !!s.command && !s.startDisabled, click: () => start(p.id, s.id).catch(report) },
          { label: 'Stoppen', enabled: s.running && (!s.projectStandard || !!s.composeFile || s.registered), click: () => stop(p.id, s.id).catch(report) },
          ...(s.url ? [{ label: 'Im Browser öffnen', click: () => openUrl(s.url).catch(report) }] : [])
        ] })) ] })),
      { type: 'separator' }, { label: `${inventory.length} Projektprozesse`, enabled: false },
      { label: 'Dev Orbit beenden', click: quit }
    ]));
  }
}
function report(error) { dialog.showErrorBox('Dev Orbit', error.message); }
function scan() {
  if (!scanPromise) scanPromise = performScan().finally(() => { scanPromise = null; });
  return scanPromise;
}
async function performScan() {
  scanning = true;
  try {
    await Promise.all(config.projects.map(p => refreshDiscovery(p)));
    const { stdout } = await ps("$ErrorActionPreference='Stop'; $ports=@{}; Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { $key=[string]$_.OwningProcess; if(!$ports.ContainsKey($key)){$ports[$key]=@()}; $ports[$key]+=$_.LocalPort }; $items=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;command=$_.CommandLine;created=$_.CreationDate.ToUniversalTime().ToString('o');ports=@($ports[[string]$_.ProcessId] | Sort-Object -Unique)} }); ConvertTo-Json -InputObject $items -Depth 4 -Compress");
    const all = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    allListeners = all.filter(p => p.ports.length);
    const assigned = associate(all, config.projects, owned);
    let containers,dockerError;
    if(config.projects.some(p=>discoveries.get(p.id)?.services.some(s=>s.projectStandard && s.composeFile))) {try{containers=await dockerInventory();}catch(error){dockerError='Docker nicht erreichbar: '+error.message;}}
    for(const project of config.projects) for(const service of discoveries.get(project.id)?.services || []) {
      if(!service.projectStandard)continue;
      const standard={root:project.directory};
      const current=service.composeFile ? (dockerError ? {running:false,pids:[],ports:[],statusError:dockerError} : dockerStatus(service,containers)) : localStatus(standard,service,all);
      const previous=standardStates.get(project.id+':'+service.id);
      standardStates.set(project.id+':'+service.id,current);
      if(service.composeFile && (!previous || previous.running!==current.running || previous.statusError!==current.statusError || JSON.stringify(previous.ports)!==JSON.stringify(current.ports)))record({projectId:project.id,projectName:project.name,serviceId:service.id,serviceName:service.name,kind:'docker-status',source:'Docker',ports:current.ports,message:current.statusError || (current.running ? 'Container läuft · Ports '+current.ports.join(', ') : 'Container gestoppt oder noch nicht vorhanden')});
      const ids=new Set(current.pids);
      for(const p of assigned)if(ids.has(p.pid)){p.projectId=project.id;p.serviceId=service.id;p.reason=current.registered ? 'Projekt-Starter: PID und Startzeit geprüft' : 'Projektpfad und Dienstmerkmal';}
      const file=path.join(project.directory,'.dev/logs',service.key+'.log');
      if(fs.existsSync(file)) {
        const size=fs.statSync(file).size;let offset=projectLogOffsets.get(file) ?? Math.max(0,size-20000);if(size<offset)offset=0;
        if(size>offset){const handle=fs.openSync(file,'r');try{const buffer=Buffer.alloc(Math.min(size-offset,100000));fs.readSync(handle,buffer,0,buffer.length,offset);sessionContexts.set(service.id,{projectId:project.id,projectName:project.name,serviceId:service.id,serviceName:service.name});addLog(service.id,buffer.toString('utf8'));offset+=buffer.length;}finally{fs.closeSync(handle);}}
        projectLogOffsets.set(file,offset);
      }
    }
    inventory = projectProcesses(assigned.filter(p => p.pid !== process.pid), config.projects, config.assignments);
    inventory = annotateLineage(inventory,all);
    journal.observe(inventory,all,processContext);
    await Promise.all(config.projects.map(async p => { try { const result = await exec('git', ['-C', p.directory, 'branch', '--show-current'], { windowsHide: true, timeout: 5000 }); branches.set(p.id, result.stdout.trim() || 'Detached HEAD'); } catch { branches.set(p.id, 'Kein Git-Repository'); } }));
    scanError = null; scannedAt = new Date().toISOString();
  } catch (error) { scanError = 'Windows-Erkennung fehlgeschlagen: ' + error.message; }
  finally { scanning = false; publish(); }
}
function find(projectId, serviceId) { const project = config.projects.find(p => p.id === projectId); const service = project && servicesFor(project).find(s => s.id === serviceId); if (!service) throw new Error('Service nicht gefunden.'); return { project, service }; }
async function start(projectId, serviceId) {
  if (startingProjects.has(projectId)) throw new Error('Für dieses Projekt läuft bereits eine Startprüfung. Bitte kurz warten.');
  startingProjects.add(projectId);
  try {
  await scan();
  if (scanError) throw new Error('Start verhindert: Der aktuelle Prozessstatus konnte nicht geprüft werden.');
  const { project, service } = find(projectId, serviceId);
  if(service.projectStandard) {
    if(service.statusError)throw Error(service.statusError);
    const result=await exec('node',[path.join(project.directory,'scripts/dev-runner.cjs'),'start',service.key],{cwd:project.directory,windowsHide:true,timeout:180000,maxBuffer:4*1024*1024});
    record({...serviceContext(projectId,serviceId),kind:'start',source:'Projekt-Starter',message:result.stdout+result.stderr});await scan();return;
  }
  const conflict = startConflict(service, servicesFor(project), allListeners);
  if (conflict) throw new Error(conflict);
  if (!service.command) throw new Error('Für diesen Prozess ist kein Startbefehl bekannt. Bitte zuerst konfigurieren.');
  if (!fs.existsSync(service.directory || project.directory)) throw new Error('Arbeitsverzeichnis existiert nicht.');
  sessionContexts.set(serviceId,serviceContext(projectId,serviceId));
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', service.command], { cwd: service.directory || project.directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.set(child.pid, { projectId, serviceId, child });
  sessionContexts.set(serviceId,{...sessionContexts.get(serviceId),pid:child.pid});
  record({...sessionContexts.get(serviceId),kind:'start',source:'Dev Orbit',message:`Prozess gestartet: ${service.command}\nArbeitsverzeichnis: ${service.directory || project.directory}`});
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => addLog(serviceId, chunk,'stdout')); child.stderr.on('data', chunk => addLog(serviceId, chunk,'stderr'));
  child.on('error', error => { addLog(serviceId, error.message,'error'); owned.delete(child.pid); publish(); });
  child.on('exit', code => { addLog(serviceId, `Prozess beendet (Code ${code})`,'exit'); owned.delete(child.pid); scan(); });
  publish(); setTimeout(scan, 1200);
  } finally { startingProjects.delete(projectId); }
}
async function stop(projectId, serviceId) {
  const { project, service } = find(projectId, serviceId);
  if(service.projectStandard) {
    const result=await exec('node',[path.join(project.directory,'scripts/dev-runner.cjs'),'stop',service.key],{cwd:project.directory,windowsHide:true,timeout:45000,maxBuffer:4*1024*1024});
    record({...serviceContext(projectId,serviceId),kind:'stop',source:'Projekt-Starter',message:result.stdout+result.stderr || 'Dienst gestoppt'});await scan();return;
  }
  record({...serviceContext(projectId,serviceId),kind:'stop-request',source:'Dev Orbit',message:`Stop angefordert · PID ${service.pids.join(', ') || 'wird geprüft'}`});
  const entry = [...owned.entries()].find(([, v]) => v.serviceId === serviceId);
  if (!entry) {
    const targets = inventory.filter(p => service.pids.includes(p.pid) && p.projectId === project.id);
    if (!targets.length) throw new Error('Kein laufender Service-Prozess gefunden.');
    await terminateExternal(targets); return;
  }
  if (service.stopCommand) {
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', service.stopCommand], { cwd: service.directory || project.directory, windowsHide: true, timeout: 10000 });
    addLog(serviceId, result.stdout + result.stderr);
  }
  if (owned.has(entry[0])) await exec('taskkill.exe', ['/PID', String(entry[0]), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  owned.delete(entry[0]); await scan();
  record({...serviceContext(projectId,serviceId),kind:'stop',source:'Dev Orbit',pid:entry[0],message:'Stop erfolgreich: gestarteter Prozessbaum beendet'});
}
async function openUrl(url) { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Nur lokale HTTP/HTTPS-Adressen sind erlaubt.'); await shell.openExternal(parsed.toString()); }
function show() {
  const anchor = tray?.getBounds();
  const display = anchor && anchor.width ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
  win.setBounds(panelBounds(display.workArea)); win.show(); win.focus();
}
function toggle() {
  if (win.isVisible()) win.hide();
  else if (Date.now() - lastBlur > 250) show();
}
async function nativeDialog(callback) {
  nativeDialogOpen++;
  try { return await callback(); }
  finally { nativeDialogOpen--; if (!quitting) show(); }
}
async function terminateExternal(targets) {
  const answer = await nativeDialog(() => dialog.showMessageBox(win, { type: 'warning', message: 'Extern gestartete Projektprozesse beenden?', detail: targets.map(p => `${p.name} · PID ${p.pid} · Ports ${p.ports.join(', ')}\n${p.command || ''}`).join('\n\n') + '\n\nDie ausgewählten Prozesse werden zwangsweise beendet. Ungespeicherte Daten können verloren gehen.', buttons: ['Abbrechen', 'Prozesse beenden'], defaultId: 0, cancelId: 0 }));
  if (answer.response !== 1) { for(const p of targets) record({...processContext(p),kind:'cancelled',source:'Dev Orbit',pid:p.pid,message:'Beenden abgebrochen'}); return; }
  const contexts=new Map(targets.map(p=>[p.pid,processContext(p)]));
  for (const p of targets) {
    const result = await ps(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${p.pid}"; if($p){$p.CreationDate.ToUniversalTime().ToString('o')}`);
    if (result.stdout.trim() !== p.created) throw new Error('Prozess hat sich geändert. Bitte aktualisieren.');
  }
  for (const p of targets) {
    try {
      await exec('taskkill.exe', ['/PID', String(p.pid), '/F'], { windowsHide: true });
      record({...contexts.get(p.pid),kind:'stop',source:'Dev Orbit',pid:p.pid,ports:p.ports,message:'Prozess über Dev Orbit erfolgreich beendet'});
    } catch(error) {
      const result=await ps(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${p.pid}"; if($p){$p.CreationDate.ToUniversalTime().ToString('o')}`);
      if(result.stdout.trim()) throw error;
      record({...contexts.get(p.pid),kind:'stop',source:'Dev Orbit',pid:p.pid,message:'Prozess war inzwischen bereits beendet (mögliche Folgebeendigung durch Startskript).'});
    }
  }
  await scan();
}
async function quit() {
  if (owned.size) { const response = await dialog.showMessageBox({ type: 'question', message: 'Dev Orbit beenden?', detail: 'Die gestarteten Services laufen weiter. Du kannst sie vor dem Beenden in der App stoppen.', buttons: ['Abbrechen', 'Beenden'], defaultId: 0, cancelId: 0 }); if (response.response !== 1) return; }
  quitting = true; app.quit();
}
ipcMain.handle('orbit', async (_, action, data = {}) => {
  try {
    if (action === 'state') return { ok: true, value: state() };
    if (action === 'scan') await scan();
    else if (action === 'discover') { const project = config.projects.find(p => p.id === data.projectId); if (!project) throw new Error('Projekt fehlt.'); await refreshDiscovery(project, true); await scan(); publish(); }
    else if (action === 'hide') win.hide();
    else if (action === 'pickDirectory') { const result = await nativeDialog(() => dialog.showOpenDialog(win, { properties: ['openDirectory'] })); return { ok: true, value: result.canceled ? null : result.filePaths[0] }; }
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
    } else if (action === 'deleteService') { const { project, service } = find(data.projectId, data.serviceId); if ([...owned.values()].some(x => x.serviceId === service.id)) throw new Error('Service zuerst stoppen.'); if (service.runtimeOnly) throw new Error('Laufende Prozesse verschwinden nach dem Beenden.'); project.ignoredDiscovery = [...new Set([...(project.ignoredDiscovery || []), service.id])]; project.services = project.services.filter(s => s.id !== service.id); save(); publish(); }
    else if (action === 'start') await start(data.projectId, data.serviceId);
    else if (action === 'stop') await stop(data.projectId, data.serviceId);
    else if (action === 'restart') { await stop(data.projectId, data.serviceId); await start(data.projectId, data.serviceId); }
    else if (action === 'logs') return { ok: true, value: await serviceLog(data.serviceId) };
    else if (action === 'activity') return { ok: true, value:journal.query({projectId:data.projectId,output:data.output!==false,limit:500}) };
    else if (action === 'open') await openUrl(data.url);
    else if (action === 'assign') { const p = inventory.find(p => p.pid === data.pid); if (!p || !config.projects.some(x => x.id === data.projectId)) throw new Error('Prozess oder Projekt fehlt.'); config.assignments[String(p.pid)] = { created: p.created, projectId: data.projectId }; save(); await scan(); }
    else if (action === 'kill') {
      const p = inventory.find(p => p.pid === data.pid); if (!p || p.managed || !p.ports.length) throw new Error('Nur externe Prozesse mit offenen Ports können hier beendet werden.');
      await terminateExternal([p]);
    } else if (action === 'autoStart') { app.setLoginItemSettings({ openAtLogin: !!data.enabled }); publish(); }
    else if (action !== 'scan') throw new Error('Unbekannte Aktion.');
    return { ok: true };
  } catch (error) { if(['start','stop','restart','kill'].includes(action)) record({...serviceContext(data.projectId,data.serviceId),kind:'error',source:'Dev Orbit',pid:data.pid,message:`${action} fehlgeschlagen: ${error.message}`}); return { ok: false, error: error.message }; }
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) show(); });
  app.whenReady().then(() => {
    configFile = path.join(app.getPath('userData'), 'projects.json');
    journal = new Journal(path.join(app.getPath('userData'),'activity.jsonl'));
    journal.listeners.add(entry=>{if(win && !win.isDestroyed()) win.webContents.send('activity',entry);});
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); if (!Array.isArray(config.projects)) throw new Error('Ungültige Konfiguration'); config.assignments ||= {}; }
    catch (error) { config = { projects: [], assignments: {} }; if (fs.existsSync(configFile)) { fs.copyFileSync(configFile, configFile + `.backup-${Date.now()}`); dialog.showErrorBox('Konfiguration wiederhergestellt', 'Die beschädigte Konfiguration wurde als Backup gesichert.'); } }
    record({kind:'session',source:'Dev Orbit',message:'Überwachung gestartet. Externe Konsole wird nicht rückwirkend erfasst.'});
    bridge = createBridge({directory:app.getPath('userData'),journal,execute:bridgeAction});
    win = new BrowserWindow({ width: 440, height: 640, show: false, frame: false, resizable: false, maximizable: false, minimizable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#10131b', title: 'Dev Orbit', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.on('blur', () => {
      if (!nativeDialogOpen) { lastBlur = Date.now(); win.hide(); }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.loadFile(path.join(__dirname, 'index.html'));
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    const pixels = Buffer.alloc(32 * 32 * 4); for (let y=0;y<32;y++) for(let x=0;x<32;x++){ const d=Math.hypot(x-16,y-16); const i=(y*32+x)*4; if(d<8 || (d>12 && d<14)){pixels[i]=148;pixels[i+1]=128;pixels[i+2]=255;pixels[i+3]=255;} }
    tray = new Tray(nativeImage.createFromBuffer(pixels, { width: 32, height: 32 })); tray.on('click', toggle); publish();
    if (process.argv.includes('--smoke-test')) {
      win.webContents.once('did-finish-load', async () => {
        await scan();
        const startsHidden = !win.isVisible();
        show();
        await new Promise(resolve => setTimeout(resolve, 400));
        const size = win.getBounds();
        win.blur();
        win.emit('blur');
        await new Promise(resolve => setTimeout(resolve, 400));
        const hidesOnBlur = !win.isVisible();
        const rendered = await win.webContents.executeJavaScript("({title:document.title,heading:document.querySelector('h1').textContent,bridge:typeof window.orbit.call,node:typeof require})");
        let lifecycle = false, discoveryUI = false, journalUI=false, cliReuse=false, standardUI=true;
        const smokeProject = { id: id(), name: 'Smoke test', directory: path.join(__dirname, '..'), services: [{ id: id(), name: 'Lifecycle', command: "Write-Output 'ORBIT_SMOKE'; Start-Sleep -Seconds 30", ports: [], directory: '', url: '' }] };
        config.projects.push(smokeProject);
        try {
          await refreshDiscovery(smokeProject, true); publish();
          await new Promise(resolve => setTimeout(resolve, 200));
          discoveryUI = await win.webContents.executeJavaScript(`(() => { const header = document.querySelector('[data-toggle="${smokeProject.id}"]'); header.click(); return document.querySelector('.card.expanded') !== null && document.querySelector('.discovery-details') !== null && document.querySelector('.command').textContent.includes('run'); })()`);
          await start(smokeProject.id, smokeProject.services[0].id);
          const processesBefore=owned.size;
          const reused=await bridgeAction({action:'start',project:smokeProject.id,service:smokeProject.services[0].id});
          cliReuse=reused.value.reused && processesBefore===owned.size;
          await new Promise(resolve => setTimeout(resolve, 1500));
          const started = serviceState(smokeProject, smokeProject.services[0]).managed;
          await stop(smokeProject.id, smokeProject.services[0].id);
          lifecycle = started && !serviceState(smokeProject, smokeProject.services[0]).managed && (logs.get(smokeProject.services[0].id) || '').includes('ORBIT_SMOKE');
          journalUI=journal.query({serviceId:smokeProject.services[0].id}).some(e=>e.message.includes('ORBIT_SMOKE')) && journal.query({serviceId:smokeProject.services[0].id}).some(e=>e.kind==='stop');
          await win.webContents.executeJavaScript("document.querySelector('[data-view=activity]').click()");
          await new Promise(resolve=>setTimeout(resolve,200));
          journalUI=journalUI && await win.webContents.executeJavaScript("document.querySelectorAll('.activity-entry').length > 0 && document.querySelector('.group-header') === null");
        } catch (error) { console.error(error.message); }
        if(process.env.DEV_ORBIT_SMOKE_PROJECT) {
          const standardProject={id:id(),name:'Standard integration',directory:process.env.DEV_ORBIT_SMOKE_PROJECT,services:[]};config.projects.push(standardProject);
          try {
            await scan();const resolved=servicesFor(standardProject);
            standardUI=resolved.some(s=>s.key==='postgres' && s.running && s.ports.includes(10054)) && !resolved.some(s=>s.name.includes('deploy'));
            await win.webContents.executeJavaScript("document.querySelector('[data-view=overview]').click()");
            await new Promise(resolve=>setTimeout(resolve,200));
            standardUI=standardUI && await win.webContents.executeJavaScript(`(() => {const header=document.querySelector('[data-toggle="${standardProject.id}"]');header.click();return header.closest('.card').textContent.includes('Datenbanken') && header.closest('.card').textContent.includes('Läuft · Docker');})()`);
          }catch(error){console.error(error.message);standardUI=false;}
          config.projects=config.projects.filter(p=>p.id!==standardProject.id);inventory=inventory.filter(p=>p.projectId!==standardProject.id);
        }
        config.projects = config.projects.filter(p => p.id !== smokeProject.id);
        inventory = inventory.filter(p => p.projectId !== smokeProject.id);
        const projectOnly = inventory.every(p => config.projects.some(project => project.id === p.projectId));
        console.log(JSON.stringify({ rendered, lifecycle, discoveryUI, journalUI, cliReuse, standardUI, startsHidden, hidesOnBlur, size, projectOnly, processes: inventory.length, scanError }));
        quitting = true; bridge?.close(); app.exit(scanError || !lifecycle || !discoveryUI || !journalUI || !cliReuse || !standardUI || !startsHidden || !hidesOnBlur || !projectOnly || rendered.bridge !== 'function' || rendered.node !== 'undefined' ? 1 : 0);
      });
    } else { scan(); setInterval(scan, 6000); }
  });
  app.on('before-quit', () => { quitting = true; bridge?.close(); });
}
