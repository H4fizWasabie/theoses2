/* PROTOTYPE ONLY — synthetic data, no production dashboard wiring. */

const code = [
  ["const", " state =", " createCommandDeckState();"],
  ["", "", ""],
  ["await", " session.prompt", "(message, {"],
  ["", "", "  source: \"dashboard\", "],
  ["", "", "  thinkingLevel: \"high\", "],
  ["", "", "});"],
  ["", "", ""],
  ["return", " renderToolStatus", "(state.runningTool);"],
];

let activeFieldCleanup = () => {};
let liveSignalTimer = null;

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function rail() {
  return `<header class="command-rail">
    <div class="brand">Theoses<small>command deck / prototype</small></div>
    <div class="rail-spacer"></div>
    <div class="rail-stat"><label>state</label><strong class="live">EXECUTING</strong></div>
    <div class="rail-stat"><label>provider</label><strong>openrouter</strong></div>
    <div class="rail-stat"><label>model</label><strong>qwen3.5</strong></div>
    <div class="rail-stat"><label>thinking</label><strong class="amber">HIGH</strong></div>
    <div class="rail-stat"><label>context</label><strong>68%</strong></div>
    <div class="rail-stat"><label>cost</label><strong>$0.0842</strong></div>
    <button class="rail-button" type="button" data-open-runtime>Runtime</button>
    <button class="rail-button" type="button">Stop</button>
  </header>`;
}

function field() {
  return `<section class="panel field">
    <div class="panel-head"><strong>Live task field</strong><span class="meta">orbit / depth 04 / 60 fps target</span></div>
    <div class="panel-body">
      <canvas id="field-canvas" aria-label="Synthetic 3D live task field"></canvas>
      <div class="field-overlay">
        <div class="field-title"><div class="eyebrow">active operation</div><h1>Audit the Telegram task path</h1><p>Agent is reading the channel boundary and checking the live execution route.</p></div>
        <div class="field-legend"><div class="legend-row"><i class="dot cyan"></i>active execution</div><div class="legend-row"><i class="dot amber"></i>current task</div><div class="legend-row"><i class="dot blue"></i>memory cluster</div><div class="legend-row"><i class="dot green"></i>completed tool</div></div>
      </div>
    </div>
  </section>`;
}

function minimizeButton(label) {
  return `<button class="minimize-toggle" type="button" data-minimize aria-label="Minimize ${label}" title="Minimize"><span></span></button>`;
}

function chat() {
  return `<section class="panel chat">
    <div class="panel-head"><strong>Conversation / Telegram</strong><span class="meta">owner chat · live</span>${minimizeButton("Conversation")}</div>
    <div class="panel-body chat-body">
      <article class="message user"><div class="message-label">you / telegram · 14:32:08</div><div class="message-text">Audit the Telegram task path and tell me which packages are involved.</div><div class="message-meta">reply context attached</div></article>
      <article class="message active"><div class="message-label">theoses / streaming</div><div class="message-text">I’m tracing the channel boundary, session restore, and tool execution path now.</div><div class="message-meta">turn 06 · 1,842 tokens</div></article>
      <article class="message"><div class="message-label">theoses / previous</div><div class="message-text">The Telegram package is the entry point; coding-agent owns the session and agent-core runs the loop.</div><div class="message-meta">turn 05 · $0.0317</div></article>
      <div class="chat-input"><textarea placeholder="Steer the live task…"></textarea><button class="send">Send</button></div>
    </div>
  </section>`;
}

function files() {
  return `<section class="panel files">
    <div class="panel-head"><strong>File workbench</strong><span class="meta">read / edit / save</span>${minimizeButton("File workbench")}</div>
    <div class="file-body"><div class="file-tabs"><span class="file-tab active">telegram/index.ts</span><span class="file-tab">agent-session.ts</span></div><pre class="code">${code.map((line, index) => `<span class="line"><span class="ln">${String(index + 1).padStart(2, "0")}</span><span class="kw">${esc(line[0])}</span><span class="fn">${esc(line[1])}</span><span class="str">${esc(line[2])}</span></span>`).join("")}</pre></div>
  </section>`;
}

