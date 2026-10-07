const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
let YAML; try { YAML=require('./vendor/yaml'); } catch { YAML=require('yaml'); }
const quote = value => "'"+String(value).replaceAll("'","''")+"'";
function loadProject(root) {
  const file=['dev.yaml','dev.yml'].map(name=>path.join(root,name)).find(fs.existsSync);
  if(!file) return null;
  const config=YAML.parse(fs.readFileSync(file,'utf8'),{maxAliasCount:20});
  if(config?.version!==1 || !config.services || typeof config.services!=='object') throw Error('dev.yaml benötigt version: 1 und services.');
  const projectKey=crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0,12);
  const services=Object.entries(config.services).map(([key,value])=>{
    if(!/^[a-zA-Z0-9][\w-]*$/.test(key) || !value || typeof value!=='object') throw Error('Ungültiger Dienst: '+key);
    const directory=path.resolve(root,value.directory || '.');
    const contained=location=>{const rel=path.relative(root,location);return !rel.startsWith('..') && !path.isAbsolute(rel);};
    if(!contained(directory)) throw Error('Dienstverzeichnis muss im Projekt liegen: '+key);
    let rawCommand=value.command, ports=[], scriptCommand, matchToken;
    if(value.npmScript) {
      const pkg=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
      scriptCommand=pkg.scripts?.[value.npmScript];
      if(!scriptCommand) throw Error('npm-Skript fehlt: '+key);
      rawCommand='npm.cmd run '+quote(value.npmScript);
      ports=[...scriptCommand.matchAll(/--port(?:=|\s+)(\d+)/g)].map(m=>Number(m[1]));
      matchToken=/next/i.test(scriptCommand) ? 'next' : /vite/i.test(scriptCommand) ? 'vite' : null;
    }
    let composeFile,composeProject;
    if(value.composeFile) {
      composeFile=path.resolve(root,value.composeFile);
      if(!contained(composeFile)) throw Error('Compose-Datei muss im Projekt liegen.');
      const compose=YAML.parse(fs.readFileSync(composeFile,'utf8'),{maxAliasCount:20});
      const definition=compose.services?.[value.composeService];
      if(!definition) throw Error('Compose-Dienst fehlt: '+key);
      composeProject=compose.name;
      ports=(definition.ports || []).map(p=>typeof p==='object' ? Number(p.published) : Number(String(p).replace(/\/(tcp|udp)$/,'').split(':').at(-2))).filter(Boolean);
    } else if(!rawCommand || typeof rawCommand!=='string') throw Error('Startbefehl fehlt: '+key);
    if(!ports.length) {
      const properties=path.join(directory,'src/main/resources/application.properties');
      if(fs.existsSync(properties)) {
        const text=fs.readFileSync(properties,'utf8');
        const match=text.match(/^server\.port\s*=\s*(?:\$\{([\w]+):)?(\d+)/m);
        if(match) ports=[Number((match[1] && process.env[match[1]]) || match[2])];
      }
    }
    const type=value.group==='frontend' ? 'Frontend' : value.group==='datenbank' ? 'Database' : 'Backend';
    return {key,id:'dev-'+projectKey+'-'+key,name:value.name || key,type,group:value.group || 'backend',directory,rawCommand,script:value.npmScript,scriptCommand,matchToken,ports,url:'',composeFile,composeProject,composeService:value.composeService,dependsOn:value.dependsOn || [],source:file,projectStandard:true,
      command:`node ${quote(path.join(root,'scripts/dev-runner.cjs'))} start ${quote(key)}`};
  });
  for(const service of services) for(const dependency of service.dependsOn) if(!services.some(s=>s.key===dependency)) throw Error('Unbekannte Abhängigkeit: '+dependency);
  return {root,file,name:config.project || path.basename(root),services};
}
async function windowsInventory() {
  const script="$ErrorActionPreference='Stop'; $ports=@{}; Get-NetTCPConnection -State Listen | ForEach-Object { $k=[string]$_.OwningProcess; if(!$ports.ContainsKey($k)){$ports[$k]=@()}; $ports[$k]+=$_.LocalPort }; $items=@(Get-CimInstance Win32_Process | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;command=$_.CommandLine;created=$_.CreationDate.ToUniversalTime().ToString('o');ports=@($ports[[string]$_.ProcessId] | Sort-Object -Unique)}}); ConvertTo-Json -InputObject $items -Depth 4 -Compress";
  const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:20000,maxBuffer:16*1024*1024});
  return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
}
function sameProcess(record,all) {return all.find(p=>p.pid===record?.pid && p.created===record.created);}
function readState(project,service) {try{return JSON.parse(fs.readFileSync(path.join(project.root,'.dev/state',service.key+'.json'),'utf8'));}catch{return null;}}
function tree(root,all) {const ids=new Set([root]);let changed=true;while(changed){changed=false;for(const p of all)if(ids.has(p.parentPid) && !ids.has(p.pid)){ids.add(p.pid);changed=true;}}return all.filter(p=>ids.has(p.pid));}
function normalized(value) {return String(value || '').replaceAll('\\','/').toLowerCase();}
function pathIn(command,directory) {
  const text=normalized(command),root=normalized(directory).replace(/\/$/,'');let index=text.indexOf(root);
  while(index>=0){const before=text[index-1],after=text[index+root.length];if((!before || /[\s"'=]/.test(before)) && (!after || /[\/\s"']/.test(after)))return true;index=text.indexOf(root,index+1);}return false;
}
function localStatus(project,service,all) {
  const saved=readState(project,service);
  if(sameProcess(saved,all)) {const processes=tree(saved.pid,all);return {running:true,registered:true,pids:processes.map(p=>p.pid),ports:[...new Set(processes.flatMap(p=>p.ports))],state:saved};}
  const matches=all.filter(p=>pathIn(p.command,project.root) && ((service.ports.length && service.ports.some(port=>p.ports.includes(port))) || (service.matchToken && pathIn(p.command,service.directory) && normalized(p.command).includes(service.matchToken))));
  return {running:matches.length>0,registered:false,duplicate:matches.filter(p=>p.ports.length).length>1,pids:matches.map(p=>p.pid),ports:[...new Set(matches.flatMap(p=>p.ports))],state:saved};
}
function matchingContainers(service,containers) {
  return containers.filter(c=>{
    const labels=c.Config?.Labels || {};
    if(labels['com.docker.compose.service']!==service.composeService) return false;
    const files=labels['com.docker.compose.project.config_files'];
    if(files) return files.split(',').some(file=>normalized(file.trim())===normalized(service.composeFile));
    return !!service.composeProject && labels['com.docker.compose.project']===service.composeProject;
  });
}
async function dockerInventory() {
  const options={windowsHide:true,timeout:12000,maxBuffer:8*1024*1024};
  const list=await exec('docker.exe',['ps','-aq'],options);const ids=list.stdout.trim().split(/\s+/).filter(Boolean);
  if(!ids.length) return [];
  const result=await exec('docker.exe',['inspect',...ids],options);return JSON.parse(result.stdout);
}
function dockerStatus(service,containers) {
  const matches=matchingContainers(service,containers);const live=matches.filter(c=>c.State?.Running);
  return {running:live.length>0,pids:[],ports:[...new Set(live.flatMap(c=>Object.values(c.NetworkSettings?.Ports || {}).flatMap(bindings=>(bindings || []).map(b=>Number(b.HostPort)))))],containers:matches.map(c=>c.Id),liveContainers:live.map(c=>c.Id),registered:false};
}
module.exports={loadProject,windowsInventory,sameProcess,readState,tree,localStatus,dockerInventory,dockerStatus,matchingContainers,quote,exec};
