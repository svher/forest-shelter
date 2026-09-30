import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ForestAudio } from './audio.js';
import { RainSystem } from './rain-system.js';
import { DaylightTransition, morningProfile } from './daylight.js';
import { MorningWorld, morningSkyFragment } from './morning-world.js';
import { SunlightPass } from './sunlight-pass.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

const canvas = document.querySelector('#scene');
const shelter = document.querySelector('#shelter');
const mobile = matchMedia('(max-width: 700px)').matches;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const state = { rain: 0.58, morning: 0, targetMorning: 0, lamp: true, fire: true, view: 'room', tea: 0, immersed: false };
const daylight = new DaylightTransition();
const lightPreferences = { night: { lamp: true, fire: true }, morning: { lamp: false, fire: false } };
const requestedRain = new URLSearchParams(location.search).get('rain');
if (requestedRain !== null && Number.isFinite(Number(requestedRain))) {
  state.rain = THREE.MathUtils.clamp(Number(requestedRain) / 100, 0, 1);
}
const audio = new ForestAudio();
const scene = new THREE.Scene();
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const interactables = [];
const trees = [];
const flameUniforms = [];
const atmosphereUniforms = [];
const exteriorShadowLights = [];
const embers = [];
let renderer;
let composer;
let camera;
let controls;
let rainSystem;
let lightningLight;
let steamUniforms;
let morningWorld;
let skylightFill;
let bounceLight;
let beverageMaterial;
let coffeeFoam;
let duvetCorners;
let softShadows = [];
let ambientOcclusionExcluded = [];
let shadowTimer = 0;
let transitioning = null;
let animationFrame;
let toastTimeout;
let lastPointer = { x: 0, y: 0, moved: false };
let seed = 384917;

function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

function canvasTexture(width, height, paint, repeat = [1, 1]) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  paint(element.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(...repeat);
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function woodTexture() {
  return canvasTexture(1024, 256, (context, width, height) => {
    context.fillStyle = '#97704b';
    context.fillRect(0, 0, width, height);
    for (let grain = 0; grain < 1800; grain++) {
      const base = random() * height;
      const shade = Math.floor(28 + random() * 65);
      context.strokeStyle = `rgba(${shade},${Math.floor(shade * 0.65)},${Math.floor(shade * 0.34)},${0.08 + random() * 0.22})`;
      context.lineWidth = 0.3 + random() * 1.1;
      context.beginPath();
      for (let position = 0; position <= width; position += 12) {
        const wave = Math.sin(position * 0.012 + base * 0.048) * 2.2 + Math.sin(position * 0.032 + base) * 0.65;
        context.lineTo(position, base + wave);
      }
      context.stroke();
    }
    for (let knot = 0; knot < 7; knot++) {
      const horizontal = random() * width;
      const vertical = random() * height;
      for (let ring = 0; ring < 17; ring++) {
        context.strokeStyle = `rgba(46,24,13,${0.2 - ring * 0.009})`;
        context.beginPath();
        context.ellipse(horizontal, vertical, 4 + ring * 2.4, 1 + ring * 0.6, 0.015, 0, Math.PI * 2);
        context.stroke();
      }
    }
  });
}

function fabricTexture(color, chunky = false) {
  return canvasTexture(512, 512, (context, width, height) => {
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    const step = chunky ? 14 : 5;
    for (let vertical = 0; vertical < height; vertical += step) {
      for (let horizontal = 0; horizontal < width; horizontal += step) {
        const bright = Math.floor(120 + random() * 115);
        context.strokeStyle = `rgba(${bright},${bright},${bright},.19)`;
        context.lineWidth = chunky ? 3.5 : 1.2;
        context.beginPath();
        context.moveTo(horizontal + 2, vertical);
        context.quadraticCurveTo(horizontal + step, vertical + step * 0.35, horizontal + step * 0.45, vertical + step);
        context.moveTo(horizontal + 1, vertical);
        context.quadraticCurveTo(horizontal - step * 0.4, vertical + step * 0.45, horizontal + step * 0.4, vertical + step);
        context.stroke();
        context.fillStyle = 'rgba(22,18,12,.1)';
        context.fillRect(horizontal, vertical, 1, step);
      }
    }
  }, chunky ? [7, 7] : [4, 4]);
}

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.83, ...options });
}

function mesh(geometry, surface, position, parent = scene, cast = true) {
  const object = new THREE.Mesh(geometry, surface);
  object.position.set(...position);
  object.castShadow = cast;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

function box(size, position, surface, radius = 0, parent = scene) {
  return mesh(radius ? new RoundedBoxGeometry(...size, 3, radius) : new THREE.BoxGeometry(...size), surface, position, parent);
}

function cylinder(top, bottom, height, position, surface, parent = scene, segments = 20) {
  return mesh(new THREE.CylinderGeometry(top, bottom, height, segments), surface, position, parent);
}

function rod(start, end, radius, surface, parent = scene) {
  const from = new THREE.Vector3(...start);
  const to = new THREE.Vector3(...end);
  const middle = from.clone().add(to).multiplyScalar(0.5);
  const object = cylinder(radius, radius, from.distanceTo(to), middle.toArray(), surface, parent, 8);
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.sub(from).normalize());
  return object;
}

function softShadow(width, depth, position, opacity = 0.4) {
  const texture = canvasTexture(128, 128, context => {
    const gradient = context.createRadialGradient(64, 64, 8, 64, 64, 64);
    gradient.addColorStop(0, `rgba(9,6,3,${opacity})`);
    gradient.addColorStop(0.55, `rgba(9,6,3,${opacity * 0.6})`);
    gradient.addColorStop(1, 'rgba(9,6,3,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  });
  const object = mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }), position, scene, false);
  object.rotation.x = -Math.PI / 2;
  softShadows.push(object);
  return object;
}

const roofSlope = 0.66;
const roofHeight = depth => 3.1 + (depth + 4.4) * roofSlope;
let warmLight;
let fireLight;
let coolLight;
let hemisphere;
let bulb;
let shadeMaterial;
let fireGroup;
let sky;

function buildArchitecture(wood) {
  const darkWood = material('#9c8168', { map: wood, bumpMap: wood, bumpScale: 0.025 });
  const wallWood = material('#b99a78', { map: wood, bumpMap: wood, bumpScale: 0.025 });
  const frameWood = material('#72533c', { map: wood, bumpMap: wood, bumpScale: 0.018, roughness: 0.62 });
  const plankMaterials = Array.from({ length: 9 }, () => material(new THREE.Color('#71543a').multiplyScalar(0.69 + random() * 0.45), { map: wood, bumpMap: wood, bumpScale: 0.018, roughness: 0.65 }));
  box([11.7, 0.2, 12.2], [0, -0.14, 1], frameWood);
  for (let plank = 0; plank < 30; plank++) {
    const horizontal = -5.65 + plank * 0.39;
    for (let segment = 0; segment < 3; segment++) {
      const object = box([0.375, 0.07, 4.01], [horizontal, 0, -3.04 + segment * 4.03], plankMaterials[(plank + segment * 3) % 9], 0.01);
      object.material.map = wood;
    }
  }
  for (let row = 0; row < 11; row++) {
    const object = box([11.65, 0.276, 0.28], [0, 0.18 + row * 0.284, -4.5], wallWood, 0.055);
    object.material = wallWood.clone();
    object.material.color.multiplyScalar(0.82 + random() * 0.26);
  }
  for (let side = -1; side <= 1; side += 2) {
    for (let depth = -4.35; depth <= 7.35; depth += 0.48) {
      const height = roofHeight(depth) + 0.18;
      box([0.23, height, 0.467], [side * 5.75, height / 2, depth], darkWood, 0.01);
    }
    box([0.2, 0.14, 11.6], [side * 5.57, 0.2, 1], frameWood);
  }
  box([11.7, roofHeight(7.2), 0.2], [0, roofHeight(7.2) / 2, 7.2], darkWood);
  const roofLength = Math.sqrt(1 + roofSlope * roofSlope) * 5.8;
  for (const horizontal of [-4.59, 4.97]) {
    const object = box([horizontal < 0 ? 2.6 : 1.85, 0.13, roofLength], [horizontal, roofHeight(-1.55), -1.55], darkWood);
    object.rotation.x = -Math.atan(roofSlope);
  }
  const frontCeiling = box([11.8, 0.16, 7.35], [0, roofHeight(4.28), 4.28], darkWood);
  frontCeiling.rotation.x = -Math.atan(roofSlope);
  const rearBeam = box([11.7, 0.26, 0.3], [0, 3.03, -4.3], frameWood, 0.015);
  rearBeam.receiveShadow = true;
  for (const horizontal of [-5.5, -3.35, 4.12, 5.5]) {
    rod([horizontal, roofHeight(-4.38) - 0.03, -4.38], [horizontal, roofHeight(4.5) - 0.03, 4.5], 0.145, frameWood);
  }
  const metalFrame = material('#48535a', { metalness: 0.83, roughness: 0.26 });
  for (const horizontal of [-3.31, -0.86, 1.64, 4.1]) {
    const mullion = box([0.09, 0.13, 5.64 * Math.sqrt(1 + roofSlope ** 2)], [horizontal, roofHeight(-1.51), -1.51], metalFrame, 0.009);
    mullion.rotation.x = -Math.atan(roofSlope);
  }
  for (const depth of [-4.33, -1.5, 1.31]) {
    const beam = box([7.5, 0.135, 0.11], [0.38, roofHeight(depth) - 0.015, depth], metalFrame, 0.009);
    beam.rotation.x = -Math.atan(roofSlope);
  }
  for (const horizontal of [-5.55, -3.36, 4.15, 5.55]) {
    box([0.19, 3.03, 0.3], [horizontal, 1.5, -4.28], frameWood, 0.03);
  }
  rainSystem = new RainSystem({
    scene, renderer, mobile, slope: roofSlope, roofHeight,
    paneColumns: [-3.31, -0.86, 1.64, 4.1],
    paneRows: [-4.33, -1.5, 1.31],
    audio, initialRain: state.rain,
    diagnostics: new URLSearchParams(location.search).has('rain-debug')
  });
  interactables.push(...rainSystem.panes);
  return { darkWood, wallWood, frameWood };
}

