import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const vertexShader = 'varying vec2 coordinates;void main(){coordinates=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';

// Shared by the room's haze and the forest's: the view ray, the room it starts in, and the sun's shadow map.
const volumeCommon = `
#include <packing>
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D shadowMap;
uniform mat4 shadowMatrix;
uniform mat4 projectionInverse;
uniform mat4 cameraWorld;
uniform vec3 viewOrigin;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform float strength;
uniform float time;
uniform vec3 roomMin;
uniform vec3 roomMax;
uniform vec4 roofPlane;
varying vec2 coordinates;

float hash(vec3 point) {
  point = fract(point * .3183099 + .1);
  point *= 17.;
  return fract(point.x * point.y * point.z * (point.x + point.y + point.z));
}

float noise(vec3 point) {
  vec3 cell = floor(point);
  vec3 blend = fract(point);
  blend = blend * blend * (3. - 2. * blend);
  return mix(
    mix(mix(hash(cell), hash(cell + vec3(1, 0, 0)), blend.x), mix(hash(cell + vec3(0, 1, 0)), hash(cell + vec3(1, 1, 0)), blend.x), blend.y),
    mix(mix(hash(cell + vec3(0, 0, 1)), hash(cell + vec3(1, 0, 1)), blend.x), mix(hash(cell + vec3(0, 1, 1)), hash(cell + vec3(1, 1, 1)), blend.x), blend.y),
    blend.z);
}

float sunVisibility(vec3 point, float outside) {
  vec4 coordinate = shadowMatrix * vec4(point, 1.);
  coordinate.xyz /= coordinate.w;
  if (any(lessThan(coordinate.xyz, vec3(0.))) || any(greaterThan(coordinate.xyz, vec3(1.)))) return outside;
  return step(coordinate.z - .0006, unpackRGBAToDepth(texture2D(shadowMap, coordinate.xy)));
}

// The view ray through this pixel: its direction and the distance to the visible surface.
float viewRay(vec2 point, out vec3 direction) {
  float depth = texture2D(tDepth, point).x;
  vec4 view = projectionInverse * vec4(point * 2. - 1., depth * 2. - 1., 1.);
  view /= view.w;
  vec3 ray = (cameraWorld * view).xyz - viewOrigin;
  float surface = length(ray);
  direction = ray / surface;
  return surface;
}

// Where the ray enters and leaves the room's air: a box under the roof plane.
vec2 roomSpan(vec3 direction) {
  vec3 safeDirection = direction + vec3(equal(direction, vec3(0.))) * 1e-5;
  vec3 near = (roomMin - viewOrigin) / safeDirection;
  vec3 far = (roomMax - viewOrigin) / safeDirection;
  vec3 low = min(near, far);
  vec3 high = max(near, far);
  float enter = max(max(low.x, low.y), max(low.z, 0.));
  float leave = min(min(high.x, high.y), high.z);
  float roofRate = dot(roofPlane.xyz, direction);
  if (roofRate > 0.) leave = min(leave, (roofPlane.w - dot(roofPlane.xyz, viewOrigin)) / roofRate);
  return vec2(enter, leave);
}

float forwardScattering(vec3 direction) {
  float cosine = dot(sunDirection, -direction);
  return .3 + .19 / pow(1.36 - 1.2 * cosine, 1.5);
}`;

const roomFragmentShader = `${volumeCommon}

void main() {
  vec4 base = texture2D(tDiffuse, coordinates);
  vec3 direction;
  float surface = viewRay(coordinates, direction);
  vec2 span = roomSpan(direction);
  float enter = span.x;
  float leave = min(span.y, surface);
  if (leave <= enter) {
    gl_FragColor = base;
    return;
  }
  float stepLength = (leave - enter) / float(STEPS);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
  vec3 drift = vec3(time * .045, -time * .02, time * .03);
  float scattered = 0.;
  for (int index = 0; index < STEPS; index++) {
    vec3 point = viewOrigin + direction * (enter + (float(index) + jitter) * stepLength);
    float haze = .25 + pow(noise(point * vec3(1.1, .7, 1.1) + drift), 1.6) * 1.35 + noise(point * 3.7 - drift * 2.) * .25;
    scattered += sunVisibility(point, 0.) * haze;
  }
  scattered *= stepLength;
  gl_FragColor = vec4(base.rgb + sunColor * scattered * forwardScattering(direction) * strength, base.a);
}`;

