/* Ambient background that doubles as a lightweight camera toy: drag to orbit,
 * wheel/pinch to zoom. The canvas sits at z-index 0 under the app (z-index 1),
 * so panel clicks still hit the panel first — only the empty background gaps
 * feed the canvas pointer events. Idle auto-rotation resumes a few seconds
 * after the last interaction so the view doesn't go static. */
async function setupField() {
  const canvas = document.getElementById("field-canvas");
  if (!canvas) return;
  try {
    const THREE = await import("three");
    const { EffectComposer } = await import("three/addons/postprocessing/EffectComposer.js");
    const { RenderPass } = await import("three/addons/postprocessing/RenderPass.js");
    const { UnrealBloomPass } = await import("three/addons/postprocessing/UnrealBloomPass.js");

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#05080a");
    scene.fog = new THREE.Fog("#05080a", 11, 26);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 2.5, 10.5);
    camera.lookAt(0, 0.2, 0);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.32, 0.42);
    composer.addPass(bloomPass);
    scene.add(new THREE.HemisphereLight("#d7ffff", "#12191b", 1.4));
    const key = new THREE.DirectionalLight("#ffc66d", 2.2);
    key.position.set(4, 6, 5);
    scene.add(key);

    const tiltGroup = new THREE.Group();
    tiltGroup.rotation.x = -0.52;
    tiltGroup.rotation.z = 0.08;
    scene.add(tiltGroup);
    const fieldGroup = new THREE.Group();
    tiltGroup.add(fieldGroup);

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
    fieldGroup.add(new THREE.Points(galaxyGeometry, galaxyMaterial));

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
    fieldGroup.add(new THREE.Points(sparkleGeometry, sparkleMaterial));

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

    // Camera orbits `target` in spherical coordinates so drag/wheel can move it
    // without fighting the galaxy's own idle spin (fieldGroup.rotation.y below).
    const target = new THREE.Vector3(0, 0.2, 0);
    const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(target));
    const MIN_RADIUS = 3, MAX_RADIUS = 22;
    let targetRadius = spherical.radius;
    let dragging = false;
    let lastX = 0, lastY = 0;
    let idleUntil = 0;
    const IDLE_DELAY = 3200;

    const applyCamera = () => {
      spherical.radius += (targetRadius - spherical.radius) * 0.12;
      spherical.makeSafe();
      camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical));
      camera.lookAt(target);
    };

    canvas.addEventListener("pointerdown", (event) => {
      dragging = true;
      lastX = event.clientX; lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      idleUntil = performance.now() + IDLE_DELAY;
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - lastX, dy = event.clientY - lastY;
      lastX = event.clientX; lastY = event.clientY;
      spherical.theta -= dx * 0.005;
      spherical.phi -= dy * 0.005;
      idleUntil = performance.now() + IDLE_DELAY;
    });
    const endDrag = (event) => {
      dragging = false;
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      idleUntil = performance.now() + IDLE_DELAY;
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      targetRadius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, targetRadius + event.deltaY * 0.01));
      idleUntil = performance.now() + IDLE_DELAY;
    }, { passive: false });
    // The field-focus HUD's +/- buttons zoom the same way the wheel does; they
    // exist because the canvas is normally covered by panels almost everywhere.
    window.addEventListener("theoses-field-zoom", (event) => {
      const step = event.detail?.direction === "in" ? -1.5 : 1.5;
      targetRadius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, targetRadius + step));
      idleUntil = performance.now() + IDLE_DELAY;
    });

    const frame = () => {
      const now = performance.now();
      fieldGroup.rotation.y += 0.0012;
      if (!dragging && now > idleUntil) spherical.theta += 0.0009;
      applyCamera();
      core.rotation.y += 0.006;
      const pulse = 1 + Math.sin(now * 0.0035) * 0.22;
      taskStar.scale.setScalar(pulse);
      composer.render();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } catch (error) {
    console.warn("Live field disabled:", error);
    canvas.remove();
  }
}

setupField();