function buildBed(wood, frames) {
  const linenTexture = fabricTexture('#ddd4bf');
  const linen = material('#e1d7bc', { map: linenTexture, bumpMap: linenTexture, bumpScale: 0.025, roughness: 1 });
  const cream = material('#c9c0a9', { map: linenTexture, bumpMap: linenTexture, bumpScale: 0.04 });
  const cushionTexture = fabricTexture('#af8e62', true);
  const cushion = material('#c5a172', { map: cushionTexture, bumpMap: cushionTexture, bumpScale: 0.05 });
  const mossTexture = fabricTexture('#727866', true);
  const moss = material('#8b9480', { map: mossTexture, bumpMap: mossTexture, bumpScale: 0.06, roughness: 1 });
  const blanketTexture = fabricTexture('#b29b7d', true);
  const blanketMaterial = material('#cab191', { map: blanketTexture, bumpMap: blanketTexture, bumpScale: 0.07, roughness: 1, side: THREE.DoubleSide });
  const bedX = 0.5;
  const bedZ = -1.6;
  softShadow(5.1, 6, [bedX, 0.05, bedZ], 0.7);
  box([3.72, 0.25, 4.48], [bedX, 0.45, bedZ], frames.frameWood, 0.085);
  box([3.85, 0.2, 0.2], [bedX, 0.55, 0.63], frames.darkWood, 0.05);
  for (const horizontal of [-1.05, 2.04]) {
    for (const depth of [-3.5, 0.25]) cylinder(0.1, 0.12, 0.5, [horizontal, 0.24, depth], frames.frameWood);
  }
  box([3.52, 0.45, 4.13], [bedX, 0.76, bedZ], cream, 0.18);
  box([3.77, 1.55, 0.21], [bedX, 1.18, -3.87], frames.darkWood, 0.12);
  box([3.4, 1.08, 0.22], [bedX, 1.3, -3.72], material('#898272', { map: linenTexture, bumpMap: linenTexture, bumpScale: 0.035 }), 0.12);
  for (let seam = 0; seam < 5; seam++) rod([-0.85 + seam * 0.67, 0.91, -3.591], [-0.85 + seam * 0.67, 1.77, -3.591], 0.006, material('#5b594f'));
  const duvetGeometry = new THREE.PlaneGeometry(3.78, 3.63, 65, 65);
  const positions = duvetGeometry.attributes.position;
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const horizontal = positions.getX(vertex);
    const vertical = positions.getY(vertex);
    const drape = Math.pow(Math.max(0, Math.abs(horizontal) - 1.54) / 0.35, 1.4) * 0.36 + Math.pow(Math.max(0, -vertical - 1.39) / 0.44, 1.6) * 0.45;
    const fold = 0.021 * Math.sin(horizontal * 4 + vertical * 2.5) + 0.011 * Math.sin(vertical * 7 - horizontal * 3.2) + 0.006 * Math.sin(vertical * 13 + horizontal * 4);
    positions.setZ(vertex, 0.095 + fold - drape);
  }
  duvetGeometry.computeVertexNormals();
  const duvet = mesh(duvetGeometry, linen, [bedX, 0.985, -1.18]);
  duvet.rotation.x = -Math.PI / 2;
  duvetCorners = { geometry: duvetGeometry, original: new Float32Array(positions.array), last: -1 };
  for (const [horizontal, depth, rotation] of [[-0.38, -3.05, -0.08], [1.3, -3.07, 0.06]]) {
    const pillow = box([1.52, 0.42, 0.95], [horizontal, 1.21, depth], linen, 0.2);
    pillow.rotation.set(0.28, rotation, rotation * 0.4);
    const second = box([1.25, 0.4, 0.77], [horizontal + 0.03, 1.14, depth + 0.4], cream, 0.18);
    second.rotation.set(0.18, -rotation, rotation);
  }
  const cushionOne = box([0.74, 0.5, 0.63], [-0.2, 1.22, -2.42], moss, 0.16);
  cushionOne.rotation.set(0.37, 0.05, -0.15);
  const cushionTwo = box([0.77, 0.48, 0.66], [1.04, 1.22, -2.51], cushion, 0.16);
  cushionTwo.rotation.set(0.3, -0.13, 0.1);
  const blanketGeometry = new THREE.PlaneGeometry(3.91, 1.48, 85, 40);
  const blanketPositions = blanketGeometry.attributes.position;
  for (let vertex = 0; vertex < blanketPositions.count; vertex++) {
    const horizontal = blanketPositions.getX(vertex);
    const vertical = blanketPositions.getY(vertex);
    const fall = Math.pow(Math.max(0, Math.abs(horizontal) - 1.56) / 0.4, 1.2) * 0.6;
    blanketPositions.setZ(vertex, 0.018 * Math.sin(horizontal * 6 + vertical * 5) + 0.009 * Math.sin(horizontal * 13 - vertical * 8) - fall);
  }
  blanketGeometry.computeVertexNormals();
  const blanket = mesh(blanketGeometry, blanketMaterial, [bedX + 0.025, 1.15, -0.12]);
  blanket.rotation.set(-Math.PI / 2, 0, -0.045);
  for (let fringe = 0; fringe < 66; fringe++) {
    const horizontal = -1.44 + fringe * 0.059;
    const fall = Math.pow(Math.max(0, Math.abs(horizontal - bedX) - 1.56) / 0.4, 1.2) * 0.6;
    rod([horizontal, 1.12 - fall, 0.595], [horizontal + 0.014, 1.07 - fall, 0.73 + random() * 0.04], 0.009, blanketMaterial);
  }
  const rugTexture = fabricTexture('#b3a694', true);
  const rugMaterial = material('#b5aa92', { map: rugTexture, bumpMap: rugTexture, bumpScale: 0.085, roughness: 1 });
  box([5.65, 0.045, 5.8], [0.3, 0.069, -0.16], rugMaterial, 0.024);
  for (let fringe = 0; fringe < 100; fringe++) {
    const horizontal = -2.5 + fringe * 0.057;
    rod([horizontal, 0.08, 2.73], [horizontal + random() * 0.03, 0.068, 2.87 + random() * 0.1], 0.009, rugMaterial);
  }
  softShadow(1.7, 1.5, [-2.11, 0.085, -2.87], 0.52);
  box([0.97, 0.1, 0.84], [-2.14, 0.92, -2.98], frames.darkWood, 0.04);
  box([0.84, 0.29, 0.69], [-2.14, 0.7, -2.98], frames.frameWood, 0.035);
  box([0.76, 0.19, 0.025], [-2.14, 0.72, -2.62], frames.wallWood, 0.025);
  cylinder(0.026, 0.026, 0.065, [-2.14, 0.72, -2.579], material('#b39968', { metalness: 0.65, roughness: 0.35 })).rotation.x = Math.PI / 2;
  for (const horizontal of [-2.49, -1.8]) for (const depth of [-3.25, -2.7]) box([0.065, 0.64, 0.065], [horizontal, 0.34, depth], frames.frameWood);
  buildLamp([-2.19, 0.98, -3.02]);
  buildBook([-2.09, 0.99, -2.63], '#69765f', 0.42, 0.075, 0.29, -0.15);
  buildTea([-1.94, 1.11, -2.61]);
}

