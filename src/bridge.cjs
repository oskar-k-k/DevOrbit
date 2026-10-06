const net=require('node:net');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
function createBridge({directory,journal,execute}) {
 const token=crypto.randomBytes(32).toString('hex');
 const address='\\\\.\\pipe\\dev-orbit-'+crypto.createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0,20);
 const metadata=path.join(directory,'bridge.json');
 const sockets=new Set();
 const server=net.createServer(socket=>{
  sockets.add(socket); socket.setEncoding('utf8'); let buffer='',unsubscribe,subscribed=false;
  const send=data=>{if(!socket.destroyed) {if(socket.writableLength>1024*1024) socket.destroy(); else socket.write(JSON.stringify(data)+'\n');}};
  socket.on('error',()=>{}); socket.on('close',()=>{sockets.delete(socket);if(unsubscribe)journal.listeners.delete(unsubscribe);});
  socket.on('data',chunk=>{
   buffer+=chunk; if(buffer.length>65536){socket.destroy();return;}
   let index;
   while((index=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
    (async()=>{
     const request=JSON.parse(line);
     if(typeof request.token!=='string' || request.token.length!==token.length || !crypto.timingSafeEqual(Buffer.from(request.token),Buffer.from(token))) throw Error('CLI nicht autorisiert.');
     if(subscribed) throw Error('Pro Verbindung nur ein Aufruf.'); subscribed=true;
     const result=await execute(request);
     send({ok:true,value:result.value});
     if(request.follow && result.filter) {
      const filter=result.filter;
      unsubscribe=entry=>{if(entry.projectId===filter.projectId && (!filter.serviceId || entry.serviceId===filter.serviceId || (entry.serviceIds || []).includes(filter.serviceId))) send({event:entry});};
      journal.listeners.add(unsubscribe);
      for(const entry of journal.query({...filter,limit:200})) send({event:entry});
     } else socket.end();
    })().catch(error=>{send({ok:false,error:error.message});socket.end();});
   }
  });
 });
 server.on('error',error=>journal.add({kind:'error',source:'Dev Orbit',message:'CLI-Verbindung konnte nicht geöffnet werden: '+error.message}));
 server.listen(address,()=>fs.writeFileSync(metadata,JSON.stringify({address,token}),{mode:0o600}));
 return {close:()=>{for(const socket of sockets)socket.destroy();server.close();try{fs.unlinkSync(metadata);}catch{}}};
}
module.exports={createBridge};
