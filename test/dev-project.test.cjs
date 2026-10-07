const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {loadProject,localStatus,dockerStatus}=require('../src/dev-project.cjs');
const {discoverProject}=require('../src/discovery.cjs');
test('Explicit project standard replaces broad discovery and references existing npm scripts',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-standard-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'web'));fs.writeFileSync(path.join(root,'web/package.json'),JSON.stringify({scripts:{dev:'next dev --port 3021',start:'next start --port 3021'}}));
  fs.writeFileSync(path.join(root,'dev.yaml'),'version: 1\nproject: Test\nservices:\n  web:\n    group: frontend\n    directory: web\n    npmScript: dev\n');
  const config=loadProject(root);assert.equal(config.services.length,1);assert.deepEqual(config.services[0].ports,[3021]);
  const other=path.join(root,'other');fs.mkdirSync(other);fs.mkdirSync(path.join(other,'web'));fs.copyFileSync(path.join(root,'web/package.json'),path.join(other,'web/package.json'));fs.copyFileSync(path.join(root,'dev.yaml'),path.join(other,'dev.yaml'));assert.notEqual(loadProject(other).services[0].id,config.services[0].id);
  const discovered=await discoverProject(root);assert.equal(discovered.services.length,1);assert.equal(discovered.standard,true);
  fs.writeFileSync(path.join(root,'dev.yaml'),'version: 1\nservices:\n  web:\n    directory: ../outside\n    command: node app.js\n');assert.throws(()=>loadProject(root),/im Projekt/);
});
test('Registered process requires matching creation time and includes child ports',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-state-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'.dev/state'),{recursive:true});fs.writeFileSync(path.join(root,'.dev/state/web.json'),JSON.stringify({pid:10,created:'a'}));
  const service={key:'web',directory:root,ports:[]};
  const all=[{pid:10,created:'a',ports:[],parentPid:0},{pid:11,created:'b',parentPid:10,ports:[3000]}];
  assert.deepEqual(localStatus({root},service,all).ports,[3000]);assert.equal(localStatus({root},service,all).registered,true);
  all[0].created='reused';assert.equal(localStatus({root},service,all).running,false);
});
test('Docker status uses Compose identity and actual published ports',()=>{
  const service={composeFile:'C:\\work\\backend\\compose.yml',composeService:'postgres',composeProject:'work'};
  const container={Id:'db',Config:{Labels:{'com.docker.compose.service':'postgres','com.docker.compose.project.config_files':'C:/work/backend/compose.yml'}},State:{Running:true},NetworkSettings:{Ports:{'5432/tcp':[{HostPort:'10054'}]}}};
  assert.deepEqual(dockerStatus(service,[container]).ports,[10054]);assert.equal(dockerStatus(service,[container]).running,true);
  container.Config.Labels['com.docker.compose.project.config_files']='C:/work/deploy/compose.yml';assert.equal(dockerStatus(service,[container]).running,false);
});
