# splat-editor – Fork von playcanvas/supersplat

Basis: `playcanvas/supersplat` v3.5.2 (Commit `f2a1b49`), MIT-Lizenz.

## Starten

```bash
npm install
npm run develop
```

Danach http://localhost:3000 öffnen. Eine Datei lässt sich direkt per URL laden: `http://localhost:3000/?load=/datei.ply`. Die Datei muss dafür in `dist/` liegen.
Testdatei: `test-data/wall-floaters.ply`. Sie enthält eine Wand bei z = 0 und 300 rote Floater bei z = 4…6.

## Neu: Tiefen-Selektion (Panel oben in der Mitte)

| Regler | Wirkung |
|---|---|
| **Tiefenfilter** | Schaltet den Filter ein. Ist er aktiv, ist das Panel orange umrandet. |
| **Near / Far (m)** | Bereich der View-Tiefe: Abstand der Splat-Mitte entlang der Blickachse, in Szeneneinheiten. Rechteck, Lasso, Polygon, Pinsel, Kugelpinsel und Klick erfassen nur Splats in diesem Bereich. |
| **Außerhalb** | `Normal`, `Abdunkeln` (Standard) oder `Ausblenden`. Legt fest, wie Splats außerhalb des Bereichs angezeigt werden. |
| **Min. Deckkraft** | „Nur sichtbare Splats“ für die Tiefen-Selektion (Depth-Schalter in der unteren Leiste an). Ein Splat gewinnt ein Pixel nur, wenn er dort mindestens diese Deckkraft beiträgt. 0 = aus. |

Bei der Kugel- und Box-Selektion (3D-Volumen) bleibt der Filter bewusst wirkungslos.

### Umsetzung (minimal-invasiv)

SuperSplat hat drei Selektionspfade. Alle drei filtern jetzt nach Tiefe:

1. **Centers** (Footprint 0, Depth aus): Ein Compute-Shader prüft die Splat-Mitten, siehe `src/data-processor/intersect.ts`. Er hat jetzt die Uniforms `view` und `depthRange` und verwirft Splats außerhalb des Bereichs.
2. **Footprint** (Ringe, Depth aus): `projectedSplatRenderer.footprintIntersect`. Dieser Pfad liest den Cache, den der Projector erzeugt.
3. **Pick** (Depth an): ID-Renderpass, der vorderste Splat gewinnt. Er läuft ebenfalls über den Projector.

Der Projector (`src/shaders/projected-splat-projector-shader.ts`) hat die neue Uniform `depthRange`. In Selektionsdurchläufen (`render(forPick=true)`) entfernt er Splats außerhalb des Bereichs immer. Damit verdecken sie auch beim Pick nichts mehr. Mit Near = 5 m wählt man so z. B. die Wand *hinter* den Floatern aus. In normalen Frames dunkelt er solche Splats je nach Einstellung ab oder blendet sie aus.

Geänderte Dateien:
- `src/depth-filter.ts` (neu): Zustand und die Events `depthFilter`, `depthFilter.range`, `depthFilter.set`, `depthFilter.changed`.
- `src/ui/depth-filter-panel.ts` und `src/ui/scss/depth-filter-panel.scss` (neu): das Panel.
- `src/editor.ts`: Die Handler `select.rect`, `select.byMask`, `select.bySphereBrush` und `select.point` geben den Tiefenbereich weiter.
- `src/data-processor/intersect.ts`, `src/projected-splat-renderer.ts`, `src/shaders/projected-splat-projector-shader.ts`, `src/shaders/projected-splat-shader.ts` (`pickAlphaMin`).
- `src/main.ts`, `src/ui/editor.ts`, `src/ui/scss/style.scss`: Registrierung und Einbindung.

Verifiziert mit der Testdatei, Kamera 7 m vor der Wand, Far = 3 m: Ein Rechteck über die ganze Szene erfasst 123 Floater und 0 von 6400 Wand-Splats, und zwar in allen drei Pfaden. Lasso/Pinsel über die Maske liefern ebenfalls 0 Wand-Splats. Rechteck per Maus und dann Entf löschte 54 Floater, die Wand blieb intakt.

Bekannte Grenzen:
- Die Tiefe bezieht sich auf die **Mitte** des Splats. Ein großer Splat, dessen Mitte knapp außerhalb liegt, wird nicht erfasst.
- Die „Meter“ sind Szeneneinheiten. Ist die PLY nicht metrisch skaliert, stimmen sie nicht.
- „Min. Deckkraft“ ist ein Deckkraft-Schwellwert pro Splat, keine echte akkumulierte Transmittanz. Echte Transmittanz bräuchte einen Front-to-Back-Pass mit Akkumulation.
- Auch Tiefen-Picks, die SuperSplat intern nutzt (Kugelpinsel-Tiefe, eventuell Fokus per Doppelklick), sehen nur den Bereich, solange der Filter an ist.
- Footprint- und Pick-Pfad lesen den Filter erst bei der Ausführung der Selektion, nicht schon beim Loslassen der Maus. Bei sehr schnellem Umstellen direkt nach einer Geste kann das abweichen.

## Neu: Multi-Kamera-Timeline

### Bedienung
- **Szenen-Manager → KAMERAS**: Mit `+` fügst du eine Kamera hinzu, mit `⧉` duplizierst du die gewählte (inklusive Keys). Ein Klick auf eine Zeile wählt die Kamera aus, ein Doppelklick auf den Namen benennt sie um, `✕` löscht sie. Eine Kamera bleibt immer übrig. Jede Kamera hat eine eigene Farbe.
- **Viewport-Modus** (Umschalter unter der Liste):
  - `Frei`: freie Editor-Kamera, Scrubben und Abspielen bewegen den Viewport nicht.
  - `Durchschauen`: Der Viewport schaut durch die gewählte Kamera und ist animiert. Hotkey **K** schaltet zwischen Frei und Durchschauen um.
  - `Schnitt`: Der Viewport folgt der Schnittspur.
- **Keyframe setzen** (`+` in der Zeitleiste bzw. Enter) übernimmt die aktuelle Viewport-Pose in die Spur der **gewählten** Kamera. Undo/Redo funktioniert wie bisher über `AnimTrackEditOp`.
- **Zeitleiste**: Unter dem Lineal liegt eine Zeile pro Kamera mit ihren Keys in Kamerafarbe.
  - Klick in die Zeile: Kamera wählen und dorthin scrubben.
  - Key ziehen: Key verschieben.
  - Ganz unten liegt die **Schnittspur**:
    - Ziehen weist den Bereich der gewählten Kamera zu.
    - Ein Klick schneidet ab diesem Frame bis zum nächsten Schnitt auf die gewählte Kamera.
    - Rechtsklick löscht das Segment.
  - Schnitt-Edits sind rückgängig machbar.
- **Gizmos**: Jede Kamera wird als Frustum in ihrer Farbe gezeichnet, und zwar mit der aktuellen Pose (groß), den Keys (klein) und optional dem Pfad. Die Schalter `Frustums` und `Pfade` liegen unter der Liste. Gizmos sind jetzt standardmäßig an. Die Kamera, durch die der Viewport gerade schaut, wird nicht gezeichnet.
- **Video-Export** → neues Feld **Kamera**:
  - `Schnitt (ein MP4)`
  - `Kamera: <Name>`
  - `Alle Kameras einzeln`: Es öffnet sich ein Ordner-Dialog, dann entsteht ein MP4 pro Kamera als `<Projekt>_<Kameraname>.mp4`. Ohne File-System-API wird jede Datei einzeln heruntergeladen.

  Standard ist `Schnitt`, wenn es Segmente gibt, sonst die gewählte Kamera. Format und Codec bleiben standardmäßig MP4/H.264.
- **.ssproj**:
  - Jede Kamera wird als eigenes `poseSet` gespeichert (Name, Farbe, Keys).
  - Neu ist das Feld `cuts` mit dem Viewport-Modus und den Segmenten. Die Segmente verweisen auf den Index der Kamera.
  - Alte Projekte mit einer einzigen Spur `set0` werden beim Laden zu „Kamera 1“ migriert.

### Architektur
- `src/camera-poses.ts`:
  - `CameraAnimTrack` steuert die Editor-Kamera nicht mehr selbst. Sie liefert nur noch `getPoseAt(frame)`.
  - `CutTrack` hält die Segmente.
  - `registerCameraPosesEvents` ist das Kamera-Rig: Kameraliste, Auswahl, View-Modus und `camera.setRenderOverride` für den Export. Es setzt bei `timeline.time`/`timeline.frame` die Pose der verfolgten Kamera.
  - `camera.animTrack` liefert die Spur der gewählten Kamera. Dadurch arbeiten `track-manager.ts` und das Undo unverändert.
- `src/track-manager.ts`: neue Events `cut.set` und `cut.removeAt` mit Undo.
- `src/camera-pose-gizmos.ts`: Mesh pro Kamera mit Farbe, FOV-korrektem Frustum und Pfad.
- `src/ui/camera-list.ts`, `src/ui/timeline-tracks.ts` und die zugehörigen SCSS-Dateien.
- `src/render.ts`, `src/video-config.ts`, `src/ui/video-settings-dialog.ts`, `src/ui/editor.ts`: Kamera-Auswahl und Export aller Kameras.
- `src/doc.ts`: `cuts` speichern und laden.

### Verifiziert
Testszene `test-data/wall-floaters.ply`: Kamera 1 mit Keys bei 0/60/120 frontal, Kamera 2 mit Keys bei 0/90/179 seitlich, Schnitt bei Frame 90. Export als MP4 mit 640×360, 30 fps, 180 Frames, H.264. Ergebnisse liegen in `test-data/out/` (`cut.mp4`, `cam_1.mp4`, `cam_2.mp4`, `cut_sheet.png`).

Die Frames wurden mit ffmpeg extrahiert und per SSIM gegen die Einzelkamera-Videos verglichen:

| Frame im Schnitt-Video | SSIM gegen Kamera 1 | SSIM gegen Kamera 2 |
|---|---|---|
| 0, 45, 89 | 0,97–0,99 | ≈ 0,25 |
| 90, 135, 179 | ≈ 0,16–0,25 | 0,98–0,99 |

Der Schnitt liegt also exakt auf Frame 90.

Ebenfalls geprüft:
- Undo von Key- und Schnitt-Edits.
- Duplizieren, Umbenennen und Löschen von Kameras.
- Speichern und Laden über echtes `doc.saveAs`/`doc.load`.
- Migration einer alten `set0`-Spur.

Unterwegs gefunden und behoben: Der Render-Loop summiert `1/fps` auf, Frame 90 kommt deshalb als 89,99999 an. `CutTrack.cameraAt` rastet jetzt auf den Frame ein.

### Grenzen / offen
- ~~Kamera hinzufügen, löschen, umbenennen und duplizieren ist nicht rückgängig machbar.~~ Erledigt, siehe „Undo für die Kameraliste“.
- ~~Schnitte sind nur harte Schnitte.~~ Überblendungen gibt es jetzt im Export, siehe „Überblendung am Schnitt“. Der Viewport schneidet weiterhin hart.
- Im Modus Durchschauen springt der Viewport beim nächsten Scrubben zurück auf die Spur, wenn du ihn frei bewegst und keinen Key setzt. Das war im Original auch so.
- Viewer-Export und Publish nehmen die Spur der **gewählten** Kamera (`camera.poses`), nicht den Schnitt.
- Der „Alle Kameras“-Export über den Ordner-Dialog wurde nicht per Klick getestet, weil sich Dialoge aus der Automatisierung nicht bedienen lassen. Die Einzel-Renders mit Dateinamen-Suffix wurden direkt über `render.video` geprüft.

## Neu: Layer-Animation und Punktwolken-Modus

### Layer-Animator (Szenen-Manager → LAYER-ANIMATION, gilt für den ausgewählten Layer)
- **Deckkraft** (0–1): Ohne Keys ist das ein fester Wert. Mit Keys wird sie animiert.
- **Darstellung**: `Global`, `Splats` oder `Punkte`. Damit überschreibt dieser Layer den globalen Modus.
- **Punkt-Mix**: Ist der Schalter aus, folgt der Layer seiner Darstellung. Ist er an, blendet er stufenlos zwischen Splat (0) und Punkt (1) über. Der Wert lässt sich keyen, ein Layer kann sich so z. B. aus Punkten „materialisieren“.
- **Interpolation**: `Linear` oder `Smooth` (weiches Ein- und Ausschwingen pro Segment), pro Layer.
- **◆ Key setzen**: speichert Deckkraft, Punkt-Mix (falls der Schalter an ist) und Transform am aktuellen Frame. **◇ Key löschen** entfernt den Key dort.
- **Fade in / Fade out**: setzt zwei reine Deckkraft-Keys (0→1 bzw. 1→0) ab dem aktuellen Frame über die eingestellte Dauer in Frames. Fades legen den Transform **nicht** fest.
- Jeder Key speichert nur die Kanäle, die er trägt. Kanäle ohne Keys werden nicht angefasst.
- Alle Key-Edits sind rückgängig machbar (`AnimTrackEditOp`).
- **Zeitleiste**: Unter Kameras und Schnittspur gibt es eine Zeile pro Layer.
  - Die Füllung eines Keys zeigt seine Deckkraft. Ein hohler Key trägt nur Transform.
  - Klick: Layer wählen und scrubben. Doppelklick: Key mit allen Kanälen setzen.
  - Key ziehen: verschieben. Rechtsklick auf einen Key: löschen.
  - Die Spurliste ist auf 170 px begrenzt und scrollt danach. So ändert sich bei vielen Layern die Höhe nicht unkontrolliert.
- Die Deckkraft wirkt im Viewport, in der Vorschau und in jedem Video-Export, auch im Schnitt-Export. Dafür wird das Splat-Alpha im Projector multipliziert. Bei Deckkraft 0 zeichnet der Layer nichts.
- Auswahl und Picking sehen Layer immer als normale Splats mit voller Deckkraft.

### Punktwolke (Szenen-Manager → PUNKTWOLKE, global)
- **Modus** `Splats` oder `Punktwolke`. Jeder Layer kann das überschreiben (siehe Darstellung).
- **Größe** in `Pixel` (konstant auf dem Bildschirm) oder `Welt` (Welteinheiten, wird mit der Entfernung kleiner).
- **Farbe** `Original` (Splatfarbe inklusive SH und Color-Grade) oder `Einheit` mit Farbwähler.
- **Deckkraft** der Punkte.
- **Glühen** (0–1): Die Punkte werden additiv geblendet. Dafür wird das geschriebene Alpha reduziert, und der Premultiplied-Blend wird so additiv.
- **Umsetzung**: SuperSplats vorhandene Centers-Ansicht ist nur ein Editor-Overlay, beim Export wird `centersLayer` abgeschaltet. Darauf habe ich bewusst nicht aufgebaut. Die Punktwolke steckt stattdessen im Splat-Renderer selbst:
  - Der Projector macht aus der Ellipse einen runden Punkt der gewählten Größe und setzt Farbe und Deckkraft.
  - Er schreibt Punkt-Mix (4 Bit) und Glühen (2 Bit) in freie Bits von `cacheB`.
  - Der Render-Shader zeichnet daraus statt der Gauß-Kurve eine runde Scheibe mit weicher Kante.

  Damit funktioniert alles automatisch im Video-Export und lässt sich stufenlos überblenden.
- **.ssproj**: Pro Layer werden Deckkraft, Mix, Darstellung, Interpolation und Keys gespeichert (im Splat-Eintrag unter `anim`). Global kommt `pointCloud` dazu.