function filesystem() {
  return `<section class="panel filesystem"><div class="panel-head"><strong>File system</strong><span class="meta">workspace</span>${minimizeButton("File system")}</div><div class="fs-path"><span>THEOSES2</span><span>/</span><span>packages</span><span>/</span><span>telegram</span></div><div class="fs-body">
    <div class="fs-row directory"><span class="fs-kind">DIR</span><span class="fs-name">..</span></div>
    <div class="fs-row directory"><span class="fs-kind">DIR</span><span class="fs-name">src</span><span class="fs-size">12 items</span></div>
    <div class="fs-row active"><span class="fs-kind">TS</span><span class="fs-name">index.ts</span><span class="fs-size">18.4 KB</span></div>
    <div class="fs-row"><span class="fs-kind">TS</span><span class="fs-name">session-manager.ts</span><span class="fs-size">9.1 KB</span></div>
    <div class="fs-row"><span class="fs-kind">TS</span><span class="fs-name">outbox.ts</span><span class="fs-size">6.8 KB</span></div>
    <div class="fs-row directory"><span class="fs-kind">DIR</span><span class="fs-name">test</span><span class="fs-size">8 items</span></div>
    <div class="fs-row"><span class="fs-kind">MD</span><span class="fs-name">README.md</span><span class="fs-size">4.2 KB</span></div>
    <div class="fs-row"><span class="fs-kind">JS</span><span class="fs-name">package.json</span><span class="fs-size">1.7 KB</span></div>
  </div><div class="fs-footer"><span>7 files</span><span>read / edit / save</span></div></section>`;
}

const RUNTIME_MODELS = [
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", active: true },
  { id: "openai/gpt-5", label: "GPT-5" },
  { id: "qwen/qwen3-235b-a22b", label: "Qwen3 235B" },
  { id: "deepseek/deepseek-chat-v3.1", label: "DeepSeek Chat v3.1" },
  { id: "moonshotai/kimi-k2", label: "Kimi K2" },
];

const RUNTIME_THINKING_LEVELS = [
  ["off", "No reasoning"],
  ["minimal", "Very brief reasoning (~1k tokens)"],
  ["low", "Light reasoning (~2k tokens)"],
  ["medium", "Moderate reasoning (~8k tokens)"],
  ["high", "Deep reasoning (~16k tokens)"],
  ["xhigh", "Extra-high reasoning (~32k tokens)"],
  ["max", "Maximum reasoning"],
];

const RUNTIME_PROVIDERS = [
  ["OpenRouter", "oauth", true],
  ["Anthropic", "api_key", true],
  ["Google", null, false],
  ["Groq", null, false],
];

function runtimeModal() {
  return `<dialog class="runtime-modal" id="runtime-modal"><div class="runtime-modal-head"><div><div class="eyebrow">Operator controls</div><h2>Runtime</h2></div><button type="button" class="modal-close" data-close-runtime>Close</button></div><div class="runtime-grid">
    <section class="runtime-card wide">
      <div class="eyebrow">Model</div>
      <div class="model-list">${RUNTIME_MODELS.map((model) => `<button type="button" class="model-row ${model.active ? "active" : ""}"><span>${model.label}</span><span class="model-id">${model.id}</span></button>`).join("")}</div>
      <div class="runtime-sub">Routed through OpenRouter · explicit provider, no auto-routing</div>
    </section>
    <section class="runtime-card wide">
      <div class="eyebrow">Thinking level</div>
      <div class="thinking-list">${RUNTIME_THINKING_LEVELS.map(([level, description]) => `<button type="button" class="thinking-row ${level === "high" ? "active" : ""}"><strong>${level}</strong><span>${description}</span></button>`).join("")}</div>
    </section>
    <section class="runtime-card wide">
      <div class="eyebrow">Provider authentication</div>
      <div class="provider-list">${RUNTIME_PROVIDERS.map(([name, type, connected]) => `<div class="provider-row"><span class="provider-name">${name}</span><span class="provider-type">${type ? (type === "oauth" ? "OAuth" : "API key") : "—"}</span><span class="provider-status ${connected ? "connected" : ""}">${connected ? "Connected" : "Not connected"}</span><button class="rail-button" type="button">${connected ? "Disconnect" : "Connect"}</button></div>`).join("")}</div>
    </section>
    <section class="runtime-card"><div class="eyebrow">Turn usage</div><div class="value-row"><span>input context</span><strong>8,240 / 12,000</strong></div><div class="meter"><i style="width: 68%"></i></div><div class="value-row"><span>output</span><strong>1,842 tokens</strong></div><div class="value-row"><span>estimated cost</span><strong class="amber">$0.0842</strong></div></section>
    <section class="runtime-card"><div class="eyebrow">Telegram</div><div class="runtime-value">Owner chat · live <span class="status-dot"></span></div><div class="runtime-sub">Inbound messages are routed to this session.</div></section>
  </div></dialog>`;
}

