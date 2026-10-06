const {test} = require('node:test');
const assert = require('node:assert/strict');
const {resolveServices,startConflict} = require('../src/discovery.cjs');
test('OskarLab shared Next.js launcher: app cards and script aliases all show their running instance',()=>{
  const dir = 'C:\\OskarLab\\frontend';
  const project = {id:'p',directory:'C:\\OskarLab',services:[]};
  const root = {id:'root',directory:dir,name:'dev',script:'dev',scriptCommand:'node scripts/dev.mjs',command:'npm.cmd run dev',matchToken:'scripts/dev.mjs',ports:[],type:'Backend'};
  const leaf = {id:'leaf',directory:dir+'\\apps\\2d-lab',name:'2d-lab',script:'dev',scriptCommand:'next dev --port 10038',command:'npm.cmd run dev',matchToken:'next',ports:[10038],type:'Frontend'};
  const services = [root,{...root,id:'root-alias',script:'dev:app'},leaf,{...leaf,id:'leaf-start',script:'start',scriptCommand:'next start --port 10038'},{...leaf,id:'other',directory:dir+'\\apps\\chess',ports:[10039]}];
  const inventory = [{pid:1,projectId:'p',ports:[],command:'node "'+dir+'\\scripts\\dev.mjs"',launchScript:'dev'}, {pid:2,projectId:'p',ports:[],command:'node "'+dir+'\\node_modules\\next\\dist\\bin\\next" dev --port 10038',launchScript:'dev',ancestorPids:[1]}, {pid:3,projectId:'p',name:'node.exe',ports:[10038],command:'node "'+dir+'\\node_modules\\next\\dist\\server\\lib\\start-server.js"',launchScript:'dev',ancestorPids:[2,1]}];
  const result = resolveServices(project,services,inventory);
  for(const id of ['root','root-alias','leaf','leaf-start']) assert.equal(result.find(s=>s.id===id).running,true,id);
  assert.equal(result.find(s=>s.id==='other').running,false);
  assert.deepEqual(result.find(s=>s.id==='leaf').ports,[10038]);
  assert.ok(result.find(s=>s.id==='leaf').pids.includes(3));
  for(const id of ['root','root-alias','leaf','leaf-start']) assert.ok(startConflict(result.find(s=>s.id===id),result,inventory));
});