function buildLamp(position) {
  const group = new THREE.Group();
  group.position.set(...position);
  scene.add(group);
  const brass = material('#a28755', { metalness: 0.7, roughness: 0.36 });
  cylinder(0.23, 0.26, 0.06, [0, 0.015, 0], brass, group);
  cylinder(0.047, 0.07, 0.49, [0, 0.28, 0], brass, group);
  const shadeTexture = fabricTexture('#e7cf9d');
  shadeMaterial = material('#ffdb97', { map: shadeTexture, emissive: '#efb458', emissiveIntensity: 0.8, side: THREE.DoubleSide, roughness: 1 });
  const shade = mesh(new THREE.CylinderGeometry(0.245, 0.4, 0.43, 48, 1, true), shadeMaterial, [0, 0.61, 0], group);
  shade.castShadow = false;
  for (const [height, radius] of [[0.395, 0.4], [0.825, 0.244]]) {
    const rim = mesh(new THREE.TorusGeometry(radius, 0.009, 6, 48), brass, [0, height, 0], group, false);
    rim.rotation.x = Math.PI / 2;
  }
  bulb = mesh(new THREE.SphereGeometry(0.082, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.9, 0.8) }), [0, 0.51, 0], group, false);
  warmLight = new THREE.PointLight('#ffd093', 48, 9, 2);
  warmLight.position.set(position[0], position[1] + 0.51, position[2]);
  warmLight.castShadow = true;
  warmLight.shadow.mapSize.set(1024, 1024);
  warmLight.shadow.bias = -0.002;
  warmLight.shadow.normalBias = 0.04;
  warmLight.shadow.camera.near = 0.1;
  scene.add(warmLight);
  shade.userData.action = 'lamp';
  interactables.push(shade);
}

function buildBook(position, color, width = 0.4, height = 0.08, depth = 0.58, angle = 0) {
  const group = new THREE.Group();
  group.position.set(...position);
  group.rotation.y = angle;
  scene.add(group);
  const cover = material(color);
  const paper = material('#cac1a6');
  box([width, height, depth], [0, 0, 0], paper, 0.008, group);
  box([width + 0.016, 0.014, depth + 0.024], [0, height / 2, 0], cover, 0.005, group);
  box([width + 0.016, 0.014, depth + 0.024], [0, -height / 2, 0], cover, 0.005, group);
  box([0.024, height + 0.015, depth + 0.025], [-width / 2, 0, 0], cover, 0.004, group);
  return group;
}

