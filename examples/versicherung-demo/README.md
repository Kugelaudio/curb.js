# Versicherung-Demo - Nora

Der Demo-Agent: deutschsprachiger Kundenservice einer Sachversicherung. Er ist
klein genug, um vollständig gezeigt zu werden, und deckt trotzdem die drei
Punkte ab, die curb von einer Konfigurationsplattform unterscheiden.

Zehn Fähigkeiten, drei Ebenen tief, ein gemeinsamer Zustand, ein Ablauf, vier
Sparten hinter einer einzigen Sperre, und eine Fähigkeit, die vor der
Verifizierung gar nicht existiert. Jedes Gespräch beginnt auf der Agentenebene,
`src/agent/agent.tsx`: Prompt mit Begrüßung, `<Skills>`-Index und das
Rückruf-Werkzeug. Jede Fähigkeit kommt erst dazu, wenn das Gespräch sie braucht.

```
/ablauf                    Sofortmaßnahmen (Procedure, drei Schritte)
/schaden                   "Schaden melden" - Verteilstelle über die Sparten
/schaden/sach              Gebäude & Hausrat   ┐
/schaden/kfz               Kfz                 │ vier Sparten, eigene Felder,
/schaden/haftpflicht       Haftpflicht         │ EINE gemeinsame Sperre
/schaden/rechtsschutz      Rechtsschutz        ┘
/vertrag                   Leistungen aus Markdown
/vertrag/selbstbeteiligung Unterfähigkeit
/kundenkonto               Verifizierung - schaltet Inhalte UND eine Fähigkeit frei
/kundenkonto/prioritaet    Gesperrte Fähigkeit, vorher nicht auffindbar
```

Zehn Fähigkeiten, aber nur vier im globalen `<Skills>`-Index: die vier Sparten
werden aus `/schaden` heraus verlinkt, die Unterfähigkeiten aus ihrer jeweiligen
Elternfähigkeit. Nur Routen der obersten Ebene gehören in den globalen Index,
sonst erscheinen sie in der Übersicht doppelt.

Der Ablauf liegt deshalb bewusst auf oberster Ebene und nicht unter `/schaden`:
das Modell muss ihn direkt von der Agentenebene aus erreichen können.

## Starten

```bash
npm install            # einmalig im Repo-Root (curb.js/)
cd examples/versicherung-demo
npm run dev            # Vorschau auf http://127.0.0.1:4000
```

Für **Sprache** braucht die Demo Schlüssel in `.env`: `AZURE_SPEECH_KEY` und
`KUGELAUDIO_API_KEY`. `AZURE_SPEECH_REGION` ist optional und standardmäßig
`eastus`. Ohne die Schlüssel startet alles normal und der Textchat funktioniert -
nur der Sprachteil ist aus. Vor dem Termin einrichten und einmal durchsprechen.

---

## Der Ablauf im Termin

Vorher offen haben: die Vorschau, daneben `src/agent/claim-intake.tsx`.
Die **Kontext-Ansicht** links ist der Star. Sie zeigt, was das Modell in diesem
Zug tatsächlich bekommen hat, Werkzeugliste inklusive.

### Beat 1 - Der Agent weiß nur, was er gerade wissen soll (2 min)

> "Ich möchte einen Wasserschaden melden."

Der Agent lädt `read_skill` still nach. **In der Kontext-Ansicht zeigen:**
vorher stand da nur die Agentenebene, jetzt die Sofortmaßnahmen. Der Agent ist nicht
mit allem gestartet, er hat sich geholt, was das Thema braucht.

Satz dazu: *"Er hätte auch vierzig Themen können. Im Kontext steht trotzdem
nur das eine."*

### Beat 2 - Die Regel, an der das Modell nicht vorbeikommt (4 min) **Kernstück**

> "Können Sie das direkt aufnehmen? Ich habe es eilig."

Der Agent nimmt nicht auf. **Jetzt die Werkzeugliste zeigen:**
`sachschaden_aufnehmen` ist **nicht da**. Nicht verboten - nicht vorhanden.

Dann `src/agent/claim-intake.tsx` daneben legen, die eine Verzweigung:

```tsx
if (!ablaufAbgeschlossen) return <Text>gesperrt …</Text>;
return <Tool name={name} schema={schema} … />;
```

Ablauf durchsprechen (drei Schritte), dann erneut in die Werkzeugliste: das
Werkzeug ist **jetzt da**.

