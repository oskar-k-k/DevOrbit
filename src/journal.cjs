const fs = require('node:fs');
const crypto = require('node:crypto');
class Journal {
  constructor(file, {maxBytes = 4 * 1024 * 1024} = {}) {
    this.file = file; this.maxBytes = maxBytes; this.entries = []; this.previous = new Map(); this.initialized = false; this.listeners = new Set(); this.error = null;
    for (const candidate of [file + '.1', file]) {
      try { for (const line of fs.readFileSync(candidate,'utf8').split('\n')) { try { const entry = JSON.parse(line); if (entry.id && entry.time && typeof entry.message === 'string') this.entries.push(entry); } catch { /* Incomplete last write. */ } } } catch { /* First launch. */ }
    }
    this.entries = this.entries.slice(-3000);
    try { this.bytes = fs.statSync(file).size; } catch { this.bytes = 0; }
  }
  add(data) {
    const entry = {...data,id:crypto.randomUUID(),time:new Date().toISOString(),message:String(data.message || '').slice(0,16000)};
    this.entries.push(entry); if(this.entries.length>3000) this.entries.shift();
    const line = JSON.stringify(entry)+'\n';
    try {
      if(this.bytes + Buffer.byteLength(line)>this.maxBytes) { if(fs.existsSync(this.file+'.1')) fs.unlinkSync(this.file+'.1'); if(fs.existsSync(this.file)) fs.renameSync(this.file,this.file+'.1'); this.bytes=0; }
      fs.appendFileSync(this.file,line); this.bytes+=Buffer.byteLength(line); this.error=null;
    } catch(error) { this.error=error.message; }
    for(const listener of this.listeners) listener(entry);
    return entry;
  }
  query({projectId,serviceId,output=true,limit=500}={}) {
    return this.entries.filter(e=>(!projectId || e.projectId===projectId) && (!serviceId || e.serviceId===serviceId || (e.serviceIds || []).includes(serviceId)) && (output || !['stdout','stderr'].includes(e.kind))).slice(-Math.min(1000,limit));
  }
  observe(processes, all, context) {
    const next = new Map(processes.filter(p=>p.ports.length || p.managed).map(p=>[p.pid+':'+p.created,p]));
    const alive = new Set(all.map(p=>p.pid+':'+p.created));
    for(const [key,p] of next) {
      const previous = this.previous.get(key);
      const data = context(p);
      if(!previous) this.add({...data,kind:'observed',source:'Windows',pid:p.pid,ports:p.ports,message:this.initialized ? 'Laufender Projektprozess neu erkannt' : 'Bereits laufender Projektprozess erkannt'});
      else if(p.ports.slice().sort().join(',')!==previous.ports.slice().sort().join(',')) this.add({...data,kind:'ports',source:'Windows',pid:p.pid,ports:p.ports,message:`Ports geändert: ${previous.ports.join(', ') || 'keine'} → ${p.ports.join(', ') || 'keine'}`});
    }
    for(const [key,p] of this.previous) if(!next.has(key)) this.add({...p.observedContext,kind:'disappeared',source:'Windows',pid:p.pid,ports:p.ports,message:alive.has(key) ? 'Prozess läuft noch, wird aber nicht mehr als aktiver Projektservice erkannt' : 'Prozess beendet / nicht mehr vorhanden; Auslöser extern nicht bestimmbar'});
    this.previous=new Map([...next].map(([key,p])=>[key,{...p,observedContext:context(p)}])); this.initialized=true;
  }
}
function formatEntries(entries) {
  return entries.map(e=>`[${new Date(e.time).toLocaleString('de-DE')}] ${e.projectName || 'Dev Orbit'}${e.serviceName ? ' / '+e.serviceName : ''} · ${e.source || 'Dev Orbit'}${e.pid ? ' · PID '+e.pid : ''}${e.ports?.length ? ' · :'+e.ports.join(', :') : ''}\n${e.message}`).join('\n\n');
}
module.exports={Journal,formatEntries};