function buildTea(position) {
  const ceramic = material('#cad0b7', { roughness: 0.32 });
  const group = new THREE.Group();
  group.position.set(...position);
  scene.add(group);
  cylinder(0.16, 0.14, 0.023, [0, -0.067, 0], ceramic, group, 40);
  const cup = cylinder(0.107, 0.076, 0.17, [0, 0.025, 0], ceramic, group, 36);
  cup.userData.action = 'tea';
  interactables.push(cup);
  beverageMaterial = material('#423022', { roughness: 0.17, metalness: 0.15 });
  cylinder(0.093, 0.093, 0.01, [0, 0.111, 0], beverageMaterial, group, 36);
  coffeeFoam = mesh(new THREE.TorusGeometry(0.082, 0.007, 7, 32), material('#c7a276', { transparent: true, opacity: 0 }), [0, 0.119, 0], group, false);
  coffeeFoam.rotation.x = -Math.PI / 2;
  const lip = mesh(new THREE.TorusGeometry(0.103, 0.009, 8, 40), ceramic, [0, 0.113, 0], group);
  lip.rotation.x = Math.PI / 2;
  const handle = mesh(new THREE.TorusGeometry(0.071, 0.018, 8, 22), ceramic, [0.119, 0.033, 0], group);
  handle.userData.action = 'tea';
  interactables.push(handle);
  steamUniforms = { time: { value: 0 }, boost: { value: 0 }, morning: { value: 0 } };
  const steamMaterial = new THREE.ShaderMaterial({
    uniforms: steamUniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.NormalBlending,
    vertexShader: `varying vec2 coordinates; void main(){coordinates=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `uniform float time; uniform float boost; uniform float morning; varying vec2 coordinates;
      void main(){vec2 point=coordinates;float swirl=sin(point.y*11.0-time*1.7)*(.03+point.y*.1)+sin(point.y*21.0-time)*.018;float center=.5+swirl;float width=.02+point.y*.11;float smoke=exp(-pow((point.x-center)/width,2.0));smoke+=exp(-pow((point.x-(.46-swirl*.7))/(width*.52),2.0))*.6;float fade=smoothstep(0.,.15,point.y)*(1.-smoothstep(.28,1.,point.y));float pulse=.6+.4*sin(point.y*18.-time*2.5);gl_FragColor=vec4(.87,.91,.89,smoke*fade*pulse*(.15+boost*.18+morning*.18));}`
  });
  const steam = mesh(new THREE.PlaneGeometry(0.49, 0.85), steamMaterial, [0, 0.55, 0], group, false);
  steam.rotation.y = 0.52;
  const steamCross = steam.clone();
  steamCross.rotation.y += Math.PI / 2;
  group.add(steamCross);
}

function buildFireplace(frames) {
  fireGroup = new THREE.Group();
  fireGroup.position.set(-4.22, 0.13, -3.65);
  scene.add(fireGroup);
  const charcoal = material('#262b29', { metalness: 0.65, roughness: 0.47 });
  const slate = material('#68675a', { roughness: 0.93 });
  const soot = material('#111815');
  box([1.88, 0.12, 1.6], [0, 0.06, 0.12], slate, 0.05, fireGroup);
  box([1.45, 0.095, 1.2], [0, 0.26, 0], charcoal, 0.025, fireGroup);
  box([1.42, 0.095, 1.13], [0, 1.49, 0], charcoal, 0.03, fireGroup);
  box([1.28, 1.23, 0.11], [0, 0.88, -0.5], soot, 0.02, fireGroup);
  box([0.16, 1.24, 1.12], [-0.65, 0.88, 0], charcoal, 0.02, fireGroup);
  box([0.16, 1.24, 1.12], [0.65, 0.88, 0], charcoal, 0.02, fireGroup);
  for (const horizontal of [-0.64, 0.64]) {
    box([0.1, 1.18, 0.11], [horizontal, 0.89, 0.57], charcoal, 0.02, fireGroup);
    box([0.12, 0.27, 0.15], [horizontal, 0.18, 0.4], charcoal, 0.02, fireGroup);
  }
  box([1.32, 0.14, 0.13], [0, 0.38, 0.56], charcoal, 0.02, fireGroup);
  box([1.32, 0.13, 0.13], [0, 1.42, 0.56], charcoal, 0.02, fireGroup);
  const doorGlass = box([1.09, 0.95, 0.016], [0, 0.91, 0.56], material('#7d8c89', { transparent: true, opacity: 0.04, metalness: 0.5, roughness: 0.12 }));
  fireGroup.add(doorGlass);
  doorGlass.userData.action = 'fire';
  interactables.push(doorGlass);
  box([0.06, 0.28, 0.06], [0.57, 0.92, 0.67], material('#b7a17a', { metalness: 0.7 }), 0.015, fireGroup);
  cylinder(0.16, 0.17, 2.2, [0, 2.57, -0.2], charcoal, fireGroup);
  for (let ring = 0; ring < 5; ring++) cylinder(0.172, 0.172, 0.045, [0, 1.57 + ring * 0.52, -0.2], charcoal, fireGroup);
  for (let log = 0; log < 5; log++) {
    const object = cylinder(0.092, 0.105, 0.79, [(log % 2 - 0.5) * 0.4, 0.48 + Math.floor(log / 2) * 0.11, -0.13 + log * 0.078], frames.frameWood, fireGroup, 14);
    object.rotation.z = Math.PI / 2 + (log % 2 ? 0.15 : -0.15);
  }
  const coalMaterial = material('#4d1507', { emissive: '#fa3607', emissiveIntensity: 1.8, roughness: 1 });
  for (let coal = 0; coal < 22; coal++) mesh(new THREE.IcosahedronGeometry(0.035 + random() * 0.04, 0), coalMaterial, [(random() - 0.5) * 0.92, 0.43 + random() * 0.07, (random() - 0.5) * 0.63], fireGroup);
  for (let flame = 0; flame < 7; flame++) {
    const uniforms = { time: { value: 0 }, offset: { value: flame * 5.12 }, power: { value: 1 } };
    flameUniforms.push(uniforms);
    const surface = new THREE.ShaderMaterial({
      uniforms, side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec2 coordinates;void main(){coordinates=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `uniform float time;uniform float offset;uniform float power;varying vec2 coordinates;
      void main(){vec2 point=coordinates;float sway=sin(point.y*9.-time*3.3+offset)*point.y*.17+sin(point.y*19.-time*5.+offset)*point.y*.06;float width=(1.-point.y)*.34;float shape=1.-smoothstep(width*.18,width,abs(point.x-.5+sway));float flutter=.8+.2*sin(point.y*27.-time*6.+offset);float alpha=shape*smoothstep(0.,.08,point.y)*(1.-smoothstep(.62,1.,point.y))*flutter;vec3 color=mix(vec3(2.,1.32,.34),vec3(1.2,.18,.012),point.y);gl_FragColor=vec4(color,alpha*power);}`
    });
    const object = mesh(new THREE.PlaneGeometry(0.32 + random() * 0.16, 0.56 + random() * 0.23), surface, [(flame - 3) * 0.12, 0.83, 0.16 + random() * 0.2], fireGroup, false);
    object.rotation.y = random() * 0.5 - 0.25;
  }
  fireLight = new THREE.PointLight('#ffab53', 50, 10, 2);
  fireLight.position.set(-4.22, 1.04, -2.89);
  fireLight.castShadow = true;
  fireLight.shadow.mapSize.set(1024, 1024);
  fireLight.shadow.bias = -0.002;
  fireLight.shadow.normalBias = 0.05;
  scene.add(fireLight);
  const emberSurface = new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 0.8, 0.1), transparent: true, opacity: 0.8 });
  for (let particle = 0; particle < 15; particle++) {
    const ember = mesh(new THREE.SphereGeometry(0.007, 5, 4), emberSurface.clone(), [0, 0.7, 0.2], fireGroup, false);
    embers.push({ mesh: ember, offset: random() * 6, horizontal: (random() - 0.5) * 0.7 });
  }
  softShadow(2.3, 2.1, [-4.22, 0.075, -3.34], 0.65);
  for (let log = 0; log < 7; log++) {
    const object = cylinder(0.1, 0.1, 0.65, [-5.17 + (log % 2) * 0.18, 0.22 + Math.floor(log / 2) * 0.17, -2.68], frames.darkWood, scene, 12);
    object.rotation.x = Math.PI / 2;
  }
  const poker = rod([-5.13, 0.25, -3.08], [-5.07, 1.16, -3.23], 0.018, charcoal);
  poker.castShadow = true;
}

function buildDecor(frames) {
  const shelving = new THREE.Group();
  shelving.position.set(-5.25, 0.07, -0.78);
  shelving.rotation.y = Math.PI / 2;
  scene.add(shelving);
  box([1.65, 2.6, 0.17], [0, 1.3, -0.3], frames.frameWood, 0.015, shelving);
  for (const horizontal of [-0.84, 0.84]) box([0.1, 2.65, 0.64], [horizontal, 1.33, 0], frames.darkWood, 0.02, shelving);
  for (let shelf = 0; shelf < 5; shelf++) {
    box([1.75, 0.075, 0.64], [0, 0.18 + shelf * 0.61, 0], frames.wallWood, 0.012, shelving);
    if (shelf === 4) continue;
    let horizontal = -0.7;
    const bookColors = ['#6c7662', '#8e6f4a', '#b7a58b', '#4c6061', '#806052', '#535c49', '#b0996d'];
    for (let book = 0; book < 8; book++) {
      const width = 0.07 + random() * 0.075;
      const height = 0.29 + random() * 0.19;
      const surface = material(bookColors[(shelf * 3 + book) % bookColors.length]);
      box([width, height, 0.36], [horizontal + width / 2, 0.23 + shelf * 0.61 + height / 2, 0.06], surface, 0.008, shelving);
      for (const mark of [0.07, height - 0.045]) box([width * 0.75, 0.009, 0.004], [horizontal + width / 2, 0.23 + shelf * 0.61 + mark, 0.244], material('#c4b089'), 0, shelving);
      horizontal += width + 0.014;
    }
  }
  cylinder(0.15, 0.1, 0.35, [-5.17, 2.92, -0.75], material('#8d9984'));
  for (let stem = 0; stem < 9; stem++) {
    const start = [-5.17, 3.01, -0.75];
    const end = [-5.17 + (random() - 0.5) * 0.64, 3.25 + random() * 0.3, -0.75 + (random() - 0.5) * 0.42];
    rod(start, end, 0.006, material('#5d654c'));
    const leaf = mesh(new THREE.SphereGeometry(0.1, 8, 6), material('#758166'), end);
    leaf.scale.set(0.44, 1.4, 0.28);
    leaf.rotation.z = random() - 0.5;
  }
  const frame = box([1.12, 0.9, 0.07], [3.5, 1.92, -4.29], frames.frameWood, 0.012);
  const painting = canvasTexture(256, 192, (context, width, height) => {
    context.fillStyle = '#b1ae91';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#7e8775';
    context.beginPath();
    context.moveTo(0, height);
    for (let horizontal = 0; horizontal <= width; horizontal += 16) context.lineTo(horizontal, 78 + Math.sin(horizontal * 0.023) * 37);
    context.lineTo(width, height);
    context.fill();
    for (let tree = 0; tree < 13; tree++) {
      const horizontal = random() * width;
      const vertical = 100 + random() * 75;
      const size = 20 + random() * 45;
      context.fillStyle = '#4d6254';
      context.beginPath();
      context.moveTo(horizontal, vertical - size);
      context.lineTo(horizontal + size * 0.24, vertical);
      context.lineTo(horizontal - size * 0.24, vertical);
      context.fill();
    }
  });
  mesh(new THREE.PlaneGeometry(0.96, 0.73), material('#d1c7a3', { map: painting }), [3.5, 1.92, frame.position.z + 0.04]);
  const bench = box([2.25, 0.13, 0.66], [0.62, 0.58, 1.57], frames.wallWood, 0.05);
  for (const horizontal of [-0.28, 1.53]) for (const depth of [1.34, 1.81]) box([0.1, 0.54, 0.1], [horizontal, 0.28, depth], frames.frameWood, 0.012);
  buildBook([1.1, 0.69, 1.58], '#4f665c', 0.46, 0.095, 0.55, -0.19);
  const openBook = new THREE.Group();
  openBook.position.set(0.3, 0.691, 1.58);
  openBook.rotation.y = 0.1;
  scene.add(openBook);
  const pageTexture = canvasTexture(256, 256, context => {
    context.fillStyle = '#c8c1a3';
    context.fillRect(0, 0, 256, 256);
    context.fillStyle = '#827762';
    for (let line = 0; line < 22; line++) context.fillRect(25, 25 + line * 9, 185 - random() * 40, 1);
  });
  const pages = material('#e0d7b7', { map: pageTexture });
  for (const side of [-1, 1]) {
    const page = box([0.28, 0.025, 0.4], [side * 0.132, 0.023, 0], pages, 0.003, openBook);
    page.rotation.z = side * 0.13;
  }
  const slippers = material('#b49a76', { map: fabricTexture('#bca684'), bumpScale: 0.03 });
  for (let shoe = 0; shoe < 2; shoe++) {
    const slipper = box([0.21, 0.115, 0.46], [-1.82 + shoe * 0.31, 0.16, 0.24 - shoe * 0.04], slippers, 0.1);
    slipper.rotation.y = -0.17 + shoe * 0.13;
  }
  const basketMaterial = material('#947650', { map: fabricTexture('#aa8458', true), bumpScale: 0.03 });
  cylinder(0.4, 0.32, 0.48, [3.14, 0.31, -2.9], basketMaterial);
  const rim = mesh(new THREE.TorusGeometry(0.4, 0.025, 8, 40), basketMaterial, [3.14, 0.55, -2.9]);
  rim.rotation.x = Math.PI / 2;
  const folded = box([0.48, 0.16, 0.52], [3.13, 0.59, -2.9], material('#a5a18a', { map: fabricTexture('#b3ad94', true) }), 0.055);
  folded.rotation.z = 0.1;
  softShadow(2.7, 1.3, [bench.position.x, 0.096, 1.57], 0.32);
}

function buildAtmosphere() {
  const shaftUniforms = { strength: { value: 1 } };
  const shaftMaterial = new THREE.ShaderMaterial({
    uniforms: shaftUniforms, transparent: true, side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 coordinates;void main(){coordinates=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform float strength;varying vec2 coordinates;void main(){float edge=pow(sin(coordinates.x*3.14159),3.);float fade=sin(coordinates.y*3.14159)*coordinates.y;gl_FragColor=vec4(.85,.54,.22,edge*fade*.023*strength);}`
  });
  const shaft = mesh(new THREE.CylinderGeometry(0.24, 1.12, 1.13, 40, 1, true), shaftMaterial, [-2.19, 0.83, -3.02], scene, false);
  shaft.receiveShadow = false;
  atmosphereUniforms.push({ uniforms: shaftUniforms, source: 'lamp' });
  const smokeUniforms = { strength: { value: 1 }, time: { value: 0 } };
  const smokeMaterial = new THREE.ShaderMaterial({
    uniforms: smokeUniforms, transparent: true, side: THREE.DoubleSide, depthWrite: false,
    vertexShader: `varying vec2 coordinates;void main(){coordinates=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform float time;uniform float strength;varying vec2 coordinates;
      void main(){vec2 point=coordinates;float center=.5+sin(point.y*9.-time*.65)*.08;float swirl=exp(-pow((point.x-center)/(.09+point.y*.17),2.));float fade=sin(point.y*3.14159);float waves=.6+.4*sin(point.y*22.-time*1.2);gl_FragColor=vec4(.69,.68,.6,swirl*fade*waves*.055*strength);}`
  });
  mesh(new THREE.PlaneGeometry(0.79, 0.6), smokeMaterial, [-4.22, 1.28, -3.24], scene, false);
  atmosphereUniforms.push({ uniforms: smokeUniforms, source: 'fire' });
}

