const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let current = { projects: [], processes: [] }, view = 'overview', selected = null, editing = null, logService = null;
async function call(action, data) { const result = await window.orbit.call(action, data); if (!result.ok) throw new Error(result.error); return result.value; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; setTimeout(() => $('#toast').hidden = true, 5500); }
function button(label, action, attrs = '', disabled = false) { return `<button data-action="${action}" ${attrs} ${disabled ? 'disabled' : ''}>${label}</button>`; }
function render() {
  $('#projectNav').innerHTML = current.projects.map(p => `<button class="project-link ${selected === p.id ? 'selected' : ''}" data-project="${p.id}"><span class="dot ${p.services.some(s => s.running) ? '' : 'off'}"></span>${escape(p.name)}</button>`).join('');
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.view === view && !selected));
  $('#error').hidden = !current.scanError; $('#error').textContent = current.scanError || '';
  $('#scanTime').textContent = current.scannedAt ? 'Letzte Erkennung: ' + new Date(current.scannedAt).toLocaleTimeString('de-DE') + ' · alle 6 Sekunden' : 'Windows-Erkennung wird gestartet …';
  if (view === 'processes') return renderProcesses();
  if (view === 'settings') return renderSettings();
  const projects = selected ? current.projects.filter(p => p.id === selected) : current.projects;
  $('#heading').textContent = selected ? (projects[0]?.name || 'Projekt') : 'Dein Orbit im Überblick';
  $('#subtitle').textContent = selected ? 'Services, Git und lokale Entwicklung an einem Ort.' : 'Alle Projekte. Alle Services. Ein gemeinsamer Überblick.';
  const running = current.projects.flatMap(p => p.services).filter(s => s.running).length;
  const ports = new Set(current.processes.flatMap(p => p.ports)).size;
  const unassigned = current.processes.filter(p => !p.projectId).length;
  $('#content').innerHTML = `<div class="stats"><div class="stat"><span class="stat-label">◈ Projekte</span><strong>${current.projects.length}</strong><small>In deinem Workspace</small></div><div class="stat"><span class="stat-label">ϟ Laufende Services</span><strong>${running}</strong><small>Aus konfigurierten Services</small></div><div class="stat"><span class="stat-label">◎ Offene TCP-Ports</span><strong>${ports}</strong><small>Systemweit erkannt</small></div><div class="stat"><span class="stat-label">◇ Nicht zugeordnet</span><strong>${unassigned}</strong><small>Prozesse zur Prüfung</small></div></div><div class="section-title"><h2>${selected ? 'Projekt-Services' : 'Deine Projekte'}</h2><small>● Live-Status</small></div>` + (projects.length ? `<div class="projects">${projects.map(projectCard).join('')}</div>` : `<div class="empty"><div class="empty-icon">◎</div><h2>Ein neuer Orbit beginnt hier.</h2><p>Füge dein erstes lokales Projekt hinzu und definiere seine Services. Dev Orbit behält Prozesse, Ports und Git für dich im Blick.</p>${button('+ Erstes Projekt hinzufügen','newProject')}</div>`);
}
function projectCard(p) {
  return `<article class="card"><div class="card-head"><div class="project-icon">◈</div><div class="card-title"><h2>${escape(p.name)}</h2><div class="path" title="${escape(p.directory)}">${escape(p.directory)}</div></div><span class="badge ${p.services.some(s => s.running) ? '' : 'idle'}">${p.services.filter(s => s.running).length}/${p.services.length} aktiv</span></div>${p.services.map(s => `<div class="service"><div class="service-top"><span class="service-name"><span class="dot ${s.running ? '' : 'off'}"></span>${escape(s.name)}<span class="service-type">${escape(s.type)}</span></span><span class="badge ${s.running ? '' : 'idle'}">${s.running ? s.managed ? 'Läuft · Orbit' : 'Läuft · Extern' : 'Gestoppt'}</span></div><div class="service-meta"><span>${s.ports.length ? s.ports.map(n => ':' + n).join(' · ') : 'Kein Port konfiguriert'}</span>${s.pids.length ? `<span>PID ${s.pids.join(', ')}</span>` : ''}${s.url ? `<span>${escape(s.url)}</span>` : ''}</div><div class="command">${escape(s.command)}</div><div class="service-actions">${button('▶ Start','start',`data-p="${p.id}" data-s="${s.id}"`,s.running)}${button('↻ Restart','restart',`data-p="${p.id}" data-s="${s.id}"`,!s.managed)}${button('■ Stop','stop',`data-p="${p.id}" data-s="${s.id}"`,!s.managed)}${s.url ? button('↗ Öffnen','open',`data-url="${escape(s.url)}"`) : ''}${button('Logs','logs',`data-s="${s.id}"`)}${button('Bearbeiten','editService',`data-p="${p.id}" data-s="${s.id}"`,s.managed)}${button('×','deleteService',`data-p="${p.id}" data-s="${s.id}"`,s.managed)}</div></div>`).join('') || '<div class="service"><p>Noch keine Services. Füge Frontend, Backend oder Datenbank hinzu.</p></div>'}<div class="card-bottom"><span>⑂ ${escape(p.branch)}</span><div>${button('+ Service','newService',`data-p="${p.id}"`)}${button('•••','editProject',`data-p="${p.id}"`)}</div></div></article>`;
}
function renderProcesses() {
  $('#heading').textContent = 'Prozesse & Ports'; $('#subtitle').textContent = 'Auch Services aus Terminal, IDE und Coding-Agent werden hier sichtbar.';
  $('#content').innerHTML = `<div class="section-title"><h2>Windows-Prozessübersicht</h2><small>${current.processes.length} Prozesse · TCP Listener & zugeordnete Services</small></div><div class="table-wrap"><table><thead><tr><th>Prozess / PID</th><th>Ports</th><th>Projekt</th><th>Zuordnung</th><th>Aktion</th></tr></thead><tbody>${current.processes.map(p => `<tr><td><b>${escape(p.name)}</b> <span>${p.pid}</span><small title="${escape(p.command)}">${escape(p.command || 'Befehlszeile nicht zugänglich')}</small></td><td>${p.ports.join(', ') || '—'}</td><td>${escape(current.projects.find(x => x.id === p.projectId)?.name || 'Nicht zugeordnet')}</td><td><small>${escape(p.reason)}</small>${!p.managed ? `<select data-assign="${p.pid}"><option value="">Projekt zuweisen …</option>${current.projects.map(x => `<option value="${x.id}">${escape(x.name)}</option>`).join('')}</select>` : ''}</td><td>${!p.managed && p.ports.length ? button('Beenden …','kill',`data-pid="${p.pid}"`) : '—'}</td></tr>`).join('') || '<tr><td colspan="5">Noch keine Prozesse erkannt.</td></tr>'}</tbody></table></div><p>Port allein reicht nicht zur automatischen Projektzuordnung. Externe Prozesse werden nur nach Bestätigung beendet.</p>`;
}
function renderSettings() {
  $('#heading').textContent = 'Einstellungen'; $('#subtitle').textContent = 'Dein lokaler Begleiter, so wie du ihn brauchst.';
  $('#content').innerHTML = `<div class="card settings"><h2>Windows-Integration</h2><div class="settings-row"><div><b>Mit Windows starten</b><p>Dev Orbit beim Anmelden automatisch öffnen.</p></div><input type="checkbox" id="autoStart" ${current.autoStart ? 'checked' : ''}></div><div class="settings-row"><div><b>System-Tray</b><p>Das Schließen des Fensters minimiert die App in den Tray. Dort kannst du sie öffnen und vollständig beenden.</p></div></div><div class="settings-row"><div><b>Lokale Daten</b><p>Projektkonfiguration wird im Windows-Benutzerprofil gespeichert. Logs bleiben für diese App-Sitzung verfügbar. Gestartete Services laufen beim Beenden weiter.</p></div></div><p>Version 1.0 · Windows-first · Keine Cloud erforderlich</p></div>`;
}
function field(name, label, value = '', placeholder = '') { return `<label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" value="${escape(value)}" placeholder="${escape(placeholder)}">`; }
function editProject(project) {
  editing = { kind: 'project', id: project?.id }; $('#modalTitle').textContent = project ? 'Projekt bearbeiten' : 'Projekt hinzufügen';
  $('#fields').innerHTML = field('name','Projektname',project?.name,'Mein Projekt') + `<label>Projektverzeichnis</label><div class="field-row"><input name="directory" value="${escape(project?.directory || '')}" placeholder="C:\\Projects\\MeinProjekt"><button type="button" data-action="browse">Auswählen</button></div>` + (project ? `<p>${button('Projekt entfernen','deleteProject',`data-p="${project.id}"`)}</p>` : ''); openEditor();
}
function editService(projectId, service) {
  editing = { kind: 'service', projectId, id: service?.id }; $('#modalTitle').textContent = service ? 'Service bearbeiten' : 'Service hinzufügen';
  $('#fields').innerHTML = field('name','Servicename',service?.name,'Frontend') + `<label>Typ</label><select name="type">${['Frontend','Backend','Database','Worker','Custom'].map(type => `<option ${service?.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select>` + field('command','Startbefehl (PowerShell)',service?.command,'npm.cmd run dev') + field('stopCommand','Stopbefehl (optional, danach verbleibende Prozesse beenden)',service?.stopCommand) + field('directory','Arbeitsverzeichnis (leer = Projektverzeichnis)',service?.directory) + field('ports','Ports (durch Komma getrennt)',service?.ports.join(', '),'3000, 3001') + field('url','Lokale URL (optional)',service?.url,'http://localhost:3000') + '<p>Befehle werden mit deinen Windows-Benutzerrechten ausgeführt.</p>'; openEditor();
}
function openEditor() { $('#formError').textContent = ''; $('#editor').showModal(); }
document.addEventListener('click', async event => {
  const el = event.target.closest('button'); if (!el) return;
  if (el.dataset.view) { view = el.dataset.view; selected = null; render(); return; }
  if (el.dataset.project) { selected = el.dataset.project; view = 'overview'; render(); return; }
  const action = el.dataset.action; if (!action) return;
  try {
    const project = current.projects.find(p => p.id === el.dataset.p);
    const service = project?.services.find(s => s.id === el.dataset.s);
    if (action === 'newProject') return editProject();
    if (action === 'editProject') return editProject(project);
    if (action === 'newService') return editService(project.id);
    if (action === 'editService') return editService(project.id,service);
    if (action === 'browse') { const directory = await call('pickDirectory'); if (directory) $('#editForm [name=directory]').value = directory; return; }
    if (action === 'logs') { logService = el.dataset.s; $('#logsText').textContent = await call('logs',{serviceId:logService}); $('#logsModal').showModal(); return; }
    if (action === 'deleteProject') { if (!confirm('Projekt aus Dev Orbit entfernen? Die Projektdateien bleiben erhalten.')) return; await call(action,{id:project.id}); $('#editor').close(); selected = null; }
    else if (action === 'deleteService') { if (!confirm('Service-Konfiguration entfernen?')) return; await call(action,{projectId:project.id,serviceId:service.id}); }
    else { el.disabled = true; await call(action,{projectId:el.dataset.p,serviceId:el.dataset.s,url:el.dataset.url,pid:Number(el.dataset.pid)}); }
    current = await call('state'); render();
  } catch(error) { toast(error.message); } finally { if (el.isConnected) el.disabled = false; }
});
document.addEventListener('change', async event => { try { if (event.target.dataset.assign && event.target.value) await call('assign',{pid:Number(event.target.dataset.assign),projectId:event.target.value}); if (event.target.id === 'autoStart') await call('autoStart',{enabled:event.target.checked}); } catch(error) { toast(error.message); } });
$('#editForm').addEventListener('submit', async event => { event.preventDefault(); try { const data = Object.fromEntries(new FormData(event.target)); await call(editing.kind === 'project' ? 'saveProject' : 'saveService',{...data,id:editing.id,projectId:editing.projectId}); $('#editor').close(); current = await call('state'); render(); } catch(error) { $('#formError').textContent = error.message; } });
$('#addProject').onclick = $('#addProjectSmall').onclick = () => editProject();
$('#closeModal').onclick = $('#cancelModal').onclick = () => $('#editor').close();
$('#closeLogs').onclick = () => $('#logsModal').close();
$('#refreshLogs').onclick = async () => { try { $('#logsText').textContent = await call('logs',{serviceId:logService}); } catch(error) { toast(error.message); } };
$('#refresh').onclick = async () => { try { $('#refresh').disabled = true; await call('scan'); } catch(error) { toast(error.message); } finally { $('#refresh').disabled = false; } };
window.orbit.subscribe(data => { current = data; render(); });
call('state').then(data => { current = data; render(); }).catch(error => toast(error.message));
