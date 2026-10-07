const fs=require('node:fs');
const path=require('node:path');
const YAML=require('yaml');
const repo=path.resolve(__dirname,'..');
const target=process.argv[2];
const sourceProject=process.argv[3] || target;
if(!target || !sourceProject)throw Error('Ziel und OskarLab-Projekt angeben.');
const services={postgres:{group:'datenbank',composeFile:'backend/docker-compose.yml',composeService:'postgres'},backend:{group:'backend',directory:'backend',command:'.\\gradlew.bat bootRun',dependsOn:['postgres']}};
for(const directory of fs.readdirSync(path.join(sourceProject,'frontend/apps')).sort()) {
  const file=path.join(sourceProject,'frontend/apps',directory,'package.json');if(!fs.existsSync(file))continue;
  const pkg=JSON.parse(fs.readFileSync(file,'utf8'));if(!pkg.scripts?.dev)continue;
  services[directory]={group:'frontend',directory:'frontend/apps/'+directory,npmScript:'dev'};
}
function put(relative,content) {
  const file=path.join(target,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file) && fs.readFileSync(file).toString()!==content.toString())fs.copyFileSync(file,file+'.backup-'+Date.now());
  fs.writeFileSync(file,content);
}
put('dev.yaml','# Lokale Entwicklung. Vorhandene npm-/Gradle-/Compose-Befehle bleiben unverändert.\n'+YAML.stringify({version:1,project:'OskarLab',services}));
put('dev.cmd',fs.readFileSync(path.join(repo,'examples/OskarLab/dev.cmd')));
for(const file of ['dev-runner.cjs','dev-project.cjs'])put('scripts/'+file,fs.readFileSync(path.join(repo,'src',file)));
const vendor=path.join(target,'scripts/vendor/yaml');fs.mkdirSync(vendor,{recursive:true});
fs.cpSync(path.join(repo,'node_modules/yaml/dist'),path.join(vendor,'dist'),{recursive:true});
for(const file of ['package.json','LICENSE'])fs.copyFileSync(path.join(repo,'node_modules/yaml',file),path.join(vendor,file));
const ignore=path.join(target,'.gitignore');const text=fs.existsSync(ignore) ? fs.readFileSync(ignore,'utf8') : '';
if(!text.split(/\r?\n/).includes('/.dev/'))fs.writeFileSync(ignore,text+'\n# Lokale Prozesse und Logs des eigenständigen Projekt-Starters\n/.dev/\n*.backup-*\n');
const guidance=`# Lokaler Entwicklungsworkflow\n\nDienste über den eigenständigen Projekt-Starter starten: \`dev.cmd start <Dienst>\`.\nVorher \`dev.cmd status\` prüfen. Eine bereits laufende Instanz verwenden.\nLogs: \`dev.cmd logs <Dienst>\` oder mit \`--follow\`.\nNur eigene, registrierte Dienste oder eindeutig zugeordnete Docker-Container stoppen.\nDev Orbit und IntelliJ müssen dafür nicht geöffnet sein.\nBuilds und Tests weiter über die vorhandenen npm-/Gradle-Aufgaben ausführen.\nBei Änderungen in Unterordnern deren AGENTS.md beachten.\n`;
if(!fs.existsSync(path.join(target,'AGENTS.md')))put('AGENTS.md',guidance);
put('DEV-WORKFLOW.md',`# OskarLab lokal starten\n\nVoraussetzungen: Windows, Node.js, Java 21 für das Backend und Docker für PostgreSQL.\nDer YAML-Parser wird inklusive Lizenz mitgeliefert; Orbit ist nicht erforderlich.\n\nDoppelklick auf dev.cmd öffnet ein Menü. Im Terminal:\n\n~~~cmd\ndev.cmd status\ndev.cmd start cloth-lab\ndev.cmd start backend\ndev.cmd start\ndev.cmd logs cloth-lab --follow\ndev.cmd stop cloth-lab\n~~~\n\nIn IntelliJ eine Run-Konfiguration für denselben dev.cmd-Aufruf anlegen.\nCodex verwendet dieselben Befehle. Schließen der Log-Anzeige stoppt keinen Dienst.\n\nDie dev.yaml wählt ausschließlich lokale Dienste aus. Bestehende package.json- und Compose-Dateien bleiben die Quelle für Skripte und Ports.\nDer Starter übernimmt bereits laufende, anhand Projektpfad und Dienstmerkmal zuordenbare Prozesse, ohne sie neu zu starten. Ihre frühere Konsolenausgabe ist nicht verfügbar; dafür einmal bewusst über den ursprünglichen Startweg stoppen und über dev.cmd starten.\nUnbekannte Portbelegung verhindert einen neuen Start. Externe Prozesse werden vom Starter nicht beendet.\nRegistrierte Dienste laufen in einem eigenständigen Hintergrundprozess weiter und schreiben nach .dev/logs; PID plus Prozessstartzeit stehen in .dev/state.\nDocker-Dienste werden über Compose-Kennzeichnungen zugeordnet. Stoppen ist beim eigenen Prozessbaum zwangsweise; Docker verwendet docker stop.\n\nDas Skript bestätigt den Prozessstart, nicht automatisch die Betriebsbereitschaft oder Datenbankmigration. Fehlgeschlagene Starts und Exit-Codes stehen in den Logs.\n`);
console.log('Projektstandard eingerichtet: '+target);