function buildForest() {
  const existingObjects = new Set(scene.children);
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { morning: rainSystem.uniforms.morning, rain: rainSystem.uniforms.rain, time: rainSystem.uniforms.time, lightning: rainSystem.uniforms.lightning },
    vertexShader: `varying vec3 direction;void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: morningSkyFragment
  });
  sky = mesh(new THREE.SphereGeometry(95, 24, 16), skyMaterial, [0, 0, 0], scene, false);
  sky.receiveShadow = false;
  const trunkMaterial = material('#273531', { roughness: 1 });
  const treeTexture = canvasTexture(640, 1280, context => {
    context.strokeStyle = '#597367';
    context.lineCap = 'round';
    context.lineWidth = 7;
    context.beginPath();
    context.moveTo(320, 29);
    context.lineTo(316, 1270);
    context.stroke();
    for (let level = 0; level < 85; level++) {
      const height = 60 + level * 13.3;
      const width = 8 + level * 3.3;
      for (const side of [-1, 1]) {
        const tipX = 320 + side * width * (0.68 + random() * 0.32);
        const tipY = height + 22 + random() * 39;
        context.lineWidth = 1 + level * 0.029;
        context.strokeStyle = `rgb(${42 + Math.floor(random() * 18)},${69 + Math.floor(random() * 20)},${62 + Math.floor(random() * 14)})`;
        context.beginPath();
        context.moveTo(320, height);
        context.quadraticCurveTo(320 + side * width * 0.5, height + 8, tipX, tipY);
        context.stroke();
        for (let twig = 0; twig < 27; twig++) {
          const progress = twig / 27;
          const originX = 320 + (tipX - 320) * progress;
          const originY = height + (tipY - height) * progress;
          const twigLength = (7 + random() * 18) * (0.4 + level / 85);
          context.lineWidth = 1.2;
          for (let needle = 0; needle < 7; needle++) {
            const offset = needle * 1.7;
            context.beginPath();
            context.moveTo(originX + side * offset, originY);
            context.lineTo(originX + side * (offset + 3 + random() * 4), originY - twigLength * (1 - needle / 9));
            context.moveTo(originX + side * offset, originY);
            context.lineTo(originX + side * (offset + 4), originY + twigLength * 0.6);
            context.stroke();
          }
        }
      }
    }
  });
  const foliageMaterials = ['#738f8b', '#879e9a', '#a0adaa', '#6c8582'].map(color => material(color, {
    map: treeTexture, alphaTest: 0.24, side: THREE.DoubleSide, roughness: 0.36, metalness: 0.12
  }));
  const treeGeometry = new THREE.PlaneGeometry(1, 1);
  for (let tree = 0; tree < 62; tree++) {
    const horizontal = (random() - 0.5) * 49;
    let depth = -8 - random() * 28;
    if (tree > 42) depth = -4 + random() * 17;
    if (Math.abs(horizontal) < 7 && depth > -7) continue;
    const height = 8 + random() * 12;
    const group = new THREE.Group();
    group.position.set(horizontal, -0.6, depth);
    group.rotation.y = random() * Math.PI;
    scene.add(group);
    const trunk = cylinder(0.035, 0.19, height * 0.94, [0, height * 0.47, 0], trunkMaterial, group, 7);
    trunk.castShadow = false;
    for (let plane = 0; plane < 3; plane++) {
      const foliage = mesh(treeGeometry, foliageMaterials[tree % 4], [0, height / 2, 0], group, false);
      foliage.scale.set(height * 0.47, height, 1);
      foliage.rotation.y = plane * Math.PI / 3;
    }
    trees.push({ group, phase: random() * Math.PI * 2, weight: 0.002 + random() * 0.005 });
  }
  const ground = mesh(new THREE.PlaneGeometry(150, 150), material('#182721'), [0, -0.7, 0], scene, false);
  ground.rotation.x = -Math.PI / 2;
  const fogTexture = canvasTexture(128, 128, context => {
    const gradient = context.createRadialGradient(64, 64, 1, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(132,164,174,.16)');
    gradient.addColorStop(0.5, 'rgba(104,140,151,.06)');
    gradient.addColorStop(1, 'rgba(90,130,150,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  });
  for (let bank = 0; bank < 12; bank++) {
    const fog = mesh(new THREE.PlaneGeometry(15, 7), new THREE.MeshBasicMaterial({ map: fogTexture, transparent: true, depthWrite: false }), [(random() - 0.5) * 35, 3 + random() * 9, -10 - random() * 19], scene, false);
    fog.rotation.y = (random() - 0.5) * 0.5;
  }
  scene.children.forEach(object => {
    if (!existingObjects.has(object)) object.traverse(child => child.layers.enable(1));
  });
}

function lighting() {
  hemisphere = new THREE.HemisphereLight('#9fb8ce', '#6b4930', 1.6);
  scene.add(hemisphere);
  coolLight = new THREE.DirectionalLight('#a1b9d2', 2.1);
  coolLight.position.set(-2, 12, -9);
  coolLight.castShadow = true;
  coolLight.shadow.mapSize.set(2048, 2048);
  coolLight.shadow.camera.left = -8;
  coolLight.shadow.camera.right = 8;
  coolLight.shadow.camera.top = 9;
  coolLight.shadow.camera.bottom = -8;
  coolLight.shadow.normalBias = 0.05;
  coolLight.shadow.bias = -0.0007;
  scene.add(coolLight);
  bounceLight = new THREE.PointLight('#e6bf8b', 7, 11, 2);
  bounceLight.position.set(1, 4.7, 2.8);
  scene.add(bounceLight);
  RectAreaLightUniformsLib.init();
  skylightFill = new THREE.RectAreaLight('#f6f5ee', 0, 6.7, 4.1);
  skylightFill.position.set(0.3, 4.1, -1.6);
  skylightFill.lookAt(0.3, 0.5, -1.3);
  scene.add(skylightFill);
  scene.fog = new THREE.FogExp2('#26363e', 0.012);
  lightningLight = new THREE.DirectionalLight('#d8edff', 0);
  lightningLight.position.set(4, 18, -7);
  scene.add(lightningLight);
  scene.traverse(object => {
    if (object.isLight) object.layers.enable(1);
  });
}

// The room's directional shadow maps hug the cabin so the skylight frame stays sharp, which clipped every tree
// shadow a few metres short of its trunk and left the trees floating. The forest behind the glass (layer 1) is
// lit by wide-frustum twins of those lights instead, so each shadow starts at the base of its own tree.
function buildExteriorShadows() {
  const forest = new THREE.Object3D();
  forest.position.set(0, 0, -8);
  scene.add(forest);
  for (const light of [coolLight, morningWorld.sun]) {
    light.layers.disable(1);
    const twin = new THREE.DirectionalLight(light.color, light.intensity);
    twin.layers.set(1);
    twin.target = forest;
    twin.position.subVectors(light.position, light.target.position).setLength(70).add(forest.position);
    twin.castShadow = true;
    twin.shadow.mapSize.setScalar(mobile ? 1024 : 2048);
    Object.assign(twin.shadow.camera, { left: -36, right: 32, top: 36, bottom: -28, near: 20, far: 100 });
    twin.shadow.bias = -0.0005;
    twin.shadow.normalBias = 0.12;
    scene.add(twin);
    exteriorShadowLights.push({ light, twin });
  }
}

const cameraPresets = {
  room: { position: [4.65, 3.05, 6.85], target: [-0.22, 2.42, -1.85], up: [0, 1, 0], fov: mobile ? 72 : 57 },
  // Lying on the back with the head on the pillows: eyes face the skylight, tipped 8° toward the feet,
  // and the top of the head (the headboard side) is the top of the screen.
  bed: { position: [0.45, 1.56, -2.78], target: [0.45, 4.53, -2.36], up: [0, 0.139, -0.99], fov: 70 },
  fire: { position: [-1.62, 1.53, 0.88], target: [-3.87, 1.52, -3.41], up: [0, 1, 0], fov: 60 }
};
const bedFrame = (() => {
  const eye = new THREE.Vector3(...cameraPresets.bed.position);
  const forward = new THREE.Vector3(...cameraPresets.bed.target).sub(eye).normalize();
  const right = forward.clone().cross(new THREE.Vector3(...cameraPresets.bed.up)).normalize();
  return { eye, forward, right, head: right.clone().cross(forward) };
})();
const bedLook = { yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0, fov: cameraPresets.bed.fov, drag: null };

function setView(name) {
  const preset = cameraPresets[name];
  state.view = name;
  transitioning = { startPosition: camera.position.clone(), startTarget: controls.target.clone(), startUp: camera.up.clone(), startFov: camera.fov, time: 0, preset };
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === name)));
  controls.enabled = name !== 'bed';
  Object.assign(bedLook, { yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0, fov: cameraPresets.bed.fov, drag: null });
  controls.maxPolarAngle = name === 'bed' ? Math.PI * 0.97 : Math.PI * 0.64;
  if (name === 'bed') toast(state.targetMorning ? '再躺一会儿，看晨光穿过雨。' : '枕好枕头，抬头就是整片雨夜。');
  if (name === 'fire') toast(state.targetMorning ? '咖啡还热，世界正在醒来。' : '火还在燃烧，夜还很长。');
}

function updateTimeCopy() {
  const morning = state.targetMorning === 1;
  document.querySelector('.scene-caption h1').textContent = morning ? morningProfile(state.rain).headline : '今夜，只听雨。';
  document.querySelector('.scene-caption p').textContent = morning ? '世界在窗外醒来。' : '世界很大。这一刻，小屋刚刚好。';
  document.querySelector('#time-label').textContent = morning ? '06:40' : '23:48';
  document.querySelector('.panel-heading h2').textContent = morning ? '醒来，深呼吸。' : '让世界，慢一点。';
  document.querySelector('.panel-foot p').innerHTML = morning ? '轻点天窗，拭去一小片雾气<br>碰一碰咖啡，感受升起的暖意' : '轻点天窗，拭去一小片雾气<br>碰一碰茶杯，感受升起的暖意';
  document.querySelector('#audio-note').textContent = audio.enabled
    ? morning ? '晨雨、鸟鸣与林风，正陪着你' : '雨声、风声与炉火，正陪着你'
    : '戴上耳机，让雨声包围你';
  shelter.dataset.time = morning ? 'morning' : 'night';
}

function setTime(mode) {
  const previous = state.targetMorning ? 'morning' : 'night';
  lightPreferences[previous] = { lamp: state.lamp, fire: state.fire };
  state.targetMorning = mode === 'morning' ? 1 : 0;
  daylight.set(state.targetMorning);
  state.lamp = lightPreferences[mode].lamp;
  state.fire = lightPreferences[mode].fire;
  document.querySelector('#lamp').checked = state.lamp;
  document.querySelector('#fire').checked = state.fire;
  document.querySelectorAll('[data-time]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.time === mode)));
  updateTimeCopy();
}

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => element.classList.remove('visible'), 3600);
}

function setImmersive(enabled) {
  state.immersed = enabled;
  shelter.classList.toggle('immersed', enabled);
  document.querySelector('#exit-immersive').hidden = !enabled;
  document.querySelector('#immersive').setAttribute('aria-pressed', String(enabled));
  document.querySelectorAll('.interface').forEach(element => {
    element.inert = enabled || (element.id === 'ambience-panel' && shelter.classList.contains('panel-hidden'));
  });
  if (enabled) document.querySelector('#exit-immersive').focus({ preventScroll: true });
  else document.querySelector('#immersive').focus({ preventScroll: true });
}

function updateRay(event) {
  const rectangle = canvas.getBoundingClientRect();
  pointer.set((event.clientX - rectangle.left) / rectangle.width * 2 - 1, -(event.clientY - rectangle.top) / rectangle.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const intersection = raycaster.intersectObjects(interactables, false)[0];
  if (!intersection) return null;
  const obstruction = raycaster.intersectObjects(scene.children, true).find(hit => hit.object.visible && !hit.object.material?.transparent && hit.distance < intersection.distance - 0.03);
  return obstruction ? null : intersection;
}

function bindInteractions() {
  const rainInput = document.querySelector('#rain');
  rainInput.value = String(Math.round(state.rain * 100));
  rainInput.style.setProperty('--fill', `${rainInput.value}%`);
  document.querySelector('#rain-value').textContent = state.rain === 0 ? '雨暂时停了' : state.rain < 0.32 ? '轻柔细雨' : state.rain < 0.72 ? '绵绵中雨' : '倾盆大雨';
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); setView('room'); });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelectorAll('[data-time]').forEach(button => button.addEventListener('click', () => {
    setTime(button.dataset.time);
  }));
  document.querySelector('#rain').addEventListener('input', event => {
    state.rain = Number(event.target.value) / 100;
    document.querySelector('#rain-value').textContent = state.rain === 0 ? '雨暂时停了' : state.rain < 0.32 ? '轻柔细雨' : state.rain < 0.72 ? '绵绵中雨' : '倾盆大雨';
    event.target.style.setProperty('--fill', `${event.target.value}%`);
    updateTimeCopy();
  });
  document.querySelector('#volume').addEventListener('input', event => {
    audio.volume = Number(event.target.value) / 100;
    audio.sync();
    document.querySelector('#volume-value').textContent = `${event.target.value}%`;
    event.target.style.setProperty('--fill', `${event.target.value}%`);
  });
  document.querySelector('#lamp').addEventListener('change', event => { state.lamp = event.target.checked; });
  document.querySelector('#fire').addEventListener('change', event => {
    state.fire = event.target.checked;
    audio.sync();
  });
  document.querySelector('#sound-toggle').addEventListener('click', async () => {
    try {
      const enabled = await audio.toggle();
      document.querySelector('#sound-toggle').setAttribute('aria-pressed', String(enabled));
      document.querySelector('#sound-toggle').setAttribute('aria-label', enabled ? '关闭环境音' : '开启环境音');
      document.querySelector('#sound-label').textContent = enabled ? '声音已开启' : '开启声音';
      updateTimeCopy();
      document.querySelector('#sound-path').setAttribute('d', enabled ? 'M3 9v6h4l5 4V5L7 9H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14' : 'M3 9v6h4l5 4V5L7 9H3Zm13 0 5 6m0-6-5 6');
    } catch (error) {
      toast(error.message);
    }
  });
  document.querySelector('#panel-toggle').addEventListener('click', () => {
    const hidden = shelter.classList.toggle('panel-hidden');
    document.querySelector('#panel-toggle').setAttribute('aria-expanded', String(!hidden));
    document.querySelector('#panel-toggle').setAttribute('aria-label', hidden ? '展开环境设置' : '收起环境设置');
    document.querySelector('#ambience-panel').inert = hidden;
  });
  if (mobile) {
    shelter.classList.add('panel-hidden');
    document.querySelector('#panel-toggle').setAttribute('aria-expanded', 'false');
    document.querySelector('#panel-toggle').setAttribute('aria-label', '展开环境设置');
    document.querySelector('#ambience-panel').inert = true;
  }
  document.querySelector('#immersive').addEventListener('click', () => setImmersive(true));
  document.querySelector('#exit-immersive').addEventListener('click', () => setImmersive(false));
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') setImmersive(false);
    if (event.target.matches('input,button,a')) return;
    if (event.key === '1') setView('room');
    if (event.key === '2') setView('bed');
    if (event.key === '3') setView('fire');
  });
  controls.addEventListener('start', () => {
    if (transitioning) camera.up.set(...transitioning.preset.up);
    transitioning = null;
  });
  canvas.addEventListener('pointerdown', event => {
    if (state.view !== 'bed' || transitioning) return;
    bedLook.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (bedLook.drag?.id !== event.pointerId) return;
    bedLook.targetYaw = THREE.MathUtils.clamp(bedLook.targetYaw + (event.clientX - bedLook.drag.x) * .0032, -.95, .95);
    bedLook.targetPitch = THREE.MathUtils.clamp(bedLook.targetPitch + (event.clientY - bedLook.drag.y) * .0032, -.75, .45);
    bedLook.drag.x = event.clientX;
    bedLook.drag.y = event.clientY;
  });
  const endBedDrag = event => { if (bedLook.drag?.id === event.pointerId) bedLook.drag = null; };
  canvas.addEventListener('pointerup', endBedDrag);
  canvas.addEventListener('pointercancel', endBedDrag);
  canvas.addEventListener('wheel', event => {
    if (state.view !== 'bed') return;
    event.preventDefault();
    bedLook.fov = THREE.MathUtils.clamp(bedLook.fov + event.deltaY * .03, 42, 78);
  }, { passive: false });
  canvas.addEventListener('pointerdown', event => {
    lastPointer = { x: event.clientX, y: event.clientY, moved: false };
    document.querySelector('#interaction-label').style.display = 'none';
  });
  let lastHoverTime = 0;
  canvas.addEventListener('pointermove', event => {
    if (Math.hypot(event.clientX - lastPointer.x, event.clientY - lastPointer.y) > 5) lastPointer.moved = true;
    if (event.buttons || performance.now() - lastHoverTime < 85) return;
    lastHoverTime = performance.now();
    const hit = updateRay(event);
    const label = document.querySelector('#interaction-label');
    if (hit) {
      const labels = { window: '轻点，拭去雾气', tea: state.targetMorning ? '一杯刚煮好的咖啡' : '一杯温热的茶', lamp: '开关床头灯', fire: '开关壁炉' };
      label.textContent = labels[hit.object.userData.action];
      label.style.display = 'block';
      label.style.left = `${Math.min(event.clientX + 18, window.innerWidth - 150)}px`;
      label.style.top = `${event.clientY + 18}px`;
      canvas.style.cursor = 'pointer';
    } else {
      label.style.display = 'none';
      canvas.style.cursor = 'grab';
    }
  });
  canvas.addEventListener('pointerleave', () => { document.querySelector('#interaction-label').style.display = 'none'; });
  canvas.addEventListener('pointerup', event => {
    if (lastPointer.moved) return;
    const hit = updateRay(event);
    if (!hit) return;
    const action = hit.object.userData.action;
    if (action === 'window') {
      rainSystem.wipe(hit.object.userData.paneIndex, hit.uv);
      toast(state.targetMorning ? '擦亮晨光。雨仍在玻璃外流淌。' : '擦亮一小片夜色。雾气会慢慢回来。');
    } else if (action === 'tea') {
      state.tea = 1;
      toast(state.targetMorning ? '咖啡的香气，和一个缓慢的清晨。' : '茶还温着。此刻，不必赶路。');
    } else {
      const checkbox = document.querySelector(`#${action}`);
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    }
  });
  if (new URLSearchParams(location.search).get('time') === 'morning') setTime('morning');
}