// The forest's haze is marched at half resolution. Each texel keeps how much of its ray's haze the sun reaches and
// how much haze there is in total (both already weighted by step length), plus the distance to the surface behind.
const forestMarchShader = `${volumeCommon}
uniform float fogDensity;
uniform float groundHeight;

void main() {
  vec3 direction;
  float surface = viewRay(coordinates, direction);
  vec2 span = roomSpan(direction);
  // The forest's air starts exactly where the room's pass stops, so no stretch of a ray is lit twice.
  float start = span.y > span.x ? span.y : 0.;
  float range = min(surface, REACH) - start;
  if (range <= 0.) {
    gl_FragColor = vec4(0., 0., 0., surface);
    return;
  }
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
  vec3 drift = vec3(time * .08, -time * .012, time * .05);
  float lit = 0.;
  float total = 0.;
  for (int index = 0; index < STEPS; index++) {
    // Samples crowd toward the glass (distance grows with the square of the step) where beams look widest;
    // each one is weighted by the stretch of ray it stands for.
    float along = (float(index) + jitter) / float(STEPS);
    float distance = start + range * along * along;
    vec3 point = viewOrigin + direction * distance;
    float height = max(point.y - groundHeight, 0.);
    float fog = fogDensity * distance;
    float haze = exp(-height / 7.) * (.3 + pow(noise(point * vec3(.22, .12, .22) + drift), 1.5) * 1.5) * exp(-fog * fog) * along;
    lit += sunVisibility(point, 1.) * haze;
    total += haze;
  }
  float scale = 2. * range / float(STEPS);
  gl_FragColor = vec4(lit * scale, total * scale, 0., surface);
}`;

// Gathers the half-resolution haze back onto the forest. Texels whose surface is at a different distance (the sky
// behind a trunk, say) are left out, so the smoothing that hides the marching noise never bleeds across a silhouette.
// The share of each ray that is lit is then steepened: this forest is open enough that most of every ray is in sun,
// and without it the gaps between shadows read as flat fog rather than beams.
const forestCompositeShader = `${volumeCommon}
uniform sampler2D tHaze;
uniform vec2 hazeTexel;

void main() {
  vec4 base = texture2D(tDiffuse, coordinates);
  vec3 direction;
  float surface = viewRay(coordinates, direction);
  vec2 haze = vec2(0.);
  float weights = 0.;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      vec4 texel = texture2D(tHaze, coordinates + vec2(x, y) * hazeTexel);
      float weight = (2. - abs(float(x))) * (2. - abs(float(y))) * exp(-abs(texel.a - surface) / (.06 * surface + .1)) + 1e-4;
      haze += texel.rg * weight;
      weights += weight;
    }
  }
  haze /= weights;
  float scattered = haze.y * pow(haze.x / max(haze.y, 1e-6), CONTRAST);
  gl_FragColor = vec4(base.rgb + sunColor * scattered * forwardScattering(direction) * strength, base.a);
}`;

function createMaterial(fragmentShader, defines, extraUniforms = {}) {
  return new THREE.ShaderMaterial({
    defines,
    uniforms: {
      tDiffuse: { value: null }, tDepth: { value: null }, shadowMap: { value: null },
      shadowMatrix: { value: new THREE.Matrix4() }, projectionInverse: { value: new THREE.Matrix4() }, cameraWorld: { value: new THREE.Matrix4() },
      viewOrigin: { value: new THREE.Vector3() }, sunDirection: { value: new THREE.Vector3() }, sunColor: { value: new THREE.Color() },
      strength: { value: 0 }, time: { value: 0 },
      roomMin: { value: new THREE.Vector3(-5.45, 0.02, -4.25) }, roomMax: { value: new THREE.Vector3(5.45, 9, 7.05) },
      roofPlane: { value: new THREE.Vector4(0, 1, -0.66, 5.97) },
      ...extraUniforms
    },
    vertexShader, fragmentShader, depthTest: false, depthWrite: false
  });
}

function aim(uniforms, camera, sun, density, strength, time) {
  uniforms.shadowMap.value = sun.shadow.map.texture;
  uniforms.shadowMatrix.value.copy(sun.shadow.matrix);
  uniforms.projectionInverse.value.copy(camera.projectionMatrixInverse);
  uniforms.cameraWorld.value.copy(camera.matrixWorld);
  uniforms.viewOrigin.value.setFromMatrixPosition(camera.matrixWorld);
  uniforms.sunDirection.value.subVectors(sun.target.getWorldPosition(new THREE.Vector3()), sun.getWorldPosition(new THREE.Vector3())).normalize();
  uniforms.sunColor.value.copy(sun.color).multiplyScalar(density);
  uniforms.strength.value = strength;
  uniforms.time.value = time;
}

