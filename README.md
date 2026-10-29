# O'Reilly Pulse · Radar, Live Events & MCP Intelligence Hub (WebGPU & Local AI Edition)

Centro de inteligencia y monitorización **100 % Local-First** para todo el ecosistema **O'Reilly Learning** (`learning.oreilly.com`) y **O'Reilly Radar** (`oreilly.com/radar/`), inspirado en la experiencia de lectura de revista de `feedly_clon` pero diseñado específicamente para la naturaleza multiformato de O'Reilly: **Conferencias en Vivo, Superstreams grabados, coloquios *Live with Tim O'Reilly*, libros en *Early Release*, informes ejecutivos (*Reports*), *Expert Playlists*, laboratorios interactivos y glosarios técnicos generados con IA local**.

Construido **sin dependencias externas (`0` paquetes en `node_modules`)** sobre la API nativa de **Node.js (v22.5+)**, motor de búsqueda indexada **SQLite FTS5 en modo WAL**, cliente **MCP JSON-RPC 2.0 nativo** sobre `stdio`, síntesis neuronal local mediante **Ollama (`Gemma 4`)** y un pipeline doble en GPU acelerado con **WebGPU + Shaders WGSL** (`@compute` y `@fragment`).

Repositorio oficial: **[https://github.com/0utKast/oreilly-pulse-webgpu](https://github.com/0utKast/oreilly-pulse-webgpu)**

---

## ✨ Características Principales

### 1. 📡 Escaneo Integral del Ecosistema O'Reilly en 6 Canales Especializados
* **📡 O'Reilly Radar & Trends:** Artículos diarios de *O'Reilly Radar* junto con los informes mensuales *Radar Trends to Watch* de Mike Loukides.
* **🗓️ Agenda Live & Conferencias Virtuales:** Monitor de próximos eventos en directo con **reloj de cuenta atrás** y conversión automática a hora local (`Europe/Madrid`), distinguiendo entre *Virtual Conferences / Showcases*, *Special Live Events (Spotlights, Agent Skills Live)* y *Live Courses*.
* **🎬 Charlas y Eventos Grabados (Hemeroteca Replay):** Grabaciones íntegras recién subidas de *AI Superstreams*, *Software Architecture Superstreams*, *AI Codecon*, *Live with Tim O'Reilly*, *This Week in AI* y *Lunch & Learn*.
* **🚀 Early Releases, Libros & Reports:** Detección automática de libros en fase de acceso anticipado (`publication_date` futura) para explorar capítulos meses antes de su salida al mercado, junto con los informes ejecutivos cortos (`tags: ["report"]`).
* **🎧 Expert Playlists, Cursos & Audiolibros:** Listas vivas curadas por referentes (Neal Ford, Sam Newman, Mike Loukides, Ben Lorica), cursos bajo demanda y audiolibros completos.
* **🧪 Explore Skills, Labs & Certificaciones:** Escenarios interactivos (`scenario` / `sandbox`), *Skill Plans* y simuladores oficiales de certificación.

### 2. 🧭 Radares por Áreas Técnicas Dinámicas (Presets Oficiales + Búsqueda Abierta MCP)
* **6 Áreas Técnicas Preconfiguradas de Serie:**
  1. 🤖 **Agentes IA & Protocolo MCP**
  2. 🏛️ **Arquitectura de Software & Patrones**
  3. ⚡ **WebGPU, C++26, Rust & Wasm**
  4. 🗄️ **Ingeniería de Datos, RAG & Vector DBs**
  5. 🛡️ **Seguridad, DevSecOps & Gobernanza IA**
  6. ☁️ **Linux, Kubernetes & Observabilidad**
* **Modal «+ Añadir Área» en 2 Modos:**
  * **Catálogo de Especialidades O'Reilly en 1 Clic:** 10 radares adicionales adaptados a autores y etiquetas canónicas de O'Reilly (*Tim O'Reilly & Mike Loukides*, *Context Engineering & Evals*, *Web Moderna & Performance*, *Python & DSPy*, *PostgreSQL & Vector DBs*, *Neal Ford & Mark Richards*, *Ataques a MCP & Red Teaming*, *Labs Interactivos*, *Audiolibros* y *Certificaciones*).
  * **Área Técnica Abierta Personalizada:** Cualquier combinación de palabras clave (`query`), filtro de autores (`author_filter`) y formato (`content_types`) sincronizada directamente contra el servidor MCP.

### 3. 📚 Inspector de Profundización: Desglose de Sesiones (TOC), Glosarios Técnicos y Dossier IA
Cada libro, charla en vivo o conferencia grabada cuenta con un inspector lateral de 3 pestañas:
1. **📖 Resumen & Sesiones (TOC):** Síntesis ejecutiva en español, calendario de sesiones en directo, temario desglosado capítulo a capítulo o ponencia a ponencia, ficha bibliográfica canónica (`ourn`) y botón directo **`Abrir en O'Reilly Learning ↗`** (`?orm_source=mcp`).
2. **📚 Glosario Técnico del Recurso:** Tarjetas con la definición técnica en español de los conceptos, arquitecturas y patrones clave introducidos en esa charla o libro (ej. *Harness Engineering*, *Architectural Fitness Function*, *Episodic Agent Memory*, *MCP Tool Poisoning*, *ACL-Aware Retrieval*).
3. **✦ Dossier Ejecutivo IA (`Gemma 4`) & Notas:** Generación bajo demanda de un informe técnico estructurado, **exportable en 1 clic a Markdown (`.md`)** o a **Vista de Informe Técnico Imprimible (PDF/HTML)**, más bloc de notas personales indexado en SQLite FTS5.

### 4. ✦ Informes en Vivo + Radar de Conocimiento en GPU (`WebGPU` + `WGSL`)
* **Compute Shader WGSL (`@compute @workgroup_size(64)` con `vec4<f32>` SIMD):** Calcula en la GPU la matriz de afinidad coseno entre los vectores característicos 64-D de las áreas técnicas en `< 2 ms`.
* **Fragment Shader WGSL (`@fragment`):** Renderiza en tiempo real un radar interactivo de energía editorial y convergencia temática con resaltado al vuelo.

---

## 📂 Estructura del Proyecto

```text
oreilly-pulse-webgpu/
├── server.js                         # Servidor HTTP multi-interfaz (0.0.0.0:3050), Cliente MCP, SQLite FTS5 y Agente Ollama
├── package.json                      # Configuración para Node.js >= 22.5.0 (0 dependencias externas)
├── seed-catalog.json                 # Catálogo curado de 47 recursos O'Reilly, TOCs, glosarios y 16 áreas técnicas
├── .agents/mcp_config.json           # Definición del servidor MCP oficial de O'Reilly (mcp-remote)
├── OReillyPulse.command              # Acceso directo de escritorio para macOS (instala LaunchAgent y abre el navegador)
├── iniciar-mac.command               # Lanzador directo de doble clic para macOS
├── iniciar-windows.bat               # Lanzador directo de doble clic para Windows
├── iniciar-linux.sh                  # Lanzador directo para Linux
├── com.jesusconde.oreillypulse.plist # Definición de agente launchd para inicio automático al arrancar macOS
├── Dockerfile                        # Imagen Docker ligera basada en node:22-alpine
├── docker-compose.yml                # Orquestación Docker con volumen persistente ./data
└── public/
    ├── index.html                    # Interfaz 3 paneles, cinta de eventos en vivo, inspector de glosarios y modales
    ├── styles.css                    # Sistema de diseño Magazine, Modo Claro/Oscuro (light-dark) y content-visibility
    ├── app.js                        # Controlador reactivo, cuenta atrás CET, explorador MCP y exportación de informes
    └── webgpu-pulse.js               # Motor WebGPU/WGSL: Compute Shader SIMD vec4<f32> y Render Shader del Radar
```

---

## 🚀 Instalación y Uso en Mac y Windows

### Opción A: Uso Directo en Red Local (Mac como Servidor Residente + Acceso desde Windows)
El servidor de **O'Reilly Pulse** escucha en todas las interfaces de red (`0.0.0.0:3050`) y se inicia automáticamente al encender el Mac mediante `launchd` (`com.jesusconde.oreillypulse.plist`):
* **En este Mac:** **[http://localhost:3050](http://localhost:3050)** (o doble clic en `OReillyPulse.command`).
* **Desde tu PC con Windows en la misma red:** Abre directamente `http://<IP_DE_TU_MAC>:3050` en el navegador para compartir exactamente la misma base de datos SQLite, tus notas, guardados y dossieres en tiempo real.

### Opción B: Instalación Nativa Independiente en Windows, Mac o Linux
1. Clona el repositorio oficial:
   ```bash
   git clone https://github.com/0utKast/oreilly-pulse-webgpu.git
   cd oreilly-pulse-webgpu
   ```
2. Inicia sin necesidad de ejecutar `npm install`:
   * **Windows:** Doble clic en `iniciar-windows.bat` (o `npm start`).
   * **macOS:** Doble clic en `OReillyPulse.command` o `iniciar-mac.command`.
   * **Linux:** `./iniciar-linux.sh`.

---

## ⚙️ Servicio Siempre Activo al Iniciar Sesión en macOS (`launchd`)

El script `OReillyPulse.command` instala y activa automáticamente el agente en `~/Library/LaunchAgents/com.jesusconde.oreillypulse.plist`. También puedes gestionarlo manualmente con:

```bash
cp com.jesusconde.oreillypulse.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.jesusconde.oreillypulse.plist
launchctl kickstart -k gui/$(id -u)/com.jesusconde.oreillypulse
```