function timeline() {
  const turns = [["06", "active", "Tracing Telegram boundary"], ["05", "$0.0317", "Restored channel session"], ["04", "$0.0194", "Read agent-session runtime"], ["03", "$0.0112", "Checked provider settings"]];
  return `<section class="panel timeline"><div class="panel-head"><strong>Turn timeline</strong><span class="meta">context and cost by turn</span></div><div class="timeline-body">${turns.map(([number, stat, text], index) => `<div class="turn ${index === 0 ? "active" : ""}"><div class="turn-top"><span>TURN ${number}</span><span>${stat}</span></div><strong>${text}</strong><p>${index === 0 ? "read → bash → next model response" : "completed and persisted"}</p><div class="turn-stats"><span>${index === 0 ? "8.2k" : `${4 + index}.1k`} in</span><span>${index === 0 ? "1.8k" : `${index + 1}42`} out</span></div></div>`).join("")}</div></section>`;
}

function render() {
  activeFieldCleanup();
  const body = `<div class="layout">${field()}${chat()}${files()}${filesystem()}${timeline()}</div>`;
  document.querySelector("#app").innerHTML = `<div class="prototype-ribbon">prototype / synthetic state / no production wiring</div><main class="deck">${rail()}${body}</main>${runtimeModal()}`;
  document.querySelectorAll("[data-minimize]").forEach((button) => button.addEventListener("click", () => {
    button.closest(".panel")?.classList.toggle("minimized");
    updateLayoutColumns();
  }));
  setupField();
  bindRuntimeModal();
  startLiveSignals();
}

function updateLayoutColumns() {
  const layout = document.querySelector(".layout");
  if (!layout) return;
  const colA = document.querySelector(".chat")?.classList.contains("minimized") ? "56px" : "3fr";
  const colB = document.querySelector(".files")?.classList.contains("minimized") ? "56px" : "4fr";
  const colC = document.querySelector(".filesystem")?.classList.contains("minimized") ? "56px" : "3fr";
  layout.style.gridTemplateColumns = `${colA} ${colB} ${colC}`;
}