// Sun-shaft haze inside the cabin: marches each view ray through the room and lights only
// the air that the sun's shadow map sees, so the beams follow the real skylight, mullions and trees.
export class SunlightPass extends Pass {
  constructor({ scene, camera, sun, depthTexture, renderOpaque, steps }) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.sun = sun;
    this.depthTexture = depthTexture;
    this.renderOpaque = renderOpaque;
    this.strength = 0;
    this.density = 0.017;
    this.time = 0;
    if (!depthTexture) {
      this.depthTarget = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(), minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });
    }
    this.material = createMaterial(roomFragmentShader, { STEPS: steps });
    this.quad = new FullScreenQuad(this.material);
  }

  get ready() {
    return this.sun.shadow.map !== null;
  }

  setSize(width, height) {
    this.depthTarget?.setSize(width, height);
  }

  renderDepth(renderer) {
    this.renderOpaque(() => {
      const hidden = [];
      this.scene.traverse(object => {
        if ((object.isPoints || object.isLine || object.isSprite) && object.visible) {
          hidden.push(object);
          object.visible = false;
        }
      });
      this.scene.overrideMaterial = this.depthMaterial;
      renderer.setRenderTarget(this.depthTarget);
      renderer.clear();
      renderer.render(this.scene, this.camera);
      this.scene.overrideMaterial = null;
      hidden.forEach(object => { object.visible = true; });
    });
    return this.depthTarget.depthTexture;
  }

  render(renderer, writeBuffer, readBuffer) {
    const uniforms = this.material.uniforms;
    uniforms.tDiffuse.value = readBuffer.texture;
    uniforms.tDepth.value = this.depthTexture ? this.depthTexture() : this.renderDepth(renderer);
    aim(uniforms, this.camera, this.sun, this.density, this.strength, this.time);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
    this.depthTarget?.dispose();
    this.depthMaterial?.dispose();
  }
}

// The same haze for the forest seen through the glass. It picks up where the room's air ends and runs out between
// the trees, lit by the forest's own wide shadow map, so the beams lean with the real sun, start in the gaps of the
// canopy and thin out into the morning fog instead of being painted over the trees.
export class ForestSunlight {
  constructor({ sun, steps, reach = 48, groundHeight = -0.7, contrast = 3 }) {
    this.sun = sun;
    this.strength = 0;
    this.density = 0.03;
    this.fogDensity = 0;
    this.time = 0;
    this.enabled = false;
    this.hazeTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.marchMaterial = createMaterial(forestMarchShader, { STEPS: steps, REACH: reach.toFixed(1) }, {
      fogDensity: { value: 0 }, groundHeight: { value: groundHeight }
    });
    this.compositeMaterial = createMaterial(forestCompositeShader, { CONTRAST: contrast.toFixed(1) }, {
      tHaze: { value: this.hazeTarget.texture }, hazeTexel: { value: new THREE.Vector2() }
    });
    this.quad = new FullScreenQuad();
  }

  get ready() {
    return this.sun.shadow.map !== null;
  }

  setSize(width, height) {
    this.hazeTarget.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
    this.compositeMaterial.uniforms.hazeTexel.value.set(1 / this.hazeTarget.width, 1 / this.hazeTarget.height);
  }

  render(renderer, source, destination, camera) {
    for (const material of [this.marchMaterial, this.compositeMaterial]) {
      material.uniforms.tDiffuse.value = source.texture;
      material.uniforms.tDepth.value = source.depthTexture;
      aim(material.uniforms, camera, this.sun, this.density, this.strength, this.time);
    }
    this.marchMaterial.uniforms.fogDensity.value = this.fogDensity;
    renderer.setRenderTarget(this.hazeTarget);
    this.quad.material = this.marchMaterial;
    this.quad.render(renderer);
    renderer.setRenderTarget(destination);
    this.quad.material = this.compositeMaterial;
    this.quad.render(renderer);
  }

  dispose() {
    this.marchMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
    this.hazeTarget.dispose();
  }
}
