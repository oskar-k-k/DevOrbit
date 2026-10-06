const path=require('node:path');
function hierarchy(project) {
 const groups=new Map();
 for(const service of project.services) {
  const relative=path.win32.relative(project.directory,service.directory || project.directory).replaceAll('\\','/');
  const evidence=(relative+' '+(service.source || '')+' '+(service.processCommand || '')).replaceAll('\\','/').toLowerCase();
  const group=service.type==='Database' ? 'Datenbanken' : /(?:^|[\s/])frontend(?:\/|\s|$)/.test(evidence) || service.type==='Frontend' ? 'Frontend' : /(?:^|[\s/])backend(?:\/|\s|$)/.test(evidence) || service.type==='Backend' ? 'Backend' : 'Weitere Dienste';
  const parts=relative.split('/').filter(Boolean); const appIndex=parts.indexOf('apps');
  const launcher=service.launcher || service.type==='Launcher';
  const name=launcher ? 'Workspace starten' : appIndex>=0 && parts[appIndex+1] ? parts[appIndex+1] : service.runtimeOnly || service.composeService || service.type==='Database' ? service.name : parts.length ? parts.at(-1) : service.name.split(' · ')[0];
  const key=launcher ? 'launcher:'+relative : service.runtimeOnly || service.composeService || service.type==='Database' ? service.id : relative || service.id;
  if(!groups.has(group)) groups.set(group,new Map());
  const apps=groups.get(group);if(!apps.has(key)) apps.set(key,{key,name,services:[]});apps.get(key).services.push(service);
 }
 return ['Frontend','Backend','Datenbanken','Weitere Dienste'].filter(name=>groups.has(name)).map(name=>({name,apps:[...groups.get(name).values()]}));
}
module.exports={hierarchy};