async function setupField() {
  const canvas = document.querySelector("#field-canvas");
  if (!canvas) return;
  try {
    const THREE = await import("three");
    const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
    const { EffectComposer } = await import("three/addons/postprocessing/EffectComposer.js");
    const { RenderPass } = await import("three/addons/postprocessing/RenderPass.js");
    const { UnrealBloomPass } = await import("three/addons/postprocessing/UnrealBloomPass.js");
    if (!canvas.isConnected) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#05080a");
    scene.fog = new THREE.Fog("#05080a", 11, 26);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 2.5, 10.5);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.32, 0.42);
    composer.addPass(bloomPass);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 6;
    controls.maxDistance = 16;
    controls.target.set(0, 0.2, 0);
    scene.add(new THREE.HemisphereLight("#d7ffff", "#12191b", 1.4));
    const key = new THREE.DirectionalLight("#ffc66d", 2.2);
    key.position.set(4, 6, 5);
    scene.add(key);

    // Tilt the whole disk for a three-quarter view (parallax rides on top of this).
    const tiltGroup = new THREE.Group();
    tiltGroup.rotation.x = -0.52;
    tiltGroup.rotation.z = 0.08;
    scene.add(tiltGroup);
    const fieldGroup = new THREE.Group();
    tiltGroup.add(fieldGroup);

    // Procedural mottled-surface texture so the core reads as a real star, not a flat ball.
    const sunCanvas = document.createElement("canvas");
    sunCanvas.width = sunCanvas.height = 256;
    const sunCtx = sunCanvas.getContext("2d");
    sunCtx.fillStyle = "#c96f28";
    sunCtx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 480; i += 1) {
      const x = Math.random() * 256, y = Math.random() * 256, r = 3 + Math.random() * 9;
      const warm = Math.random() < 0.4;
      const grad = sunCtx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, warm ? `rgba(255,244,214,${0.06 + Math.random() * 0.12})` : `rgba(255,150,60,${0.06 + Math.random() * 0.14})`);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      sunCtx.fillStyle = grad;
      sunCtx.beginPath();
      sunCtx.arc(x, y, r, 0, Math.PI * 2);
      sunCtx.fill();
    }
    const sunTexture = new THREE.CanvasTexture(sunCanvas);
    sunTexture.wrapS = sunTexture.wrapT = THREE.RepeatWrapping;
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.34, 48, 48), new THREE.MeshBasicMaterial({ map: sunTexture }));
    fieldGroup.add(core);

    // Two-layer glow: a tight bright rim, then a soft outward corona.
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = glowCanvas.height = 128;
    const glowCtx = glowCanvas.getContext("2d");
    const glowGrad = glowCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
    glowGrad.addColorStop(0, "rgba(255,244,214,0.55)");
    glowGrad.addColorStop(0.35, "rgba(255,168,76,0.2)");
    glowGrad.addColorStop(1, "rgba(255,120,40,0)");
    glowCtx.fillStyle = glowGrad;
    glowCtx.fillRect(0, 0, 128, 128);
    const coronaTexture = new THREE.CanvasTexture(glowCanvas);
    const coronaMaterial = new THREE.SpriteMaterial({ map: coronaTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const corona = new THREE.Sprite(coronaMaterial);
    corona.scale.set(0.92, 0.92, 1);
    fieldGroup.add(corona);
    const halo = new THREE.Sprite(coronaMaterial);
    halo.scale.set(1.5, 1.5, 1);
    fieldGroup.add(halo);

    // Soft radial sprite so stars read as glowing dust, not flat squares.
    const spriteCanvas = document.createElement("canvas");
    spriteCanvas.width = spriteCanvas.height = 64;
    const spriteCtx = spriteCanvas.getContext("2d");
    const spriteGradient = spriteCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
    spriteGradient.addColorStop(0, "rgba(255,255,255,1)");
    spriteGradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
    spriteGradient.addColorStop(1, "rgba(255,255,255,0)");
    spriteCtx.fillStyle = spriteGradient;
    spriteCtx.fillRect(0, 0, 64, 64);
    const starSprite = new THREE.CanvasTexture(spriteCanvas);

    // Spiral-galaxy particle field (arms, bulge-weighted density, additive glow).
    const starCount = 7200;
    const armsCount = 3;
    const spin = 1.15;
    const maxRadius = 3.6;
    const insideColor = new THREE.Color("#ffd9a0");
    const outsideColor = new THREE.Color("#4d6a89");
    const galaxyPositions = new Float32Array(starCount * 3);
    const galaxyColors = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i += 1) {
      const i3 = i * 3;
      const radius = Math.pow(Math.random(), 1.5) * maxRadius;
      const spinAngle = radius * spin;
      const armAngle = ((i % armsCount) / armsCount) * Math.PI * 2;
      const spread = Math.pow(Math.random(), 3) * 0.32 * (radius + 0.4);
      const randomX = (Math.random() < 0.5 ? 1 : -1) * spread;
      const randomZ = (Math.random() < 0.5 ? 1 : -1) * spread;
      const randomY = (Math.random() < 0.5 ? 1 : -1) * Math.pow(Math.random(), 3) * 0.14 * (maxRadius - radius * 0.5);
      const angle = armAngle + spinAngle;
      galaxyPositions[i3] = Math.cos(angle) * radius + randomX;
      galaxyPositions[i3 + 1] = randomY;
      galaxyPositions[i3 + 2] = Math.sin(angle) * radius + randomZ;
      const mixed = insideColor.clone().lerp(outsideColor, Math.min(1, radius / maxRadius));
      galaxyColors[i3] = mixed.r;
      galaxyColors[i3 + 1] = mixed.g;
      galaxyColors[i3 + 2] = mixed.b;
    }
    const galaxyGeometry = new THREE.BufferGeometry();
    galaxyGeometry.setAttribute("position", new THREE.BufferAttribute(galaxyPositions, 3));
    galaxyGeometry.setAttribute("color", new THREE.BufferAttribute(galaxyColors, 3));
    const galaxyMaterial = new THREE.PointsMaterial({ size: 0.09, map: starSprite, sizeAttenuation: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, transparent: true, opacity: 0.85 });
    const galaxyPoints = new THREE.Points(galaxyGeometry, galaxyMaterial);
    fieldGroup.add(galaxyPoints);

    // A sparse handful of brighter stars stand in for completed tool calls.
    const sparkleCount = 46;
    const sparklePositions = new Float32Array(sparkleCount * 3);
    for (let i = 0; i < sparkleCount; i += 1) {
      const i3 = i * 3;
      const source = Math.floor(Math.random() * starCount) * 3;
      sparklePositions[i3] = galaxyPositions[source] * 1.01;
      sparklePositions[i3 + 1] = galaxyPositions[source + 1] * 1.01;
      sparklePositions[i3 + 2] = galaxyPositions[source + 2] * 1.01;
    }
    const sparkleGeometry = new THREE.BufferGeometry();
    sparkleGeometry.setAttribute("position", new THREE.BufferAttribute(sparklePositions, 3));
    const sparkleMaterial = new THREE.PointsMaterial({ size: 0.16, map: starSprite, sizeAttenuation: true, depthWrite: false, blending: THREE.AdditiveBlending, color: "#bfe6b3", transparent: true, opacity: 0.9 });
    const sparklePoints = new THREE.Points(sparkleGeometry, sparkleMaterial);
    fieldGroup.add(sparklePoints);

    // One warm marker star for the task currently in flight.
    const taskStar = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), new THREE.MeshBasicMaterial({ color: "#ffb765" }));
    taskStar.position.set(1.9, 0.05, 0.6);
    fieldGroup.add(taskStar);

    const resize = () => {
      const width = window.innerWidth, height = window.innerHeight;
      renderer.setSize(width, height, false);
      composer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener("resize", resize);

    const pointer = { x: 0, y: 0 };
    const onPointerMove = (event) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointerMove);

    const baseTiltX = tiltGroup.rotation.x;
    const baseTiltZ = tiltGroup.rotation.z;
    let animationFrame = 0;
    const frame = () => {
      if (!canvas.isConnected) return;
      const now = performance.now();
      fieldGroup.rotation.y += 0.0012;
      tiltGroup.rotation.x += (baseTiltX + pointer.y * 0.06 - tiltGroup.rotation.x) * 0.04;
      tiltGroup.rotation.z += (baseTiltZ + pointer.x * -0.04 - tiltGroup.rotation.z) * 0.04;
      core.rotation.y += 0.006;
      const pulse = 1 + Math.sin(now * 0.0035) * 0.22;
      taskStar.scale.setScalar(pulse);
      controls.update();
      composer.render();
      animationFrame = requestAnimationFrame(frame);
    };
    animationFrame = requestAnimationFrame(frame);
    activeFieldCleanup = () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      controls.dispose();
      composer.dispose();
      renderer.dispose();
      galaxyGeometry.dispose();
      galaxyMaterial.dispose();
      sparkleGeometry.dispose();
      sparkleMaterial.dispose();
      starSprite.dispose();
      sunTexture.dispose();
      coronaTexture.dispose();
      coronaMaterial.dispose();
      taskStar.geometry.dispose();
      taskStar.material.dispose();
      core.geometry.dispose();
      core.material.dispose();
    };
  } catch {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const draw = (time) => { const width = canvas.width = window.innerWidth * (devicePixelRatio || 1), height = canvas.height = window.innerHeight * (devicePixelRatio || 1); ctx.fillStyle = "#05080a"; ctx.fillRect(0, 0, width, height); ctx.save(); ctx.translate(width / 2, height / 2); for (let i = 0; i < 70; i += 1) { const angle = i * 2.4 + time / 50000; const radius = Math.sqrt(i) * Math.min(width, height) / 32; ctx.fillStyle = i < 4 ? "#d9963e" : i % 3 ? "#3f6764" : "#86a9e8"; ctx.beginPath(); ctx.arc(Math.cos(angle) * radius, Math.sin(angle) * radius, i < 4 ? 5 : 2, 0, Math.PI * 2); ctx.fill(); } ctx.restore(); requestAnimationFrame(draw); };
    requestAnimationFrame(draw);
  }
}

