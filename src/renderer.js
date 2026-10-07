const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let current = { projects: [], processes: [] }, view = 'overview', selected = null, editing = null, logService = null;
const expanded = new Set();
const expandedGroups=new Set(), expandedApps=new Set();
let activityEntries=[], activityProject='', activityOutput=true;
async function call(action, data) { const result = await window.orbit.call(action, data); if (!result.ok) throw new Error(result.error); return result.value; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; setTimeout(() => $('#toast').hidden = true, 5500); }
function button(label, action, attrs = '', disabled = false) { return `<button data-action="${action}" ${attrs} ${disabled ? 'disabled' : ''}>${label}</button>`; }
function render() {
  $('#projectNav').innerHTML = current.projects.map(p => `<button class="project-link ${selected === p.id ? 'selected' : ''}" data-project="${p.id}"><span class="dot ${p.services.some(s => s.running) ? '' : 'off'}"></span>${escape(p.name)}</button>`).join('');
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.view === view && !selected));
  $('#error').hidden = !current.scanError; $('#error').textContent = current.scanError || '';
  $('#scanTime').textContent = current.scannedAt ? 'Letzte Erkennung: ' + new Date(current.scannedAt).toLocaleTimeString('de-DE') + ' · alle 6 Sekunden' : 'Windows-Erkennung wird gestartet …';
  if (view === 'processes') return renderProcesses();
  if (view === 'activity') return renderActivity();
  if (view === 'settings') return renderSettings();
  const projects = selected ? current.projects.filter(p => p.id === selected) : current.projects;
  $('#heading').textContent = selected ? (projects[0]?.name || 'Projekt') : 'Deine Projekte';
  $('#subtitle').textContent = 'Projekt aufklappen, Services steuern.';
  const containers=current.projects.flatMap(p=>p.services).filter(s=>s.projectStandard && s.composeFile && s.running);
  const running = current.processes.filter(p=>p.ports.length).length+containers.length;
  const ports = new Set(current.processes.flatMap(p => p.ports).concat(containers.flatMap(s=>s.ports))).size;
  $('#content').innerHTML = `<div class="stats"><div class="stat"><span class="stat-label">Projekte</span><strong>${current.projects.length}</strong></div><div class="stat"><span class="stat-label">Apps mit Ports</span><strong>${running}</strong></div><div class="stat"><span class="stat-label">Projekt-Ports</span><strong>${ports}</strong></div></div>` + (projects.length ? `<div class="projects">${projects.map(projectCard).join('')}</div>` : `<div class="empty"><div class="empty-icon">◎</div><h2>Dein erstes Projekt</h2><p>Wähle einen Projektordner und füge seine Services hinzu.</p>${button('+ Projekt hinzufügen','newProject')}</div>`);
  enhanceProjectCards(projects);
}
function enhanceProjectCards(projects) {
  document.querySelectorAll('.projects > .card').forEach((card, index) => {
    const project = projects[index];
    const listeners = project.services.some(s=>s.projectStandard) ? project.services.filter(s=>s.projectStandard && s.running).length : current.processes.filter(p=>p.projectId===project.id && p.ports.length).length;
    card.querySelector('.card-head > .badge').textContent = `${listeners} Apps aktiv`;
    card.querySelectorAll(':scope > .service').forEach((row, serviceIndex) => {
      const service = project.services[serviceIndex]; if (!service) return;
      row.querySelector('[data-action=start]').disabled = service.running || !service.command || service.startDisabled;
      if(service.projectStandard) {
        row.querySelector('[data-action=restart]').disabled=!service.running || (!service.registered && !service.composeFile);
        row.querySelector('[data-action=editService]').disabled=true;
        row.querySelector('[data-action=deleteService]').disabled=true;
        row.querySelector('.service-top > .badge').textContent=service.statusError ? 'Status unbekannt' : service.running ? service.composeFile ? 'Läuft · Docker' : service.registered ? 'Läuft · Projekt-Starter' : 'Läuft · Extern' : 'Gestoppt';
      }
      row.querySelector('[data-action=stop]').disabled = !service.running;
      if(service.projectStandard && !service.composeFile && !service.registered)row.querySelector('[data-action=stop]').disabled=true;
      if(service.statusError){const note=document.createElement('p');note.className='discovery-note';note.textContent=service.statusError;row.append(note);}
      row.querySelector('[data-action=deleteService]').disabled = service.managed || service.runtimeOnly || service.projectStandard;
      if (service.runtimeOnly) row.querySelector('[data-action=editService]').textContent = 'Start konfigurieren';
      if (service.autoDetected) row.querySelector('.service-type').textContent = 'Auto · ' + service.type;
      if (service.projectStandard) row.querySelector('.service-type').textContent = 'dev.yaml · ' + service.type;
      if (service.activeElsewhere) row.querySelector('.service-top > .badge').textContent = 'App bereits aktiv';
      if (service.duplicate) { const note = document.createElement('p'); note.className = 'discovery-note'; note.textContent = 'Mehrere Listener-Prozesse für diese App – mögliche Doppelstarts prüfen.'; row.append(note); }
      const command = row.querySelector('.command');
      command.textContent = service.command ? 'Start: ' + service.command : 'Startbefehl noch unbekannt';
      if (service.source || service.processCommand) {
        const details = document.createElement('details'); details.className = 'discovery-details';
        const summary = document.createElement('summary'); summary.textContent = service.runtimeOnly ? 'Prozessdetails' : 'Erkanntes Startskript';
        const text = document.createElement('div'); text.textContent = [service.scriptCommand, service.processCommand, service.source, service.directory].filter(Boolean).join('\n');
        details.append(summary, text); row.append(details);
      }
    });
    const rescan = document.createElement('button'); rescan.dataset.action = 'discover'; rescan.dataset.p = project.id; rescan.textContent = '↻ Erkennen'; rescan.title = 'Projektdateien erneut nach Services durchsuchen';
    card.querySelector('.card-bottom > div').prepend(rescan);
    for (const note of project.discoveryNotes || []) { const text = document.createElement('p'); text.className = 'discovery-note'; text.textContent = note; card.append(text); }
    const rows=new Map([...card.querySelectorAll(':scope > .service')].map((row,i)=>[project.services[i]?.id,row]));
    const bottom=card.querySelector('.card-bottom');
    for(const group of project.groups || []) {
      const section=document.createElement('section');section.className='service-group';
      const key=project.id+':'+group.name;
      const header=document.createElement('button');header.className='group-header';header.dataset.groupToggle=key;header.setAttribute('aria-expanded',expandedGroups.has(key));
      header.textContent=`${expandedGroups.has(key) ? '⌄' : '›'} ${group.name} · ${group.apps.filter(app=>app.services.some(s=>s.running)).length}/${group.apps.length} aktiv`;
      const unknown=group.apps.filter(app=>app.services.some(s=>s.statusError)).length;if(unknown)header.textContent+=' · '+unknown+' unbekannt';
      const contents=document.createElement('div');contents.hidden=!expandedGroups.has(key);
      for(const app of group.apps) {
        const appKey=key+':'+app.key;
        const wrapper=document.createElement('section');wrapper.className='app-section';
        const title=document.createElement('button');title.className='app-header';title.dataset.appToggle=appKey;title.setAttribute('aria-expanded',expandedApps.has(appKey));
        const active=app.services.find(s=>s.running && !s.activeElsewhere) || app.services.find(s=>s.running);
        title.textContent=`${expandedApps.has(appKey) ? '⌄' : '›'} ${active ? '●' : '○'} ${app.name}${active?.ports.length ? ' · :'+active.ports.join(', :') : ''}`;
        const scripts=document.createElement('div');scripts.hidden=!expandedApps.has(appKey);
        for(const service of app.services) {const row=rows.get(service.id);if(row)scripts.append(row);}
        wrapper.append(title,scripts);contents.append(wrapper);
      }
      section.append(header,contents);card.insertBefore(section,bottom);
    }
  });
}
async function loadActivity() {
  activityEntries=await call('activity',{projectId:activityProject || undefined,output:activityOutput});
  if(view==='activity') renderActivity();
}
function renderActivity() {
  $('#heading').textContent='Zentrales Protokoll';$('#subtitle').textContent='Aktionen, Prozesswechsel und erfasste Ausgabe.';
  $('#content').innerHTML=`<div class="activity-controls"><select id="activityProject"><option value="">Alle Projekte</option>${current.projects.map(p=>`<option value="${p.id}" ${p.id===activityProject ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select><label><input type="checkbox" id="activityOutput" ${activityOutput ? 'checked' : ''}> Konsole</label></div>${current.journalError ? `<p class="error">Protokoll konnte nicht gespeichert werden: ${escape(current.journalError)}</p>` : ''}<p class="activity-hint">Externe Aktionen werden beobachtet; deren Auslöser und Konsolenausgabe sind ohne gemeinsamen Startweg nicht bekannt.</p><div id="activityFeed">${activityEntries.slice().reverse().map(e=>`<article class="activity-entry"><div><time>${new Date(e.time).toLocaleString('de-DE')}</time><span>${escape(e.source || 'Dev Orbit')}${e.pid ? ' · PID '+e.pid : ''}</span></div><b>${escape(e.projectName || 'Dev Orbit')}${e.serviceName ? ' / '+escape(e.serviceName) : ''}</b><pre>${escape(e.message)}</pre></article>`).join('') || '<p>Noch keine Ereignisse aufgezeichnet.</p>'}</div>`;
}
function projectCard(p) {
  return `<article class="card ${expanded.has(p.id) ? 'expanded' : ''}"><div class="card-head" role="button" tabindex="0" data-toggle="${p.id}" aria-expanded="${expanded.has(p.id)}"><div class="project-icon">◈</div><div class="card-title"><h2>${escape(p.name)}</h2><div class="path" title="${escape(p.directory)}">${escape(p.directory)}</div></div><span class="badge ${p.services.some(s => s.running) ? '' : 'idle'}">${p.services.filter(s => s.running).length}/${p.services.length} aktiv</span><span class="chevron">${expanded.has(p.id) ? '⌄' : '›'}</span></div>${p.services.map(s => `<div class="service"><div class="service-top"><span class="service-name"><span class="dot ${s.running ? '' : 'off'}"></span>${escape(s.name)}<span class="service-type">${escape(s.type)}</span></span><span class="badge ${s.running ? '' : 'idle'}">${s.running ? s.managed ? 'Läuft · Orbit' : 'Läuft · Extern' : 'Gestoppt'}</span></div><div class="service-meta"><span>${s.ports.length ? s.ports.map(n => ':' + n).join(' · ') : 'Kein Port konfiguriert'}</span>${s.pids.length ? `<span>PID ${s.pids.join(', ')}</span>` : ''}${s.url ? `<span>${escape(s.url)}</span>` : ''}</div><div class="command">${escape(s.command)}</div><div class="service-actions">${button('▶ Start','start',`data-p="${p.id}" data-s="${s.id}"`,s.running)}${button('↻ Restart','restart',`data-p="${p.id}" data-s="${s.id}"`,!s.managed)}${button('■ Stop','stop',`data-p="${p.id}" data-s="${s.id}"`,!s.managed)}${s.url ? button('↗ Öffnen','open',`data-url="${escape(s.url)}"`) : ''}${button('Logs','logs',`data-s="${s.id}"`)}${button('Bearbeiten','editService',`data-p="${p.id}" data-s="${s.id}"`,s.managed)}${button('×','deleteService',`data-p="${p.id}" data-s="${s.id}"`,s.managed)}</div></div>`).join('') || '<div class="service"><p>Noch keine Services. Füge Frontend, Backend oder Datenbank hinzu.</p></div>'}<div class="card-bottom"><span>⑂ ${escape(p.branch)}</span><div>${button('+ Service','newService',`data-p="${p.id}"`)}${button('•••','editProject',`data-p="${p.id}"`)}</div></div></article>`;
}
function renderProcesses() {
  $('#heading').textContent = 'Projektprozesse'; $('#subtitle').textContent = 'Nur Prozesse deiner hinterlegten Projekte.';
  $('#content').innerHTML = `<div class="section-title"><h2>Prozesse & Ports</h2><small>${current.processes.length} zugeordnet</small></div><div class="table-wrap"><table><thead><tr><th>Prozess / PID</th><th>Ports</th><th>Projekt</th><th>Aktion</th></tr></thead><tbody>${current.processes.map(p => `<tr><td><b>${escape(p.name)}</b><small>PID ${p.pid}</small><small title="${escape(p.command)}">${escape(p.command || '')}</small></td><td>${p.ports.join(', ') || '—'}</td><td>${escape(current.projects.find(x => x.id === p.projectId)?.name)}</td><td>${!p.managed && p.ports.length ? button('Stop …','kill',`data-pid="${p.pid}"`) : '—'}</td></tr>`).join('') || '<tr><td colspan="4">Keine laufenden Projektprozesse erkannt.</td></tr>'}</tbody></table></div><p>Externe Projektprozesse werden erst nach Bestätigung beendet.</p>`;
}
function renderSettings() {
  $('#heading').textContent = 'Einstellungen'; $('#subtitle').textContent = 'Dein lokaler Begleiter, so wie du ihn brauchst.';
  $('#content').innerHTML = `<div class="card settings"><h2>Windows-Integration</h2><div class="settings-row"><div><b>Mit Windows starten</b><p>Dev Orbit beim Anmelden im System-Tray starten.</p></div><input type="checkbox" id="autoStart" ${current.autoStart ? 'checked' : ''}></div><div class="settings-row"><div><b>System-Tray</b><p>Klicke auf das Tray-Icon, um dieses Fenster zu öffnen. Ein Klick außerhalb blendet es aus. Rechtsklick auf das Icon bietet Beenden.</p></div></div><div class="settings-row"><div><b>Lokale Daten</b><p>Projektkonfiguration wird im Windows-Benutzerprofil gespeichert. Ereignisse und erfasste Konsolenausgabe werden dauerhaft und mit begrenzter Historie gespeichert. Gestartete Services laufen beim Beenden weiter.</p></div></div><p>Version 1.4 · Windows-first · Keine Cloud erforderlich</p></div>`;
}
function field(name, label, value = '', placeholder = '') { return `<label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" value="${escape(value)}" placeholder="${escape(placeholder)}">`; }
function editProject(project) {
  editing = { kind: 'project', id: project?.id }; $('#modalTitle').textContent = project ? 'Projekt bearbeiten' : 'Projekt hinzufügen';
  $('#fields').innerHTML = field('name','Projektname',project?.name,'Mein Projekt') + `<label>Projektverzeichnis</label><div class="field-row"><input name="directory" value="${escape(project?.directory || '')}" placeholder="C:\\Projects\\MeinProjekt"><button type="button" data-action="browse">Auswählen</button></div>` + (project ? `<p>${button('Projekt entfernen','deleteProject',`data-p="${project.id}"`)}</p>` : ''); openEditor();
}
function editService(projectId, service) {
  editing = { kind: 'service', projectId, id: service?.id }; $('#modalTitle').textContent = service ? 'Service bearbeiten' : 'Service hinzufügen';
  $('#fields').innerHTML = field('name','Servicename',service?.name,'Frontend') + `<label>Typ</label><select name="type">${['Frontend','Backend','Database','Worker','Launcher','Custom'].map(type => `<option ${service?.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select>` + field('command','Startbefehl (PowerShell)',service?.command,'npm.cmd run dev') + field('stopCommand','Stopbefehl (optional, danach verbleibende Prozesse beenden)',service?.stopCommand) + field('directory','Arbeitsverzeichnis (leer = Projektverzeichnis)',service?.directory) + field('ports','Ports (durch Komma getrennt)',(service?.configuredPorts || service?.ports)?.join(', '),'3000, 3001') + field('url','Lokale URL (optional)',service?.configuredUrl ?? service?.url,'http://localhost:3000') + '<p>Befehle werden mit deinen Windows-Benutzerrechten ausgeführt.</p>'; openEditor();
}
function openEditor() { $('#formError').textContent = ''; $('#editor').showModal(); }
document.addEventListener('click', async event => {
  const group=event.target.closest('[data-group-toggle]');if(group){const key=group.dataset.groupToggle;if(expandedGroups.has(key))expandedGroups.delete(key);else expandedGroups.add(key);render();return;}
  const app=event.target.closest('[data-app-toggle]');if(app){const key=app.dataset.appToggle;if(expandedApps.has(key))expandedApps.delete(key);else expandedApps.add(key);render();return;}
  const projectHeader = event.target.closest('[data-toggle]');
  if (projectHeader) { const id = projectHeader.dataset.toggle; if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); return; }
  const el = event.target.closest('button'); if (!el) return;
  if (el.dataset.view) { view = el.dataset.view; selected = null; render(); if(view==='activity') loadActivity().catch(error=>toast(error.message)); return; }
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
document.addEventListener('change',event=>{if(event.target.id==='activityProject'){activityProject=event.target.value;loadActivity().catch(error=>toast(error.message));}if(event.target.id==='activityOutput'){activityOutput=event.target.checked;loadActivity().catch(error=>toast(error.message));}});
$('#editForm').addEventListener('submit', async event => { event.preventDefault(); try { const data = Object.fromEntries(new FormData(event.target)); await call(editing.kind === 'project' ? 'saveProject' : 'saveService',{...data,id:editing.id,projectId:editing.projectId}); $('#editor').close(); current = await call('state'); render(); } catch(error) { $('#formError').textContent = error.message; } });
$('#addProject').onclick = $('#addProjectSmall').onclick = () => editProject();
$('#hidePanel').onclick = () => call('hide').catch(error => toast(error.message));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) call('hide').catch(error => toast(error.message));
  if (['Enter',' '].includes(event.key) && event.target.matches('[data-toggle]')) { event.preventDefault(); event.target.click(); }
});
$('#closeModal').onclick = $('#cancelModal').onclick = () => $('#editor').close();
$('#closeLogs').onclick = () => $('#logsModal').close();
$('#refreshLogs').onclick = async () => { try { $('#logsText').textContent = await call('logs',{serviceId:logService}); } catch(error) { toast(error.message); } };
$('#refresh').onclick = async () => { try { $('#refresh').disabled = true; await call('scan'); } catch(error) { toast(error.message); } finally { $('#refresh').disabled = false; } };
let logRefreshing=false;
async function refreshOpenLogs() {
  if(!$('#logsModal').open || !logService || logRefreshing)return;
  logRefreshing=true;const serviceId=logService;
  try{const text=await call('logs',{serviceId});if(serviceId===logService){const el=$('#logsText');const bottom=el.scrollHeight-el.scrollTop-el.clientHeight<30;el.textContent=text;if(bottom)el.scrollTop=el.scrollHeight;}}
  catch(error){toast(error.message);}finally{logRefreshing=false;}
}
window.orbit.subscribe(data => { current = data; render(); refreshOpenLogs(); });
let activityTimer;
window.orbit.onActivity(entry=>{
  if($('#logsModal').open && logService) {clearTimeout(activityTimer);activityTimer=setTimeout(refreshOpenLogs,200);}
  if(view==='activity' && (!activityProject || entry.projectId===activityProject) && (activityOutput || !['stdout','stderr'].includes(entry.kind))) {activityEntries.push(entry);activityEntries=activityEntries.slice(-500);renderActivity();}
});
call('state').then(data => { current = data; render(); }).catch(error => toast(error.message));
