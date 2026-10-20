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
- Kamera hinzufügen, löschen, umbenennen und duplizieren ist **nicht** rückgängig machbar. Rückgängig machbar sind nur Key- und Schnitt-Edits.
- Schnitte sind nur harte Schnitte, es gibt keine Überblendungen.
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

**Fazit:** Layer, Keyframe-Timeline und MP4-Export waren als Grundgerüst vorhanden. Mehrere Kameraspuren mit Schnitt, Layer-Animation und ein Punktwolken-Modus sind inzwischen ergänzt (siehe oben). Es fehlt noch eine Desktop-Hülle (z. B. Electron oder Tauri) für echten Offline-Betrieb. Der Build ist bereits eine statische PWA und braucht keinen Server.