function startLiveSignals() {
  clearInterval(liveSignalTimer);
  liveSignalTimer = setInterval(() => {
    const panels = document.querySelectorAll(".panel:not(.field)");
    const target = panels[Math.floor(Math.random() * panels.length)];
    if (target) {
      target.classList.add("flash");
      setTimeout(() => target.classList.remove("flash"), 650);
    }
    const liveStat = document.querySelector(".rail-stat strong.live");
    liveStat?.classList.add("pulse-once");
    setTimeout(() => liveStat?.classList.remove("pulse-once"), 650);
  }, 3200);
}

function bindRuntimeModal() {
  const modal = document.querySelector("#runtime-modal");
  document.querySelectorAll("[data-open-runtime]").forEach((button) => button.addEventListener("click", () => modal?.showModal()));
  modal?.querySelector("[data-close-runtime]")?.addEventListener("click", () => modal.close());
  modal?.querySelectorAll(".model-row, .thinking-row").forEach((row) => row.addEventListener("click", () => {
    row.parentElement?.querySelectorAll(".active").forEach((active) => active.classList.remove("active"));
    row.classList.add("active");
  }));
  modal?.querySelectorAll(".provider-row .rail-button").forEach((button) => button.addEventListener("click", () => {
    const row = button.closest(".provider-row");
    const status = row?.querySelector(".provider-status");
    const type = row?.querySelector(".provider-type");
    const nowConnecting = button.textContent === "Connect";
    status?.classList.toggle("connected", nowConnecting);
    if (status) status.textContent = nowConnecting ? "Connected" : "Not connected";
    if (type) type.textContent = nowConnecting ? "API key" : "—";
    button.textContent = nowConnecting ? "Disconnect" : "Connect";
  }));
}

render();