let bloom;
let ssao;
let sunlight;

function resize() {
  const width = shelter.clientWidth;
  const height = shelter.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  rainSystem.resize(size.x, size.y);
}

// While lying down, dragging turns the head on the pillow instead of orbiting the room:
// yaw rotates around the body's long axis, pitch tips the chin toward the headboard or the feet.
function updateBedLook(delta) {
  bedLook.yaw = THREE.MathUtils.damp(bedLook.yaw, bedLook.targetYaw, 10, delta);
  bedLook.pitch = THREE.MathUtils.damp(bedLook.pitch, bedLook.targetPitch, 10, delta);
  const turn = new THREE.Quaternion().setFromAxisAngle(bedFrame.head, bedLook.yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(bedFrame.right, bedLook.pitch));
  camera.position.copy(bedFrame.eye);
  camera.up.copy(bedFrame.head).applyQuaternion(turn);
  controls.target.copy(bedFrame.forward).applyQuaternion(turn).multiplyScalar(3).add(bedFrame.eye);
  if (Math.abs(camera.fov - bedLook.fov) > .01) {
    camera.fov = THREE.MathUtils.damp(camera.fov, bedLook.fov, 8, delta);
    camera.updateProjectionMatrix();
  }
}

function renderOpaque(render) {
  return rainSystem.withoutWater(() => {
    const visibility = ambientOcclusionExcluded.map(object => object.visible);
    ambientOcclusionExcluded.forEach(object => { object.visible = false; });
    try {
      return render();
    } finally {
      ambientOcclusionExcluded.forEach((object, index) => { object.visible = visibility[index]; });
    }
  });
}

