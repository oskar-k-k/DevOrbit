const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const net=require('node:net');
const {createBridge}=require('../src/bridge.cjs');const {Journal}=require('../src/journal.cjs');
test('CLI bridge requires the local token and streams the same journal events',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-bridge-'));
 const journal=new Journal(path.join(directory,'activity.jsonl'));let calls=0;
 const bridge=createBridge({directory,journal,execute:async()=>{calls++;return{value:'same process',filter:{projectId:'p',serviceId:'s'}};}});
 t.after(()=>{bridge.close();fs.rmSync(directory,{recursive:true,force:true});});
 const file=path.join(directory,'bridge.json');for(let i=0;i<100&&!fs.existsSync(file);i++)await new Promise(resolve=>setTimeout(resolve,10));
 const metadata=JSON.parse(fs.readFileSync(file,'utf8'));
 const rejected=await new Promise((resolve,reject)=>{const socket=net.createConnection(metadata.address);socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({token:'wrong',action:'start'})+'\n'));socket.on('data',chunk=>resolve(JSON.parse(chunk.toString().trim())));});
 assert.equal(rejected.ok,false);assert.equal(calls,0);
 await new Promise((resolve,reject)=>{const socket=net.createConnection(metadata.address);let buffer='';socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({token:metadata.token,action:'start',follow:true})+'\n'));socket.on('data',chunk=>{buffer+=chunk.toString();let i;while((i=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(message.ok)journal.add({projectId:'p',serviceId:'s',kind:'stdout',message:'same output'});if(message.event){assert.equal(message.event.message,'same output');socket.destroy();resolve();}}});});
 assert.equal(calls,1);
});