### Architektur
- `src/layer-anim.ts` (neu): `LayerAnimTrack` (AnimTrack mit Kanal-Keys), Zustand pro Layer, globale Punktwolken-Einstellungen, Fades, Undo und Serialisierung. Auswertung bei `timeline.time`/`timeline.frame`. Die Transform-Kanäle laufen über `splat.move()`.
- `src/projected-splat-renderer.ts`: Uniforms `layerParams` (Deckkraft, Mix, Glühen), `pointParams` und `pointColor` pro Layer. In Selektionsdurchläufen sind sie neutral.
- `src/shaders/projected-splat-projector-shader.ts`, `src/shaders/projected-splat-shader.ts`: Deckkraft, Punktgeometrie, Punktfarbe, Scheiben-Falloff, Glühen.
- `src/ui/layer-anim-panel.ts`, `src/ui/timeline-tracks.ts` (Layer-Zeilen), die zugehörigen SCSS-Dateien, `src/splat.ts` und `src/doc.ts` (Serialisierung).
- `src/ui/timeline-panel.ts`: `moveCursor?.()`. Das Lineal hat vor seinem ersten Layout noch keinen Cursor, ein Frame-Wechsel warf dort vorher einen Fehler und brach die Event-Kette ab.

### Verifiziert
Zwei Layer: `test-data/wall-floaters.ply` (Wand + Floater) und `test-data/green-sphere.ply` (grüne Kugel). Die Wand blendet über Frame 0–30 ein, die Kugel über Frame 60–90 aus. Kamera fest frontal.

Export als MP4 mit 640×360 und 121 Frames, einmal im Splat-, einmal im Punktwolken-Modus (4 px, Original-Farbe, Glühen 0,4). Ergebnisse: `test-data/out/layers_splats.mp4`, `layers_points.mp4` und das Kontaktblatt `layers_sheet.png`. Die Helligkeit wurde mit ffmpeg und OpenCV gemessen:

| Messung | Splat-Modus | Punktwolken-Modus |
|---|---|---|
| Wand, Frame 0 / 15 / 30 | 0 / 109 / 141 | 0 / 15,7 / 31,4 |
| Kugel-Fenster, Frame 60 / 75 / 90 | 184 / 183 / 121 | 69 / 51 / 30 |

Bei Frame 90 ist im Kugel-Fenster nur noch die Wand dahinter zu sehen, die Kugel ist also weg. Die Punkte sind im Export sichtbar.

Ebenfalls geprüft:
- Überschreibung pro Layer.
- Mix-Spur 1→0 über Frame 30–60 (Frame 45 ergibt 0,5).
- Interpolation umschalten plus Undo, Fade plus Undo/Redo.
- Echter .ssproj-Round-Trip über `doc.saveAs`/`doc.load`: Layer, Keys, Interpolation und Punktwolken-Einstellungen kommen aus der Datei zurück.

### Grenzen / offen
- **Deckkraft wirkt pro Splat und nicht auf den fertig gerenderten Layer.** Dichte Layer mit vielen überlappenden Splats wirken deshalb bei 0,5 noch fast deckend; sichtbar verblassen sie erst gegen Ende. Im Test hatte die Kugel bei Deckkraft 0,5 noch fast volle Helligkeit. Ein „echter“ Layer-Fade müsste den Layer in ein eigenes Render-Target zeichnen und dann einblenden.
- Glühen und Punkt-Scheiben greifen im sortierten Blend-Renderer. Im stochastischen Modus (`view.stochastic`) gibt es kein additives Glühen.
- Transform-Keys überschreiben beim Scrubben manuelle Gizmo-Änderungen, solange kein neuer Key gesetzt wird. Das gleiche Verhalten hat die Kameraspur.
- Unterhalb von 0,75 px werden Punkte nicht kleiner gezeichnet.

## Neu: Aufbau-Transitions (per Splat)

Hinweis: Mit „Spec Transform“ war ursprünglich splat-transform gemeint. Das Paket enthält aber keine Transitions, sie sind deshalb eigener Shader-Code.

### Bedienung
- **Anlegen**: Zwei Wege.
  - Szenen-Manager → **TRANSITIONS** → `+ In` bzw. `+ Out` legt ab dem aktuellen Frame eine Transition mit 30 Frames an.
  - In der Layer-Zeile der Zeitleiste: **Shift+Ziehen** legt eine In-Transition über den gezogenen Bereich an, **Shift+Alt+Ziehen** eine Out-Transition.
- **Blöcke in der Layer-Zeile**: In-Transitions sind cyan, Out-Transitions magenta.
  - Körper ziehen: verschieben. Enden ziehen: Länge ändern.
  - Klick: auswählen (öffnet die Parameter). Rechtsklick: löschen.
  - Anlegen, Verschieben, Länge, Typ, Effekt, Easing, Richtung und Ursprung lassen sich rückgängig machen. Slider-Parameter (Kante, Glühkante, Streuung, Wirbel) wirken live und ohne Undo.
- **Parameter**:
  - Typ: In (Aufbau) oder Out (Abbau, die Umkehrung).
  - Effekt.
  - Start und Dauer.
  - Easing: Linear, In, Out oder In-Out.
  - Richtung: ±X, ±Y oder ±Z.
  - Ursprung: Layer-Mitte oder aktuelle Pivot-Position.
  - Kantenbreite, Glühkante samt Farbe, Streuung, Wirbel, Seed, „Punkte zuerst“ (Punktwolken-Phase vor den Splats) und Fly-in-Verteilung (Zufall oder Explosion).
- **Logik**: Es gilt jeweils die zuletzt gestartete Transition. Vor einer In-Transition ist der Layer unsichtbar, nach einer Out-Transition weg.
- **Effekte**:
  1. **Sweep**: Aufbau entlang der Achse mit weicher Front und Glühkante.
  2. **Radial**: Aufbau kugelförmig vom Ursprung aus, mit Glühkante.
  3. **Dissolve**: Einblenden per Rauschen pro Splat; mit „Punkte zuerst“ erscheinen erst Punkte, dann Splats.
  4. **Grow**: Jeder Splat skaliert von 0 auf volle Größe, zeitversetzt nach Abstand zum Ursprung.
  5. **Fly-in**: Die Splats starten verstreut (zufällig oder als Explosion vom Ursprung) und fliegen mit optionalem Wirbel an ihren Platz.
  6. **Wave**: Die Splats fallen mit kleinem Nachfedern entlang der Achse ein. Mit −Y heben sie sich von unten.
- Alles wird in .ssproj gespeichert (im Splat-Eintrag `anim.transitions`).

### Umsetzung
- `src/layer-anim.ts`:
  - `Transition` gehört zur Spur und damit zu Snapshot/Undo und Serialisierung.
  - `buildAt(frame)` liefert die maßgebliche Transition und den Aufbauwert (0…1, mit Easing).
  - `layerAnim.transitionParams` rechnet daraus sechs vec4-Uniforms. Achsenbereich und Radius kommen aus dem Welt-Bounding-Box des Layers.
- `src/shaders/projected-splat-projector-shader.ts`, `buildTransition()`:
  - Pro Splat wird eine Startzeit berechnet: Achsenposition, Abstand, Hash der Source-ID oder gestaffelter Zufall.
  - Daraus folgt der lokale Fortschritt durch die Front.
  - Je nach Effekt ändern sich Weltposition (Versatz, Wirbel per Rodrigues-Rotation), Skalierung (fließt in die Kovarianz ein), Alpha, Glühen (additiv auf die Farbe) und Punkt-Mix.
  - Alles läuft auf der GPU und ist im Viewport, in der Vorschau und im Export identisch.
- In Selektionsdurchläufen (`forPick`) sind die Uniforms neutral.

### Verifiziert
Jeder Effekt einmal als In-Transition über Frame 0–60 auf dem Layer `wall-floaters.ply`, mit schräger Kamera. Export je eines MP4 mit 480×270: `test-data/out/trans_<effekt>.mp4`. Kontaktbogen `transitions_sheet.png`: eine Zeile pro Effekt, Spalten bei 0/25/50/75/100 %. Bei 0 % ist der Layer leer, bei 100 % vollständig aufgebaut, dazwischen ist der jeweilige Effekt sichtbar.

Ebenfalls geprüft:
- Out-Transition: Aufbauwert 1 → 0,75 → 0,5 → 0.
- Verschieben mit Undo, Löschen mit Undo.
- Round-Trip über `docSerialize`/`deserialize`.

### Grenzen
- Positionsversatz und Skalierung wirken nur im Renderer. Auswahl und Picking sehen die Splats an ihrer Endposition.
- Die Glühkante wird additiv auf die Splatfarbe gerechnet, ohne eigenen Bloom.

## Neu: Dissolve / Materialize (Hauptfeature der Transitions)

Dissolve ist jetzt ein eigener Shader-Pfad (`dissolveTransition()` im Projector) und kein einfacher Fade mehr.
- **Schwelle**: 3D-fBm-Value-Noise über der Weltposition. Die Frequenz ist relativ zur Layer-Größe und hat drei Oktaven, daraus entsteht eine zerfasernde, organische Front.
  - Modi: `Rauschen` (rein), `Achse` (Richtungsgradient) oder `Radial` (vom Ursprung).
  - Bei Achse und Radial mischt der `Rausch-Anteil` das Rauschen hinein.
  - Jeder Splat bekommt so seinen eigenen Zeitpunkt im Gesamtfortschritt.
- **Phasen pro Splat** (In; Out ist die Umkehrung), über ein eigenes Zeitfenster (`Kante`):
  1. Unsichtbares Partikel mit Versatz. `Drift`: nach außen vom Ursprung, entlang der Richtung (z. B. +Y = fällt von oben) oder zufällig. Optional Wirbel, Weite über `Streuung`, pro Splat variiert.
  2. Kleiner runder, leuchtender Punkt (`Punktgröße` in px; `Punkt-Tönung` mischt zwischen Splatfarbe und Glühfarbe), der an seinen Platz fliegt.
  3. Aufglühen kurz vor dem Ziel: additive Glühfarbe in Gauß-Form bei 60 % des Fensters, Stärke über `Glühkante`.
  4. Materialisieren: Er wächst vom Punkt zur vollen Gauß-Kovarianz (über den Punkt-Mix), Deckkraft und Farbe gehen auf das Original zurück.
- Das Ergebnis ist deterministisch: Es hängt nur vom Fortschritt, der Weltposition und dem Seed ab, nie von der Frame-Zeit. Viewport und Export sind dadurch identisch und reproduzierbar.
- Es wirkt mit der Layer-Deckkraft (multipliziert) und mit der Schnittspur (betrifft nur die Kamera) zusammen.
- Die übrigen Presets (Sweep, Radial, Grow, Fly-in, Wave) bleiben unverändert verfügbar.

**Verifiziert** an einem echten Postshot-Splat (`Desktop/bus/postshot/bus.ply`, 2,0 Mio. Splats): Dissolve-In und Dissolve-Out über je 90 Frames (linear, Rauschen, Frequenz 4, Glühfarbe Cyan). Ergebnisse: `test-data/out/dissolve_in.mp4`, `dissolve_out.mp4` und der Kontaktbogen `dissolve_sheet.png` (Zeile In / Zeile Out, Spalten bei 0/20/40/60/80/100 %). Zu sehen ist:
- 0 %: leer.
- 20 %: vereinzelte leuchtende Partikel.
- 40–60 %: zerfasernde cyan glühende Front aus Punkten, die zu Splats materialisieren.
- 80 %: fast fertig.
- 100 %: vollständig. Out läuft entsprechend umgekehrt.

Ein Export von 91 Frames in 640×360 dauerte rund 2 s.

Grenze: Mit In-Out-Easing passiert in den ersten 20 % kaum etwas. Für gleichmäßige Phasen ist `Linear` besser.

## Neu: Keyframe-Ziel folgt der Auswahl

- `track-manager.getActiveTrack()` folgt der letzten Wahl:
  - Ein Splat im Szenen-Manager (oder ein Klick auf seine Layer-Zeile) macht dessen Layer-Spur zum Ziel. Das gilt auch, wenn der Splat schon ausgewählt war.
  - Eine Kamera in der Kameraliste (oder ihre Zeile) macht deren Kamera-Spur zum Ziel.
  - Das gilt für den Key-Button, Enter, Key löschen, Verschieben und Kopieren (Shift-Ziehen) im Lineal, jeweils mit Undo.
- Ein Key auf dem Splat speichert Position, Rotation, Skalierung, Deckkraft und, falls aktiv, den Punkt-Mix.
- **Anzeige**: Neben dem Key-Button steht „Key → Splat: Name“ (orange) bzw. „Key → Kamera n“ in der Kamerafarbe. Die Zeile des Ziels ist in der Zeitleiste markiert, und das Lineal zeigt die Keys des Ziels.
- **Auto-Key** (roter Punkt ●): Jede Transform-Änderung (Gizmo-Drag oder Transform-Panel, beide enden in `pivot.ended`) und jede Deckkraft-Änderung am gewählten Splat setzt einen Key auf dem aktuellen Frame. Abspielen und Scrubben lösen nie einen Auto-Key aus. Für die Kamera gibt es kein Auto-Key.
- Beim Scrubben und Abspielen führt die Layer-Animation den Pivot nach, Transform-Panel und Gizmo laufen also live mit.
- **Per Klick geprüft**:
  1. Splat im Szenen-Manager gewählt: Label „Key → Splat: /wall-floaters.ply“.
  2. Key-Button auf Frame 0: Key (Deckkraft 1, Position 0/0/0).
  3. Frame 60, im Transform-Panel X = 3, im Animator Deckkraft = 0, Key-Button: zweiter Key auf dem Splat.
  4. Scrubben auf Frame 30: X = 1,5 und Deckkraft 0,5, Transform-Panel und Pivot zeigen 1,5.
  5. **Die Kamera-Spur hatte 0 Keys.**
  6. Auto-Key an, Frame 120, Y = 2 im Transform-Panel: automatischer Key.
  7. Kamera in der Liste angeklickt, Key-Button: Key landet auf der Kamera, die Layer-Spur bleibt unverändert.

## Neu: Ausrichten per Ankerpunkten (Splatterline-Stil)

Rechenkern: `src/align/point-align.ts` (aus der Hauptsession, unverändert). Anbindung: `src/align/align-tool.ts`, registriert als Tool `align`. Der Button in der rechten Toolbar stammt aus der Hauptsession.
- **Bedienung**:
  - Werkzeug öffnen (rechte Toolbar). Im Panel die Referenz per Radio wählen; Standard ist der erste Layer.
  - Aktiven Layer im Szenen-Manager oder per Klick auf den Namen im Panel wählen und in den Viewport klicken. Der Punkt wird **nur gegen den aktiven Layer** gepickt (`intersectMany([...], [aktiver Layer])`).
  - Die Punkte sind nummeriert und in der Layer-Farbe. Ziehen verschiebt einen Punkt (erneuter Pick beim Loslassen), Rechtsklick löscht ihn. Alles ist rückgängig machbar.
  - Die Punkte werden in **Layer-Lokalkoordinaten** gespeichert, wandern also beim Align mit, und kommen ins .ssproj (Splat-Eintrag `align`).
  - Tipp: Der Tiefenfilter (Near/Far) blendet Floater vor der Oberfläche auch beim Pick aus.
- **Align**:
  - Pro bewegtem Layer mit mindestens 3 Paaren wird `alignPoints` mit Weltkoordinaten aufgerufen (Skalierung optional, Standard an). Bei mehr Paaren gibt es Least Squares.
  - Neue Welttransformation = M × alte. Daraus werden Position, Rotation und uniforme Skalierung des Layers abgeleitet und als **ein** Undo-Schritt gesetzt (`EntityTransformOp` in `MultiOp`).
  - Danach zeigt das Panel RMS und Residuen pro Punkt. Bei kollinearen Punkten erscheint ein Hinweis.
