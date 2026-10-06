#!/usr/bin/env node
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {formatEntries}=require('./journal.cjs');
const args=process.argv.slice(2);
const action=args[0]; const follow=args.includes('--follow');
const positional=args.slice(1).filter(arg=>arg!=='--follow');
if(!['list','start','logs','stop'].includes(action)) {
 console.log('Dev Orbit muss im Tray laufen.\n\nnode orbit-cli.cjs list\nnode orbit-cli.cjs start "Projekt" "Service" --follow\nnode orbit-cli.cjs logs "Projekt" "Service" --follow\nnode orbit-cli.cjs stop "Projekt" "Service"\n\nstart nutzt eine bereits laufende Instanz. Ctrl+C beendet nur die Log-Anzeige.');process.exit(0);
}
let connection;
try {connection=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'dev-orbit','bridge.json'),'utf8'));}
catch {console.error('Dev Orbit ist nicht erreichbar. Bitte zuerst die App im Tray starten.');process.exit(1);}
const socket=net.createConnection(connection.address);let buffer='';socket.setEncoding('utf8');
socket.on('connect',()=>socket.write(JSON.stringify({...connection,action,project:positional[0],service:positional[1],follow})+'\n'));
socket.on('error',error=>{console.error('Verbindung zu Dev Orbit fehlgeschlagen: '+error.message);process.exitCode=1;});
socket.on('data',chunk=>{
 buffer+=chunk;let index;
 while((index=buffer.indexOf('\n'))>=0){
  const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
  const message=JSON.parse(line);
  if(message.ok===false){console.error(message.error);process.exitCode=1;}
  else if(message.event) console.log(formatEntries([message.event]));
  else if(message.value) console.log(typeof message.value==='string' ? message.value : JSON.stringify(message.value,null,2));
 }
});
process.on('SIGINT',()=>{socket.end();process.exit(0);});
