const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { discoverProject, resolveServices, portsIn, quote } = require('../src/discovery.cjs');
test('Discovery finds nested scripts, .NET profiles and Compose without executing code', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-discovery-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'apps','web'),{recursive:true});
  await fs.mkdir(path.join(root,'node_modules','ignored'),{recursive:true});
  await fs.mkdir(path.join(root,'api','Properties'),{recursive:true});
  await fs.writeFile(path.join(root,'apps','web','package.json'),JSON.stringify({packageManager:'pnpm@10.0.0',scripts:{dev:'vite --port 3020',build:'vite build',start:'vite preview',lint:'eslint .'}}));
  await fs.writeFile(path.join(root,'node_modules','ignored','package.json'),JSON.stringify({scripts:{dev:'should-not-run'}}));
  await fs.writeFile(path.join(root,'api','Api.csproj'),'<Project Sdk="Microsoft.NET.Sdk.Web"/>');
  await fs.writeFile(path.join(root,'api','Properties','launchSettings.json'),JSON.stringify({profiles:{http:{commandName:'Project',applicationUrl:'http://localhost:5080'},iis:{commandName:'IISExpress'}}}));
  await fs.writeFile(path.join(root,'compose.yaml'),'services:\n  db:\n    image: postgres:16\n    ports:\n      - "127.0.0.1:5433:5432"\n  cache:\n    image: redis:7\n    ports:\n      - target: 6379\n        published: 6380\n');
  const result = await discoverProject(root);
  assert.equal(result.services.length,5);
  assert.deepEqual(result.notes,[]);
  assert.equal(result.services.find(s=>s.script==='dev').command,"pnpm.cmd run 'dev'");
  assert.deepEqual(result.services.find(s=>s.script==='dev').ports,[3020]);
  assert.deepEqual(result.services.find(s=>s.composeService==='db').ports,[5433]);
  assert.deepEqual(result.services.find(s=>s.composeService==='cache').ports,[6380]);
  assert.equal(result.services.find(s=>s.type==='Backend' && !s.script).url,'http://localhost:5080');
  assert.deepEqual((await discoverProject(root)).services.map(s=>s.id),result.services.map(s=>s.id));
});
test('Invalid manifests do not prevent other folders from being discovered', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'orbit-invalid-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'package.json'),'{');
  const result = await discoverProject(root); assert.equal(result.services.length,0); assert.equal(result.notes.length,1);
});
const project = {id:'p',directory:'C:\\Repo',services:[]};
const candidate = {id:'dev',name:'dev',type:'Frontend',command:"npm.cmd run 'dev'",directory:'C:\\Repo\\web',ports:[],matchToken:'vite',script:'dev',autoDetected:true};
const process = {pid:20,created:'now',name:'node.exe',command:'node C:\\Repo\\web\\node_modules\\vite\\bin\\vite.js',projectId:'p',ports:[5173]};
test('Unique script match uses actual ports and produces a local frontend URL',()=>{
  const result = resolveServices(project,[candidate],[process]);
  assert.equal(result.length,1); assert.equal(result[0].running,true); assert.deepEqual(result[0].ports,[5173]); assert.equal(result[0].url,'http://localhost:5173');
});
test('Ambiguous script matches stay separate; ancestor script can disambiguate',()=>{
  const scripts = [candidate,{...candidate,id:'start',script:'start'}];
  let result = resolveServices(project,scripts,[process]);
  assert.equal(result.length,3); assert.equal(result.filter(s=>s.runtimeOnly).length,1); assert.equal(result.filter(s=>s.running&&!s.runtimeOnly).length,0);
  result = resolveServices(project,scripts,[{...process,launchScript:'dev'}]);
  assert.equal(result.length,2); assert.equal(result[0].running,true); assert.equal(result[1].running,false);
});
test('Manual overrides and excluded discoveries survive repeated detection',()=>{
  const edited = {...candidate,name:'My frontend',autoDetected:false};
  assert.equal(resolveServices({...project,services:[edited]},[candidate],[])[0].name,'My frontend');
  assert.equal(resolveServices({...project,ignoredDiscovery:['dev']},[candidate],[]).length,0);
});
test('Existing manually configured start scripts are enriched instead of duplicated',()=>{
  const configured = {...candidate,id:'manual',autoDetected:false,name:'Frontend',command:'npm.cmd run dev',matchToken:undefined};
  const result = resolveServices({...project,services:[configured]},[candidate],[process]);
  assert.equal(result.length,1); assert.equal(result[0].name,'Frontend'); assert.equal(result[0].running,true);
});
test('Other projects and shared Docker ports are never claimed as this service',()=>{
  const result = resolveServices(project,[{...candidate,composeService:'web',ports:[5173]}],[{...process,projectId:'other'}]);
  assert.equal(result[0].running,false); assert.equal(result.length,1);
});
test('PowerShell quoting and explicit port extraction',()=>{
  assert.equal(quote("a'b"),"'a''b'");
  assert.deepEqual(portsIn('PORT=3001 next dev --port 3002 -p 3003 --port 99999'),[3001,3002,3003]);
});
test('Python web entry points become launchable services without running Python',async t=>{
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'orbit-python-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'main.py'),'from fastapi import FastAPI\napp = FastAPI()\n');
  await fs.writeFile(path.join(root,'app.py'),'from flask import Flask\nserver = Flask(__name__)\n');
  await fs.writeFile(path.join(root,'manage.py'),'from django.core.management import execute_from_command_line\n');
  const result = await discoverProject(root);
  assert.equal(result.services.length,3);
  assert.ok(result.services.some(s=>s.command==='python.exe -m uvicorn main:app --reload'));
  assert.ok(result.services.some(s=>s.command==='python.exe -m flask --app app:server run'));
});