- **Layer-Animation**: Vorhandene Transform-Keys des Layers bekommen dieselbe Korrektur (im selben Undo-Schritt). Animationen bleiben also erhalten und laufen relativ zur neuen Lage.
- **Verifiziert**:
  - **Skript** (Kopie um 37° um Y gedreht, um (2, 0.5, −1) verschoben, mit 1,3 skaliert; exakte Ankerpunkte): Mit 3 und mit 4 Paaren liegen Positions-, Winkel- und Skalierungsfehler bei ~1e-7, die RMS bei ~5e-8, die gelöste Skalierung bei 0,769 = 1/1,3. Undo stellt die verdrehte Lage wieder her.
  - **Per Klick im Browser** (Werkzeug über die Toolbar, je 3 Klicks auf die Wand, Align-Button): RMS 1,1 cm, Rotationsfehler 0,3°, Skalierungsfehler 1 %, Positionsfehler am Layer-Ursprung 9,5 cm (Hebelarm des Klickrauschens).
  - Mit Animation: Ein Key-Schritt von 1 Einheit entlang der lokalen X-Achse des verdrehten Layers lief nach dem Align als (−1,01; 0; 0) in Referenz-Koordinaten.
  - Speichern und Laden der Ankerpunkte (`docSerialize`/`deserialize`).
- **Nicht umgesetzt**: das optionale „Verfeinern“ per ICP.
- **Button und Bedienung**:
  - Eigener Umschalter `right-toolbar-align` in der rechten Leiste (eigene Gruppe über dem Zahnrad, Icon `ui/svg/align.svg`, Tooltip DE/EN mit Shortcut).
  - Shortcut **J**. „A“ ist nicht frei, weil der Fly-Modus mit `KeyA` nach links fliegt.
  - Aktiv heißt: Der Button ist orange, das Panel ist offen, und Klicks in den Viewport setzen Ankerpunkte.
  - Ein erneuter Klick, J oder Esc beendet das Werkzeug. Der Tool-Manager stellt dann das zuvor aktive Werkzeug wieder her (`RETURNING_TOOLS` in `tool-manager.ts`). Die Marker werden ausgeblendet, die Ankerpunkte bleiben gespeichert.
- **Rechte Leiste**: Sie ist jetzt auf die Viewport-Höhe begrenzt (`max-height: calc(100% - 32px)`) und scrollt bei Bedarf. Bei 1280×600 mit offener Zeitleiste: Leiste 16–388 px bei einem 404 px hohen Canvas, der Ausrichten-Button sichtbar.
- **Per Klick geprüft**: Verschieben-Werkzeug aktiv, dann Ausrichten-Button: Werkzeug an, Button orange, Panel offen. Ankerpunkt gesetzt, Button erneut geklickt: Verschieben wieder aktiv, Marker weg, Punkt gespeichert. Dasselbe mit J und Esc.

## Neu: Präzisieren (ICP) und Qualität (Heatmap, Schwelle, Scan-Vergleich)

Die Rechenkerne kommen aus der Hauptsession: `src/align/icp.ts` (`refineAlignment`) und `src/quality/quality-score.ts` (`scoreSplats`, `compareLayers`). Ich habe sie unverändert angebunden.

### Infrastruktur
- **Analyse-Worker**:
  - `src/analysis/analysis-worker.ts` ist ein eigener Rollup-Eintrag und wird zu `dist/analysis-worker.js` (Modul-Worker).
  - `src/analysis/analysis-client.ts` verteilt die Jobs, liefert Fortschritt und bricht ab, indem es den Worker beendet. Die Kerne laufen in engen Schleifen ohne Nachrichtenabfrage; der nächste Job startet einen neuen Worker.
- **Splat-Daten**: `src/analysis/splat-data.ts` liest pro Layer Mitten, lineare Skalen und Deckkraft in Weltkoordinaten. Die Quelle sind die GPU-Texturen (Half-Floats werden dekodiert). Layer-Transformation und Per-Instanz-Paletten werden angewendet, versteckte (gesperrte) Splats ausgelassen.

### Präzisieren (Ausrichten-Panel)
- Button **Präzisieren** und Regler **Suchradius** (0 = automatisch; sonst `maxError`). „Skalierung mitrechnen“ gilt auch hier.
- Pro sichtbarem Nicht-Referenz-Layer wird `refineAlignment` im Worker aufgerufen. Eingang: Splats mit Deckkraft ≥ 0,3, bei Bedarf auf etwa 500k pro Layer ausgedünnt.
- Das Ergebnis ist ein Undo-Schritt, mit derselben Transform- und Keyframe-Korrektur wie Align. Ist `improved` falsch, wird nichts angewendet und „keine Verbesserung“ angezeigt.
- Das Panel zeigt „Median vorher → nachher · Überlappung %“. Fortschritt läuft über die Fortschrittsanzeige, Abbrechen ist möglich. „do not overlap“ und „too few points“ erscheinen als Hinweis.
- **Test A.4** (per Klick): Bus doppelt geladen, die Kopie 1,5° um eine schiefe Achse um den Szenenschwerpunkt gedreht und um (3, 1, −2) cm verschoben, Ausgangsfehler bis 24 cm an den Szenenrändern. Werkzeug über den Button geöffnet, Präzisieren geklickt.

  | | vorher | nachher |
  |---|---|---|
  | Winkelfehler | 1,5° | 0,0008° |
  | größter Punktfehler | 24 cm | 1,9 mm |
  | Skalierung | 1 | 0,99993 |

  Das Panel zeigte „Median 0,0525 → 0,0066 · Überlappung 94 %“. Undo und Redo sind ein Schritt. Laufzeit rund 10 s bei 2 × 2 Mio. Splats.

### Qualität (Werkzeug `quality`, rechte Leiste, Shortcut U)
- **Regler**: Die Gewichte werden direkt aus `DEFAULT_WEIGHTS` des Kerns gelesen (Größe 1, Deckkraft 1, Nadeln 0,5, Dichte 0,25). Schwelle 0,3. Raster: Bei 0 zeigt das Panel „auto“ (der Kern passt das Raster an die Splat-Dichte an), nach einem Vergleich den tatsächlich verwendeten Wert. Toleranz 0,15 (= margin).
- **Hinweis im Panel**: Die Heatmap ist relativ und zeigt die schwächsten Bereiche dieses Scans. Welcher Scan wo schärfer ist, zeigt „Scans vergleichen“. Ein einzelner Scan kann Unschärfe nicht sicher von naturgemäß großen Splats (z. B. im Hintergrund) unterscheiden.
- **Scores berechnen**: `scoreSplats` pro sichtbarem Layer im Worker, danach Heatmap.
- **Scans vergleichen**: `compareLayers` über alle sichtbaren Layer. Die markierten Splats (1 = ein anderer Scan ist dort klar schärfer) gehen an den Modus „Vergleich“, die gemeinsam skalierten Scores an die Heatmap.
- **Selektieren**: „Unter Schwelle“ und „Schlechtere“ jeweils als `SelectOp` mit Undo, gelöscht wird mit Entf.
- **Darstellung**: Ein fester Anzeigepuffer pro Layer, dessen Inhalt je nach Modus neu geschrieben wird.
- **Test B.5** (per Klick):
  - Aufbau: Bus-Kopie `dist/bus-blur.ply`. Darin eine Kugel um den Schwerpunkt der deckenden Splats (r = 1,35, 21.678 Splats), die künstlich unscharf ist: 3× größer, Deckkraft −1,5 logit, Positionsrauschen.

  | Raster | markiert im Original | in der Kopie: in der Kugel | in der Kopie: außerhalb |
  |---|---|---|---|
  | automatisch (0,635) | 0 | 50,4 % | 0,026 % |
  | 0,2 | 0 | 83,8 % | 0,023 % |

  - Screenshots: In der Kopie ist der Bereich rot, im Original an derselben Stelle nichts. Laufzeit rund 8 s für den Vergleich.
- **Befund und Korrektur im Kern**:
  - Im ersten Stand lagen auf dem echten Bus 84 % der Splats unter 0,5, und das Auto-Raster war mit 0,635 grob.
  - Die Hauptsession hat den Kern angepasst: Footprint-Größe statt Volumen mit Referenz am 75. Perzentil, Nadeln nur noch in der Fläche, Deckkraft-Abzug erst unter 0,15, ein dichteabhängiges Auto-Raster (etwa 40 Splats pro Voxel) und Dichte-Gewicht 0,25.

  | Messung (echter Bus) | erster Stand | jetzt |
  |---|---|---|
  | Splats unter 0,5 | 84 % | 20 % |
  | Splats unter 0,3 | – | 12 % |
  | Auto-Raster | 0,635 | 16,7 cm |
  | markiert im unscharfen Bereich | 50 % | 83–85 % |
  | markiert außerhalb | 0,026 % | 0,04 % |

  - Im Original wurden praktisch keine Splats markiert. Per Klick wählte „Schlechtere selektieren“ 18.483 Splats als kompakten Block im unscharfen Bereich aus.
  - Kleiner Test hier: Wand mit deckenden Floatern gegen Wand mit Nebel-Floatern, Auto-Raster 0,6, 294 der 300 Nebel-Floater markiert, im deckenden Layer 0.
- **Grenzen**: Der Tiefenfilter wirkt bei „Unter Schwelle selektieren“ noch nicht mit. Nach einem Löschen gelten die Scores als veraltet (Heatmap aus), bis neu berechnet wird.

## Neu: Schnitt (Dach wegschneiden bis zum Grundriss)

`src/section/section-tool.ts`, Werkzeug `section`, Button `right-toolbar-section` in der rechten Leiste (Icon Haus mit Schnittlinie, Tooltip DE/EN, Shortcut **Y**, Umschalt-Logik wie Ausrichten und Qualität).

### Bedienung
- **Schnitt 0–100 %**: 0 % schneidet nichts ab, 100 % schneidet bis zur Grundriss-Höhe über dem Boden. Dazwischen verläuft die Schnitthöhe linear zwischen Oberkante und Boden + Grundriss-Höhe. Daneben steht die absolute **Höhe in Metern**, gekoppelt in beide Richtungen, plus die gemessene Spanne.
- **Kanten**: Ober- und Unterkante werden robust per 1. bzw. 99. Perzentil der sichtbaren Splats gemessen (bis 200k pro Layer), automatisch beim ersten Öffnen und über „Neu messen“.
- **Boden**: Standard ist die Unterkante. „Boden picken“ setzt die Bodenhöhe mit dem nächsten Klick in den Viewport. **Grundriss** (Standard 0,4 m) bestimmt, was von den Wänden stehen bleibt.
- **Achse**: Welt Y, oder „Layer“ = Hochachse des aktiven Layers inklusive des Local Frames aus dem Orient-Werkzeug.
- **Wirkt auf**: alle sichtbaren Layer oder nur den aktiven.
- **Kante**: weich (5 cm Ausblendung) oder hart. **Ebene zeigen**: oranges Gitter auf Schnitthöhe, nur im Editor (Gizmo-Layer, nicht im Export).
- **Abgeschnittenes selektieren**: `SelectOp` auf dem aktiven Layer, danach Entf, z. B. für einen Export ohne Dach.

### Umsetzung
- **Nicht destruktiv**: Der Projector verwirft Splats, deren Mitte über der Schnitthöhe liegt (Uniforms `sectionPlane` und `sectionEdge`). Das gilt auch in Selektions- und Pick-Durchläufen, dort immer mit harter Kante. Der Centers-Selektions-Compute (`intersect.ts`) testet dieselbe Ebene. Abgeschnittene Splats sind damit für Picking, Rechteck/Lasso/Pinsel, Ausrichten-Anker und Boden-Pipette unsichtbar.
- **Animierbar**: eigene Keyframe-Spur (`SectionTrack`, weiche Interpolation) mit einer Zeitleisten-Zeile „Schnitt“.
  - Key-Ziel ist der Schnitt, sobald das Werkzeug geöffnet oder die Zeile angeklickt wird. Das Label zeigt dann „Key → Schnitt“; Key-Button, Enter und Lineal-Verschieben arbeiten auf dieser Spur, mit Undo.
  - Im Panel gibt es zusätzlich „◆ Key“.
- Wirkt im Video-Export und im Schnitt-Export; wird in .ssproj gespeichert (`section`).

### Verifiziert (per Klick, synthetisches Häuschen `test-data/house.ply`: Boden, Wände 2,5 m, Satteldach bis 4 m)
- Gemessen: unten 0,00 m, oben 3,95 m.
- **0 / 50 / 100 %** (Screenshots im Verlauf): komplettes Haus; Schnitt auf 2,18 m mit weggeschnittenem Dach und Gitter; Grundriss mit 0,4 m hohen Wandansätzen.
- **Picking**: Bei 0 % trifft ein Klick auf den First 3,96 m. Bei 100 % trifft dieselbe Bildstelle nichts mehr, der Strahl geht durch das abgeschnittene Dach.
- **Selektion**: Ein Rechteck über den ganzen Viewport wählte 6.877 Splats. Das ist genau Gesamtzahl 19.959 minus 13.082 abgeschnittene, die „Abgeschnittenes selektieren“ findet.
- **Animation**: Key 0 % auf Frame 0 und 100 % auf Frame 60 über den Key-Button der Zeitleiste. Kamera und Layer bekamen keine Keys. Bei Frame 30 liegt der Wert bei 50 %.
- **Export**: 61 Frames, 640×360: `test-data/out/section_anim.mp4` und der Kontaktbogen `section_sheet.png` (0/25/50/75/100 %). Im Video ist kein Editor-Gitter zu sehen.
- Speichern und Laden der Spur und der Einstellungen per `docSerialize`/`docDeserialize`.
- **Nicht per Klick getestet**: Boden-Pipette, Achse „Layer“, „Aktiven Layer“ und harte Kante.

## Neu: Tiefenschärfe (Depth of Field)

Eine Dünnlinsen-Unschärfe pro Splat im Projector (`src/shaders/projected-splat-projector-shader.ts`): Die projizierte 2D-Kovarianz wird um den Zerstreuungskreis (`Blende · Brennweite_px · |1/Fokus − 1/Tiefe|`, gedeckelt auf „Max. px“) verbreitert. Die Deckkraft sinkt dabei mit `sqrt(det_scharf / det_unscharf)`, damit die Energie gleich bleibt. Weil das im Projector passiert, sieht der Viewport genauso aus wie jeder Bild- und Video-Export. Pick- und Selektionspässe (`forPick`) bleiben scharf.

### Bedienung (Szenen-Manager → KAMERAS)
- **Tiefenschärfe**: Schalter. **Pipette**: Der nächste Klick in den Viewport stellt auf die Fläche darunter scharf und schaltet die Tiefenschärfe ein.
- **Fokus**: Abstand der Schärfeebene (View-Tiefe, Welteinheiten). **Blende**: Linsenradius, größer bedeutet weniger Schärfentiefe. **Max. px**: Obergrenze der Unschärfe.
- **◆ Key**: keyt Fokus und Blende am aktuellen Frame. Die Spur **Fokus** erscheint dann in der Timeline (blau, unter „Schnitt“), Klick darauf macht sie zum Key-Ziel („Key → Fokus“). Keys lassen sich im Lineal verschieben und löschen, Undo/Redo funktioniert. Interpolation: smoothstep.
- Wie bei den anderen animierten Werten überschreibt die Spur beim Scrubben den Wert. Nach Pipette oder Slider also neu keyen.

### Umsetzung
- `src/dof/dof.ts`: Zustand, `DofTrack` (AnimTrack), Pipette (`scene.camera.intersect(...).depth`), Events `dof.set` / `dof.addKey` / `dof.pickFocus` / `dof.selectTrack`, Funktion `dof.params` für den Renderer, Projekt-Serialisierung (`document.dof`).
- `src/projected-splat-renderer.ts`: Uniform `dofParams` (an, 1/Fokus, Blende, Max-Blur).
- `track-manager.ts`: Key-Ziel `dof`. `ui/timeline-tracks.ts`: Fokus-Zeile. `ui/camera-list.ts`: UI.