function animate() {
  animationFrame = requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.1);
  const time = clock.elapsedTime;
  if (transitioning) {
    transitioning.time += delta;
    const progress = Math.min(1, transitioning.time / (reducedMotion ? 0.01 : 2.2));
    const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    camera.position.lerpVectors(transitioning.startPosition, new THREE.Vector3(...transitioning.preset.position), eased);
    controls.target.lerpVectors(transitioning.startTarget, new THREE.Vector3(...transitioning.preset.target), eased);
    camera.up.lerpVectors(transitioning.startUp, new THREE.Vector3(...transitioning.preset.up), eased).normalize();
    camera.fov = THREE.MathUtils.lerp(transitioning.startFov, transitioning.preset.fov, eased);
    camera.updateProjectionMatrix();
    if (progress >= 1) transitioning = null;
  }
  if (state.view === 'bed' && !transitioning) updateBedLook(delta);
  else controls.update();
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -5.37, 5.37);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -4.03, 6.87);
  camera.position.y = THREE.MathUtils.clamp(camera.position.y, 0.58, roofHeight(camera.position.z) - 0.32);
  camera.lookAt(controls.target);
  state.morning = daylight.update(delta);
  rainSystem.update(delta, state.rain, state);
  const dawn = morningWorld.update(delta, time, state.morning, rainSystem.rain, rainSystem.wind);
  renderer.toneMappingExposure = THREE.MathUtils.lerp(1.13, .61, state.morning);
  sunlight.strength = state.morning * dawn.sunlight;
  sunlight.time = time;
  sunlight.enabled = sunlight.strength > .002 && sunlight.ready;
  lightningLight.intensity = rainSystem.flash * 12;
  coolLight.color.set('#a1b9d2').lerp(new THREE.Color('#f2f6f5'), state.morning);
  coolLight.intensity = THREE.MathUtils.lerp(2.1, .22 + dawn.sunlight * .3, state.morning);
  hemisphere.color.set('#9fb8ce').lerp(new THREE.Color('#e1f0f5'), state.morning);
  hemisphere.groundColor.set('#6b4930').lerp(new THREE.Color('#aa9b83'), state.morning);
  hemisphere.intensity = THREE.MathUtils.lerp(1.6, dawn.ambient, state.morning) + rainSystem.flash * 3;
  skylightFill.intensity = state.morning * dawn.diffuse;
  bounceLight.color.set('#e6bf8b').lerp(new THREE.Color('#ebf1ef'), state.morning);
  bounceLight.intensity = 7 + state.morning * (7 - dawn.storm * 4);
  scene.fog.color.set('#26363e').lerp(new THREE.Color('#9dafb0').lerp(new THREE.Color('#718a92'), dawn.storm), state.morning);
  scene.fog.density = THREE.MathUtils.lerp(.012, .003, state.morning);
  rainSystem.exteriorFog.color.copy(scene.fog.color);
  rainSystem.exteriorFog.density = THREE.MathUtils.lerp(.012, dawn.visibility, state.morning);
  const lightMode = state.targetMorning ? 'morning' : 'night';
  lightPreferences[lightMode].lamp = state.lamp;
  lightPreferences[lightMode].fire = state.fire;
  const lampPower = THREE.MathUtils.lerp(Number(lightPreferences.night.lamp), Number(lightPreferences.morning.lamp), state.morning);
  const firePower = THREE.MathUtils.lerp(Number(lightPreferences.night.fire), Number(lightPreferences.morning.fire), state.morning);
  warmLight.intensity = THREE.MathUtils.damp(warmLight.intensity, lampPower * 48, 5, delta);
  shadeMaterial.emissiveIntensity = lampPower * .8;
  bulb.visible = lampPower > .01;
  bulb.material.color.setRGB(3 * lampPower, 1.9 * lampPower, .8 * lampPower);
  const flicker = reducedMotion ? 1 : 1 + Math.sin(time * 8.1) * 0.035 + Math.sin(time * 13.7) * 0.04 + Math.sin(time * 2.2) * 0.055;
  const embersPower = state.morning * (1 - firePower) * (.35 + dawn.storm * .65);
  fireLight.intensity = THREE.MathUtils.damp(fireLight.intensity, firePower * 50 * flicker + embersPower, 8, delta);
  flameUniforms.forEach(uniforms => {
    uniforms.time.value = time;
    uniforms.power.value = THREE.MathUtils.damp(uniforms.power.value, firePower, 4, delta);
  });
  fireGroup.children.forEach(object => {
    if (object.material?.emissive) object.material.emissiveIntensity = firePower * 1.8 * flicker + embersPower * .35;
  });
  embers.forEach(ember => {
    const phase = (time * 0.38 + ember.offset) % 1;
    ember.mesh.position.set(ember.horizontal + Math.sin(time * 2 + ember.offset) * 0.045, 0.58 + phase * 0.69, 0.33);
    ember.mesh.material.opacity = Math.sin(phase * Math.PI) * (firePower * .8 + embersPower * (ember.offset < 1 ? .18 : 0));
  });
  atmosphereUniforms.forEach(({ uniforms, source }) => {
    uniforms.strength.value = THREE.MathUtils.damp(uniforms.strength.value, source === 'lamp' ? lampPower : firePower, 4, delta);
    if (uniforms.time) uniforms.time.value = time;
  });
  state.tea = Math.max(0, state.tea - delta * 0.12);
  steamUniforms.time.value = time;
  steamUniforms.boost.value = state.tea;
  steamUniforms.morning.value = state.morning;
  beverageMaterial.color.set('#423022').lerp(new THREE.Color('#21160f'), state.morning);
  coffeeFoam.material.opacity = state.morning * .72;
  softShadows.forEach(object => { object.material.opacity = 1 - state.morning * .42; });
  if (Math.abs(duvetCorners.last - state.morning) > .005) {
    const positions = duvetCorners.geometry.attributes.position;
    for (let vertex = 0; vertex < positions.count; vertex++) {
      const horizontal = duvetCorners.original[vertex * 3];
      const vertical = duvetCorners.original[vertex * 3 + 1];
      const curl = THREE.MathUtils.smoothstep(horizontal, .7, 1.85) * THREE.MathUtils.smoothstep(vertical, .5, 1.8);
      positions.setZ(vertex, duvetCorners.original[vertex * 3 + 2] + curl * state.morning * .55);
    }
    positions.needsUpdate = true;
    duvetCorners.geometry.computeVertexNormals();
    duvetCorners.last = state.morning;
  }
  shelter.style.setProperty('--daylight', String(state.morning));
  audio.morning = state.morning;
  audio.fire = firePower;
  shadowTimer += delta;
  if (shadowTimer > .65 && state.morning * dawn.sunlight > .01) {
    morningWorld.sun.shadow.needsUpdate = true;
    renderer.shadowMap.needsUpdate = true;
    shadowTimer = 0;
  }
  if (!reducedMotion) trees.forEach(tree => {
    tree.group.rotation.z = Math.sin(time * 0.4 + tree.phase) * tree.weight * (0.5 + rainSystem.rain * 2.5) + rainSystem.wind * tree.weight * 2;
    tree.group.rotation.x = Math.sin(time * 0.27 + tree.phase) * tree.weight * (0.5 + rainSystem.rain);
  });
  exteriorShadowLights.forEach(({ light, twin }) => {
    twin.color.copy(light.color);
    twin.intensity = light.intensity;
    if (light.shadow.needsUpdate) twin.shadow.needsUpdate = true;
  });
  rainSystem.renderCaptures(camera);
  composer.render();
  if (time > 0.4 && !document.querySelector('#loading').classList.contains('loaded')) {
    document.querySelector('#loading').classList.add('loaded');
    setTimeout(() => { document.querySelector('#loading').hidden = true; }, 1000);
  }
}

