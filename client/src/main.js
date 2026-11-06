import * as THREE from "three";
import { io } from "socket.io-client";
import "./style.css";

const app = document.querySelector("#app");
app.innerHTML = `
  <div id="join-screen" class="overlay">
    <div class="join-card">
      <div class="eyebrow">A LITTLE PLACE TO HANG OUT</div>
      <h1>Party World<span>.</span></h1>
      <p>Bring your mates. Have a wander. See who's about.</p>
      <form id="join-form">
        <input id="name-input" maxlength="18" placeholder="Choose a name" autocomplete="off" required />
        <button type="submit">Enter the world</button>
      </form>
      <small>WASD to move · Enter to chat · Click the AI Host to talk</small>
    </div>
  </div>
  <div id="game">
    <div class="topbar">
      <div class="brand">PARTY WORLD<span>.</span></div>
      <div class="online"><i></i><b id="online-count">1</b> here</div>
    </div>
    <div class="location-tag">THE COMMON GROUND <span>•</span> OPEN SESSION</div>
    <div class="hint">WASD / arrows to walk <span>·</span> Enter to chat</div>
    <div class="chat-panel">
      <div class="panel-title">WORLD CHAT <span>LIVE</span></div>
      <div id="messages" class="messages"></div>
      <form id="chat-form"><input id="chat-input" maxlength="240" placeholder="Say something..." autocomplete="off" /><button>Send</button></form>
    </div>
    <button id="ai-button" class="ai-button"><span class="ai-face">✳</span><span><b>AI HOST</b><small>Click to chat</small></span></button>
    <div id="ai-panel" class="ai-panel hidden">
      <div class="ai-heading"><div><b>✳ AI HOST</b><small>Always around for a chat</small></div><button id="ai-close">×</button></div>
      <div id="ai-messages" class="ai-messages"><div class="bubble bot">Hey! Welcome in. What are you in the mood to talk about?</div></div>
      <form id="ai-form"><input id="ai-input" maxlength="500" placeholder="Chat with the AI host..." autocomplete="off" /><button>Send</button></form>
    </div>
  </div>
`;
const joinScreen = document.querySelector("#join-screen");
const game = document.querySelector("#game");
let socket, scene, camera, renderer, localPlayer, lastSent = 0;
const meshes = new Map();
const keys = new Set();
const playerState = { x: 0, z: 0, rotation: 0 };
const clock = new THREE.Clock();
const colours = {};