### Verifiziert (`test-data/house.ply`)
- Fokus weit hinter dem Haus: starke Unschärfe, die nahe Ecke am stärksten, die Farben bleiben satt.
- Pipette auf Bildmitte setzt den Fokus auf 3,79 (Treffertiefe).
- Keys bei Frame 0 (Fokus 2,5) und 60 (Fokus 12): Frame 30 ergibt 7,25. Undo entfernt den Key, Redo stellt ihn wieder her.
- MP4-Export `test-data/out/dof_pull.mp4`: Frame 0 unscharf, Frame 30 und 60 scharf (Kontaktabzug `dof_sheet.png`).
- Nebenbei behoben: Transitions- und Layer-Animations-Bedienelemente waren ohne gewählten Layer sichtbar. Eigene `display`-Regeln hatten `.pcui-hidden` überstimmt (`layer-anim-panel.scss`).

## Key-Button keyt alle geänderten Werte

Früher hat der ◆-Button der Timeline (und `track.addKey`) nur das **Key-Ziel** gekeyt, also die zuletzt gewählte Kamera, den Splat, den Schnitt oder den Fokus. Wer erst einen Layer verschoben und dann den Fokus geändert hatte, bekam nur einen Key für den Fokus.

Jetzt gilt:
- Jede Nutzer-Änderung am aktuellen Frame merkt sich die Spur als „geändert“. Gemerkt werden Layer-Transform (`pivot.ended`), Deckkraft und Punkt-Mix (`layerAnim.setOpacity` / `setMix`), Schnitt-Wert (`section.set` mit `value`) sowie Fokus und Blende (`dof.set`, auch die Pipette).
- Der ◆-Button keyt das Key-Ziel **und** alle geänderten Spuren in **einem** Undo-Schritt (`MultiOp`).
- Der Wechsel auf einen anderen Frame verwirft die Merkliste. Gekeyte Spuren werten dort ohnehin neu aus, die Änderung wäre also weg.
- Das Label neben den Buttons zeigt z. B. „Key → Splat: haus + 2 geändert“, der Tooltip nennt die Spuren.
- Die Kamera wird nur gekeyt, wenn sie das Key-Ziel ist. Bloßes Umsehen im Viewport soll keine Kamera-Keys erzeugen.
- Die ◆-Key-Knöpfe in den einzelnen Panels (Fokus, Schnitt, Layer) keyen weiterhin nur ihre eigene Spur.
- Umsetzung: `track-manager.ts` (Merkliste, `track.pending`), Label in `ui/timeline-panel.ts`.
- Verifiziert: Splat-Deckkraft, Fokus und Schnitt geändert, dann ein Klick auf ◆ ergibt Keys auf allen drei Spuren bei Frame 10. Undo nimmt alle drei zurück, Redo stellt sie wieder her. Ein Frame-Wechsel leert die Liste.

## UI-Überarbeitung: Szenen-Manager nach Relevanz, einklappbare Sektionen, schwebende Panels

### Szenen-Manager (`src/ui/scene-panel.ts`)
Neue Reihenfolge von oben nach unten:
1. Splats
2. **Transformation**
3. Kameras
4. Layer-Animation
5. Transitions
6. Punktwolke
7. Bereinigen
8. Farbe

Begründung: Layer wählen und platzieren ist der häufigste Arbeitsschritt, deshalb steht die Transformation direkt unter der Layer-Liste und nicht mehr ganz unten. Kameras kommen danach, weil jede Animation eine Kamera braucht. Danach folgen die Werkzeuge pro Layer: Animation, Transitions, dann die globale Darstellung. Bereinigen und Farbe sind seltene, einmalige Arbeitsgänge und stehen am Ende.

- **Einheitliche Sektionen** (`src/ui/collapsible.ts`, `CollapsibleSection`): Kopfzeile mit Pfeil, Icon, Titel, Kurzinfo rechts und optionalen Buttons (z. B. + / ⧉ bei Kameras). Ein Klick auf die ganze Kopfzeile klappt, Enter und Leertaste ebenfalls. Der Zustand wird pro Sektion in `localStorage` gespeichert (`splatmania.ui.sections`, mit try/catch).
- **Standard:** Splats, Transformation und Kameras sind offen, der Rest ist zu.
- **Kurzinfos:** „1 Layer“, Name des gewählten Layers, „2 Kameras“, „3 Keys“, „Dissolve 0–30“ (gewählte Transition) bzw. „2×“, „Splats/Punktwolke“, „splat-transform“. Die Tiefenschärfe-Untergruppe zeigt „an · Fokus“.
- **Untergruppen** (`advancedGroup` bzw. `CollapsibleSection` mit `sub: true`), standardmäßig zu:
  - Transitions → **Erweitert**: Kante, Glühkante, Streuung, Wirbel, Glühfarbe, Seed / Punkte zuerst. Die Gruppe steht unter den Dissolve-Einstellungen.
  - Punktwolke → **Erweitert**: Größe in Pixel/Welt, Glühen.
  - Kameras → **Tiefenschärfe**: An, Pipette, Key, Fokus, Blende, Max. px.
