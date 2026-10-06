const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Journal,formatEntries}=require('../src/journal.cjs');
function fixture(t,options) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-journal-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return new Journal(path.join(dir,'activity.jsonl'),options); }
test('Action and console history survives a restart and supports service aliases',t=>{
 const log=fixture(t); log.add({projectId:'p',serviceIds:['dev','start'],kind:'stop',message:'Cloth stopped'}); log.add({projectId:'p',serviceId:'dev',kind:'stdout',message:'Ready'});
 const restored=new Journal(log.file); assert.equal(restored.query({serviceId:'start'}).length,1); assert.equal(restored.query({serviceId:'dev'}).length,2); assert.equal(restored.query({output:false}).length,1);
 assert.ok(formatEntries(restored.query()).includes('Cloth stopped'));
});
test('External process observation reports exits, port changes and PID reuse without inventing actor',t=>{
 const log=fixture(t); const p={pid:1,created:'old',ports:[10032],projectId:'p'}; const context=p=>({projectId:p.projectId});
 log.observe([p],[p],context); log.observe([p],[p],context); assert.equal(log.entries.length,1);
 log.observe([{...p,ports:[10033]}],[p],context); assert.equal(log.entries.at(-1).kind,'ports');
 log.observe([{...p,created:'new'}],[{...p,created:'new'}],context);
 assert.equal(log.entries.at(-1).kind,'disappeared'); assert.ok(log.entries.at(-1).message.includes('nicht bestimmbar'));
});
test('Journal rotates bounded history and tolerates an incomplete final line',t=>{
 const log=fixture(t,{maxBytes:500}); for(let i=0;i<10;i++) log.add({kind:'stdout',message:'x'.repeat(100)});
 assert.ok(fs.existsSync(log.file+'.1')); fs.appendFileSync(log.file,'{broken'); const restored=new Journal(log.file); assert.ok(restored.entries.length>0);
});
