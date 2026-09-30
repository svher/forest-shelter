import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const vertexShader = 'varying vec2 coordinates;void main(){coordinates=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';

const fragmentShader = `
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

float sunVisibility(vec3 point) {
  vec4 coordinate = shadowMatrix * vec4(point, 1.);
  coordinate.xyz /= coordinate.w;
  if (any(lessThan(coordinate.xyz, vec3(0.))) || any(greaterThan(coordinate.xyz, vec3(1.)))) return 0.;
  return step(coordinate.z - .0006, unpackRGBAToDepth(texture2D(shadowMap, coordinate.xy)));
}

void main() {
  vec4 base = texture2D(tDiffuse, coordinates);
  float depth = texture2D(tDepth, coordinates).x;
  vec4 view = projectionInverse * vec4(coordinates * 2. - 1., depth * 2. - 1., 1.);
  view /= view.w;
  vec3 ray = (cameraWorld * view).xyz - viewOrigin;
  float surface = length(ray);
  vec3 direction = ray / surface;
  vec3 safeDirection = direction + vec3(equal(direction, vec3(0.))) * 1e-5;
  vec3 near = (roomMin - viewOrigin) / safeDirection;
  vec3 far = (roomMax - viewOrigin) / safeDirection;
  vec3 low = min(near, far);
  vec3 high = max(near, far);
  float enter = max(max(low.x, low.y), max(low.z, 0.));
  float leave = min(min(high.x, high.y), high.z);
  float roofRate = dot(roofPlane.xyz, direction);
  if (roofRate > 0.) leave = min(leave, (roofPlane.w - dot(roofPlane.xyz, viewOrigin)) / roofRate);
  leave = min(leave, surface);
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
    scattered += sunVisibility(point) * haze;
  }
  scattered *= stepLength;
  float cosine = dot(sunDirection, -direction);
  float forward = .19 / pow(1.36 - 1.2 * cosine, 1.5);
  gl_FragColor = vec4(base.rgb + sunColor * scattered * (.3 + forward) * strength, base.a);
}`;

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
    this.material = new THREE.ShaderMaterial({
      defines: { STEPS: steps },
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null }, shadowMap: { value: null },
        shadowMatrix: { value: new THREE.Matrix4() }, projectionInverse: { value: new THREE.Matrix4() }, cameraWorld: { value: new THREE.Matrix4() },
        viewOrigin: { value: new THREE.Vector3() }, sunDirection: { value: new THREE.Vector3() }, sunColor: { value: new THREE.Color() },
        strength: { value: 0 }, time: { value: 0 },
        roomMin: { value: new THREE.Vector3(-5.45, 0.02, -4.25) }, roomMax: { value: new THREE.Vector3(5.45, 9, 7.05) },
        roofPlane: { value: new THREE.Vector4(0, 1, -0.66, 5.97) }
      },
      vertexShader, fragmentShader, depthTest: false, depthWrite: false
    });
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
    uniforms.shadowMap.value = this.sun.shadow.map.texture;
    uniforms.shadowMatrix.value.copy(this.sun.shadow.matrix);
    uniforms.projectionInverse.value.copy(this.camera.projectionMatrixInverse);
    uniforms.cameraWorld.value.copy(this.camera.matrixWorld);
    uniforms.viewOrigin.value.setFromMatrixPosition(this.camera.matrixWorld);
    uniforms.sunDirection.value.subVectors(this.sun.target.position, this.sun.position).normalize();
    uniforms.sunColor.value.copy(this.sun.color).multiplyScalar(this.density);
    uniforms.strength.value = this.strength;
    uniforms.time.value = this.time;
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
