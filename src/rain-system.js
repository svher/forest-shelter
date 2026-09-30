import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { WaterSimulation, rainProfile } from './water-simulation.js';
import { morningProfile } from './daylight.js';
import { glassVertex, glassFragment, rainVertex, rainFragment, curtainFragment, splashVertex, splashFragment } from './rain-shaders.js';

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  return { canvas, context };
}

function dataTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function particleGeometry(count) {
  const plane = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = plane.index;
  geometry.attributes.position = plane.attributes.position;
  geometry.attributes.uv = plane.attributes.uv;
  geometry.instanceCount = count;
  return geometry;
}

export class RainSystem {
  constructor({ scene, renderer, mobile, slope, roofHeight, paneColumns, paneRows, audio, initialRain = 0.58, diagnostics = false }) {
    this.scene = scene;
    this.renderer = renderer;
    this.mobile = mobile;
    this.slope = slope;
    this.roofHeight = roofHeight;
    this.columns = paneColumns;
    this.rows = paneRows;
    this.audio = audio;
    this.exteriorFog = new THREE.FogExp2('#26363e', .012);
    this.time = 0;
    this.rain = initialRain;
    this.wind = 0;
    this.flash = 0;
    this.nextLightning = 11;
    this.flashAge = 5;
    this.lightningCount = 0;
    this.drawTimer = 0;
    this.frameCount = 0;
    this.diagnosticTimer = 0;
    this.diagnostics = diagnostics;
    this.pendingThunder = [];
    this.panes = [];
    this.curtains = [];
    this.impacts = Array.from({ length: 6 }, () => Array.from({ length: 12 }, () => new THREE.Vector4(-10, -10, -100, 0)));
    this.impactCursor = Array(6).fill(0);
    this.fogFadeTimer = 0;
    this.width = mobile ? 256 : 384;
    this.height = mobile ? 352 : 512;
    this.heightAtlas = makeCanvas(this.width * 3, this.height * 2);
    this.trailAtlas = makeCanvas(this.width * 3, this.height * 2);
    this.clearAtlas = makeCanvas(this.width * 3, this.height * 2);
    this.heightTexture = dataTexture(this.heightAtlas.canvas);
    this.clearTexture = dataTexture(this.clearAtlas.canvas);
    this.dropBrush = makeCanvas(64, 64);
    const gradient = this.dropBrush.context.createRadialGradient(32, 32, 0, 32, 32, 31);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.4, 'rgba(233,233,233,.96)');
    gradient.addColorStop(0.7, 'rgba(183,183,183,.83)');
    gradient.addColorStop(0.88, 'rgba(120,120,120,.66)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    this.dropBrush.context.fillStyle = gradient;
    this.dropBrush.context.fillRect(0, 0, 64, 64);
    this.simulation = new WaterSimulation({
      width: this.width,
      height: this.height,
      slope,
      onImpact: (pane, impact) => this.onImpact(pane, impact),
      onTrail: (...argumentsList) => this.drawTrail(...argumentsList)
    });
    this.simulation.seedDrops(this.rain);
    this.uniforms = {
      time: { value: 0 }, rain: { value: this.rain }, film: { value: rainProfile(initialRain).film },
      wind: { value: 0 }, lightning: { value: 0 }, morning: { value: 0 },
      lamp: { value: 1 }, fire: { value: 1 },
      background: { value: null }, reflectionMap: { value: null },
      reflectionMatrix: { value: new THREE.Matrix4() },
      heightMap: { value: this.heightTexture }, clearedMap: { value: this.clearTexture },
      texel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
      resolution: { value: new THREE.Vector2(1, 1) },
      refractionStrength: { value: 0.29 },
      rainTravel: { value: 0 },
      flowTravel: { value: 0 },
      slopeSpeed: { value: Math.sin(Math.atan(slope)) / Math.sin(Math.atan(0.66)) }
    };
    this.glassGroup = new THREE.Group();
    scene.add(this.glassGroup);
    this.createPanes();
    this.createExteriorRain();
    this.createSplashes();
    const centerDepth = (paneRows[0] + paneRows[2]) * 0.5;
    const rotation = Math.atan(1 / slope);
    this.reflector = new Reflector(new THREE.PlaneGeometry(7.5, 6.9), {
      textureWidth: mobile ? 384 : 768,
      textureHeight: mobile ? 384 : 768,
      clipBias: 0.003,
      multisample: 0
    });
    this.reflector.position.set(0.395, roofHeight(centerDepth), centerDepth);
    this.reflector.rotation.x = rotation;
    this.reflector.updateMatrixWorld(true);
    this.inverseReflectionModel = this.reflector.matrixWorld.clone().invert();
    this.uniforms.reflectionMap.value = this.reflector.getRenderTarget().texture;
    this.refractionTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.uniforms.background.value = this.refractionTarget.texture;
    this.backgroundCamera = new THREE.PerspectiveCamera();
    this.backgroundCamera.layers.set(1);
    this.shadowCamera = new THREE.PerspectiveCamera();
    this.drawMaps(0.033);
    if (diagnostics) this.createDiagnostics();
  }

