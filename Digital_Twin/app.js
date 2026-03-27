/**
 * EV Digital Twin — Three.js Application
 * 
 * Features:
 * - GLB model loading with progress tracking
 * - Orbit controls with smooth damping
 * - HDR-style multi-light setup with shadows
 * - Component detection & click-to-inspect via raycasting
 * - Real-time data fetch from /data API
 * - RPM-based wheel rotation animation
 * - Temperature-based color mapping (blue→red heat map)
 * - Energy flow glow effects (emissive pulsing)
 * - Eco/Sport mode visual theming
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

// =========================================================================
// GLOBALS
// =========================================================================
let scene, camera, renderer, controls;
let model = null;
let mixer = null;   // AnimationMixer for built-in animations (if any)
let clock = new THREE.Clock();

// Component groups discovered from the model
const componentGroups = {
  wheels: [],
  motor: [],
  battery: [],
  body: [],
  lights: [],
  interior: [],
  chassis: [],
  other: [],
};

// Global Fleet state
const urlParams = new URLSearchParams(window.location.search);
let currentVehicleId = urlParams.get('vid') || 'EV-Alpha';
let fleetData = [];

// Current telemetry state
let telemetry = { id: currentVehicleId, battery: 85, rpm: 3000, temp: 45, mode: 'eco', running: true };
let previousTelemetry = { ...telemetry };

// Interaction state
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let hoveredObject = null;
let selectedObject = null;

// Original materials cache (for highlight restore)
const originalMaterials = new Map();

// Energy flow particles
let energyFlowParticles = [];

// Alert cooldown
let lastAlertTime = 0;

// =========================================================================
// INITIALIZATION
// =========================================================================
function init() {
  // --- Scene ---
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e17);
  scene.fog = new THREE.FogExp2(0x0a0e17, 0.015);

  // --- Camera ---
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(5, 3, 8);

  // --- Renderer ---
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  // --- Lights ---
  setupLights();

  // --- Ground Plane ---
  setupGround();

  // --- Orbit Controls ---
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 2;
  controls.maxDistance = 25;
  controls.maxPolarAngle = Math.PI / 2 + 0.1;
  controls.target.set(0, 0.8, 0);
  controls.update();

  // --- Event Listeners ---
  window.addEventListener('resize', onResize);
  renderer.domElement.addEventListener('click', onModelClick);
  renderer.domElement.addEventListener('mousemove', onMouseMove);

  // --- Manual Override Listeners ---
  const rpmSlider = document.getElementById('slider-rpm');
  const tempSlider = document.getElementById('slider-temp');

  if (rpmSlider) {
    rpmSlider.addEventListener('input', (e) => {
      document.getElementById('label-rpm-override').textContent = e.target.value;
      syncOverride('rpm', e.target.value);
    });
  }
  if (tempSlider) {
    tempSlider.addEventListener('input', (e) => {
      document.getElementById('label-temp-override').textContent = e.target.value + '°C';
      syncOverride('temp', e.target.value);
    });
  }

  // --- Load Model ---
  loadModel();

  // --- Start Data Fetch Loop ---
  setInterval(fetchTelemetry, 1000);

  // --- Animation Loop ---
  animate();
}

// =========================================================================
// LIGHTING SETUP
// =========================================================================
function setupLights() {
  // Ambient fill
  const ambient = new THREE.AmbientLight(0x4488cc, 0.4);
  scene.add(ambient);

  // Hemisphere (sky/ground gradient)
  const hemi = new THREE.HemisphereLight(0x88bbff, 0x224466, 0.5);
  scene.add(hemi);

  // Key light (main shadow-casting directional)
  const keyLight = new THREE.DirectionalLight(0xffeedd, 1.8);
  keyLight.position.set(8, 12, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 50;
  keyLight.shadow.camera.left = -10;
  keyLight.shadow.camera.right = 10;
  keyLight.shadow.camera.top = 10;
  keyLight.shadow.camera.bottom = -10;
  keyLight.shadow.bias = -0.0005;
  keyLight.shadow.normalBias = 0.02;
  scene.add(keyLight);

  // Fill light (opposite side, softer)
  const fillLight = new THREE.DirectionalLight(0x88aaff, 0.6);
  fillLight.position.set(-6, 8, -4);
  scene.add(fillLight);

  // Rim light (back)
  const rimLight = new THREE.DirectionalLight(0xff8844, 0.4);
  rimLight.position.set(0, 4, -10);
  scene.add(rimLight);

  // Spot accent from front
  const spotLight = new THREE.SpotLight(0x38bdf8, 1.0, 30, Math.PI / 6, 0.5, 1);
  spotLight.position.set(0, 8, 12);
  spotLight.target.position.set(0, 0, 0);
  scene.add(spotLight);
  scene.add(spotLight.target);
}

// =========================================================================
// GROUND PLANE
// =========================================================================
function setupGround() {
  // Reflective ground with grid
  const groundGeo = new THREE.PlaneGeometry(60, 60);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x0a0e17,
    roughness: 0.85,
    metalness: 0.2,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  ground.name = '__ground__';
  scene.add(ground);

  // Grid overlay
  const grid = new THREE.GridHelper(60, 120, 0x1a2744, 0x111827);
  grid.position.y = 0.005;
  grid.material.opacity = 0.3;
  grid.material.transparent = true;
  scene.add(grid);
}

// =========================================================================
// MODEL LOADING
// =========================================================================
function loadModel() {
  const loader = new GLTFLoader();
  const progressBar = document.getElementById('load-progress');

  loader.load(
    'ev_sport_car_test.glb',
    (gltf) => {
      model = gltf.scene;

      // Auto-scale to fit
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 4 / maxDim;
      model.scale.setScalar(scale);

      // Center on ground
      const boxScaled = new THREE.Box3().setFromObject(model);
      const center = boxScaled.getCenter(new THREE.Vector3());
      model.position.x -= center.x;
      model.position.z -= center.z;
      model.position.y -= boxScaled.min.y;

      // Setup shadows & classify components
      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          classifyComponent(child);
          // Cache original material
          originalMaterials.set(child.uuid, child.material.clone());
        }
      });

      scene.add(model);

      // Set up animations if any
      if (gltf.animations && gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(model);
        gltf.animations.forEach((clip) => {
          mixer.clipAction(clip).play();
        });
      }

      // Update camera target
      controls.target.copy(boxScaled.getCenter(new THREE.Vector3()));
      controls.target.y = boxScaled.getCenter(new THREE.Vector3()).y;
      controls.update();

      // Create energy flow particles
      createEnergyFlow();

      // Hide loading screen
      setTimeout(() => {
        document.getElementById('loading-screen').classList.add('hidden');
      }, 500);

      console.log('✅ Model loaded. Component groups:', {
        wheels: componentGroups.wheels.length,
        motor: componentGroups.motor.length,
        battery: componentGroups.battery.length,
        body: componentGroups.body.length,
        lights: componentGroups.lights.length,
        interior: componentGroups.interior.length,
        chassis: componentGroups.chassis.length,
        other: componentGroups.other.length,
      });
    },
    (progress) => {
      if (progress.total > 0) {
        const pct = (progress.loaded / progress.total) * 100;
        if (progressBar) progressBar.style.width = pct + '%';
      }
    },
    (error) => {
      console.error('❌ Model load error:', error);
      document.querySelector('.loader-text').textContent = 'Error loading model';
    }
  );
}

// =========================================================================
// COMPONENT CLASSIFICATION & NAMING
// =========================================================================
const COMPONENT_NAME_MAP = {
  // Motor & Drive
  'motor': 'AC Induction Motor',
  'engine': 'Powertrain Assembly',
  'rotor': 'Main Rotor',
  'stator': 'Stator Assembly',
  'powertrain': 'Single-Speed Transaxle',
  'inverter': 'DC-AC Inverter',
  
  // Battery
  'battery': 'Lithium-Ion Battery Pack',
  'cell': 'Energy Cell Module',
  'accumulator': 'High-Voltage Accumulator',
  'bms': 'BMS Control Module',
  'platform': 'Main Battery Chassis',
  'generic_ev_platform': 'Lithium-Ion Battery Pack',
  'platform02': 'Front Dual-Motor Assembly',
  'plasticred': 'High-Voltage Power Inverter',
  'aluminium': 'Rear Drive Unit / Motor Area',
  'controller': 'Central Drive Controller',
  
  // Body & Structure
  'hood': 'Composite Hood',
  'bonnet': 'Composite Hood',
  'door': 'Lightweight Door Panel',
  'glass': 'Acoustic Glass',
  'window': 'Acoustic Glass',
  'roof': 'Panoramic Glass Roof',
  'panel': 'Body Exterior Panel',
  'bumper': 'Impact-Resistant Bumper',
  'spoiler': 'Active AeroSpoiler',
  
  // Interior
  'seat': 'Leather Sports Seat',
  'steer': 'Steering Control System',
  'dash': 'Digital Instrument Cluster',
  'console': 'Center Control Console',
  
  // Wheels & Suspension
  'wheel': 'Alloy Performance Wheel',
  'tire': 'Michelin Pilot Sport Tire',
  'tyre': 'Performance Tire',
  'brake': 'Regenerative Braking Hub',
  'caliper': 'Brembo Brake Caliper',
  'suspension': 'Adaptive Air Suspension',
  'spring': 'Suspension Coil',
  'axle': 'Front/Rear Drive Axle',
  
  // Lights
  'led': 'Matrix LED System',
  'light': 'Headlight Assembly',
  'lamp': 'Taillight Unit',
};

function classifyComponent(mesh) {
  const name = (mesh.name || '').toLowerCase();
  const parentName = (mesh.parent?.name || '').toLowerCase();
  const combined = name + ' ' + parentName;

  // Refined keyword detection
  if (/wheel|tire|tyre|rim|hub|brake|caliper|spoke/i.test(combined)) {
    componentGroups.wheels.push(mesh);
    mesh.userData.componentType = 'wheel';
  } else if (/motor|engine|drive|rotor|stator|power|invert|platform02|plasticred|aluminium|controller/i.test(combined)) {
    componentGroups.motor.push(mesh);
    mesh.userData.componentType = 'motor';
  } else if (/batter|cell|pack|energy|accum|bms|voltage|platform/i.test(combined)) {
    componentGroups.battery.push(mesh);
    mesh.userData.componentType = 'battery';
  } else if (/light|lamp|head|tail|signal|led|beam|optic/i.test(combined)) {
    componentGroups.lights.push(mesh);
    mesh.userData.componentType = 'lights';
  } else if (/seat|inter|dash|steer|cabin|console|pedal|carpet/i.test(combined)) {
    componentGroups.interior.push(mesh);
    mesh.userData.componentType = 'interior';
  } else if (/chassis|frame|suspension|axle|shock|struct|under/i.test(combined)) {
    componentGroups.chassis.push(mesh);
    mesh.userData.componentType = 'chassis';
  } else if (/body|door|hood|bon|bump|fend|roof|trunk|glass|wind|mirr|panel|spoil|car/i.test(combined)) {
    componentGroups.body.push(mesh);
    mesh.userData.componentType = 'body';
  } else {
    componentGroups.other.push(mesh);
    mesh.userData.componentType = 'other';
  }
}

// =========================================================================
// ENERGY FLOW PARTICLES
// =========================================================================
function createEnergyFlow() {
  const particleCount = 60;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(particleCount * 3);
  const colors = new Float32Array(particleCount * 3);
  const sizes = new Float32Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 3;
    positions[i * 3 + 1] = Math.random() * 1.5 + 0.2;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 2;
    colors[i * 3] = 0.22;
    colors[i * 3 + 1] = 0.74;
    colors[i * 3 + 2] = 0.97;
    sizes[i] = Math.random() * 3 + 1;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.PointsMaterial({
    size: 0.03,
    vertexColors: true,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });

  const particles = new THREE.Points(geometry, material);
  particles.name = '__energyFlow__';
  scene.add(particles);
  energyFlowParticles.push(particles);
}

// =========================================================================
// ANIMATION LOOP
// =========================================================================
function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  // Update orbit controls
  controls.update();

  // Built-in animations
  if (mixer) mixer.update(delta);

  // Wheel rotation based on RPM
  if (telemetry.running) {
    const rotSpeed = (telemetry.rpm / 10000) * delta * 30;
    componentGroups.wheels.forEach((wheel) => {
      wheel.rotation.x += rotSpeed;
    });
  }

  // Temperature-based color mapping
  updateThermalColors(elapsed);

  // Energy flow particle animation
  updateEnergyFlow(elapsed, delta);

  // Render
  renderer.render(scene, camera);
}

// =========================================================================
// DYNAMIC HEATMAP VISUALIZATION — Zone-based thermal mapping
// =========================================================================
let heatLight = null;  // Dynamic point light near hottest zone

function updateThermalColors(elapsed) {
  const temp = telemetry.temp;
  const t = THREE.MathUtils.clamp((temp - 20) / 80, 0, 1); // 20°C → 100°C → 0→1

  // --- Color Gradient: Blue → Cyan → Yellow → Orange → Red ---
  const coldColor   = new THREE.Color(0x1565c0);   // Deep Blue (cool)
  const coolColor   = new THREE.Color(0x00bcd4);   // Cyan (warm-up)
  const warmColor   = new THREE.Color(0xffca28);    // Yellow (moderate)
  const hotColor    = new THREE.Color(0xff5722);    // Orange (hot)
  const critColor   = new THREE.Color(0xd50000);    // Red (critical)

  let thermalColor;
  if (t < 0.25) {
    thermalColor = coldColor.clone().lerp(coolColor, t * 4);
  } else if (t < 0.5) {
    thermalColor = coolColor.clone().lerp(warmColor, (t - 0.25) * 4);
  } else if (t < 0.75) {
    thermalColor = warmColor.clone().lerp(hotColor, (t - 0.5) * 4);
  } else {
    thermalColor = hotColor.clone().lerp(critColor, (t - 0.75) * 4);
  }

  // --- Pulse speed increases with temperature (heartbeat effect) ---
  const pulseSpeed = 2 + t * 8;  // 2 Hz at cold → 10 Hz at critical
  const pulse = 0.3 + 0.4 * Math.sin(elapsed * pulseSpeed);
  const critPulse = 0.5 + 0.5 * Math.sin(elapsed * 12);  // fast flash for critical

  // ═══ MOTOR — Hottest zone (1.0x heat) ═══
  componentGroups.motor.forEach((mesh) => {
    if (mesh.material && mesh !== selectedObject) {
      mesh.material.emissive = thermalColor.clone();
      mesh.material.emissiveIntensity = pulse * t * 1.2;
      // At critical temp, override to bright red flash
      if (t > 0.85) {
        mesh.material.emissive = critColor.clone();
        mesh.material.emissiveIntensity = critPulse * 1.5;
      }
    }
  });

  // ═══ BATTERY — Moderate heat (0.65x) ═══
  const batteryT = t * 0.65;
  let batteryColor;
  if (batteryT < 0.5) {
    batteryColor = coldColor.clone().lerp(warmColor, batteryT * 2);
  } else {
    batteryColor = warmColor.clone().lerp(hotColor, (batteryT - 0.5) * 2);
  }
  componentGroups.battery.forEach((mesh) => {
    if (mesh.material && mesh !== selectedObject) {
      mesh.material.emissive = batteryColor;
      mesh.material.emissiveIntensity = pulse * batteryT * 0.8;
    }
  });

  // ═══ CHASSIS — Subtle radiation from heat transfer (0.35x) ═══
  const chassisT = t * 0.35;
  const chassisColor = coldColor.clone().lerp(warmColor, chassisT * 2);
  componentGroups.chassis.forEach((mesh) => {
    if (mesh.material && mesh !== selectedObject) {
      mesh.material.emissive = chassisColor;
      mesh.material.emissiveIntensity = chassisT * 0.3;
    }
  });

  // ═══ WHEELS — Brake heat glow (RPM-dependent) ═══
  const rpmT = THREE.MathUtils.clamp(telemetry.rpm / 10000, 0, 1);
  const brakeHeat = rpmT * 0.4;
  const brakeColor = coldColor.clone().lerp(hotColor, brakeHeat * 2);
  componentGroups.wheels.forEach((mesh) => {
    if (mesh.material && mesh !== selectedObject) {
      mesh.material.emissive = brakeColor;
      mesh.material.emissiveIntensity = brakeHeat * 0.25;
    }
  });

  // ═══ BODY — Faint ambient thermal tint (0.15x) ═══
  const bodyT = t * 0.15;
  const bodyColor = coldColor.clone().lerp(coolColor, bodyT * 4);
  componentGroups.body.forEach((mesh) => {
    if (mesh.material && mesh !== selectedObject) {
      mesh.material.emissive = bodyColor;
      mesh.material.emissiveIntensity = bodyT * 0.15;
    }
  });

  // ═══ DYNAMIC HEAT LIGHT — Glowing point light on the model ═══
  if (!heatLight && model) {
    heatLight = new THREE.PointLight(0xff5500, 0, 3);
    heatLight.name = '__heatLight__';
    model.add(heatLight);
    heatLight.position.set(0, 0.5, 0);  // Center of model
  }
  if (heatLight) {
    heatLight.color.copy(thermalColor);
    heatLight.intensity = t > 0.4 ? t * 2.5 * pulse : 0;
    heatLight.distance = 2 + t * 3;
  }
}

// =========================================================================
// ENERGY FLOW ANIMATION
// =========================================================================
function updateEnergyFlow(elapsed, delta) {
  energyFlowParticles.forEach((particles) => {
    const positions = particles.geometry.attributes.position.array;
    const colors = particles.geometry.attributes.color.array;
    const count = positions.length / 3;

    const speed = telemetry.running ? (telemetry.rpm / 5000) : 0;
    for (let i = 0; i < count; i++) {
      // Move particles along X (simulating flow)
      positions[i * 3] += speed * delta * 2;
      // Oscillate Y
      positions[i * 3 + 1] += Math.sin(elapsed * 4 + i) * delta * 0.1;

      // Reset particles that go too far
      if (positions[i * 3] > 2) {
        positions[i * 3] = -2;
        positions[i * 3 + 1] = Math.random() * 1.2 + 0.3;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 1.5;
      }

      // Color based on mode
      if (telemetry.mode === 'eco') {
        colors[i * 3] = 0.13; colors[i * 3 + 1] = 0.83; colors[i * 3 + 2] = 0.93;
      } else if (telemetry.mode === 'normal') {
        colors[i * 3] = 0.66; colors[i * 3 + 1] = 0.33; colors[i * 3 + 2] = 0.97;
      } else if (telemetry.mode === 'wet') {
        colors[i * 3] = 0.18; colors[i * 3 + 1] = 0.83; colors[i * 3 + 2] = 0.75;
      } else {
        colors[i * 3] = 0.96; colors[i * 3 + 1] = 0.25; colors[i * 3 + 2] = 0.37;
      }
    }

    particles.geometry.attributes.position.needsUpdate = true;
    particles.geometry.attributes.color.needsUpdate = true;
    particles.material.opacity = telemetry.running ? 0.6 : 0.1;
  });
}

// =========================================================================
// DATA FETCHING — Core API Loops
// =========================================================================
async function fetchTelemetry() {
  try {
    const res = await fetch(`/data/${currentVehicleId}`);
    if (!res.ok) throw new Error('Network response was not ok');
    const data = await res.json();
    previousTelemetry = { ...telemetry };
    telemetry = data;
    updateDashboard(data);
    updateConnectionStatus(true);
  } catch (err) {
    console.warn('⚠️ Data fetch failed:', err.message);
    updateConnectionStatus(false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('active-vehicle-title').textContent = `EV DIGITAL TWIN — ${currentVehicleId.split('-')[1].toUpperCase()}`;
});

// Start telemetry poll
setInterval(fetchTelemetry, 100);    // 10Hz Focus Poll

// =========================================================================
// DASHBOARD UI UPDATES
// =========================================================================
function updateDashboard(data) {
  // --- Battery ---
  const batEl = document.getElementById('val-battery');
  const barBat = document.getElementById('bar-battery');
  const rangeEl = document.getElementById('val-range');
  const batStatusEl = document.getElementById('battery-status');

  const bat = Math.round(data.battery);
  batEl.textContent = bat;
  barBat.style.width = bat + '%';

  // Color based on level
  let batColor;
  if (bat > 60) batColor = 'var(--success)';
  else if (bat > 25) batColor = 'var(--warning)';
  else batColor = 'var(--danger)';
  batEl.style.color = batColor;
  barBat.style.background = batColor;

  // Estimated range (Dynamic based on mode efficiency)
  let efficiencyMultiplier = 3.8; // Default Normal
  if (data.mode === 'eco') efficiencyMultiplier = 4.5;
  else if (data.mode === 'sport') efficiencyMultiplier = 2.8;
  else if (data.mode === 'wet') efficiencyMultiplier = 3.5;

  rangeEl.textContent = Math.round(bat * efficiencyMultiplier);
  batStatusEl.textContent = data.running ? 'Discharging' : 'Idle';

  // State of Health (SoH)
  const healthEl = document.getElementById('val-health');
  if (healthEl && data.health !== undefined) {
    const health = data.health;
    healthEl.textContent = health.toFixed(1) + '%';
    if (health > 95) healthEl.style.color = '#22c55e'; // Green
    else if (health > 80) healthEl.style.color = '#eab308'; // Yellow
    else healthEl.style.color = '#ef4444'; // Red
  }

  // --- RPM ---
  const rpmEl = document.getElementById('val-rpm');
  const barRpm = document.getElementById('bar-rpm');
  const powerEl = document.getElementById('val-power');
  const torqueEl = document.getElementById('val-torque');

  rpmEl.textContent = data.rpm.toLocaleString();
  const rpmPct = Math.min(100, (data.rpm / 10000) * 100);
  barRpm.style.width = rpmPct + '%';

  let rpmColor = 'var(--accent)';
  if (data.mode === 'sport') rpmColor = 'var(--sport-accent)';
  else if (data.mode === 'normal') rpmColor = '#a855f7';
  else if (data.mode === 'wet') rpmColor = '#2dd4bf';
  rpmEl.style.color = rpmColor;
  barRpm.style.background = rpmColor;

  // Derived values
  powerEl.textContent = Math.round(data.rpm * 0.015);
  torqueEl.textContent = Math.round(180 + (data.rpm / 10000) * 150);

  // --- Temperature ---
  const tempEl = document.getElementById('val-temp');
  const tempRing = document.getElementById('temp-ring');
  const motorTempEl = document.getElementById('val-motor-temp');
  const batTempEl = document.getElementById('val-bat-temp');

  tempEl.textContent = Math.round(data.temp);
  motorTempEl.textContent = Math.round(data.temp * 0.85);
  batTempEl.textContent = Math.round(data.temp * 0.7);

  // Ring progress (circumference = 2 * π * 34 ≈ 213.6)
  const tempPct = THREE.MathUtils.clamp((data.temp - 20) / 100, 0, 1);
  const circumference = 213.6;
  tempRing.style.strokeDashoffset = circumference * (1 - tempPct);

  // Ring color
  let ringColor;
  if (data.temp < 50) ringColor = '#38bdf8';
  else if (data.temp < 70) ringColor = '#fbbf24';
  else if (data.temp < 85) ringColor = '#f97316';
  else ringColor = '#ef4444';
  tempRing.style.stroke = ringColor;
  tempEl.style.color = ringColor;

  // --- Mode Badge ---
  const badge = document.getElementById('mode-badge');
  const btnEco = document.getElementById('btn-eco');
  const btnNormal = document.getElementById('btn-normal');
  const btnSport = document.getElementById('btn-sport');
  const btnWet = document.getElementById('btn-wet');

  if (btnEco) btnEco.className = 'ctrl-btn';
  if (btnNormal) btnNormal.className = 'ctrl-btn';
  if (btnSport) btnSport.className = 'ctrl-btn';
  if (btnWet) btnWet.className = 'ctrl-btn';

  if (data.mode === 'sport') {
    badge.textContent = 'SPORT';
    badge.className = 'panel-badge badge-sport';
    if (btnSport) btnSport.classList.add('active', 'sport-active');
  } else if (data.mode === 'normal') {
    badge.textContent = 'NORMAL';
    badge.className = 'panel-badge badge-normal';
    if (btnNormal) btnNormal.classList.add('active', 'normal-active');
  } else if (data.mode === 'wet') {
    badge.textContent = 'WET';
    badge.className = 'panel-badge badge-wet';
    if (btnWet) btnWet.classList.add('active', 'wet-active');
  } else {
    badge.textContent = 'ECO';
    badge.className = 'panel-badge badge-eco';
    if (btnEco) btnEco.classList.add('active');
  }

  // --- Sim Button ---
  const simBtn = document.getElementById('btn-sim');
  if (data.running) {
    simBtn.className = 'sim-btn running';
    simBtn.innerHTML = '⏸ Stop Simulation';
  } else {
    simBtn.className = 'sim-btn stopped';
    simBtn.innerHTML = '▶ Start Simulation';
  }

  // --- Temperature Alerts ---
  checkAlerts(data);
}

function updateConnectionStatus(connected) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  if (connected) {
    if (dot) dot.classList.remove('offline');
    if (label) label.textContent = 'CONNECTED · LIVE DATA';
  } else {
    if (dot) dot.classList.add('offline');
    if (label) label.textContent = 'DISCONNECTED';
  }
}

// =========================================================================
// ALERTS
// =========================================================================
function checkAlerts(data) {
  const now = Date.now();
  if (now - lastAlertTime < 5000) return; // Cooldown

  if (data.temp >= 90) {
    showAlert('🚨 CRITICAL: Temperature ' + Math.round(data.temp) + '°C — Overheating!', 'danger');
    lastAlertTime = now;
  } else if (data.temp >= 75) {
    showAlert('⚠️ Warning: Temperature ' + Math.round(data.temp) + '°C — Approaching limit', 'warning');
    lastAlertTime = now;
  }

  if (data.battery <= 15) {
    showAlert('🔋 Low Battery: ' + Math.round(data.battery) + '% — Recharge needed', 'warning');
    lastAlertTime = now;
  }
}

function showAlert(text, type) {
  const container = document.getElementById('alert-container');
  const toast = document.createElement('div');
  toast.className = 'alert-toast ' + type;
  toast.textContent = text;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fadeOut');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

// =========================================================================
// CLICK / HOVER INTERACTION
// =========================================================================
function onModelClick(event) {
  if (!model) return;

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(model, true);

  // Filter out ground
  const hit = intersects.find((i) => i.object.name !== '__ground__');

  if (hit) {
    selectComponent(hit.object);
  } else {
    deselectComponent();
  }
}

function onMouseMove(event) {
  if (!model) return;

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(model, true);
  const hit = intersects.find((i) => i.object.name !== '__ground__');

  if (hit && hit.object !== selectedObject) {
    if (hoveredObject && hoveredObject !== selectedObject) {
      restoreMaterial(hoveredObject);
    }
    hoveredObject = hit.object;
    // Subtle hover highlight
    if (hoveredObject.material) {
      hoveredObject.material = hoveredObject.material.clone();
      hoveredObject.material.emissive = new THREE.Color(0x38bdf8);
      hoveredObject.material.emissiveIntensity = 0.15;
    }
    renderer.domElement.style.cursor = 'pointer';
  } else if (!hit) {
    if (hoveredObject && hoveredObject !== selectedObject) {
      restoreMaterial(hoveredObject);
    }
    hoveredObject = null;
    renderer.domElement.style.cursor = 'default';
  }
}

function selectComponent(mesh) {
  // Deselect previous
  if (selectedObject) {
    restoreMaterial(selectedObject);
  }

  selectedObject = mesh;

  // Highlight
  if (mesh.material) {
    mesh.material = mesh.material.clone();
    mesh.material.emissive = new THREE.Color(0x38bdf8);
    mesh.material.emissiveIntensity = 0.5;
  }

  // Show info panel
  showInfoPanel(mesh);
}

function deselectComponent() {
  if (selectedObject) {
    restoreMaterial(selectedObject);
    selectedObject = null;
  }
  closeInfoPanel();
}

function restoreMaterial(mesh) {
  const original = originalMaterials.get(mesh.uuid);
  if (original) {
    mesh.material = original.clone();
  }
}

// =========================================================================
// INFO PANEL
// =========================================================================
function showInfoPanel(mesh) {
  const panel = document.getElementById('info-panel');
  const title = document.getElementById('info-title');
  const body = document.getElementById('info-body');

  const type = mesh.userData.componentType || 'unknown';
  const displayName = formatComponentName(mesh.name, type);

  title.textContent = displayName;

  // Build info content based on component type
  let html = '';

  const stat = (label, value) =>
    `<div class="info-stat"><span>${label}</span><span class="info-stat-val">${value}</span></div>`;

  switch (type) {
    case 'wheel':
      html += stat('Type', 'High-Performance Wheel');
      html += stat('Angular Velocity', Math.round(telemetry.rpm * 0.1) + ' rad/s');
      html += stat('Traction Level', 'Optimal (Regenerative)');
      html += stat('Material', 'Forged Aluminum Alloy');
      break;
    case 'motor':
      html += stat('Type', 'Drive Unit');
      html += stat('RPM', telemetry.rpm.toLocaleString());
      html += stat('Power Stage', Math.round(telemetry.rpm * 0.015) + ' kW');
      html += stat('Thermal State', Math.round(telemetry.temp) + '°C');
      html += stat('Health', '🟢 100%');
      break;
    case 'battery':
      html += stat('Chemistry', 'Lithium Nickel Manganese');
      html += stat('SoC (Charge)', Math.round(telemetry.battery) + '%');
      html += stat('Module Temp', Math.round(telemetry.temp * 0.7) + '°C');
      html += stat('Cell Balancing', 'Active');
      html += stat('Cycles', '124');
      break;
    case 'body':
      html += stat('Type', 'Exterior Trim');
      html += stat('Aerodynamics', telemetry.mode === 'sport' ? 'Active Aero (Aggressive)' : 'Efficiency (Sleek)');
      html += stat('Paint Finish', 'Metallic Digital Blue');
      break;
    case 'lights':
      html += stat('Illumination', 'Adaptive Matrix LED');
      html += stat('Intensity', 'Dynamic');
      html += stat('Logic State', telemetry.mode === 'wet' ? 'Fog Optimized' : 'Standard');
      break;
    case 'interior':
      html += stat('Zone', 'Driver Cockpit');
      html += stat('Ergonomics', 'Sport-Optimized');
      break;
    case 'chassis':
      html += stat('Rigidity', 'Ultra-High Torsional Strength');
      html += stat('Suspension', 'Multi-link Dynamic Air');
      break;
    default:
      html += stat('Status', 'Operational');
      html += stat('Group', type.charAt(0).toUpperCase() + type.slice(1));
  }

  html += `<div style="margin-top:12px; font-size:9px; color:rgba(255,255,255,0.2)">Component ID: ${mesh.name || 'ANON_MESH'}</div>`;

  body.innerHTML = html;
  panel.classList.add('visible');
}

function formatComponentName(name, type) {
  const lowName = (name || '').toLowerCase();
  
  // 1. Precise Match from the Map
  for (const [key, mapping] of Object.entries(COMPONENT_NAME_MAP)) {
    if (lowName.includes(key)) return mapping;
  }

  // 2. Fallback to clean formatting
  if (!name || name === type) return type.charAt(0).toUpperCase() + type.slice(1);

  return name
    .replace(/[_.-]/g, ' ')
    .replace(/\d+/g, '')
    .trim()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .trim() || 'Internal Component';
}

// =========================================================================
// UI CONTROL FUNCTIONS (exposed globally)
// =========================================================================
window.setMode = async function (mode) {
  try {
    await fetch(`/mode/${currentVehicleId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });

    // Update energy flow label color
    const dots = document.querySelectorAll('.energy-dot');
    let color = 'var(--accent)';
    if (mode === 'sport') color = 'var(--sport-accent)';
    else if (mode === 'normal') color = '#a855f7';
    else if (mode === 'wet') color = '#2dd4bf';
    dots.forEach((d) => (d.style.background = color));

  } catch (err) {
    console.warn('Mode switch failed:', err);
  }
};

window.resetOverride = async function (type) {
  try {
    const label = type === 'rpm' ? 'label-rpm-override' : 'label-temp-override';
    document.getElementById(label).textContent = 'Auto';
    
    await fetch('/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [type]: null }),
    });
  } catch (err) {
    console.warn('Reset override failed:', err);
  }
};

async function syncOverride(type, value) {
  try {
    await fetch(`/override/${currentVehicleId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [type]: parseFloat(value) }),
    });
  } catch (err) {
    console.warn('Sync override failed:', err);
  }
}

window.toggleSim = async function () {
  try {
    const res = await fetch(`/control/${currentVehicleId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle' }),
    });
    const data = await res.json();
    telemetry.running = data.running;
  } catch (err) {
    console.warn('Sim toggle failed:', err);
  }
};

window.closeInfoPanel = function () {
  document.getElementById('info-panel').classList.remove('visible');
  if (selectedObject) {
    restoreMaterial(selectedObject);
    selectedObject = null;
  }
};

// =========================================================================
// RL AGENT — Data Fetching & Dashboard
// =========================================================================
async function fetchRLStatus() {
  try {
    const res = await fetch(`/rl/status/${currentVehicleId}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.available) {
      updateAIDashboard(data);
    }
  } catch (err) {
    // Silent fail — RL may not be available
  }
}

function updateAIDashboard(data) {
  // Epsilon
  const epsilonEl = document.getElementById('ai-epsilon');
  if (epsilonEl) epsilonEl.textContent = data.epsilon.toFixed(2);

  // Episode
  const episodeEl = document.getElementById('ai-episode');
  if (episodeEl) episodeEl.textContent = data.episode;

  // Avg Reward
  const avgRewardEl = document.getElementById('ai-avg-reward');
  if (avgRewardEl) avgRewardEl.textContent = data.avg_reward.toFixed(1);

  // Loss
  const lossEl = document.getElementById('ai-loss');
  if (lossEl) lossEl.textContent = data.last_loss.toFixed(4);

  // Current Action
  const actionEl = document.getElementById('ai-action');
  if (actionEl) actionEl.textContent = data.enabled ? data.action_name : '—';

  // Reward
  const rewardEl = document.getElementById('ai-reward');
  if (rewardEl) rewardEl.textContent = data.enabled ? data.last_reward.toFixed(1) : '0.0';

  // Phase badge (exploring vs exploiting)
  const phaseEl = document.getElementById('ai-phase');
  if (phaseEl) {
    if (data.exploring) {
      phaseEl.textContent = 'EXPLORING';
      phaseEl.className = 'ai-exploring explore';
    } else {
      phaseEl.textContent = 'EXPLOITING';
      phaseEl.className = 'ai-exploring exploit';
    }
  }

  // AI toggle button state
  const btnAI = document.getElementById('btn-ai');
  const panelAI = document.getElementById('panel-ai');
  if (btnAI) {
    if (data.enabled) {
      btnAI.classList.add('active');
      btnAI.innerHTML = '<span>🤖</span> Disable AI Autopilot';
      if (panelAI) panelAI.classList.add('ai-active');
    } else {
      btnAI.classList.remove('active');
      btnAI.innerHTML = '<span>🤖</span> Enable AI Autopilot';
      if (panelAI) panelAI.classList.remove('ai-active');
    }
  }

  // Q-value bars
  if (data.q_values && data.q_values.length >= 4) {
    const qValues = data.q_values;
    const maxQ = Math.max(...qValues.map(Math.abs), 0.01);
    const bestIdx = qValues.indexOf(Math.max(...qValues));

    for (let i = 0; i < data.q_values.length; i++) {
      const bar = document.getElementById('qbar-' + i);
      const num = document.getElementById('qval-' + i);
      if (bar) {
        const pct = Math.max(2, (Math.abs(qValues[i]) / maxQ) * 100);
        bar.style.width = pct + '%';
        bar.className = i === bestIdx ? 'qval-bar-fill best' : 'qval-bar-fill';
      }
      if (num) {
        num.textContent = qValues[i].toFixed(2);
      }
    }
  }
}

window.toggleAI = async function () {
  try {
    const res = await fetch(`/rl/control/${currentVehicleId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle' }),
    });
    const data = await res.json();
    console.log('🤖 AI Autopilot:', data.enabled ? 'ENABLED' : 'DISABLED');
  } catch (err) {
    console.warn('AI toggle failed:', err);
  }
};

// Start RL status polling alongside telemetry
setInterval(fetchRLStatus, 1000);

// =========================================================================
// RESIZE HANDLER
// =========================================================================
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// =========================================================================
// START
// =========================================================================
init();