function addMessage({ name, text, system }) {
  const el = document.createElement("div");
  el.className = system ? "message system" : "message";
  const n = document.createElement("b");
  n.textContent = name;
  const t = document.createElement("span");
  t.textContent = text;
  el.append(n, t);
  const box = document.querySelector("#messages");
  box.append(el);
  box.scrollTop = box.scrollHeight;
}
function makeAvatar(colour, name) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.55, 4, 8), material);
  body.position.y = 0.78;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 12), new THREE.MeshStandardMaterial({ color: 0xf1d2b6 }));
  head.position.y = 1.55;
  group.add(head);
  const label = makeNameLabel(name);
  label.position.y = 2.05;
  group.add(label);
  return group;
}
function makeNameLabel(name) {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(15,24,27,.78)";
  ctx.roundRect(5, 5, 246, 54, 18); ctx.fill();
  ctx.font = "bold 25px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "#fff";
  ctx.fillText(name.slice(0, 18), 128, 40);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(2.0, 0.5, 1);
  return sprite;
}
function addPlayer(p, isLocal = false) {
  if (meshes.has(p.id)) return;
  const mesh = makeAvatar(p.colour || "#f4a261", p.name || "Guest");
  mesh.position.set(p.x, 0, p.z);
  scene.add(mesh);
  meshes.set(p.id, mesh);
  if (isLocal) localPlayer = mesh;
}
function removePlayer(id) {
  const mesh = meshes.get(id);
  if (mesh) { scene.remove(mesh); meshes.delete(id); }
}
function makeWorld() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color("#b9d9d1");
  scene.fog = new THREE.Fog("#b9d9d1", 28, 65);
  camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 13, 17);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  game.prepend(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x648477, 2.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.3);
  sun.position.set(-8, 15, 9); sun.castShadow = true; scene.add(sun);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: "#7fae83" }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  // A simple open-air soundsystem and DJ booth.
  const stage = new THREE.Group();
  const platform = new THREE.Mesh(new THREE.BoxGeometry(8, 0.45, 3.2), new THREE.MeshStandardMaterial({ color: "#4a4843" }));
  platform.position.set(0, 0.22, -9); stage.add(platform);
  for (const x of [-2.8, 2.8]) {
    const stack = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1.25, 0.8), new THREE.MeshStandardMaterial({ color: "#202629" }));
      box.position.y = 0.7 + i * 1.25; stack.add(box);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.055, 8, 24), new THREE.MeshStandardMaterial({ color: "#d99a55", emissive: "#633b1d" }));
      ring.position.set(0, box.position.y, 0.43); stack.add(ring);
    }
    stack.position.set(x, 0, -9); stage.add(stack);
  }
  const booth = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.05, 0.8), new THREE.MeshStandardMaterial({ color: "#262f32" }));
  booth.position.set(0, 0.95, -8.4); stage.add(booth);
  const decks = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 0.5), new THREE.MeshStandardMaterial({ color: "#d7b47a" }));
  decks.position.set(0, 1.55, -8.35); stage.add(decks);
  scene.add(stage);

  // Scattered lights, trees and benches make the field feel occupied.
  for (let i = 0; i < 22; i++) {
    const x = (Math.random() - 0.5) * 42, z = (Math.random() - 0.5) * 38;
    if (Math.abs(x) < 5 && z < -5 && z > -13) continue;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 1.4, 7), new THREE.MeshStandardMaterial({ color: "#75533a" }));
    trunk.position.set(x, 0.7, z); scene.add(trunk);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.85 + Math.random() * 0.4, 9, 8), new THREE.MeshStandardMaterial({ color: ["#3e765b", "#4c805d", "#5b8b62"][i % 3] }));
    crown.position.set(x, 1.8, z); scene.add(crown);
  }
  for (let i = 0; i < 6; i++) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.18, 0.55), new THREE.MeshStandardMaterial({ color: "#9c7049" }));
    bench.position.set(-10 + i * 4, 0.55, 3 + (i % 2) * 2); scene.add(bench);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 0.12), new THREE.MeshStandardMaterial({ color: "#624a37" }));
    legs.position.set(-10 + i * 4, 0.28, 3 + (i % 2) * 2); scene.add(legs);
  }
}
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (localPlayer) {
    let dx = 0, dz = 0;
    if (keys.has("w") || keys.has("arrowup")) dz -= 1;
    if (keys.has("s") || keys.has("arrowdown")) dz += 1;
    if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
    if (keys.has("d") || keys.has("arrowright")) dx += 1;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const speed = 5.2;
    playerState.x = THREE.MathUtils.clamp(playerState.x + dx * speed * dt, -22, 22);
    playerState.z = THREE.MathUtils.clamp(playerState.z + dz * speed * dt, -22, 22);
    if (dx || dz) playerState.rotation = Math.atan2(dx, dz);
    localPlayer.position.set(playerState.x, 0, playerState.z);
    localPlayer.rotation.y = playerState.rotation;
    camera.position.lerp(new THREE.Vector3(playerState.x, 12.5, playerState.z + 16), 0.08);
    camera.lookAt(playerState.x, 0, playerState.z - 1.5);
    if (socket && performance.now() - lastSent > 50) {
      socket.emit("player:move", playerState);
      lastSent = performance.now();
    }
  }
  renderer.render(scene, camera);
}
function connect(name) {
  makeWorld();
  socket = io();
  socket.on("connect", () => socket.emit("join", name));
  socket.on("world:init", list => {
    list.forEach(p => addPlayer(p, p.id === socket.id));
    document.querySelector("#online-count").textContent = meshes.size;
  });
  socket.on("player:joined", p => { addPlayer(p); document.querySelector("#online-count").textContent = meshes.size; addMessage({ name: "WORLD", text: `${p.name} joined the world.`, system: true }); });
  socket.on("player:moved", p => {
    const mesh = meshes.get(p.id);
    if (mesh && p.id !== socket.id) { mesh.position.x = p.x; mesh.position.z = p.z; mesh.rotation.y = p.rotation; }
  });
  socket.on("player:left", id => { removePlayer(id); document.querySelector("#online-count").textContent = meshes.size; });
  socket.on("chat:message", addMessage);
  socket.on("chat:error", message => addMessage({ name: "MODERATION", text: message, system: true }));
  animate();
}
document.querySelector("#join-form").addEventListener("submit", e => {
  e.preventDefault();
  const name = document.querySelector("#name-input").value.trim() || "Guest";
  joinScreen.classList.add("hidden");
  game.classList.add("active");
  connect(name);
});
document.querySelector("#chat-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = document.querySelector("#chat-input");
  if (input.value.trim()) socket?.emit("chat:send", input.value.trim());
  input.value = "";
});
document.addEventListener("keydown", e => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }
  const key = e.key.toLowerCase();
  if (["w","a","s","d","arrowup","arrowdown","arrowleft","arrowright"].includes(key)) { keys.add(key); e.preventDefault(); }
  if (e.key === "Enter" && game.classList.contains("active")) { document.querySelector("#chat-input").focus(); }
});
document.addEventListener("keyup", e => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());
window.addEventListener("resize", () => {
  if (!renderer) return;
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// AI host panel
const aiPanel = document.querySelector("#ai-panel");
document.querySelector("#ai-button").addEventListener("click", () => aiPanel.classList.toggle("hidden"));
document.querySelector("#ai-close").addEventListener("click", () => aiPanel.classList.add("hidden"));
const aiHistory = [];
function addAiBubble(text, who) {
  const el = document.createElement("div");
  el.className = `bubble ${who}`;
  el.textContent = text;
  const box = document.querySelector("#ai-messages");
  box.append(el); box.scrollTop = box.scrollHeight;
}
document.querySelector("#ai-form").addEventListener("submit", async e => {
  e.preventDefault();
  const input = document.querySelector("#ai-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  addAiBubble(message, "you");
  aiHistory.push({ role: "user", content: message });
  const button = e.submitter;
  button.disabled = true; button.textContent = "…";
  try {
    const res = await fetch("/api/ai", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: aiHistory.slice(-8, -1) })
    });
    const data = await res.json();
    const reply = data.reply || data.error || "I couldn't think of a reply.";
    addAiBubble(reply, "bot");
    aiHistory.push({ role: "assistant", content: reply });
  } catch {
    addAiBubble("I can't reach the AI service right now. Is the server running?", "bot");
  } finally { button.disabled = false; button.textContent = "Send"; }
});