function init() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.4 : 1.65));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.13;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  camera = new THREE.PerspectiveCamera(mobile ? 72 : 57, window.innerWidth / window.innerHeight, 0.06, 150);
  camera.position.set(...cameraPresets.room.position);
  controls = new OrbitControls(camera, canvas);
  controls.target.set(...cameraPresets.room.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = false;
  controls.minDistance = 1.4;
  controls.maxDistance = 12.5;
  controls.maxPolarAngle = Math.PI * 0.64;
  controls.minPolarAngle = 0.045;
  controls.rotateSpeed = 0.43;
  controls.zoomSpeed = 0.6;
  controls.update();
  const wood = woodTexture();
  const frames = buildArchitecture(wood);
  buildForest();
  rainSystem.setCanopies(trees);
  buildBed(wood, frames);
  buildFireplace(frames);
  buildDecor(frames);
  buildAtmosphere();
  lighting();
  morningWorld = new MorningWorld({ scene, trees, mobile, roofHeight, reducedMotion });
  buildExteriorShadows();
  scene.traverse(object => {
    if (object.isLight && object.shadow) {
      object.shadow.autoUpdate = false;
      object.shadow.needsUpdate = true;
    }
    // The forest (layer 1) is only ever seen through the glass's own capture. SSAO's override material ignores the
    // needles' alpha cutout, so left in it the trees become solid cards whose outlines get darkened onto the glass.
    if (object.isMesh && (object.material?.transparent || object.layers.isEnabled(1))) ambientOcclusionExcluded.push(object);
  });
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (!mobile) {
    ssao = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight, 16);
    ssao.kernelRadius = 0.13;
    ssao.minDistance = 0.001;
    ssao.maxDistance = 0.16;
    const renderAmbientOcclusion = ssao.render.bind(ssao);
    ssao.render = (...parameters) => renderOpaque(() => {
      ssao.ssaoMaterial.uniforms.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
      ssao.ssaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);
      return renderAmbientOcclusion(...parameters);
    });
    composer.addPass(ssao);
  }
  sunlight = new SunlightPass({
    scene, camera, sun: morningWorld.sun, renderOpaque, steps: mobile ? 16 : 28,
    depthTexture: ssao ? () => ssao.normalRenderTarget.depthTexture : null
  });
  sunlight.enabled = false;
  composer.addPass(sunlight);
  bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.21, 0.47, 1.12);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  bindInteractions();
  resize();
  window.addEventListener('resize', resize);
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    cancelAnimationFrame(animationFrame);
    document.querySelector('#fatal-error').hidden = false;
    document.querySelector('#fatal-message').textContent = '显卡上下文已中断。请关闭其他高负载页面后重新进入。';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(animationFrame);
      if (audio.context) audio.context.suspend();
    } else {
      clock.getDelta();
      if (audio.enabled && audio.context) audio.context.resume();
      animate();
    }
  });
  animate();
}

try {
  init();
} catch (error) {
  console.error(error);
  document.querySelector('#loading').hidden = true;
  document.querySelector('#fatal-error').hidden = false;
  document.querySelector('#fatal-message').textContent = '需要支持 WebGL 2 的浏览器与硬件加速。请使用新版 Chrome、Edge 或 Safari。' + `（${error.message}）`;
}