- **Look:**
  - Zwischen den Sektionen dünne Trennlinien (#3a3150), unter einer offenen Kopfzeile eine magentafarbene Linie (rgba(194,14,126,.35)).
  - Untergruppen sind eingerückt und haben eine Magenta-Kante links.
  - Hover-Fläche #221d30.
  - Die Panelbreite bleibt bei 320 px, wird es zu hoch, scrollt es wie bisher.
- Die eigene Klapp-Logik der Farbe-Sektion wurde durch `CollapsibleSection` ersetzt.
- Layer-Animation und Transitions haben neue Icons (Figur bzw. Halbkreis), weil die alten Dreiecke wie Klapppfeile aussahen.

### Schwebende Panels (`src/ui/floating-panel.ts`, `makeFloating`)
Das Tiefenfilter-, Schnitt-, Qualitäts- und Ausrichten-Panel haben jetzt eine echte Titelzeile:
- **Ziehen** an der Titelzeile verschiebt das Panel (Griff-Cursor). Es bleibt immer vollständig im Viewport, auch nach einem Fenster-Resize. Gespeichert wird die gewünschte Position: Wird das Fenster wieder größer, kehrt das Panel dorthin zurück.
- **▾/▸** minimiert das Panel auf die Titelzeile.
- **Doppelklick** auf die Titelzeile setzt es auf die Standardposition zurück.
- Position und Zustand werden pro Panel in `localStorage` gespeichert (`splatmania.ui.floating`).
- Beim Tiefenfilter sitzt der Ein/Aus-Schalter in der Titelzeile und bleibt auch minimiert sichtbar. Ist der Filter aktiv, zeigt die Titelzeile außerdem „0–3 m“.
- Hinweis zum Testen: Bei ausgeblendetem Preview-Pane feuern weder `ResizeObserver` noch rAF. Deshalb wird die gespeicherte Position sofort gesetzt, und das Clamping hängt zusätzlich am `resize`-Event des Fensters.

### Verifiziert (Klicktest, 1280×800, `test-data/house.ply`)
- Tiefenfilter an der Titelzeile verschoben, minimiert, neu geladen: Position (777/463) und der minimierte Zustand bleiben.
- Bei 880×580 rückt das Panel an den rechten Rand (578–880), statt herauszuragen. Doppelklick setzt es zurück, die Kurzinfo zeigt „0–3 m“.
- Punktwolke auf- und Kameras zugeklappt, neu geladen: Der Zustand bleibt. Die Reihenfolge stimmt, Transformation steht direkt unter Splats.
- Das Schnitt-Panel hat die Titelzeile „Schnitt“.
- Screenshots: `test-data/out/ui_before.jpg`, `ui_after.jpg`, `ui_after_transitions.jpg`.
- `tsc --noEmit` und `eslint src` sind sauber.

## Neu: Kamerapfad im Viewport bearbeiten (Werkzeug `cameraPath`, Shortcut X)

Starten mit **X** oder über den Knopf „✎ Pfad bearbeiten (X)“ in der Kameras-Sektion. Solange das Werkzeug aktiv ist, wirken Klicks im Viewport auf die Kamera-Keys statt auf die Splat-Selektion. Esc oder ein anderes Werkzeug beendet es.

### Bedienung
- **Marker:** Jeder Key der gewählten Kamera bekommt einen Ring in der Kamerafarbe mit Frame-Nummer. Sein **Ziel** ist eine kleinere Raute, verbunden durch eine gestrichelte Linie.
  - Hover und Auswahl heben den Marker magenta hervor (#e6128a / #c20e7e).
  - Keys anderer Kameras sind gedimmt, ein Klick darauf wählt diese Kamera.
- **Klick** auf einen Marker wählt den Key: Die Timeline springt auf dessen Frame, die Ansicht bleibt, und das TranslateGizmo hängt daran.
- **Ziehen:**
  - Direkt am Marker verschiebt man in der Bildebene, in der Tiefe des Punkts.
  - Am Gizmo verschiebt man entlang der Achsen bzw. Ebenen.
  - **Alt** verschiebt Position und Ziel gemeinsam. Die FOV bleibt unverändert.
  - Der Spline-Pfad folgt live.
- **Shift-Klick auf die Pfad-Linie** (Toleranz 10 px) fügt an dieser Stelle einen Key ein. Frame ist der nächste ganze Frame auf der Kurve, die Pose ist die interpolierte, so bleibt der Pfad gleich.
- **Entf** löscht den gewählten Key, **F** fokussiert die Ansicht auf ihn (über `getFocus`).
- **Undo:** Jeder Drag (Marker oder Gizmo), jedes Einfügen und jedes Löschen ist genau ein Undo-Schritt (`AnimTrackEditOp`, Snapshot vor und nach).

### Verträglichkeit
- Ist beim Start „Durchschauen“ oder „Schnitt“ aktiv, stellt das Werkzeug den Viewport auf **Frei** und zeigt das in der Werkzeugleiste an. Sonst würde die eigene Ansicht beim Ziehen bzw. beim Sprung auf den Key-Frame mitfahren.
- Die Marker sind HTML über dem Canvas. Tiefenfilter und Schnitt blenden sie deshalb nicht aus, und im Export tauchen sie nie auf. Das Gizmo läuft im Gizmo-Layer, ebenfalls nicht im Export.
- Pfad-Linien werden beim Start eingeschaltet, falls sie aus waren.
- Am `.ssproj`-Format ändert sich nichts: Es werden nur die vorhandenen Posen geändert.
- `Entf` löscht im aktiven Werkzeug keine Gaussians (Guard in `editor.ts` wie bei Messen und Orient).

### Umsetzung
- `src/tools/camera-path-tool.ts`: Werkzeug mit Overlay (`#camera-path-overlay`, SVG-Linien plus Marker-Divs), Gizmo, Shift-Insert, Delete und Fokus.
  - Während eines Marker-Drags werden die Marker nicht neu aufgebaut, sonst gingen Element und Pointer-Capture verloren. Die Auswahl schaltet nur eine Klasse um.
- `CameraAnimTrack.setKeyPose()` und `insertKey()` in `src/camera-poses.ts`.
- Styles in `src/ui/scss/camera-path.scss`.
  - Die Raute ist ein Quadrat mit `rotate(45deg)` im selben `transform`. Die CSS-Eigenschaft `rotate` würde vor `transform` greifen und die Verschiebung mitdrehen.
- Shortcut `tool.cameraPath` auf X in `shortcut-manager.ts`.

### Verifiziert (Klicktest, `test-data/house.ply`, Kamera mit Keys 0/60/120 um das Haus)
- Mittleren Key per Maus gezogen: Position (0, 3, 8) wird zu (0, 1,63, 9,34), die Pfad-Mitte bei Frame 30 folgt. Undo stellt (0, 3, 8) wieder her, Redo die neue Position.
- Gizmo-Y-Pfeil gezogen: nur Y ändert sich (1,63 → 3,66), die Editor-Kamera bleibt stehen.
- Ziel von Key 120 gezogen: nur das Ziel ändert sich.
- Shift-Klick auf den Pfad: Key bei Frame 31. Entf löscht ihn, Undo bringt ihn zurück. Die Splat-Anzahl bleibt bei 19.959.
- F fokussiert den gewählten Key.
- Zweite Kamera: Die Keys der ersten werden gedimmt (3), ein Klick wählt Kamera 1 wieder.
- Start im Durchschauen-Modus: Das Werkzeug schaltet auf Frei und zeigt den Hinweis.
- MP4-Export mit Kamera 1 (`shot: { mode: 'camera' }`, `test-data/out/camera_path_edit.mp4`, 122 Frames): Der hochgezogene Key bei Frame 60 schaut von oben aufs Dach, im Bild sind keine Marker (Kontaktabzug `camera_path_sheet.png`).
- Screenshots: `test-data/out/path_before.jpg`, `path_after.jpg`.
- Hinweis: Im Viewport-Modus „Frei“ fährt der Export die Editor-Ansicht, nicht die Kamera. Dafür im Export-Dialog die Kamera bzw. den Schnitt wählen.

### Idee (nicht gebaut)
- Bild-im-Bild-Vorschau (z. B. 240×135) der Sicht durch die Kamera am gezogenen Key. Bräuchte einen zweiten Render-Target-Pass für die Splats und ist deshalb ein größerer Umbau.

## Neu: Stereo-360 (VR) und Panoramen aus den Kameras

### Bedienung
- **Rendern → Bild/Video → Projektion „360° Stereo (oben/unten)“**: oben linkes Auge, unten rechtes Auge, Gesamtbild 1:1, jedes Auge 2:1 equirect. Presets im Bild 2048² bis 8192², im Video 1024² bis 8192²; was der Encoder oder die Textur-Grenze nicht schafft, wird wie bisher ausgegraut.
- Regler (nur bei Stereo):
  - **Augenabstand**: Standard 0,064 Szeneneinheiten, also 6,4 cm in einer Szene in Metern. Eine unskalierte PLY kann andere Einheiten haben, der Tooltip weist darauf hin.
  - **Pol-Überblendung ab**: Standard 50°.
  - **Stereo-Qualität**: 48, 96, 112 oder 160 Segmente pro Auge.
  - Horizont-Ausrichtung wie bei Mono-360.
- **Quelle** (Bild, Mono und Stereo):
  - Aktuelle Ansicht
  - Kamera am aktuellen Frame
  - Alle Keyframes einer Kamera
  - Alle Kameras am aktuellen Frame
  - Alle Keyframes aller Kameras
- **Ausrichtung bei Kamera-Quellen:** Die Panoramamitte folgt der Blickrichtung der Kamera bzw. des Keys, optional „Nord = Welt -Z“. Der Horizont ist immer gerade: nur der Yaw zählt, Pitch und Roll werden ignoriert.
- **Mehrere Panoramen** landen per Ordner-Dialog als `<Projekt>_<Kamera>_f<Frame>.jpg`, bei Stereo mit `_TB`. Ohne File-System-API gibt es Einzel-Downloads mit denselben Namen. Stereo-Videos bekommen ebenfalls `_TB`, auch bei „Alle Kameras einzeln“.
- **Video:** Mono- und Stereo-360 gelten für Schnitt, eine Kamera und alle Kameras, die Kamerapfade fahren als 360-Video.
- Stereo-Bilder und -Videos zeigen einen Fortschritt mit Abbrechen.

### Verfahren: omnidirektionales Stereo (ODS) aus Streifen (`src/ods-renderer.ts`, `src/shaders/ods-shader.ts`)
- **Warum ODS:** Zwei verschobene Würfelkameras liefern nur vorne die richtige Disparität. Seitlich fällt sie auf 0, hinten ist sie vertauscht.
- **Streifen:** Pro Auge und Azimut-Segment k wird eine schmale, hohe Perspektivkamera gerendert. Sie blickt mit Yaw θk und Pitch 0 und sitzt tangential auf dem Kreis mit Radius IPD/2 um den Aufnahmepunkt: linkes Auge links der Blickrichtung, rechtes Auge rechts davon. So hat jede Blickrichtung die Disparität, die ein Kopf hätte, der dorthin schaut.
- **Abdeckung:** Die Streifenkamera deckt ±72° Höhe ab. Im Equirect wird nur das Band θk ± Schrittweite geschrieben, mit Dreiecksgewichten. Benachbarte Streifen überlappen zu 100 % und ihre Gewichte summieren sich genau zu 1: eine weiche Überblendung ohne Nähte und ohne Normalisierungs-Pass, additiv geblendet.
- **Pole:** Zusätzlich werden die 6 Mono-Würfelflächen (IPD 0) gerendert. Ab der Pol-Überblendung (Standard 50°) blendet jeder Streifen über 15° (spätestens bis 70°) weich ins Mono-Panorama. Oben und unten entstehen so keine Doppelbilder. Ehrlicher Kompromiss: Das ist eine Bild-Überblendung, keine geometrisch abnehmende IPD; bei 50–65° ist die Disparität aber ohnehin klein.
- **Aufwand:** Ein Stereo-Frame braucht 6 + 2 × Segmente Render-Durchgänge. Im Test dauerte ein Bild 2048² mit 112 Segmenten ca. 4 s; ein 2-s-Video 1024² mit 48 Segmenten und 60 Frames ca. 90 s.
- **Strip-Format:** Der Splat-Renderer zieht nahe Objekte auf sehr schmalen, hohen Targets zu dünnen Nadeln aus (98 × 2006 px: deutlich, 600 × 2006: sauber). Die Streifen werden deshalb mindestens Höhe / 3,4 breit gerendert und nur ihre Mitte verwendet.
- **Weitere Änderungen dafür:**
  - Der Projector klemmt die Off-Axis-Steigung jetzt wie die 3DGS-Referenz auf 1,3 × halbe FOV. Das betrifft nur Splats außerhalb des Bildes.
  - 360-Bilder laufen jetzt im `lockedRenderMode` (sortierter Pfad), wie Videos schon immer. Sonst kann beim Springen der Kamera zwischen Flächen bzw. Streifen der adaptive stochastische Modus anspringen.

### Metadaten (`src/spherical-metadata.ts`)
- **Video Mono:** wie bisher Spherical Video V1 (uuid + GSpherical-XML).
- **Video Stereo:**
  - V1 mit zusätzlichem `<GSpherical:StereoMode>top-bottom`.
  - Spherical Video **V2**: `st3d` (stereo_mode 1 = top-bottom) und `sv3d` (svhd + proj/prhd/equi) am Ende des Sample-Entry (avc1/hvc1). Alle Vorfahren-Boxen wachsen mit, stco/co64 werden bei Fast-Start-Layout verschoben.
  - ffprobe meldet `stereo3d: top and bottom` und `spherical: equirectangular`.
- **Bilder Mono:** GPano-XMP. JPEG bekommt ein APP1-Segment nach JFIF, PNG einen iTXt-Chunk `XML:com.adobe.xmp`.
- **Bilder Stereo:** kein GPano. GPano kennt kein Top-Bottom, ein Tag würde Viewer das gestapelte Bild als verzerrtes Mono-Pano zeigen lassen. Erkennung über den Namenszusatz `_TB`, den Quest-, Skybox- und DeoVR-Player auswerten.
- WebM/MKV bekommen weiterhin keine Spherical-Tags (wie bisher bei Mono).

### Verifiziert
- **Disparität:** Synthetische Szene `test-data/make-stereo-test.py`: Wandzylinder r = 10, farbige Marker in 1,5 Einheiten Abstand vorne, hinten, links und rechts, ein weißer Marker direkt unter dem Aufnahmepunkt. Stereo-Bild 2048², IPD 0,064, ausgewertet mit `test-data/measure-disparity.py`.
  - Erwartet 2·asin(IPD/2/d) = 13,91 px, gemessen vorne +13,99, hinten +13,76, links +14,00, rechts +14,03 px.
  - Das Vorzeichen ist überall gleich, das linke Auge liegt weiter rechts. Hinten ist die Disparität also nicht vertauscht.
  - Der Pol-Marker ist in beiden Augen pixelgleich (0 px), es gibt kein Doppelbild.
- **Haus-Szene:** Mono-360 und Stereo-360 aus Kamera 1, Frame 0. Das Haus liegt mittig, die Panoramamitte folgt der Kamera.
- **Batch über den echten Dialog:** Ordner-Dialog als Stub, „Alle Keyframes aller Kameras“, 2 Kameras à 3 Keys. Ergebnis sind 6 Dateien `house_Kamera 1_f0_TB.jpg` … `house_Kamera 2_f90_TB.jpg`, alle mit dem Haus mittig.
- **Stereo-360-MP4:** 1024², 2 s, Kamera 1 fährt ihren Pfad; st3d, sv3d und StereoMode sind im File, ffprobe erkennt Stereo und Equirect. Mono-360-MP4 als Regressionstest: weiterhin `spherical: equirectangular`.
- Testdateien in `test-data/out/`:
  - Bilder: `stereo_test_TB.png`, `house_stereo_TB.jpg`, `house_mono.jpg`
  - Video: `stereo360_TB.mp4`
  - Kontaktabzüge: `batch_sheet.jpg`, `stereo360_sheet.png`

### Offen / Ideen
- Echte geometrisch abnehmende IPD zu den Polen (statt Bildüberblendung): bräuchte Streifen auch in der Höhe, also Kacheln statt Streifen.
- Die Nadel-Artefakte des Renderers bei extremen Seitenverhältnissen sind nur umgangen, nicht behoben. Vermutlich ein Problem im Raster-Pfad.
- Stereo-Bilder mit Google-Cardboard-XMP (GImage) wären möglich, sind aber kaum noch verbreitet.

## Englisch als Standard, alle Fork-Texte über i18n

- **Standardsprache Englisch:** `src/ui/localization.ts` erkennt die Sprache nur noch über `?lng=` und eine explizit gewählte Sprache (localStorage `i18nextLng`). Browsersprache (`navigator`) und `htmlTag` werden nicht mehr ausgewertet; ohne Wahl gilt fallbackLng `en`. „Automatisch“ in den Einstellungen heißt jetzt „English (default)“ / „Englisch (Standard)“ und setzt auf Englisch zurück.
- **Alle Splatmania-Texte** laufen über i18n, Schlüssel-Präfix `sm.*` (rund 300 Schlüssel, vollständig in `en.json` und `de.json`; die übrigen 7 Sprachen fallen auf Englisch zurück). Betroffen sind u. a. Kameras, Tiefenschärfe, Layer-Animation, Transitions, Punktwolke, Bereinigen (auch Fehlermeldungen in cleanup.ts), Tiefenfilter, Schnitt, Qualität, Ausrichten, Pfad bearbeiten, Timeline-Zeilen und Key-Ziel, Bild-/Video-Dialog (Stereo, Quelle) und die schwebenden Panels.
- **Live-Umschaltung:** Feste Texte hängen per `bindText` / `bindOptions` und dem neuen `i18n.bindDom(el, key, 'textContent' | 'title')` an der Sprache. Zusammengesetzte Texte (Kurzinfos in Sektionsköpfen, Kameraliste, Timeline-Zeilen, Key-Ziel) werden über `i18n.onChange` neu aufgebaut. `CollapsibleSection`- und `makeFloating`-Titel sind jetzt i18n-Schlüssel. Mengen nutzen i18next-Plural (`_one` / `_other`).
- **Englische Begriffe:** Schnittspur = „Cut“, Schnitt-Werkzeug = „Section“, Ausrichten = „Align“, Bereinigen = „Clean up“. Neue Kameras heißen „Camera n“ (bzw. „Kamera n“, wenn Deutsch gewählt ist), Duplikate „… copy“. Exportierte Dateinamen übernehmen den Kameranamen, also z. B. `_Camera 1_f60_TB.jpg`.
- **Geprüft:** Skript-Suche nach deutschen String-Literalen außerhalb von Kommentaren (keine Treffer mehr); Schlüssel-Abgleich (alle 305 verwendeten Schlüssel in en und de vorhanden, keine deutschen Wörter in en.json). Im Browser mit Browsersprache Deutsch und ohne gespeicherte Sprache: alle Sektionen aufgeklappt, Ausrichten, Qualität, Schnitt, Pfad bearbeiten, Messen, Bild- und Video-Dialog mit Stereo-Optionen geöffnet: 666 sichtbare Texte, keiner deutsch. Mit explizit Deutsch: 663 Texte, kein englischer Splatmania-Text übrig. Live-Umschaltung Englisch → Deutsch ohne Neuladen funktioniert.

## Nachbesserungen nach dem Klicktest der Hauptsession

1. **Keine Startfehler „function not found 'selection'“ mehr**: Track-Manager, Layer-Animator, Layer-Animator-Panel und Zeitleisten-Zeilen fragen die Auswahl erst ab, wenn sie registriert ist (`events.functions.has('selection')`). Geprüft: Nach frischem Laden kamen keine neuen Meldungen hinzu.
2. **Zeitleiste**: Der Layername hat einen dunklen Hintergrund und liegt über den Transition-Blöcken. Beginnt ein Block unter dem Namen, rückt seine Beschriftung rechts daneben.
3. **Ausrichten-Panel**: Steht der Suchradius auf 0, wird „auto“ angezeigt; der Kern nimmt dann Überlappungs-Diagonale/50.
4. **Viewport-Modus**: Standard ist jetzt „Frei“. „Durchschauen“ gilt nur noch, wenn der Nutzer es wählt (oder ein Projekt es so gespeichert hat).
5. **Transitions-Liste**: feste Höhe von 72 px mit Scrollen. Ein neuer Block verschiebt das Panel darunter nicht mehr.

## Neu: splat-transform-Integration (Bereinigen + Export)

### Bestand in SuperSplat 3.5.2
SuperSplat nutzt `@playcanvas/splat-transform` 3.9 bereits intern für Lesen, Schreiben, Zip und Viewer. Der Export-Dialog konnte schon PLY, Compressed PLY, SPLAT, **SOG**, **SPZ (v3/v4)** und den **HTML-Viewer** (Einzeldatei oder ZIP), jeweils für alle sichtbaren Layer. Diese Formate habe ich nicht doppelt gebaut.

Lücken, die jetzt geschlossen sind:
- **„Nur aktiver Layer“**: neuer Schalter im Export-Dialog für PLY, SPLAT, SOG, SPZ und Viewer. Vorher war `splatIdx` fest auf `'all'`.
- **HTML-Viewer mit allen Kameras**: Jede Shot-Kamera wird ein eigener `animTrack` mit dem Kameranamen und eine Viewer-Kamera an ihrem ersten Key. Die gewählte Kamera kommt zuerst, weil der Viewer die erste Spur startet.

### Bereinigen (Szenen-Manager → BEREINIGEN, wirkt auf den ausgewählten Layer)
- **Floater finden** (`filterFloaters`: Voxelgröße / Deckkraft-Schwelle / minimaler Beitrag, Standard 0,05 / 0,1 / 0,004) und **NaN-Splats** (`filterNaN`).
- **Cluster behalten** (`filterCluster`: Voxelgröße / Schwelle / Beitrag, Standard wie in der CLI 1,0 / 0,999 / 0,1). Den Seed übernehmen `Seed = Pivot` und `Seed = Fokus` (Kamera-Fokus, z. B. nach einem Doppelklick in die Szene), oder man gibt ihn numerisch ein.
- **Nicht destruktiv**:
  - Die Daten des Layers gehen als Welt-DataTable an splat-transform, mit einer zusätzlichen Spalte für den Instanz-Index. Diese Spalte überlebt das `clone({rows})` der Filter.
  - Was ein Filter verwerfen würde, wird als **Selektion** gesetzt. Gelöscht wird mit Entf über den normalen Editor-Weg mit Undo.
  - Optional löscht der Schalter „Direkt löschen“ sofort, ebenfalls mit Undo.
- **Decimate** (Prozent oder Anzahl, optional adaptiv, optional SH-Bänder reduzieren):
  - Erzeugt neue Daten. Sie werden als PLY im Speicher geschrieben und als **neuer Layer** importiert.
  - Das Original bleibt erhalten und wird ausgeblendet.
  - Rückgängig: den neuen Layer löschen und das Original wieder einblenden.
- Allgemein:
  - Fortschrittsanzeige mit den Fortschrittsbalken von splat-transform.
  - Abbrechen verwirft das Ergebnis; der Schritt selbst läuft aber zu Ende.
  - Ohne WebGPU erscheint bei den Voxel-Filtern eine klare Fehlermeldung.
  - Die letzte Log-Meldung von splat-transform steht im Ergebnis, z. B. „all blocks in one cluster, no filtering needed“.
- Für die GPU-Voxelisierung wird das Editor-Gerät mitbenutzt. splat-transform zerstört nur seine eigenen Voxel-Ressourcen.

### Verifiziert
| Test | Ergebnis |
|---|---|
| `wall-floaters.ply`: 300 voll deckende Floater (Deckkraft 0,98), Floater-Filter mit Standardwerten | 0 gefunden: Jeder deckende Floater bildet einen eigenen soliden Voxel. Das ist eine Eigenschaft des Algorithmus. |
| Dieselbe Szene, Cluster-Filter mit CLI-Standard (1,0 / 0,999) | 0 gefunden, laut Log liegt alles in einem Block-Cluster |
| Dieselbe Szene, Cluster-Filter mit 0,25 / 0,5, Seed (0,0,0) | **300 von 300 Floatern, 0 von 6400 Wand-Splats** |
| `wall-fog.ply` (neu): 300 halbtransparente Floater (Deckkraft 0,12), Floater-Filter mit Standard 0,1 | 0 gefunden, weil 0,12 über der Schwelle liegt |
| `wall-fog.ply`, Floater-Filter mit Schwelle 0,3 | **300 von 300, Wand intakt** |
| Löschen, Undo, Redo | funktioniert |
| Decimate 50 % | 6700 → 3350 Splats als neuer Layer, Bounding-Box deckungsgleich |
| Export SOG (alle sichtbaren Layer) | 32 KB, Re-Import: 10.050 Splats = 6700 + 3350 |
| Export SPZ v4 (nur aktiver Layer) | 10 KB, Re-Import: 3350 Splats |
| Export HTML-Viewer | 3,5 MB, enthält die Spuren „Kamera 1“ und „Kamera 2“, öffnet und rendert im Browser (WebGPU, ohne Fehler) |

Die Dateien liegen in `test-data/out/export-*`.

### Grenzen
- Die CLI-Standardwerte sind für echte, metrische Scans gedacht. Bei kleinen oder synthetischen Szenen müssen Voxelgröße und Schwellen angepasst werden; das Panel zeigt dazu die Log-Meldung.
- Decimate ist nicht direkt rückgängig machbar. Gesichert ist es über das ausgeblendete Original.
- Abbrechen stoppt keinen laufenden splat-transform-Schritt, es verwirft nur das Ergebnis.

## Überblendung am Schnitt (Cross-Fade)

### Bedienung
- Szenen-Manager → **Kameras** → **Überblendung** (Frames): Der Wert gilt für den Schnitt, mit dem das Segment unter dem Abspielkopf beginnt. Das Feld ist gesperrt, wenn dort kein Schnitt ist, also im ersten Segment oder wenn die vorige Kamera dieselbe ist. Die Obergrenze ist die Segmentlänge.
- Die Überblendung beginnt am Schnitt-Frame und dauert n Frames. Die neue Kamera wird linear über die alte geblendet: Beim ersten Frame ist schon 1/(n+1) zu sehen, nach n Frames nur noch die neue.
- **Timeline**: Das Segment beginnt mit einem Verlauf in der Farbe der vorigen Kamera, der Tooltip nennt Kamera und Länge.
- Undo/Redo über `cut.setFade` (Schnitt-Edit wie `cut.set`). Wird ein Segment auf denselben Start-Frame neu gesetzt, behält es seine Überblendung.
- Gespeichert wird im `.ssproj` unter `cuts.segments[].fade`, nur wenn größer als 0.
- **Wirkt nur im Video-Export** mit Kamera „Schnitt“. Viewport und Vorschau schneiden hart.

### Umsetzung
- `src/camera-poses.ts`: `CutSegment.fade`, `CutTrack.cutFrom()`, `setFade()`, `fadeAt(time)` → `{ from, to, alpha }`, Funktion `cut.fadeAt`.
- `src/render.ts`: In einem Überblend-Frame wird zuerst die alte Kamera gerendert (Render-Override auf diese Kamera, eigener Sortierlauf) und in `fadeData` gelesen. Danach kommt wie gewohnt der Schnitt-Frame, dann `mixFade` auf der CPU (8-Bit-Festkomma, alle vier Kanäle, also auch bei transparentem Hintergrund). Außerhalb der Überblendung bleibt der Export unverändert. 360°-Exporte überblenden nicht.
- UI: `ui/camera-list.ts` (Regler), `ui/timeline-tracks.ts` (Verlauf).

### Verifiziert (`house.ply`)
- Kamera 1 schaut aufs Haus, Kamera 2 vom selben Punkt in die leere Gegenrichtung. Schnitt bei Frame 30 mit 20 Frames Überblendung.
- `fadeAt`: Frame 29 –, 30 → 0,048, 39,5 → 0,5, 49 → 0,952, 50 –. Das Feld ist bei Frame 35 aktiv und bei Frame 10 gesperrt.
- MP4-Export 320×180, 60 Frames, H.264 (2,4 s). Das Video wurde im Browser per `<video>` dekodiert und die mittlere Helligkeit gemessen:

  | Frame | 0–29 | 30 | 35 | 40 | 45 | 49 | 50+ |
  |---|---|---|---|---|---|---|---|
  | gemessen | 97 | 92,1 | 68,5 | 45,6 | 22,3 | 3,8 | 0 |
  | erwartet 97·(1−α) | 97 | 92,4 | 69,6 | 46,4 | 23,2 | 4,7 | 0 |

- Undo und Redo der Länge, Round-Trip über `docSerialize.cuts`/`docDeserialize.cuts`. Ein Segment von Kamera 1 über den Bereich entfernt den Schnitt (zusammengeführt), Undo bringt ihn samt Überblendung zurück.
- Screenshot: Der Verlauf in der Schnittspur ist sichtbar.

## Undo für die Kameraliste

Hinzufügen, Duplizieren, Löschen und Umbenennen von Kameras ist jetzt je ein Undo-Schritt (Strg+Z / Strg+Umschalt+Z).
- Umsetzung in `src/camera-poses.ts`: Ein `rig`-Objekt mit `snapshot`/`restore` hält die Kameraliste (IDs, Namen, Farben), die Auswahl und die Schnittspur. Es läuft über die vorhandene `AnimTrackEditOp`. Die Keys selbst gehören nicht zum Snapshot, sie haben ihr eigenes Undo.
- Gelöschte Kameras bleiben in einem Pool (`pool`, ID → Kamera) und werden nicht mehr zerstört. Undo holt **dasselbe Objekt** zurück. Key-Edits, die schon im Verlauf stehen, zeigen deshalb weiter auf die richtige Spur. Erst `scene.clear` und das Laden eines Projekts räumen den Pool, dabei wird der Verlauf ohnehin geleert.
- Löschen entfernt auch die Schnitt-Segmente der Kamera, Undo stellt sie wieder her.
- Umbenennen auf denselben Namen erzeugt keinen Schritt.
- Verifiziert (`house.ply`):
  - Kette Hinzufügen → Schnitt 30–60 → Duplizieren → Umbenennen in „Totale“ → Löschen, danach Schritt für Schritt zurück und wieder vor. Liste, Auswahl und Schnitt-Segmente stimmen in jedem Schritt.
  - Kamera mit 2 Keys gelöscht, Undo: dieselbe Kamera mit 2 Keys. Zwei weitere Undos nehmen die Keys zurück.
  - Per Klick auf „Kamera hinzufügen“, dann Strg+Z und Strg+Umschalt+Z über die Tastatur.

## Offline und als App installieren (PWA)

### Prüfung der Netzwerkabhängigkeiten
- Im Bundle (`dist/index.js`, `index.css`, `analysis-worker.js`) gibt es keine CDN-Abhängigkeit. Die Engine, PCUI, splat-transform, mediabunny und i18next sind eingebündelt. Das Icon-Font steckt als `data:`-URL im CSS. Die Sprachen kommen aus `static/locales`, der WebP-Decoder aus `static/lib/webp/webp.wasm`.
- Laufzeitprüfung im Browser (`performance.getEntriesByType('resource')` und Netzwerkliste): Nach dem Laden mit `house.ply` gab es nur Anfragen an `localhost:3000`.
- Was online bleibt, aber nur bei ausdrücklicher Aktion:
  - Links im Hilfe- und About-Menü öffnen ein neues Fenster.
  - **Veröffentlichen** (PlayCanvas-Cloud) braucht das Login von playcanvas.com. Der Menüpunkt samt Trenner ist deshalb nur noch auf `*.playcanvas.com` sichtbar (`canPublish` in `ui/menu.ts`). Lokal und in der installierten App ist er ausgeblendet, geprüft im Datei-Menü.
  - Der exportierte HTML-Viewer lädt im WebXR-Modus Controller-Profile von jsdelivr. Das betrifft nur die exportierte Datei und dort nur XR.

### Service Worker (`src/sw.js`, Build-Plugin `service-worker.mjs`)
- Das Rollup-Plugin schreibt `dist/sw.js` mit der Liste aller Dateien dieses Builds (ohne Source Maps, plus `analysis-worker.js` aus dem zweiten Bundle). Die Cache-Version ist ein Hash über die Inhalte: Jeder neue Build bekommt einen neuen Cache (`splatmania-<hash>`), und der alte wird beim Aktivieren gelöscht.
- Strategie **Netzwerk zuerst**: Läuft der Server, kommt immer der aktuelle Stand, auch im Dev-Watcher. Der Cache antwortet nur, wenn das Netzwerk fehlt. Navigationen mit Query (z. B. `?load=…`) finden offline trotzdem `index.html`.
- Szenendateien (`.ply`, `.splat`, `.sog`, `.spz`, `.ksplat`, `.ssproj`, `.zip`) und Range-Anfragen werden nie gecacht, weil sie riesig sein können. Lokale Dateien öffnet man offline ohnehin per Datei-Dialog oder Drag & Drop.
- `index.html` registriert `./sw.js`, sobald ein Secure Context besteht (`localhost` oder HTTPS). Fremde Service Worker auf demselben Origin und alte `superSplat-v*`-Caches werden wie bisher entfernt.
- Manifest: `display: standalone` statt `fullscreen`, damit das installierte Fenster Titelleiste und Fensterknöpfe behält. Theme- und Hintergrundfarbe sind #15121e, dazu kommt `id: ./`. `file_handlers` war schon da, `main.ts` nimmt die Dateien über `launchQueue` entgegen. Ist die App installiert, öffnen PLY, SPLAT, SOG, SPZ, KSPLAT und SSPROJ per Doppelklick direkt in Splatmania.

### Installieren
1. Einmal `npm run build` und `npm run serve` ausführen (oder den Dev-Server starten) und `http://localhost:3000` in Chrome oder Edge öffnen.
2. Über das Installieren-Symbol in der Adressleiste installieren.
3. Danach startet die App aus dem Startmenü, auch ohne laufenden Server. Updates kommen, sobald der Server wieder läuft und die App einmal neu lädt.
- `file://` geht nicht: Service Worker und Modul-Worker brauchen HTTP(S).

### Verifiziert
- Service Worker aktiv, Seite kontrolliert, 18 Dateien im Cache.
- **Offline-Test**: Dev-Server gestoppt (Port 3000 frei), dann neu geladen. Der Editor startet vollständig mit deutscher Oberfläche, Szenen-Manager und Canvas, der Analyse-Worker lässt sich starten. Danach Server wieder gestartet: Neue Builds kommen ohne manuelles Leeren des Caches an.

## Was SuperSplat für die Roadmap schon mitbringt

### Layer (mehrere Splats)
- Der **Szenen-Manager** (`src/ui/splat-list.ts`, `scene-panel.ts`) lädt beliebig viele PLY/SOG/SPZ/… gleichzeitig, jede als eigenes `Splat`-Element.
- Pro Layer gibt es Sichtbarkeit, Umbenennen, Löschen, Transformation (Position, Rotation, Skalierung) und das Farb-Panel (Grade).
- Selektion und Bearbeitung wirken immer auf den **aktiven** Layer (`selection`), die anderen werden beim Pick ausgeblendet.
- Beim Export (`splat-serialize.ts`) werden alle übergebenen Splats zusammengeführt.
- Projekte werden als `.ssproj` gespeichert (Zip mit `document.json` und Ressourcen) und behalten Layer und Edit-Zustand.
- Es **fehlen**: Layer-Gruppen, Deckkraft und Blend-Modi pro Layer, Sperren ganzer Layer im UI (Sperren gibt es nur auf Splat-Ebene) und das Aufteilen einer Selektion in einen neuen Layer.

### Kameras und Keyframes
- **Zeitleiste** (`src/timeline.ts`, `ui/timeline-panel.ts`): Bildanzahl (Standard 180), Framerate (30), Glättung, Abspielen und Scrubben.
- **Kamera-Animationsspur** (`src/camera-poses.ts`, `CameraAnimTrack`): Keyframes mit Position, Ziel und optional FOV, interpoliert per kubischem Spline (`anim/spline.ts`). Hinzufügen und Löschen ist rückgängig machbar (`track-manager.ts`, `AnimTrackEditOp`). Posen werden im Projekt gespeichert und mit `camera-pose-gizmos.ts` in der Szene angezeigt.
- Ursprünglich gab es nur **eine** Kameraspur, inzwischen sind es mehrere (siehe „Multi-Kamera-Timeline“). Die `AnimTrack`-Schnittstelle ist generisch (`addKey`, `removeKey`, `snapshot`, `restore`), animierte Layer-Transformationen lassen sich daran andocken.
- `sequence.ts`: PLY-Sequenzen (`frameNNNN.ply`) als 4D-Animation entlang der Zeitleiste.

### Video-Export
- `src/render.ts` und `video-config.ts` exportieren **offline** Bild für Bild über WebCodecs `VideoEncoder` und `mediabunny` (Muxer). Das ist kein Echtzeit-Mitschnitt.
- Container: **MP4**, WebM, MOV, MKV. Codecs: **H.264**, H.265, VP9, AV1. Bitrate, Bildbereich (Start/Ende), Framerate und Auflösung bis 4K/8K sind einstellbar, je nachdem, was die GPU kann. Der Codec-Level wird automatisch gewählt.
- Optional: transparenter Hintergrund, 360°-Equirect inklusive Spherical-Metadaten, Horizont-Ausrichtung. Bildexport (PNG/WebP) gibt es ebenfalls.
- Die Kamera folgt beim Export der Kamera-Animationsspur.

**Fazit:** Layer, Keyframe-Timeline und MP4-Export waren als Grundgerüst vorhanden. Mehrere Kameraspuren mit Schnitt, Layer-Animation und ein Punktwolken-Modus sind inzwischen ergänzt (siehe oben). Offline-Betrieb und Installation als App laufen über die PWA (siehe „Offline und als App installieren“), eine Desktop-Hülle wie Electron oder Tauri ist dafür nicht nötig.

## Keyframes pro Eigenschaft, Kamera-Objektiv, Schnittspur (09.11.2026)

- **Kamera-Kanäle** (`src/camera-poses.ts`, `CameraAnimTrack`): `position`, `target` (als Rotation angezeigt: Neigung/Schwenk), `fov` (Objektiv, im Panel als mm Kleinbild + Grad), `focus`, `aperture`. Jeder Kanal hat eigene Keys und einen eigenen Spline; ohne Keys gilt der Grundwert `base`. Ungekeyte Änderungen an animierten Kanälen sind ein Override bis zum Frame-Wechsel (Key-Knopf orange).
- **Schärfentiefe gehört zur Kamera**: `dof.ts` hat keine eigene Spur mehr; der Kamera-Rig schiebt Fokus/Blende der gefolgten (sonst gewählten) Kamera per `dof.lens`. An/Aus und Max-Blur bleiben global. Alte Projekte: `docDeserialize.dof` verschiebt die Fokus-Keys auf Kamera 1 (`shotCameras.importFocus`).
- **Key-Knöpfe** (`src/ui/key-button.ts`) an jeder Eigenschaft: Kamera-Panel, Transform (Splat), Deckkraft/Punkt-Mix, Schnitt-Regler, Kanal-Zeilen der Timeline. ◇ grau = nicht animiert, ◇ magenta = animiert, ◆ = Key hier (Klick löscht), orange = geändert, nicht gekeyt.
- **Auto-Key** keyt genau die geänderten Kanäle (Pivot-Vorher/Nachher-Vergleich bei Splats, Panel-Werte, Navigation im Durchblick-Modus, Schnitt-Regler). Der Haupt-◆ keyt die im Label gelisteten Kanäle (Transform + bereits animierte/geänderte).
- Das Schnitt-Werkzeug macht die Section **nicht** mehr heimlich zum Key-Ziel; nur Klick auf ihre Zeile.
- **Viewport-Navigation im Modus „Durchblick“/„Schnitt“ bewegt die Kamera** (nach 450 ms Ruhe übernommen). Im freien Modus nicht. Das freie FOV wird beim Verlassen wiederhergestellt.
- **Timeline**: ▸ klappt Kamera/Splat in Kanal-Zeilen auf (Keys einzeln ziehen/Rechtsklick löschen). ● = Kamera ist am Playhead im Schnitt live, ✂ = ab Playhead auf diese Kamera schneiden.
- **Schnittspur**: Klick auf Shot = hinspringen (überschreibt nicht mehr), Kante ziehen = Trim bzw. Roll-Edit mit angrenzendem Shot (`CutTrack.trim`), Rechtsklick = Menü Kamera wechseln/löschen, Ziehen im Leeren = neuer Shot.
- **Projektion pro Kamera** (`ShotCamera.projection`: standard / equirect / stereo, `ipd`): im Kamera-Panel umschaltbar (Objektiv-Zeile verschwindet bei 360°), Badge in der Kameraliste, undo-fähig über den Rig-Snapshot, gespeichert in `poseSets[i].projection/ipd`. Video-Dialog übernimmt Projektion + Augenabstand der gewählten Kamera (bei „Schnitt“, wenn alle Kameras im Schnitt gleich sind); „Alle Kameras“ rendert jede in ihrer eigenen Projektion (`VideoSettings.perProjection`, Auflösung des Dialogs für die gewählte Projektion, sonst 1080p / 360-4K / TB-2048). Bild-Dialog wählt bei einer Panorama-Kamera Quelle „Kamera“ + deren Projektion vor. Beim Durchblicken (Modus Kamera/Schnitt) zeigt `src/ui/panorama-preview.ts` über dem 3D-Canvas live das Equirect (mono, 512–2048 px, aus der Viewport-Pose, horizontal ausgerichtet); es rendert neu bei Frame-, Kamera-, Szenen- und Navigationsänderungen und solange die Ansicht nachschwingt. `render.panoramaPreview` in render.ts; Exporte warten auf eine laufende Vorschau (`beginExport`).
- **Splat-Größe / Weichheit** (Panel „Darstellung“, vormals „Point cloud“): `PointCloudSettings.splatScale` skaliert die projizierte Kovarianz (×s²), `splatFilter` ersetzt den festen 3DGS-Low-Pass +0.3 px² im Projector (`splatParams`-Uniform). Nur Anzeige/Render, Pick nutzt dieselben Werte; Splat-Daten und Exporte unverändert. Die Punktgröße heißt jetzt „Punktgröße“ und gilt nur für den Punktwolken-Modus. Pro Objekt: `LayerState.splatScale` (null = global), Häkchen + Regler unter Layer-Animation, undo-fähig, gespeichert in `layerAnim.serialize`; `layerAnim.renderParams(splat).splatScale` liefert den wirksamen Wert.
- Speicherformat: `poseSets[i].channels = { base, keys }` zusätzlich zu den alten `poses` (für ältere Leser).

## Offene Punkte (Stand 26.10.2026)

Erledigt in dieser Runde: Offline/PWA, Undo der Kameraliste, Überblendung am Schnitt, „Veröffentlichen“ nur auf playcanvas.com.

Nach Wichtigkeit für den Offline-Film-Editor:
1. **Echter Layer-Fade**: Die Deckkraft wirkt pro Splat, dichte Layer verblassen erst spät. Nötig wäre ein eigenes Render-Target pro Layer, das dann eingeblendet wird.
2. **Überblendung im Viewport/Vorschau** (heute nur im Export) und weitere Blenden wie Wischblende oder Abblende auf Schwarz.
3. **Viewer-Export mit Schnitt**: Der HTML-Viewer bekommt alle Kameras als einzelne Spuren, aber nicht die geschnittene Abfolge.
4. **Layer-Verwaltung**: Gruppen, ganze Layer sperren. Aufteilen gibt es schon unter Bearbeiten → Trennen.
5. **Keys vs. manuelle Änderungen**: Transform- und Kamera-Spuren überschreiben beim Scrubben ungekeyte Änderungen. Hier fehlt ein Hinweis, oder Auto-Key sollte auch für die Kamera gelten.
6. **Qualität**: Der Tiefenfilter wirkt bei „Unter Schwelle selektieren“ nicht mit. Nach dem Löschen sind die Scores veraltet.
7. **Transitions**: Picking und Auswahl sehen die Endposition der Splats. Im stochastischen Modus gibt es kein Glühen.
8. **Bereinigen**: Decimate ist nicht direkt rückgängig machbar, Abbrechen stoppt den laufenden Schritt nicht.
9. **Bild-im-Bild-Vorschau** der Kamera beim Ziehen eines Keys (zweiter Render-Pass).
10. **Nicht per Klick getestet**: Schnitt-Werkzeug (Boden-Pipette, Achse „Layer“, nur aktiver Layer, harte Kante), „Alle Kameras“-Export über den Ordner-Dialog und die PWA-Installation über das Browser-Symbol. Der Service Worker und der Offline-Start sind geprüft.
11. Kleinkram: Das Hilfe-Menü verlinkt PlayCanvas-Tutorials, Discord und Forum, nur als Links und ohne den Namen im Text. `package.json` heißt noch `supersplat`, und Rollup meldet beim Build „Building SuperSplat“. Beides ist nicht in der Oberfläche sichtbar.

## Caching auf SiteGround (09.11.2026)

SiteGround liefert statische Dateien (js, css, json) über nginx mit `max-age` von einem Jahr aus. Die `.htaccess` gilt dort nur für Anfragen, die Apache beantwortet, etwa `/apps/splatmania/`. Ein Browser, der die App einmal geöffnet hatte, behielt deshalb die alte `index.js`, obwohl auf dem Server schon der neue Build lag.

Die Lösung:
- Jeder Build bekommt eine eigene Kennung (`BUILD_ID` in `rollup.config.mjs`). Sie hängt als `?v=` an `index.js` und `index.css` in der `index.html`.
- Die Sprachdateien und der Analyse-Worker übernehmen dieselbe Kennung über `src/build-query.ts`.
- Der Service Worker holt beim Installieren mit `cache: 'reload'`. Später fragt er mit `cache: 'no-cache'` beim Server nach. Offline sucht er mit `ignoreSearch`.

Der Dev-Server (`rollup -w`) muss nach Änderungen an `service-worker.mjs` neu gestartet werden, sonst schreibt er eine kaputte `sw.js`.

## Look, Nebel, Player/VR, Bewegungsunschärfe, Titel (10.11.2026)

**Look** (`src/look/`, Panel `src/ui/look-panel.ts`, Knopf mit Sonnen-Symbol in der rechten Leiste):
- Inhalt: Glow (Bloom mit Schwelle, Radius, Farbe), Farbkorrektur (Belichtung, Kontrast, Sättigung, Farbtemperatur), Objektiv (Vignette, Filmkorn, chromatische Aberration) und eine 3D-LUT (.cube).
- Es gibt einen globalen Look pro Projekt. Er wird im Projekt gespeichert, auch die LUT-Daten.
- Der Look ist noch nicht keyframebar.
- Ablauf: `LookRenderer` rendert die Bloom-Kette (Dual-Filter) und einen Composite-Pass. Die Kamera ruft ihn über einen ziellosen `lookPass` auf, nach den Splats und vor den Gizmos. So leuchten Gitter und Gizmos nicht mit.
- Im Viewport wird der Seitenhintergrund (`bgClr`) mit einbezogen, damit Viewport und Export gleich aussehen.
- 360-Panoramen: Die Würfelflächen rendern ohne Look. Der Look läuft danach einmal auf dem fertigen Equirect-Bild bzw. pro Auge, mit horizontalem Wrap. So gibt es keine Nähte. Vignette und Aberration entfallen bei 360°.
- Die Effektgrößen sind auf 1080p abgestimmt und skalieren mit der Ausgabehöhe.

**Nebel** (auch im Look-Panel) wirkt pro Splat im Projektor-Shader (`fogParams`, `fogColor`):
- Gemessen wird die Entfernung, nicht die View-Tiefe. Dadurch passen die Würfelflächen eines Panoramas zusammen.
- Modus „fade“ senkt die Deckkraft. Das wirkt wie Ausblenden in den Hintergrund und klappt auch bei transparentem Export.
- Modus „color“ mischt zur Nebelfarbe.
- Picking sieht durch den Nebel hindurch.

**Player / VR:**
- Render → „Im Player / in VR öffnen“ baut den Viewer-Export im Speicher (`viewer.preview` in `src/file-handler.ts`) und öffnet ihn als Blob-URL in einem neuen Tab.
- Der Viewer von splat-transform hat WebXR (VR/AR) eingebaut, mit Controllern und dem Umweg WebGPU → WebGL.
- Mit PC-VR (Quest Link/Air Link, SteamVR) erscheint im Player der VR-Knopf. Für eine Standalone-Quest den HTML-Export auf das Gerät oder einen eigenen Server legen.
- Der Look wird näherungsweise in die `postEffectSettings` des Viewers übertragen (`lookPostEffects` in `src/export-options.ts`). Korn, LUT und Nebel kann der Viewer nicht.

**Bewegungsunschärfe** im Video-Export (nur Standard-Projektion, `videoSettings.motionBlur`):
- Pro Bild werden 4, 8 oder 16 Zwischenbilder über den Verschluss gerendert und auf der CPU gemittelt.

**Titel** (`src/titles.ts`, Panel `src/ui/titles-panel.ts`, Vorschau `src/ui/titles-overlay.ts`, Knopf „T“):
- Text pro Bildbereich mit Blende, Position, Ausrichtung, Größe (Anteil der Bildhöhe), Schrift, Farbe, fett und Box.
- Eine einzige Zeichenfunktion dient der Viewport-Vorschau und den Bild- und Video-Exporten (nicht 360°). Gespeichert wird im Projekt.
- Bewusst ohne vorbelegtes design4real-Branding: Die App bleibt gratis, ohne Wasserzeichen.

Reveal-/Dissolve-Effekte gab es schon vorher, als Übergänge der Layer-Animation (Sweep, Radial, Dissolve, Grow, Fly-in, Wave).

## Look keyframebar (10.11.2026)

`src/look/look.ts` hat jetzt eine `LookTrack` (AnimTrack wie die Schnitt-Spur). Ein Key speichert den ganzen Look: alle Regler, Glow-Farbe, Nebelfarbe und Nebel-Modus. Nicht gekeyt werden der Ein/Aus-Schalter und die LUT-Datei; nur die LUT-Stärke wird gekeyt.

- **Zwischen Keys** wird weich überblendet (Smoothstep). Der Nebel-Modus springt auf halber Strecke um. Vor dem ersten und nach dem letzten Key gilt der jeweilige Randwert.
- **Bedienung:**
  - Key-Knopf ◇/◆ im Kopf des Look-Panels: setzt oder entfernt den Key am aktuellen Bild und macht den Look zum Key-Ziel.
  - Timeline-Zeile „Look“ (erscheint ab dem ersten Key): Klick macht sie zum Key-Ziel, Key ziehen verschiebt ihn, Rechtsklick löscht ihn.
  - Der globale Key-Knopf keyt den Look, wenn er Key-Ziel ist.
- **Auto-Key / Pending:** greift nur, wenn der Look schon Keys hat. Ein statischer Look erzeugt also nie ungefragt Keys.
- **Undo, Projekt und Export:**
  - Alle Key-Änderungen sind über `AnimTrackEditOp` rückgängig zu machen.
  - Die Keys werden im Projekt unter `look.keys` gespeichert.
  - Der Video-Export bewegt `timeline.time` Bild für Bild weiter, deshalb folgt der Look automatisch. Bei Motion Blur geschieht das auch in den Zwischenbildern.
- **Nicht abgedeckt:** Der Player/VR-Export übernimmt nur den Look am aktuellen Bild. Die Post-Effekte des Viewers sind statisch.
- **Release:** Rollup legt im Release-Build auch `.map`-Dateien ab. Vor dem Packen `release/*.map` löschen, ebenso die `sourceMappingURL`-Zeilen. Dann sind es 20 Dateien, ca. 2,4 MB.

## EXR mit Tiefe, Alpha im Video, QuickTime PNG (10.11.2026)

- **EXR (Bild und Sequenz):** Der Writer steht in `src/exr-writer.ts`.
  - Format: Scanline, ZIP-Kompression mit 16 Zeilen pro Block.
  - Kanäle: R, G, B, A als Half, dazu optional Z als 32-bit Float.
  - Farbe: Sie kommt aus dem 8-bit-Render, also mit Look, Titeln und Blenden. Sie wird in lineares Licht umgerechnet und premultiplied geschrieben. Werte über 1 (HDR) bleiben nicht erhalten.
  - Z: Kameraabstand in Szeneneinheiten aus dem Tiefen-Pass des Pickers (`captureDepth` in `render.ts`). Pro sichtbarem Layer läuft ein Pass, der nächste Wert gewinnt. Leere Pixel bekommen 1e10 wie in Blender. Z gibt es nur in der Standardprojektion.
  - Der Tiefen-Pass überschreibt das Kamera-Farbtarget. Deshalb läuft er erst, nachdem die Farbe gelesen ist.
- **Video-Formate:**
  - **MOV + Codec PNG** (`src/mov-writer.ts`): Eigener QuickTime-Muxer (ftyp, mdat mit 64-bit-Größe, moov am Ende, co64). Verlustfrei, mit Alpha, für Premiere, AE, Resolve und Final Cut. Streamt per Positions-Writes in die Datei, ohne Dateiauswahl landet er im Speicher.
  - **WebM VP9/AV1 mit Alpha:** Ein zweiter VideoEncoder läuft in Reihe, wie bei mediabunny. Er kodiert Alpha als graues I420-Bild und setzt Keyframes synchron. Die Daten gehen als `sideData.alpha` an den Muxer, der daraus BlockAdditions und AlphaMode macht.
  - **PNG-Sequenz / EXR-Sequenz** (`src/sequence-writer.ts`): Schreibt per Ordnerauswahl in einen Ordner, sonst als unkomprimiertes ZIP64 zum Download.
- **Alpha-Handhabung:** PNG (Bild und Video) und WebM bekommen gerade (un-premultiplied) Farbe, EXR bleibt premultiplied. Beim PNG-Bild mit transparentem Hintergrund war die Farbe vorher premultiplied, das ergab dunkle Säume. Das ist damit behoben.
- **Dialog:**
  - Die Zeile „Transparent Background“ ist nur bei WebM, MOV/PNG und den Sequenzen sichtbar. „Depth (Z)“ erscheint nur bei EXR in der Standardprojektion.
  - Codec und Bitrate sind bei Sequenzen ausgeblendet, die Bitrate auch bei PNG.
  - Die Encoder-Prüfung entfällt für diese Formate.
- **Geprüft:** Unabhängig mit ffmpeg 6, außerdem mit einem eigenen Python-EXR-Leser (scratchpad).
  - Das WebM liest sich als `yuva420p`.
  - Das MOV liest sich als `png rgba`, 11 Frames.
  - Die Alpha-Masken von WebM und MOV sind identisch.
  - Das EXR hat Z zwischen 32 und 37 bei einer Außenansicht, leere Pixel stehen auf 1e10.
- **Offen:** Der Player spielt die Schnittspur (mehrere Kameras hintereinander) nicht ab. Der Viewer kennt nur `spline` und `step`, damit verwischt ein harter Schnitt oder die Kamera überschwingt. Jede Kamera ist dort weiter eine eigene Spur, Objektivänderungen pro Key spielt der Player schon ab.

## Licht / Relighting (10.11.2026)

`src/light/light.ts` (Zustand, Uniforms, Keyframe-Spur, Platzieren, Gizmos) und `src/light/light-panel.ts`. Das Panel öffnet die Glühbirne in der rechten Leiste. Es wird aus `main.ts` eingehängt, nicht aus `editor.ts`.

- **Prinzip:** Das Licht eines Scans ist in die Splat-Farben eingebacken. Zurückrechnen geht nicht ohne neues Training. Stattdessen:
  - „Scan-Licht“ dimmt die gebackene Beleuchtung (1 = wie gescannt).
  - „Umgebung“ addiert ein farbiges Grundlicht.
  - Bis zu 4 Lichter (Sonne, Lampe, Spot) multiplizieren die Splat-Farbe als Albedo-Ersatz.
- **Shader** (`projected-splat-projector-shader.ts`, `shadeLight`): Als Normale dient die kürzeste Splat-Achse in Weltkoordinaten, zur Kamera gedreht. Runde Splats haben keine definierte Normale und werden je nach Flachheit zur Blickrichtung geblendet.
  - Diffus mit Wrap („Weichheit“) gegen verrauschte Normalen.
  - Lampe/Spot mit weichem Fenster-Abfall bis zur Reichweite, Spot mit weicher Kante.
  - Keine Schatten, kein Glanz.
  - Pick-Pässe sehen kein Licht.
- **Uniforms:** `lightParams`, `lightAmbient`, `lightA/B/C0..3`, gesetzt im Renderer aus `light.uniforms`.
- **Bedienung:**
  - Lampe/Spot werden über „Setzen“ (Klick ins Modell, das Licht landet knapp davor) oder „An Kamera“ platziert. Ein Spot an der Kamera wirkt wie ein Kopflicht.
  - Spot „Ausrichten“: Klick ins Modell = Zielpunkt.
  - Esc bricht das Platzieren ab.
  - Gizmos (Kreuz, beim Spot zusätzlich ein Strahl) sind nur bei offenem Panel sichtbar.
  - Das Loslassen der Maus wird auf `window` abgefangen, weil die Kamerasteuerung den Zeiger einfängt.
- **Keyframes:** wie beim Look; ein Key speichert das ganze Rig.
  - Zahlen und Farben werden weich überblendet. Ändert sich die Lichterliste zwischen zwei Keys, springt sie auf halber Strecke um.
  - Timeline-Zeile „Licht“, Key-Knopf im Panel-Kopf. Auto-Key und Pending greifen nur bei schon animiertem Rig.
- **Projekt:** gespeichert unter `light` (mit `keys`).
- **Nicht im Player/VR-Export:** Der Viewer kennt die Lichter nicht.
- **Getestet** am Testhaus:
  - Sonne vor bzw. hinter dem Haus.
  - Nachtszene mit Lampe und Spot.
  - Keys, Undo/Redo, Speichern/Laden.
  - Setzen per Klick.
- **Noch nicht getestet:** echte, verrauschte Scans.

## Szene-Panel neu geordnet, Menü „Ansicht“ (10.11.2026)

- **Szenen-Liste** (Abschnitt „Szene“, Key `objects`): Splats und Kameras stehen in einer Liste, jeweils mit eigener Gruppenzeile, Anzahl und, bei den Kameras, den Knöpfen + und ⧉.
  - `CameraList` liefert dafür `rows` und `actions`.
  - Der Container selbst enthält nur noch die Kamera-Einstellungen.
- **Eigenschaften:** Unter der Liste sitzt ein deutlicher Balken „Eigenschaften · Name“. Darunter steht nur, was zum gewählten Objekt gehört:
  - Splat: Transform, Layer-Animation, Übergänge, Darstellung, Aufräumen, Farben.
  - Kamera: „Ansicht & Schnitt“ (Viewport-Modus, Überblendung, Pfad, Frustums) und „Gewählte Kamera“.
  - Kontextwechsel:
    - `selection` / `selection.changed` schaltet auf Splat.
    - `shotCameras.select`, `add` und `duplicate` schalten auf Kamera.
    - Ohne Splat gilt die Kamera.
  - Das gewählte Objekt der anderen Art bleibt gedimmt markiert.
- **Menü „Ansicht“** (zwischen Render und Hilfe):
  - Jeder Hauptabschnitt lässt sich mit ☑/☐ abschalten, dazu gibt es „Alle Bereiche einblenden“.
  - Umsetzung: Registry in `collapsible.ts` (`sectionShown` / `setSectionShown`), gespeichert in `localStorage` unter `splatmania.ui.sections-off`, CSS-Klasse `section-off`.
- **Optik:**
  - Hauptabschnitte haben einen dunklen Kopfbalken mit Akzentkante links; offen ist sie magenta.
  - Zwischen den Abschnitten sitzt ein kleiner Abstand.
  - Splat-Zeilen sind gleich hoch wie Kamera-Zeilen, ohne reservierten Leerraum.
  - Die Kamera-Stile sind auf `#scene-panel` umgehängt, weil die Zeilen jetzt außerhalb von `#camera-list` liegen.

## Kamera löschen, Bézier-Griffe am Kamerapfad (11.11.2026)

- **Kamera löschen:** In der Kamerazeile der Szenen-Liste steht jetzt + − ⧉. Das „−“ löscht die gewählte Kamera.
  - Die letzte Kamera bleibt erhalten, weil die Ansicht eine braucht. „−“ bzw. das ✕ der Zeile entfernt dann ihre Keys, rückgängig zu machen über `AnimTrackEditOp`.
  - Vorher passierte beim Löschen der letzten Kamera einfach nichts.
- **Bézier-Griffe** (`CameraKey.handleIn` / `handleOut`, Offsets in Weltkoordinaten):
  - In `rebuildSpline` überschreibt `applyHandles` die Hermite-Tangenten des Positions-Splines: out = 3·handleOut, in = −3·handleIn. Beim Looping-Spline bekommen die duplizierten Rand-Keys dieselben Griffe.
  - Ohne eigene Griffe zeigt `getHandles` die automatischen Tangenten. Das erste Ziehen übernimmt sie, die Kurve springt also nicht.
  - Geprüft: Automatische Griffe als eigene gesetzt ergeben exakt die alte Kurve.
- **Bedienung im Pfad-Werkzeug:** Der gewählte Positions-Key zeigt zwei Griffe mit gestrichelten Linien.
  - Ziehen spiegelt die Richtung des anderen Griffs, dessen Länge bleibt. Mit Alt wird der Griff einzeln bewegt (Ecke).
  - Doppelklick stellt die automatische Kurve wieder her.
  - Gefüllte Griffe sind eigene, hohle automatische. Jeder Zug ist ein Undo-Schritt.
- **Speichern und Player:**
  - Die Griffe werden im Projekt gespeichert (`channels.keys[].handleIn/handleOut`).
  - Der HTML-Player bekommt eine Kamera mit Griffen als ein Pose pro Frame (`viewerPoses` in `export-options.ts`), weil sein eigener Spline die Griffe nicht kennt.
  - Der Video-Export rechnet ohnehin mit der Editor-Kurve.
- **Nicht abgedeckt:** Griffe gibt es nur für die Kameraposition, nicht für das Ziel (Target).

## Ansichts-Anzeige neben dem Achsenkreuz (11.11.2026)

- `src/ui/viewport-label.ts`: Die Pille oben rechts, links vom View-Cube, zeigt, was der Viewport gerade zeigt:
  - „Freie Ansicht“
  - beim Durchblick der Kameraname mit Farbfeld
  - beim Schnitt „Schnitt · Kameraname“ der aktuellen Kamera am Abspielkopf
- Ein Klick wechselt Frei → Kamera → Schnitt.
- Quellen: `camera.viewMode` und `shotCameras.followed`. Aktualisiert wird bei Moduswechsel, Kamera-, Schnitt- und Frame-Änderungen.
- Die Anzeige ist HTML über dem Canvas und landet deshalb nie in einem Render.

## Lichter in der Szenenliste (15.11.2026)

- **Szenenliste:** Gruppe „Lichter“ unter den Kameras, eine Zeile pro Licht (Farbpunkt, Typ, an/aus, ✕). `+` öffnet das Licht-Panel.
- **Auswahl:** Klick auf eine Zeile setzt `light.select` und zeigt die Eigenschaften „Licht“. Wer einen Splat oder eine Kamera wählt, hebt die Licht-Auswahl auf.
- **Verschieben:** `TranslateGizmo` am gewählten Licht, auch bei geschlossenem Licht-Panel. Lampe/Spot: Position. Sonne: Griff im Abstand 1,3 × Szenenradius vom Szenenmittelpunkt, seine Richtung setzt Azimut und Höhe. Ein Zug = ein Undo-Schritt (`LightRigOp`).
- **Löschen:** ✕ in der Zeile oder Entf/Backspace bei gewähltem Licht (Capture-Listener vor den globalen Shortcuts, löscht also keine Splats). `light.remove` ist jetzt rückgängig machbar.
- **Grenze:** Ist das Licht-Rig animiert, überschreibt die Keyframe-Spur beim nächsten Frame-Wechsel eine Verschiebung ohne Key, wie bei Änderungen im Licht-Panel.

## Verschieben/Drehen wirkt auf das gewählte Objekt (15.11.2026)

- **Bug:** Mit gewählter Kamera oder gewähltem Licht hängten sich die Werkzeuge Verschieben/Drehen der unteren Leiste trotzdem an den Splat.
- **Lösung:** Das Szenen-Panel meldet das gewählte Objekt mit `transform.setTarget` ('splat' | 'camera' | 'light'). `transform-tool.ts` greift nur bei 'splat'; `src/tools/object-gizmo.ts` übernimmt Kamera und Licht.
  - Kamera, Verschieben: Position, das Blickziel wandert mit. Drehen: Blickrichtung um die Kameraposition (nicht über ±89°). Über `shotCameras.setValue`, also mit Auto-Key/Pending; ein Zug = ein Undo-Schritt (`shotCameras.gestureStart/End`).
  - Licht, Verschieben: das eigene Gizmo des Lichts. Drehen: Spot-Richtung bzw. Sonnenrichtung (Griff), Lampen haben keine. Ein Zug = ein Undo-Schritt (`light.editStart/End`).
  - Skalieren wirkt nur auf Splats.

## Kamera-Darstellung und Blickziel als Objekt (16.11.2026)

- **Gizmos** (`camera-pose-gizmos.ts`): an der aktuellen Pose eine stilisierte Kamera (Body, Objektiv in Blickrichtung, zwei Filmrollen) statt Frustum; Keys als kleine Rauten; Pfad gestrichelt (Strichlänge in Welteinheiten).
- **Ziel sichtbar** (nur gewählte Kamera): Kugel aus drei Ringen am aktuellen Ziel, gestrichelte Linie Kamera → Ziel; ist der Kanal `target` animiert, zusätzlich Zielpfad (gestrichelt) und Ziel-Keys. Gewähltes Ziel wird weiß.
- **Ziel als Objekt:** Unter der gewählten Kamera steht in der Szenenliste die Zeile „Ziel“ (`cameraTarget.select`). Kontext `cameraTarget` zeigt die Kamera-Eigenschaften mit dem neuen Feld „Ziel“ (XYZ + Key-Knopf für den Kanal `target`). Das Verschieben-Werkzeug bewegt dann nur das Ziel (`object-gizmo.ts`).
- Ist `target` animiert, ist eine Verschiebung wie im Panel „ausstehend“, bis ein Key gesetzt wird (Auto-Key setzt ihn sofort).

## Kamerafahrt-Vorschläge mit optionaler Claude-Anbindung (14.–15.11.2026)

Panel „Kamerafahrt-Vorschläge“ (rechte Leiste). Code in `src/ai-shots/` (`shot-types.ts`, `coverage.ts`, `shot-generator.ts`, `claude-client.ts`, `ai-shots.ts`), UI in `src/ui/ai-shots-panel.ts`, Key-Feld im Einstellungen-Panel (Abschnitt „KI (Claude)“).

- **Ablauf:** Objekt übernehmen (aktive Box/Kugel, sonst Selektion, sonst Szene), bis zu 3 Lieblingswinkel merken, Dauer und Abstand wählen, „Kamerafahrten vorschlagen“. Ergebnis: 6 Karten mit Vorschaubild, Abdeckungs-Balken und Warnungen; „Übernehmen“ legt eine Shot-Kamera mit Keys an (ein Undo-Schritt, `shotCameras.addWithKeys`).
- **Generator (offline, deterministisch):** Orbit, Reveal, Kran, Seitwärtsfahrt, Push-in (optional Fokuszug), Überflug. Trapezförmiges Tempo, Kollisions- und Sichtprüfung über ein Dichte-Voxelgitter der Splats, Spline wird abgetastet: Elevation nie über 80° (Überflug 75°). Test: `node scripts/test-shot-generator.mjs` (rund 130 000 Prüfungen, inkl. Fuzz über 3000 Anfragen).
- **Abstand:** Regler 0,5–3 (1 = automatische Bildgröße), wirkt auch auf Claude-Vorschläge und Lieblingswinkel (`distanceScale`).
- **Vorschaubilder:** `render.posePreview` rendert offscreen (Warm-up-Frame, teilt die Sperre mit der Panorama-Vorschau und `render.offscreen`), wartet in Hintergrund-Tabs auf Sichtbarkeit (Status „Wartet, bis der Tab sichtbar ist…“).
- **Claude (optional, nur Anthropic):** offizielles SDK `@anthropic-ai/sdk` im Browser (`dangerouslyAllowBrowser`), Modell `claude-opus-5-5`, Server-Fallback aktiv, strukturierte JSON-Antworten. Ein Textwunsch wählt Vorlagen und Parameter (`planShots`), danach bewertet Claude je 3 Bilder pro Fahrt (`rankShots`). Ohne Key oder offline: nur Generator.
- **API-Key:** wird erst nach erfolgreichem Test gespeichert; Standard sessionStorage, nur mit „Key merken“ localStorage. Löschen wirkt tabübergreifend. Der Key geht nur an api.anthropic.com. Externe Links öffnen mit `noopener,noreferrer`, damit sessionStorage nicht in neue Fenster kopiert wird.
- **Rollup:** `anthropicBrowserStubs` ersetzt die Node-Teile des SDK; das SDK liegt in einem eigenen, nachgeladenen Chunk.

## Hilfe pro Werkzeug (15.11.2026)

- `src/ui/help.ts` + `src/ui/scss/help.scss`: „?“-Knopf im Kopf jedes Splatmania-Panels (13 Stück) öffnet eine kurze Anleitung; Menü Hilfe → „Splatmania-Werkzeuge erklärt“ zeigt alle 14 Themen.
- Texte in den Locales unter `sm.help.<thema>.{title,intro,steps,tips}` (Schritte/Tipps zeilenweise), Deutsch und Englisch; andere Sprachen fallen auf Englisch zurück.

## Kamerahöhe und Bewegungsart bei den Kamerafahrt-Vorschlägen (16.11.2026)

- Panel: Auswahl **„Kamerahöhe“** (Automatisch, Augenhöhe, Froschperspektive, Erhöht, Luftaufnahme) und **„Bewegung“** (Alle oder eine Vorlage). Native `<select>`, damit die Liste nicht vom Panel abgeschnitten wird.
- Generator (`GenerateOptions.style`, `templates`): Boden = Unterkante des Objekts; Augenhöhe ≈ 1,6 Szeneneinheiten, begrenzt auf 12–45 % der Objekthöhe. `styled()` hält die Kamerahöhe über die ganze Bahn (Augenhöhe/Frosch konstant, Erhöht/Luft mindestens über der Oberkante); Froschperspektive hebt das Ziel an. Die Höhe des Stils schlägt Anker und Claude-Werte.
- Ohne gewählte Bewegung nimmt jeder Stil passende Vorlagen (Augenhöhe/Frosch: ohne Kran und Überflug). Eine gewählte Bewegung liefert 6 Varianten (Seiten, Richtung, Schwenkwinkel).
- Claude bekommt Höhe und erlaubte Vorlagen im Prompt; Vorschläge mit anderen Vorlagen werden verworfen.
- Tests: zusätzliche Prüfungen für Augenhöhe, Frosch, Luft und Varianten (131 504 Prüfungen grün).

## Tiefenkarte als Graubild (16.11.2026)

- Bild-Export (alle Formate) und PNG-/EXR-Sequenzen, nur Standard-Projektion: Option **„Tiefenkarte (Graubild)“** schreibt zusätzlich `<Name>_depth.png` (16-Bit-Graustufen, `encodePngGray16` in `png-writer.ts`), bei Sequenzen eine pro Frame.
- **Tiefenbereich:** „Automatisch“ = 1.–99. Perzentil der sichtbaren Splat-Tiefen (leerer Hintergrund 1e10 und Ausreißer zählen nicht); eine Sequenz behält den Bereich des ersten Frames (kein Flackern). „Von Hand“: Nah/Fern in Szeneneinheiten.
- **Nah = Weiß** (Standard, wie ControlNet/MiDaS) oder umgekehrt. Leerer Hintergrund = fern.
- Code: `src/depth-map.ts`, Dialog-Zeilen `src/ui/depth-map-options.ts`. Der EXR-Z-Kanal bleibt unverändert (echte Abstände, kein Bereich nötig).
- Getestet per `render.image` am Testhaus: PNG + 16-Bit-Graustufen-PNG, automatischer Bereich gegen 0–60 von Hand verglichen. Sequenz-Export nicht per Klick getestet.
