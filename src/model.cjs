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
module.exports = { inside, associate };
