const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { inside } = require('./model.cjs');
const { loadProject } = require('./dev-project.cjs');
const ignored = new Set(['node_modules', '.git', '.dev', '.venv', 'venv', 'dist', 'dist-tray', 'dist-auto', 'dist-fixed', 'dist-journal', 'dist-standard', 'build', 'target', 'bin', 'obj', '.next', '.idea', '.codex', '.smoke-profile', 'vendor', 'coverage']);
const quote = text => "'" + String(text).replaceAll("'", "''") + "'";
const stableId = (directory, key) => 'auto-' + crypto.createHash('sha256').update(path.resolve(directory).toLowerCase() + ':' + key).digest('hex').slice(0, 20);
function portsIn(command) {
  const matches = [...String(command).matchAll(/(?:--port(?:=|\s+)|(?:^|\s)-p\s+|\bPORT=)(\d{2,5})\b/g)];
  return [...new Set(matches.map(m => Number(m[1])).filter(n => n > 0 && n < 65536))];
}
function inferType(command) { return /vite|next|react-scripts|astro|nuxt|webpack|ng serve/i.test(command) ? 'Frontend' : /postgres|mysql|redis|mongo/i.test(command) ? 'Database' : 'Backend'; }
function fingerprint(command) {
  const tools = ['vite', 'next', 'react-scripts', 'astro', 'nuxt', 'webpack', 'uvicorn', 'flask', 'nodemon'];
  const known = tools.find(tool => new RegExp(`\\b${tool}\\b`, 'i').test(command));
  if (known) return known;
  const script = command.match(/(?:node|tsx|ts-node|python(?:3)?)\s+(?:-[^\s]+\s+)*["']?([^\s"']+\.(?:[cm]?js|ts|py))\b/i);
  return script ? script[1].replaceAll('\\', '/').toLowerCase() : null;
}
async function discoverProject(directory) {
  try { const standard=loadProject(directory); if(standard) return {services:standard.services,notes:['Projektstandard: '+standard.file],standard:true,scannedAt:Date.now()}; }
  catch(error) {return {services:[],notes:['Projektstandard ungültig: '+error.message],standard:true,scannedAt:Date.now()};}
  const services = [], notes = []; let visited = 0;
  async function read(file) { const stat = await fs.stat(file); if (stat.size > 1024 * 1024) throw new Error('Datei zu groß'); return fs.readFile(file, 'utf8'); }
  async function walk(folder, depth) {
    if (depth > 6 || visited++ >= 1200) return;
    let entries; try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { notes.push('Ordner nicht lesbar: ' + path.relative(directory, folder)); return; }
    const names = new Set(entries.map(e => e.name));
    const relative = path.relative(directory, folder).replaceAll('\\', '/');
    const displayName = suffix => (relative ? relative + ' · ' : '') + suffix;
    if (names.has('package.json')) {
      try {
        const pkg = JSON.parse(await read(path.join(folder, 'package.json')));
        const manager = /^(pnpm|yarn|bun)@/.exec(pkg.packageManager || '')?.[1] || (names.has('pnpm-lock.yaml') ? 'pnpm' : names.has('yarn.lock') ? 'yarn' : names.has('bun.lock') || names.has('bun.lockb') ? 'bun' : 'npm');
        for (const [script, command] of Object.entries(pkg.scripts || {})) {
          if (!/^(?:dev|start|serve|watch|preview)(?::[\w-]+)*$/.test(script) || typeof command !== 'string') continue;
          const ports = portsIn(command);
          const launcher = !!pkg.workspaces && !/vite|next|react-scripts|astro|nuxt|webpack|ng serve/i.test(command);
          services.push({ id: stableId(folder, 'npm:' + script), name: displayName(script), type: launcher ? 'Launcher' : inferType(command), launcher, command: `${manager === 'bun' ? 'bun.exe' : manager + '.cmd'} run ${quote(script)}`, script, scriptCommand: command, matchToken: fingerprint(command), directory: folder, ports, url: '', source: path.join(folder, 'package.json'), autoDetected: true });
        }
      } catch { notes.push('package.json konnte nicht gelesen werden: ' + (relative || '.')); }
    }
    for (const entry of entries.filter(e => e.isFile() && e.name.endsWith('.csproj'))) {
      try {
        const file = path.join(folder, entry.name); const contents = await read(file);
        if (!/Microsoft\.NET\.Sdk\.Web|<OutputType>\s*Exe\s*<\/OutputType>/i.test(contents)) continue;
        let profiles = {};
        try { profiles = JSON.parse(await read(path.join(folder, 'Properties', 'launchSettings.json'))).profiles || {}; } catch { /* Optional. */ }
        const usable = Object.entries(profiles).filter(([, p]) => p.commandName === 'Project');
        for (const [profile, settings] of usable.length ? usable : [['', {}]]) {
          const urls = String(settings.applicationUrl || '').split(';');
          const ports = urls.map(url => { try { return Number(new URL(url).port); } catch { return 0; } }).filter(n => n > 0 && n < 65536);
          services.push({ id: stableId(folder, `dotnet:${entry.name}:${profile}`), name: displayName(path.basename(entry.name, '.csproj') + (profile ? ' · ' + profile : '')), type: 'Backend', command: `dotnet.exe run --project ${quote(entry.name)}${profile ? ' --launch-profile ' + quote(profile) : ''}`, directory: folder, ports, url: urls.find(u => /^http:\/\/localhost:\d+$/.test(u)) || '', source: file, autoDetected: true, matchToken: path.basename(entry.name, '.csproj').toLowerCase() });
        }
      } catch { notes.push('.NET-Projekt konnte nicht gelesen werden: ' + entry.name); }
    }
    const compose = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find(name => names.has(name));
    if (compose) {
      try {
        const file = path.join(folder, compose);
        const parsed = YAML.parse(await read(file), { maxAliasCount: 20 });
        for (const [name, definition] of Object.entries(parsed?.services || {})) {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) continue;
          const ports = (definition?.ports || []).map(port => {
            if (typeof port === 'object' && port) return Number(port.published);
            const text = String(port).replace(/\/(tcp|udp)$/, '');
            const parts = text.split(':'); return parts.length >= 2 ? Number(parts.at(-2)) : 0;
          }).filter(n => Number.isInteger(n) && n > 0 && n < 65536);
          services.push({ id: stableId(folder, 'compose:' + name), name: displayName(name), type: inferType(String(definition?.image || name)), command: `docker.exe compose -f ${quote(compose)} up ${quote(name)}`, stopCommand: `docker.exe compose -f ${quote(compose)} stop ${quote(name)}`, directory: folder, ports, url: '', source: file, autoDetected: true, composeService: name });
        }
      } catch { notes.push('Compose-Datei konnte nicht gelesen werden: ' + displayName(compose)); }
    }
    const python = await fs.access(path.join(folder, '.venv', 'Scripts', 'python.exe')).then(() => '& ' + quote(path.join(folder, '.venv', 'Scripts', 'python.exe'))).catch(() => 'python.exe');
    if (names.has('manage.py')) {
      try {
        if ((await read(path.join(folder, 'manage.py'))).includes('execute_from_command_line')) services.push({ id: stableId(folder,'django'), name: displayName('Django'), type: 'Backend', command: `${python} manage.py runserver`, directory: folder, ports: [], url: '', source: path.join(folder,'manage.py'), autoDetected: true, matchToken: 'manage.py' });
      } catch { /* Optional Python entry point. */ }
    }
    for (const file of ['main.py','app.py'].filter(name => names.has(name))) {
      try {
        const text = await read(path.join(folder,file));
        const fastApi = text.match(/^([A-Za-z_]\w*)\s*=\s*FastAPI\(/m);
        const flask = text.match(/^([A-Za-z_]\w*)\s*=\s*Flask\(/m);
        const module = path.basename(file,'.py');
        if (fastApi || flask) services.push({ id: stableId(folder,'python:' + file), name: displayName(fastApi ? 'FastAPI' : 'Flask'), type: 'Backend', command: fastApi ? `${python} -m uvicorn ${module}:${fastApi[1]} --reload` : `${python} -m flask --app ${module}:${flask[1]} run`, directory: folder, ports: [], url: '', source: path.join(folder,file), autoDetected: true, matchToken: fastApi ? `${module}:${fastApi[1]}` : 'flask' });
      } catch { /* Optional Python entry point. */ }
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !ignored.has(entry.name.toLowerCase())) await walk(path.join(folder, entry.name), depth + 1);
  }
  await walk(directory, 0);
  if (visited >= 1200) notes.push('Ordnersuche auf 1200 Verzeichnisse begrenzt.');
  return { services, notes, scannedAt: Date.now() };
}
function matchScore(service, process, project) {
  if (process.projectId !== project.id || service.composeService) return 0;
  const directory = service.directory || project.directory;
  const directoryMatch = inside(process.command, directory);
  const specificity = path.win32.resolve(directory).split(/[\\/]/).length;
  // Once project ownership is established, an app's explicit port is stronger
  // evidence than an ancestor's generic `npm run dev` launcher.
  if ((service.ports || []).some(port => process.ports.includes(port))) return 1000 + specificity + (service.script && service.script === process.launchScript ? 20 : 0);
  if (process.serviceId === service.id) return 50 + specificity;
  if (!directoryMatch) return 0;
  const scriptMatch = service.script && process.launchScript === service.script;
  if (service.script && process.launchScript && !scriptMatch) return 0;
  const command = (process.command || '').replaceAll('\\', '/').toLowerCase();
  if (service.matchToken && command.includes(service.matchToken.toLowerCase())) return 100 + specificity * 10;
  return scriptMatch ? 60 + specificity * 10 : 0;
}
function resolveServices(project, discovered, inventory, owned = new Map()) {
  const manual = project.services || [];
  const excluded = new Set(project.ignoredDiscovery || []);
  const normalize = command => String(command || '').replace(/["']/g, '').replace(/\b(npm|pnpm|yarn)\.cmd\b/gi, '$1').replace(/\s+/g,' ').trim();
  const sameCommand = (a,b) => normalize(a.command) === normalize(b.command) && path.win32.resolve(a.directory || project.directory).toLowerCase() === path.win32.resolve(b.directory || project.directory).toLowerCase();
  const combined = new Map(discovered.filter(s => !excluded.has(s.id) && !manual.some(m => m.id !== s.id && sameCommand(m,s))).map(s => [s.id, s]));
  for (const s of manual) {
    const original = discovered.find(candidate => candidate.id === s.id || sameCommand(candidate,s));
    combined.set(s.id, { ...original, ...s, matchToken: s.matchToken || original?.matchToken, script: s.script || original?.script, autoDetected: false });
  }
  const services = [...combined.values()];
  const processMatches = new Map();
  for (const p of inventory.filter(p => p.projectId === project.id)) {
    const scores = services.map(s => ({id:s.id,score:matchScore(s,p,project)})).filter(s=>s.score>0);
    const highest = Math.max(0,...scores.map(s=>s.score));
    const matches = scores.filter(s=>s.score===highest);
    if (matches.length === 1) processMatches.set(p.pid, matches[0].id);
  }
  const result = services.map(s => {
    const entries = [...owned.values()].filter(v => v.serviceId === s.id);
    const aliases = new Set(services.filter(other => other.id !== s.id && path.win32.resolve(other.directory || project.directory).toLowerCase() === path.win32.resolve(s.directory || project.directory).toLowerCase() && ((s.ports || []).some(port => (other.ports || []).includes(port)) || (s.scriptCommand && normalize(s.scriptCommand) === normalize(other.scriptCommand)))).map(other=>other.id));
    const directIds = new Set([s.id,...aliases]);
    const found = inventory.filter(p => p.projectId === project.id && (directIds.has(processMatches.get(p.pid)) || directIds.has(p.serviceId) || (p.ancestorPids || []).some(pid=>directIds.has(processMatches.get(pid))) || (!s.matchToken && s.script && (p.launchScripts || [p.launchScript]).includes(s.script) && inside(p.command,s.directory || project.directory))));
    const actualPorts = [...new Set(found.flatMap(p => p.ports))];
    const ports = actualPorts.length ? actualPorts : s.ports;
    const duplicatePids = found.filter(p => p.ports.length && processMatches.get(p.pid) === s.id).map(p=>p.pid);
    return { ...s, ports, configuredPorts: s.ports, configuredUrl: s.url, running: !!entries.length || !!found.length, managed: !!entries.length, activeElsewhere: !entries.length && found.length > 0 && !found.some(p=>processMatches.get(p.pid)===s.id), duplicate: duplicatePids.length > 1, pids: [...new Set(found.map(p=>p.pid).concat(entries.map(v=>v.child.pid)))], url: s.url || (['Frontend','Backend'].includes(s.type) && actualPorts.length ? 'http://localhost:' + actualPorts[0] : '') };
  });
  for (const p of inventory.filter(p => p.projectId === project.id && p.ports.length && !processMatches.has(p.pid))) {
    result.push({ id: 'live-' + p.pid + '-' + p.created, name: `${p.name} · :${p.ports.join(', :')}`, type: 'Erkannt', command: '', processCommand: p.command || '', directory: project.directory, ports: p.ports, url: '', running: true, managed: false, pids: [p.pid], runtimeOnly: true, autoDetected: true, source: 'Laufender Projektprozess' });
  }
  return result;
}
function startConflict(service, services, inventory) {
  if (service.running) return `Service läuft bereits (PID ${(service.pids || []).join(', ')}).`;
  const pendingAlias = services.find(s => s.id !== service.id && s.running && path.win32.resolve(s.directory || '').toLowerCase() === path.win32.resolve(service.directory || '').toLowerCase() && ((service.configuredPorts || service.ports || []).some(port => (s.configuredPorts || s.ports || []).includes(port)) || (service.scriptCommand && service.scriptCommand === s.scriptCommand) || (service.matchToken && service.matchToken === s.matchToken)));
  if (pendingAlias) return `Start verhindert: ${pendingAlias.name} ist für diese App bereits aktiv oder startet gerade.`;
  const occupied = inventory.filter(p => (service.configuredPorts || service.ports || []).some(port => p.ports.includes(port)));
  if (occupied.length) return `Start verhindert: Port bereits belegt (PID ${occupied.map(p=>p.pid).join(', ')}).`;
  // Starting a project-wide launcher while one of its child apps is already up
  // would relaunch those children, even if the launcher itself has exited.
  if (service.script && (service.launcher || !service.matchToken)) {
    const running = services.filter(s => s.id !== service.id && s.running && inside('"' + (s.directory || '') + '"',service.directory));
    if (running.length) return `Start verhindert: ${running.map(s=>s.name).join(', ')} läuft bereits. Starte nur die fehlenden Apps einzeln.`;
  }
  return null;
}
module.exports = { discoverProject, resolveServices, portsIn, quote, startConflict };