Satz dazu: *"Auf einer Konfigurationsplattform sind das vier aufeinander
abgestimmte Artefakte: eine Zuweisung aus der Werkzeug-Antwort, eine dynamische
Variable, eine Kantenbedingung, ein eigener Knoten. Hier ist es ein Ternary.
Und eine zweite Bedingung wäre ein `&&`."*

### Beat 2b - Dieselbe Sperre, vier Sparten, eine Datei (2 min)

Direkt im Anschluss, ohne den Kontext zu wechseln:

> "Ach, und mein Auto hat auch was abbekommen."

Der Agent wechselt in die Sparte Kfz. Andere Felder - Kennzeichen, Hergang,
Gegenseite, Polizei - aber **dieselbe Sperre**, und sie ist bereits offen, weil
der Ablauf durch ist.

Dann `src/agent/claim-intake.tsx` zeigen. Die Regel steht dort **einmal**.
Vier Sparten benutzen sie, und die Checkliste kommt aus einer Datei, die für
alle gilt.

Satz dazu: *"Eine fünfte Sparte ist eine Datei mit einem eigenen Schema. Sie
steht automatisch hinter derselben Regel - niemand muss daran denken. Im
Graphen wäre jede Sparte ein eigener Zweig, und die Regel würde pro Zweig neu
verdrahtet. Vier Zweige heißt vier Gelegenheiten, sie zu vergessen."*

### Beat 3 - Eine Fähigkeit, die es für das Modell nicht gibt (3 min)

> "Ich hätte gern meine Vertragsdaten."

Gesperrt. Verifizieren mit **K-100200** und **1985**. Danach:

- die Vertragsdaten stehen im Kontext (aus `context/kundenkonto/freigeschaltet.md`),
- und ein Link auf `/kundenkonto/prioritaet` ist aufgetaucht.

Satz dazu: *"Vor der Verifizierung wusste das Modell nicht, dass es die
bevorzugte Bearbeitung gibt. Es hat sie nicht abgelehnt. Sie war nicht da. Für
eine Datenschutzprüfung ist das ein anderer Satz."*

### Beat 4 - Fachinhalte ändern, während telefoniert wird (2 min)

Im laufenden Gespräch `context/vertrag/leistungen.md` öffnen, eine Leistung
ändern oder ergänzen, speichern. Dann fragen:

> "Ist Starkregen mitversichert?"

Die Antwort nutzt den neuen Stand. Kein Build, keine neue Version, kein
Deployment.

Satz dazu: *"Das pflegt die Fachabteilung, nicht die IT."*

### Beat 5 - Optional, wenn technisch gefragt wird (2 min)

Die Sperre aus Beat 2 ist ein gewöhnlicher Unit-Test: Baum bei einem Zustand
rendern, `compileSite` aufrufen, prüfen dass `sachschaden_aufnehmen` in
`context.tools` fehlt bzw. vorhanden ist. Deterministisch, ohne Modell, ohne
Kosten, in der CI.

Satz dazu: *"Die entsprechende Prüfung auf einer Konfigurationsplattform
braucht ein Modell im Test - und kann die Werkzeugliste gar nicht einsehen."*

---

## Was ehrlich gesagt werden sollte

Pre-Alpha. Einmal am Anfang sagen, dann nicht mehr entschuldigen. Was fehlt:

- Transkripte in der gehosteten Variante (Konsument des Runner-Streams ist
  noch nicht verdrahtet)
- Telefonie-Breite: SIP steht, die Carrier-Anbindung ist in Arbeit
- Wissensdatenbank mit Retrieval gibt es nicht; `<Text src>` lädt ganze Dateien
- Ein `<Gate>`-Baustein ist in `authoring.md` beschrieben, existiert aber nicht.
  Sperren sind if/else, wie in `kundenkonto/skill.tsx`.

## Wenn es klemmt

- **Port belegt:** die Vorschau wandert selbst auf 4001 weiter.
  `lsof -tiTCP:4000 | xargs kill` räumt auf.
- **Keine Sprache:** Schlüssel fehlen, siehe oben. Textchat läuft trotzdem.
- **Agent lädt die falsche Fähigkeit:** die Beschreibungen in
  `src/agent/agent.tsx` sind die Routing-Tabelle. Dort schärfen, auch negativ
  ("NICHT für ...").
- **Nach Änderungen an Server-Code oder `.env`:** `npm run dev` neu starten.
  Nur der Browser-Teil lädt heiß nach.