  createPanes() {
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 3; column++) {
        const paneIndex = row * 3 + column;
        const horizontal = (this.columns[column] + this.columns[column + 1]) / 2;
        const depth = (this.rows[row] + this.rows[row + 1]) / 2;
        const width = this.columns[column + 1] - this.columns[column] - 0.1;
        const length = (this.rows[row + 1] - this.rows[row]) * Math.sqrt(1 + this.slope ** 2) - 0.11;
        const surface = new THREE.ShaderMaterial({
          uniforms: {
            ...this.uniforms,
            pane: { value: new THREE.Vector2(column, row) },
            reservoir: { value: 0 },
            impacts: { value: this.impacts[paneIndex] }
          },
          vertexShader: glassVertex,
          fragmentShader: glassFragment,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false
        });
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(width, length), surface);
        pane.position.set(horizontal, this.roofHeight(depth) - 0.025, depth);
        pane.rotation.x = Math.atan(1 / this.slope);
        pane.renderOrder = 10;
        pane.userData.action = 'window';
        pane.userData.paneIndex = paneIndex;
        this.glassGroup.add(pane);
        this.panes.push(pane);
        const pool = new THREE.Mesh(
          new THREE.CylinderGeometry(0.018, 0.022, width, 10),
          new THREE.MeshPhysicalMaterial({
            color: '#76999c', metalness: 0.2, roughness: 0.08,
            transparent: true, opacity: 0.4, clearcoat: 1
          })
        );
        pool.rotation.z = Math.PI / 2;
        pool.position.set(horizontal, this.roofHeight(this.rows[row]) + 0.028, this.rows[row] + 0.025);
        this.scene.add(pool);
        const curtainUniforms = {
          ...this.uniforms,
          reservoir: surface.uniforms.reservoir,
          seed: { value: paneIndex * 7.37 }
        };
        const curtain = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.2, 18, 4), new THREE.ShaderMaterial({
          uniforms: curtainUniforms,
          vertexShader: `varying vec2 surfaceUv;uniform float time;uniform float wind;void main(){surfaceUv=uv;vec3 displaced=position;displaced.z+=sin(uv.x*13.+time*2.)*.0015;gl_Position=projectionMatrix*modelViewMatrix*vec4(displaced,1.);}`,
          fragmentShader: curtainFragment,
          transparent: true, depthWrite: false, side: THREE.DoubleSide
        }));
        const drainDepth = this.rows[row] + 0.09;
        curtain.position.set(horizontal, this.roofHeight(drainDepth) - 0.033, drainDepth);
        curtain.rotation.x = Math.atan(1 / this.slope);
        curtain.renderOrder = 11;
        this.scene.add(curtain);
        this.curtains.push({ mesh: curtain, pool });
      }
    }
  }

  onImpact(paneIndex, impact) {
    const slot = this.impactCursor[paneIndex]++ % 12;
    this.impacts[paneIndex][slot].set(impact.x / this.width, 1 - impact.y / this.height, this.time, impact.size);
  }

  drawTrail(paneIndex, fromX, fromY, toX, toY, radius, delta) {
    const column = paneIndex % 3;
    const row = Math.floor(paneIndex / 3);
    const originX = column * this.width;
    const originY = row * this.height;
    const trail = this.trailAtlas.context;
    trail.save();
    trail.beginPath();
    trail.rect(originX + 2, originY + 2, this.width - 4, this.height - 4);
    trail.clip();
    trail.strokeStyle = `rgba(215,215,215,${0.07 + this.rain * 0.12})`;
    trail.lineWidth = Math.max(0.65, radius * (0.2 + this.rain * 0.35));
    trail.lineCap = 'round';
    trail.beginPath();
    trail.moveTo(originX + fromX, originY + fromY);
    trail.lineTo(originX + toX, originY + toY);
    trail.stroke();
    trail.restore();
    const clear = this.clearAtlas.context;
    clear.save();
    clear.beginPath();
    clear.rect(originX + 3, originY + 3, this.width - 6, this.height - 6);
    clear.clip();
    clear.strokeStyle = 'rgba(255,255,255,.65)';
    clear.lineWidth = radius * 2.2;
    clear.lineCap = 'round';
    clear.beginPath();
    clear.moveTo(originX + fromX, originY + fromY);
    clear.lineTo(originX + toX, originY + toY);
    clear.stroke();
    clear.restore();
  }

  wipe(paneIndex, uv) {
    const column = paneIndex % 3;
    const row = Math.floor(paneIndex / 3);
    const context = this.clearAtlas.context;
    const horizontal = (column + uv.x) * this.width;
    const vertical = (row + 1 - uv.y) * this.height;
    const radius = this.width * 0.2;
    const gradient = context.createRadialGradient(horizontal, vertical, radius * 0.35, horizontal, vertical, radius);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,.99)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.save();
    context.beginPath();
    context.rect(column * this.width, row * this.height, this.width, this.height);
    context.clip();
    context.fillStyle = gradient;
    context.fillRect(horizontal - radius, vertical - radius, radius * 2, radius * 2);
    context.restore();
    this.clearTexture.needsUpdate = true;
  }

  drawMaps(delta) {
    const trail = this.trailAtlas.context;
    trail.save();
    trail.globalCompositeOperation = 'destination-out';
    trail.fillStyle = `rgba(0,0,0,${1 - Math.exp(-delta * (0.45 + (1 - this.rain) * 0.55))})`;
    trail.fillRect(0, 0, this.trailAtlas.canvas.width, this.trailAtlas.canvas.height);
    trail.restore();
    const clear = this.clearAtlas.context;
    this.fogFadeTimer += delta;
    if (this.fogFadeTimer >= 0.25) {
      clear.save();
      clear.globalCompositeOperation = 'destination-out';
      clear.fillStyle = `rgba(0,0,0,${1 - Math.exp(-this.fogFadeTimer * 0.08)})`;
      clear.fillRect(0, 0, this.clearAtlas.canvas.width, this.clearAtlas.canvas.height);
      clear.restore();
      this.fogFadeTimer = 0;
    }
    const context = this.heightAtlas.context;
    context.fillStyle = 'black';
    context.fillRect(0, 0, this.heightAtlas.canvas.width, this.heightAtlas.canvas.height);
    context.drawImage(this.trailAtlas.canvas, 0, 0);
    for (let paneIndex = 0; paneIndex < this.simulation.panes.length; paneIndex++) {
      const originX = paneIndex % 3 * this.width;
      const originY = Math.floor(paneIndex / 3) * this.height;
      context.save();
      context.beginPath();
      context.rect(originX + 1, originY + 1, this.width - 2, this.height - 2);
      context.clip();
      for (const drop of this.simulation.panes[paneIndex].drops) {
        const radius = drop.radius;
        const stretch = 1 + Math.min(0.9, drop.velocity * 0.004);
        const height = radius * stretch;
        context.globalAlpha = Math.min(1, 0.52 + radius * 0.057);
        context.drawImage(this.dropBrush.canvas, originX + drop.x - radius, originY + drop.y - height, radius * 2, height * 2);
      }
      context.restore();
    }
    this.heightTexture.needsUpdate = true;
    this.clearTexture.needsUpdate = true;
  }

  createExteriorRain() {
    const count = this.mobile ? 2200 : 5400;
    const geometry = particleGeometry(count);
    const particles = new Float32Array(count * 4);
    for (let index = 0; index < count; index++) {
      particles[index * 4] = (this.simulation.random() - 0.5) * 43;
      particles[index * 4 + 1] = this.simulation.random() * 24;
      particles[index * 4 + 2] = -2.7 - this.simulation.random() ** 0.75 * 34;
      particles[index * 4 + 3] = this.simulation.random();
      if (index < count * 0.2) {
        particles[index * 4] = -5.1 + this.simulation.random() * 10.5;
        particles[index * 4 + 2] = -4.2 + this.simulation.random() * 6.1;
      }
    }
    geometry.setAttribute('particle', new THREE.InstancedBufferAttribute(particles, 4));
    this.exteriorRain = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: rainVertex, fragmentShader: rainFragment,
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    }));
    this.exteriorRain.frustumCulled = false;
    this.exteriorRain.layers.enable(1);
    this.scene.add(this.exteriorRain);
  }

  createSplashes() {
    const count = this.mobile ? 180 : 420;
    const geometry = particleGeometry(count);
    const launch = new Float32Array(count * 4);
    const origin = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) {
      const random = () => this.simulation.random();
      launch.set([random() * Math.PI * 2, 0.2 + random() * 0.55, random() * 8, random()], index * 4);
      const horizontal = (random() - 0.5) * 21;
      const depth = -6.5 - random() * 11;
      origin.set([horizontal, 8 + random() * 7, depth], index * 3);
      if (index < count * 0.42) {
        const glassX = -3.27 + random() * 7.31;
        const glassZ = -4.27 + random() * 5.51;
        origin.set([glassX, this.roofHeight(glassZ) + 0.09, glassZ], index * 3);
      }
    }
    geometry.setAttribute('launch', new THREE.InstancedBufferAttribute(launch, 4));
    geometry.setAttribute('origin', new THREE.InstancedBufferAttribute(origin, 3));
    this.splashes = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: splashVertex, fragmentShader: splashFragment,
      transparent: true, depthWrite: false
    }));
    this.splashes.frustumCulled = false;
    this.splashes.layers.enable(1);
    this.scene.add(this.splashes);
  }

  setCanopies(trees) {
    const origin = this.splashes.geometry.attributes.origin;
    const count = origin.count;
    for (let index = Math.floor(count * 0.42); index < count; index++) {
      const tree = trees[index % trees.length].group;
      const canopy = tree.children.find(object => object.geometry?.type === 'PlaneGeometry');
      if (!canopy) continue;
      const height = canopy.scale.y;
      const phase = 0.55 + this.simulation.random() * 0.39;
      const radius = height * 0.2 * (1 - phase);
      const angle = this.simulation.random() * Math.PI * 2;
      origin.setXYZ(index, tree.position.x + Math.cos(angle) * radius, tree.position.y + phase * height, tree.position.z + Math.sin(angle) * radius);
    }
    origin.needsUpdate = true;
  }

  update(delta, targetRain, { morning, lamp, fire }) {
    this.time += delta;
    this.rain = THREE.MathUtils.damp(this.rain, targetRain, 1.5, delta);
    const profile = rainProfile(this.rain);
    const gust = Math.max(0, Math.sin(this.time * 0.29) - 0.43) ** 2 * Math.sin(this.time * 0.81);
    this.wind = THREE.MathUtils.damp(this.wind, (Math.sin(this.time * 0.17) * 0.11 + gust * profile.wind * 3.5), 1.1, delta);
    this.uniforms.time.value = this.time;
    this.uniforms.rain.value = this.rain;
    this.uniforms.film.value = profile.film;
    this.uniforms.rainTravel.value += delta * profile.streakSpeed;
    this.uniforms.flowTravel.value += delta * (0.16 + this.rain * 0.31) * this.uniforms.slopeSpeed.value;
    this.uniforms.refractionStrength.value = 0.23 + profile.refraction * 9.2;
    this.uniforms.wind.value = this.wind;
    this.uniforms.morning.value = morning;
    this.uniforms.lamp.value = THREE.MathUtils.damp(this.uniforms.lamp.value, lamp ? 1 : 0, 4, delta);
    this.uniforms.fire.value = THREE.MathUtils.damp(this.uniforms.fire.value, fire ? 1 : 0, 4, delta);
    this.nextLightning -= delta * (0.13 + this.rain * 0.87);
    if (this.nextLightning <= 0 && this.rain > 0.06) this.triggerLightning();
    this.flashAge += delta;
    const first = Math.exp(-this.flashAge * 23);
    const second = this.flashAge > 0.13 ? Math.exp(-(this.flashAge - 0.13) * 36) * 0.48 : 0;
    this.flash = (first + second) * (0.26 + this.rain * 0.55);
    this.uniforms.lightning.value = this.flash;
    for (const thunder of this.pendingThunder) {
      if (!thunder.played && this.time >= thunder.at) {
        this.audio.thunder(thunder.strength, thunder.delay);
        this.lastThunderActual = this.time - (thunder.at - thunder.delay);
        thunder.played = true;
      }
    }
    this.pendingThunder = this.pendingThunder.filter(thunder => !thunder.played);
    this.drawTimer += delta;
    if (this.drawTimer >= 1 / 30) {
      const simulationDelta = Math.min(this.drawTimer, 0.1);
      this.simulation.update(simulationDelta, this.rain, this.wind);
      const evaporation = morning * morningProfile(this.rain).evaporation * simulationDelta;
      if (evaporation > 0) {
        this.simulation.panes.forEach(pane => {
          pane.drops.forEach(drop => { drop.radius = Math.max(.1, drop.radius - evaporation); });
        });
      }
      this.drawMaps(simulationDelta);
      this.drawTimer = 0;
    }
    for (let paneIndex = 0; paneIndex < this.panes.length; paneIndex++) {
      const reservoir = this.simulation.panes[paneIndex].reservoir;
      this.panes[paneIndex].material.uniforms.reservoir.value = reservoir;
      const curtain = this.curtains[paneIndex];
      curtain.mesh.scale.y = 0.65 + profile.film * 0.35;
      curtain.mesh.visible = this.rain > 0.04 || reservoir > 0.015;
      curtain.pool.material.opacity = Math.min(0.7, reservoir * 0.4 + this.rain * 0.25);
      curtain.pool.scale.x = 0.4 + reservoir * 0.4 + profile.film;
    }
    this.audio.rain = this.rain;
    this.audio.mix = profile;
    this.audio.wind = this.wind;
    this.audio.update(delta, this.time);
    if (this.diagnostics) this.updateDiagnostics(delta, profile);
  }

  triggerLightning() {
    this.flashAge = 0;
    this.lightningCount++;
    this.nextLightning = 18 + this.simulation.random() * 28;
    const delay = 2 + (1 - this.rain) * 1.35 + this.simulation.random() * 0.6;
    this.pendingThunder.push({ at: this.time + delay, delay, strength: this.rain, played: false });
    this.lastThunderDelay = delay;
  }

  resize(width, height) {
    this.refractionTarget.setSize(width, height);
    this.uniforms.resolution.value.set(width, height);
  }

  withoutWater(render) {
    const objects = [this.glassGroup, this.exteriorRain, this.splashes, ...this.curtains.map(curtain => curtain.mesh)];
    const visibility = objects.map(object => object.visible);
    objects.forEach(object => { object.visible = false; });
    try {
      return render();
    } finally {
      objects.forEach((object, index) => { object.visible = visibility[index]; });
    }
  }

  renderCaptures(camera) {
    this.glassGroup.visible = false;
    this.curtains.forEach(curtain => { curtain.mesh.visible = false; });
    const previousToneMapping = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.backgroundCamera.copy(camera);
    this.backgroundCamera.layers.set(1);
    this.backgroundCamera.updateMatrixWorld(true);
    this.renderer.setRenderTarget(this.refractionTarget);
    if (this.renderer.shadowMap.needsUpdate) {
      // Refresh every shadow map from a camera that sees both layers: the room's lights keep their casters, and the
      // forest's own lights (layer 1 only) still get the cabin as a caster instead of just the trees.
      this.shadowCamera.copy(camera);
      this.shadowCamera.layers.enable(1);
      this.renderer.render(this.scene, this.shadowCamera);
    }
    const interiorFog = this.scene.fog;
    this.scene.fog = this.exteriorFog;
    try {
      this.renderer.render(this.scene, this.backgroundCamera);
    } finally {
      this.scene.fog = interiorFog;
    }
    this.renderer.setRenderTarget(null);
    if (this.frameCount % (this.mobile ? 3 : 2) === 0) {
      this.reflector.onBeforeRender(this.renderer, this.scene, camera);
      this.uniforms.reflectionMatrix.value.copy(this.reflector.material.uniforms.textureMatrix.value).multiply(this.inverseReflectionModel);
    }
    this.renderer.toneMapping = previousToneMapping;
    this.glassGroup.visible = true;
    this.curtains.forEach((curtain, index) => {
      curtain.mesh.visible = this.rain > 0.04 || this.simulation.panes[index].reservoir > 0.015;
    });
    this.frameCount++;
  }

  createDiagnostics() {
    this.diagnosticElement = document.createElement('output');
    this.diagnosticElement.id = 'rain-diagnostics';
    this.diagnosticElement.setAttribute('aria-label', '雨系统诊断');
    this.diagnosticElement.style.cssText = 'position:fixed;left:18px;top:100px;z-index:5;max-width:360px;padding:10px;background:#071514d9;color:#c7e3ce;font:11px/1.7 monospace;white-space:pre;pointer-events:none;border-radius:5px';
    document.body.append(this.diagnosticElement);
    const lightningButton = document.createElement('button');
    lightningButton.textContent = '测试闪电';
    lightningButton.id = 'test-lightning';
    lightningButton.style.cssText = 'position:fixed;left:18px;top:280px;z-index:5;background:#243b35;color:#dfebdf;padding:9px;border-radius:4px';
    lightningButton.addEventListener('click', () => this.triggerLightning());
    document.body.append(lightningButton);
  }

  updateDiagnostics(delta, profile) {
    this.diagnosticTimer += delta;
    if (this.diagnosticTimer < 0.25) return;
    this.diagnosticTimer = 0;
    const statistics = this.simulation.statistics;
    this.diagnosticElement.textContent = [
      `rain ${this.rain.toFixed(3)} · film ${profile.film.toFixed(3)}`,
      `morning ${this.uniforms.morning.value.toFixed(3)} · birds ${(this.audio.birdActivity || 0).toFixed(3)} · calls ${this.audio.birdCalls || 0}`,
      `beads ${statistics.drops} · sliding ${statistics.sliding}`,
      `merged ${statistics.merges} · drained ${statistics.drained}`,
      `flow ${statistics.reservoir.toFixed(3)} · wind ${this.wind.toFixed(3)}`,
      `time ${this.time.toFixed(2)} · frames ${this.frameCount}`,
      `flash ${this.flash.toFixed(3)} · events ${this.lightningCount}`,
      `thunder planned ${(this.lastThunderDelay || 0).toFixed(2)} / actual ${(this.lastThunderActual || 0).toFixed(2)} s`,
      `pane-separated · slope ${(Math.atan(this.slope) * 180 / Math.PI).toFixed(1)}°`,
      `audio ${this.audio.enabled ? 'on' : 'off'} · wash ${(this.audio.mix?.torrent || 0).toFixed(2)}`
    ].join('\n');
  }
}
