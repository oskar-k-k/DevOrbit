function panelBounds(workArea) {
  const width = Math.min(440, workArea.width - 16);
  const height = Math.min(640, workArea.height - 16);
  return { width, height, x: workArea.x + workArea.width - width - 8, y: workArea.y + workArea.height - height - 8 };
}
function projectProcesses(processes, projects, assignments = {}) {
  const known = new Set(projects.map(p => p.id));
  return processes.map(p => {
    const manual = assignments[String(p.pid)];
    return manual && manual.created === p.created && known.has(manual.projectId)
      ? { ...p, projectId: manual.projectId, reason: 'Manuell zugewiesen' } : p;
  }).filter(p => known.has(p.projectId));
}
module.exports = { panelBounds, projectProcesses };
