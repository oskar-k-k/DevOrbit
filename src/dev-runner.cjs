const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {loadProject,windowsInventory,sameProcess,localStatus,dockerInventory,dockerStatus,exec}=require('./dev-project.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const args=process.argv.slice(2);
const root=process.env.DEV_PROJECT_ROOT || path.resolve(__dirname,'..');
const standard=loadProject(root);
if(!standard) throw Error('Keine dev.yaml gefunden.');
const folder=path.join(root,'.dev');fs.mkdirSync(path.join(folder,'state'),{recursive:true});fs.mkdirSync(path.join(folder,'logs'),{recursive:true});
const stateFile=s=>path.join(folder,'state',s.key+'.json');
const logFile=s=>path.join(folder,'logs',s.key+'.log');
const lockDir=s=>path.join(folder,'state',s.key+'.lock');
function write(s,data) {const file=stateFile(s),temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,JSON.stringify(data,null,2));fs.renameSync(temp,file);}
function event(s,text) {fs.appendFileSync(logFile(s),`\n[${new Date().toISOString()}] ${text}\n`);}
async function status(s) {return s.composeFile ? dockerStatus(s,await dockerInventory()) : localStatus(standard,s,await windowsInventory());}
function print(s,result) {console.log(JSON.stringify({service:s.key,...result,log:logFile(s)},null,2));}
async function start(s,seen=new Set()) {
  if(seen.has(s.key)) throw Error('Zyklische Abhängigkeit: '+s.key);seen.add(s.key);
  for(const key of s.dependsOn) await start(standard.services.find(x=>x.key===key),new Set(seen));
  const before=await status(s);
  if(before.running) {console.log(s.key+': läuft bereits; vorhandene Instanz verwenden.');print(s,before);return;}
  try {fs.mkdirSync(lockDir(s));fs.writeFileSync(path.join(lockDir(s),'owner.json'),JSON.stringify({pid:process.pid,time:Date.now()}));}
  catch(error) {
    if(error.code!=='EEXIST') throw error;
    let owner;try{owner=JSON.parse(fs.readFileSync(path.join(lockDir(s),'owner.json'),'utf8'));}catch{}
    if(owner && Date.now()-owner.time>30000) {
      const all=await windowsInventory();
      if(!all.some(p=>p.pid===owner.pid)) {fs.rmSync(lockDir(s),{recursive:true,force:true});return start(s,new Set());}
    }
    for(let n=0;n<40;n++){await delay(500);const current=await status(s);if(current.running){print(s,current);return;}if(!fs.existsSync(lockDir(s)))return start(s,new Set());}
    throw Error('Start ist bereits aktiv oder der Dienst startet noch: '+s.key);
  }
  let workerSpawned=false;
  try {
    const current=await status(s);if(current.running){print(s,current);return;}
    if(s.composeFile) {
      event(s,'Docker-Start angefordert');
      const result=await exec('docker.exe',['compose','-f',s.composeFile,'up','-d',s.composeService],{windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
      event(s,result.stdout+result.stderr);print(s,await status(s));return;
    }
    const all=await windowsInventory();
    if(all.some(p=>s.ports.some(port=>p.ports.includes(port))))throw Error('Konfigurierter Port belegt; kein sicher zuordenbarer Projektprozess.');
    write(s,{service:s.key,phase:'starting',requestedAt:new Date().toISOString()});
    const child=spawn(process.execPath,[__filename,'_worker',s.key],{cwd:root,detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,DEV_PROJECT_ROOT:root}});child.unref();
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    fs.writeFileSync(path.join(lockDir(s),'owner.json'),JSON.stringify({pid:child.pid,time:Date.now()}));
    workerSpawned=true;
    for(let n=0;n<60;n++) {await delay(250);const saved=JSON.parse(fs.readFileSync(stateFile(s),'utf8'));if(saved.phase==='running'){print(s,await status(s));return;}if(saved.phase==='exited' || saved.phase==='error')throw Error('Dienst beendet: '+s.key+'; siehe '+logFile(s));}
    throw Error('Start läuft noch; siehe Status und Logs: '+s.key);
  } finally {
    let pending=false;try{pending=workerSpawned && JSON.parse(fs.readFileSync(stateFile(s),'utf8')).phase==='starting';}catch{}
    if(!pending)fs.rmSync(lockDir(s),{recursive:true,force:true});
  }
}
async function worker(s) {
  let record;event(s,'Start: '+s.rawCommand);
  const out=fs.openSync(logFile(s),'a');
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',s.rawCommand],{cwd:s.directory,windowsHide:true,stdio:['ignore',out,out]});fs.closeSync(out);
  let ended=false;
  child.on('error',error=>{ended=true;write(s,{...record,phase:'error',message:error.message});event(s,error.message);});
  child.on('exit',(code,signal)=>{ended=true;write(s,{...record,phase:'exited',code,signal,endedAt:new Date().toISOString()});event(s,'Beendet: Code '+code);});
  const all=await windowsInventory();const processInfo=all.find(p=>p.pid===child.pid);
  if(!ended && processInfo) {record={service:s.key,pid:child.pid,created:processInfo.created,supervisorPid:process.pid,phase:'running',startedAt:new Date().toISOString()};write(s,record);}
}
async function stop(s) {
  const current=await status(s);
  if(!current.running){console.log(s.key+': läuft nicht.');return;}
  if(s.composeFile) {for(const container of current.liveContainers)await exec('docker.exe',['stop',container],{windowsHide:true,timeout:30000});event(s,'Docker-Dienst gestoppt');return;}
  if(!current.registered)throw Error('Extern gestarteter Dienst wird wiederverwendet, aber nicht blind beendet. Zum Stoppen dessen ursprünglichen Startweg verwenden.');
  const all=await windowsInventory();if(!sameProcess(current.state,all))throw Error('Prozessidentität hat sich geändert.');
  event(s,'Stop über Projekt-Starter angefordert');await exec('taskkill.exe',['/PID',String(current.state.pid),'/T','/F'],{windowsHide:true,timeout:15000});
}
async function logs(s,follow) {
  if(s.composeFile){const current=await status(s);if(!current.containers.length)throw Error('Kein zugehöriger Container.');const child=spawn('docker.exe',['logs',...(follow ? ['--follow'] : []),'--tail','200',current.containers[0]],{stdio:'inherit'});await new Promise(resolve=>child.on('exit',code=>{process.exitCode=code || 0;resolve();}));return;}
  let offset=0;
  function show(){if(!fs.existsSync(logFile(s)))return;const content=fs.readFileSync(logFile(s));if(content.length<offset)offset=0;process.stdout.write(content.subarray(offset));offset=content.length;}
  show();if(follow){setInterval(show,500);console.log('\nCtrl+C beendet nur die Log-Anzeige.');}
}
async function main() {
  const action=args[0] || 'status', key=args[1];
  const service=standard.services.find(s=>s.key===key);
  if(key && !service)throw Error('Unbekannter Dienst: '+key);
  if(action==='_worker')return worker(service);
  if(action==='logs'){if(!service)throw Error('Dienst angeben.');return logs(service,args.includes('--follow'));}
  if(!['start','stop','status'].includes(action))throw Error('Aufrufe: start [Dienst], stop [Dienst], status [Dienst], logs Dienst [--follow]');
  const services=service ? [service] : action==='stop' ? [...standard.services].reverse() : standard.services;
  if(action==='status') {
    const all=await windowsInventory();let containers,dockerError;
    if(services.some(s=>s.composeFile)){try{containers=await dockerInventory();}catch(error){dockerError=error.message;}}
    for(const s of services)print(s,s.composeFile ? dockerError ? {running:null,statusError:dockerError} : dockerStatus(s,containers) : localStatus(standard,s,all));return;
  }
  for(const s of services)if(action==='start')await start(s);else if(action==='stop')await stop(s);else print(s,await status(s));
  if(action==='start' && args.includes('--follow')) {if(!service)throw Error('--follow benötigt einen einzelnen Dienst.');await logs(service,true);}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
