# OskarLab lokal starten

Voraussetzungen: Windows, Node.js, Java 21 für das Backend und Docker für PostgreSQL.
Der YAML-Parser wird inklusive Lizenz mitgeliefert; Orbit ist nicht erforderlich.

Doppelklick auf dev.cmd öffnet ein Menü. Im Terminal:

~~~cmd
dev.cmd status
dev.cmd start cloth-lab
dev.cmd start backend
dev.cmd start
dev.cmd logs cloth-lab --follow
dev.cmd stop cloth-lab
~~~

In IntelliJ eine Run-Konfiguration für denselben dev.cmd-Aufruf anlegen.
Codex verwendet dieselben Befehle. Schließen der Log-Anzeige stoppt keinen Dienst.

Die dev.yaml wählt ausschließlich lokale Dienste aus. Bestehende package.json- und Compose-Dateien bleiben die Quelle für Skripte und Ports.
Der Starter übernimmt bereits laufende, anhand Projektpfad und Dienstmerkmal zuordenbare Prozesse, ohne sie neu zu starten. Ihre frühere Konsolenausgabe ist nicht verfügbar; dafür einmal bewusst über den ursprünglichen Startweg stoppen und über dev.cmd starten.
Unbekannte Portbelegung verhindert einen neuen Start. Externe Prozesse werden vom Starter nicht beendet.
Registrierte Dienste laufen in einem eigenständigen Hintergrundprozess weiter und schreiben nach .dev/logs; PID plus Prozessstartzeit stehen in .dev/state.
Docker-Dienste werden über Compose-Kennzeichnungen zugeordnet. Stoppen ist beim eigenen Prozessbaum zwangsweise; Docker verwendet docker stop.

Das Skript bestätigt den Prozessstart, nicht automatisch die Betriebsbereitschaft oder Datenbankmigration. Fehlgeschlagene Starts und Exit-Codes stehen in den Logs.
