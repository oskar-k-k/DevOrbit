const path = require('node:path');
function inside(command, directory) {
  if (!command || !directory) return false;
  const normalized = command.replaceAll('/', '\\').toLowerCase();
  const root = path.win32.resolve(directory).replace(/\\+$/, '').toLowerCase();
  let offset = normalized.indexOf(root);
  while (offset !== -1) {
    const before = normalized[offset - 1];
    const after = normalized[offset + root.length];
    if ((!before || /[\s"'=]/.test(before)) && (!after || /[\\\s"']/.test(after))) return true;
    offset = normalized.indexOf(root, offset + 1);
  }
  return false;
}
function associate(processes, projects, owned) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  return processes.map(p => {
    let ancestor = p; const seen = new Set();
    while (ancestor && !seen.has(ancestor.pid)) {
      seen.add(ancestor.pid);
      const entry = owned.get(ancestor.pid);
      if (entry) return { ...p, projectId: entry.projectId, serviceId: entry.serviceId, managed: true, reason: 'Von Dev Orbit gestartet' };
      ancestor = byPid.get(ancestor.parentPid);
    }
    const matches = projects.filter(project => inside(p.command, project.directory));
    return { ...p, projectId: matches.length === 1 ? matches[0].id : null, managed: false, reason: matches.length === 1 ? 'Projektpfad in Befehlszeile' : 'Keine eindeutige Zuordnung' };
  });
}
function annotateLineage(processes, all) {
  const byPid = new Map(all.map(p=>[p.pid,p]));
  return processes.map(p=>{
    const launchScripts = [], ancestorPids = [], seen = new Set();
    let current = p;
    while(current && !seen.has(current.pid) && seen.size < 32) {
      seen.add(current.pid);
      if(current.pid !== p.pid) ancestorPids.push(current.pid);
      if(/npm-cli|pnpm|yarn|bun/i.test(current.command || '')) {
        const script = current.command.match(/\b(?:run|run-script)\s+["']?([\w:-]+)/i)?.[1];
        if(script) launchScripts.push(script);
      }
      current = byPid.get(current.parentPid);
    }
    return {...p,launchScript:launchScripts[0],launchScripts,ancestorPids};
  });
}
module.exports = { inside, associate, annotateLineage };
