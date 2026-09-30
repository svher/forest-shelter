import * as THREE from 'three';
import { morningProfile } from './daylight.js';

export const morningSkyFragment = `
  uniform float morning;
  uniform float rain;
  uniform float time;
  uniform float lightning;
  varying vec3 direction;
  float hash(vec2 point){return fract(sin(dot(point,vec2(127.1,311.7)))*43758.5453);}
  float noise(vec2 point){
    vec2 cell=floor(point);vec2 fraction=fract(point);
    fraction=fraction*fraction*(3.-2.*fraction);
    return mix(mix(hash(cell),hash(cell+vec2(1.,0.)),fraction.x),
      mix(hash(cell+vec2(0.,1.)),hash(cell+1.),fraction.x),fraction.y);
  }
  void main(){
    vec3 normal=normalize(direction);
    float elevation=smoothstep(-.1,.9,normal.y);
    float clear=1.-smoothstep(.18,.53,rain);
    float storm=smoothstep(.65,1.,rain);
    vec2 clouds=normal.xz/max(.3,normal.y+.7)*3.+vec2(time*.0015,time*.0006);
    float cloud=noise(clouds)*.6+noise(clouds*2.7)*.27+noise(clouds*7.1)*.13;
    vec3 night=mix(vec3(.19,.28,.34),vec3(.035,.075,.12),elevation)*(.62+cloud*.45);
    vec3 pearl=mix(vec3(.91,.94,.91),vec3(.69,.8,.82),elevation);
    vec3 blue=mix(vec3(.52,.76,.82),vec3(.24,.5,.68),smoothstep(0.,.6,normal.y));
    vec3 day=mix(pearl,blue,clear);
    float horizon=pow(1.-smoothstep(0.,.36,normal.y),2.);
    day=mix(day,mix(vec3(1.02,.81,.73),vec3(.98,.9,.75),normal.x*.5+.5),horizon*clear*.52);
    float silver=smoothstep(.34,.66,cloud);
    day=mix(day,vec3(.95,1.02,1.03),silver*(.36-clear*.3));
    vec3 stormSky=mix(vec3(.4,.51,.54),vec3(.24,.35,.4),elevation)*(.83+cloud*.22);
    day=mix(day,stormSky,storm*.85);
    vec3 sunDirection=normalize(vec3(-.335,.743,-.58));
    float sunAngle=max(dot(normal,sunDirection),0.);
    float glow=pow(sunAngle,18.)*.2+pow(sunAngle,240.)*.38+pow(sunAngle,2400.)*.9;
    day+=vec3(1.,.89,.66)*glow*(clear*.92+.08)*(1.-storm);
    gl_FragColor=vec4(mix(night,day,morning)+vec3(.4,.52,.65)*lightning,1.);
  }
`;

function mesh(geometry, material, position, parent) {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(...position);
  parent.add(object);
  return object;
}

const fogFragment = `
  uniform float time;uniform float strength;uniform float seed;uniform float clear;varying vec2 coordinates;
  float hash(vec2 point){return fract(sin(dot(point,vec2(127.1,311.7)))*43758.5453);}
  float noise(vec2 point){vec2 cell=floor(point);vec2 part=fract(point);part=part*part*(3.-2.*part);return mix(mix(hash(cell),hash(cell+vec2(1.,0.)),part.x),mix(hash(cell+vec2(0.,1.)),hash(cell+1.),part.x),part.y);}
  void main(){
    vec2 point=coordinates;
    float mask=sin(point.x*3.14159)*pow(sin(point.y*3.14159),1.4);
    float cloud=noise(point*vec2(7.,3.)+vec2(time*.019,seed));
    cloud+=noise(point*vec2(17.,6.)+vec2(time*.012,seed*3.))*.35;
    vec3 color=mix(vec3(.66,.78,.79),vec3(.94,.93,.8),clear*.28);
    gl_FragColor=vec4(color,mask*cloud*strength*.32);
  }
`;

export class MorningWorld {
  constructor({ scene, trees, mobile, roofHeight, reducedMotion }) {
    this.scene = scene;
    this.trees = trees;
    this.mobile = mobile;
    this.reducedMotion = reducedMotion;
    this.roofHeight = roofHeight;
    this.outside = new THREE.Group();
    this.inside = new THREE.Group();
    scene.add(this.outside, this.inside);
    this.fogUniforms = [];
    this.birds = [];
    this.canopyMaterials = new Set();
    this.canopyDrops = [];
    this.sun = new THREE.DirectionalLight('#fff1d9', 0);
    this.sun.target.position.set(0.3, 0.5, -0.5);
    this.sun.position.set(-0.335, 0.743, -0.58).setLength(46).add(this.sun.target.position);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    Object.assign(this.sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, far: 70, near: 1 });
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.radius = 2;
    this.sun.layers.enable(1);
    scene.add(this.sun, this.sun.target);
    for (const tree of trees) {
      tree.group.traverse(object => {
        if (object.isMesh && object.geometry.type === 'PlaneGeometry') {
          this.canopyMaterials.add(object.material);
          object.material.userData.dryColor ??= object.material.color.clone();
          object.castShadow = true;
        }
      });
    }
    this.createMist();
    this.createMountains();
    this.createBirds();
    this.createRainbow();
    this.createMotes();
    this.createNeedleDrops();
    this.outside.traverse(object => object.layers.enable(1));
  }

  createMist() {
    const vertexShader = 'varying vec2 coordinates;void main(){coordinates=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
    for (let bank = 0; bank < 11; bank++) {
      const uniforms = { time: { value: 0 }, strength: { value: 0 }, seed: { value: bank * 5.13 }, clear: { value: 0 } };
      this.fogUniforms.push(uniforms);
      const fog = mesh(new THREE.PlaneGeometry(23, 5.2), new THREE.ShaderMaterial({
        uniforms, vertexShader, fragmentShader: fogFragment, transparent: true, depthWrite: false, side: THREE.DoubleSide
      }), [(bank % 4 - 1.5) * 12, 2.2 + bank % 3 * 0.9, -8 - bank * 3.8], this.outside);
      fog.rotation.y = Math.sin(bank) * 0.2;
      fog.renderOrder = 2;
    }
  }

  createMountains() {
    this.mountains = [];
    for (let ridge = 0; ridge < 3; ridge++) {
      const geometry = new THREE.PlaneGeometry(125, 24, 72, 1);
      const positions = geometry.attributes.position;
      for (let vertex = 0; vertex < positions.count; vertex++) {
        if (positions.getY(vertex) > 0) {
          const horizontal = positions.getX(vertex);
          positions.setY(vertex, 3.4 + ridge * 1.8 + Math.sin(horizontal * .09 + ridge) * 4.2 + Math.sin(horizontal * .23 + ridge * 3) * 1.9);
        }
      }
      geometry.computeVertexNormals();
      const material = new THREE.MeshBasicMaterial({ color: ['#748f94', '#859da1', '#9caeb0'][ridge], transparent: true, opacity: 0, depthWrite: false, fog: false });
      this.mountains.push(material);
      mesh(geometry, material, [0, -1, -43 - ridge * 9], this.outside);
    }
  }

  createBirds() {
    const wingGeometry = new THREE.BufferGeometry();
    wingGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, .34,.025,.045, .1,0,.19],3));
    wingGeometry.computeVertexNormals();
    this.birdMaterial = new THREE.MeshStandardMaterial({ color: '#344744', roughness: .75, side: THREE.DoubleSide, transparent: true, opacity: 0 });
    const count = this.mobile ? 7 : 12;
    for (let index = 0; index < count; index++) {
      const bird = new THREE.Group();
      const leftWing = mesh(wingGeometry, this.birdMaterial, [0,0,0], bird);
      const rightWing = mesh(wingGeometry, this.birdMaterial, [0,0,0], bird);
      rightWing.scale.x = -1;
      const body = mesh(new THREE.SphereGeometry(.068,7,5), this.birdMaterial, [0,0,.07], bird);
      body.scale.set(.5,.65,1.8);
      this.outside.add(bird);
      const tree = this.trees[index % this.trees.length].group;
      const canopy = tree.children.find(object => object.geometry?.type === 'PlaneGeometry');
      const height = canopy?.scale.y || 12;
      this.birds.push({ bird, leftWing, rightWing, anchor: new THREE.Vector3(tree.position.x+.3, height*.71, tree.position.z), phase: index*3.7, flock: index > 3 });
    }
  }

  createRainbow() {
    this.rainbowMaterial = new THREE.ShaderMaterial({
      uniforms: { strength: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      vertexShader: 'varying vec3 local;void main(){local=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `uniform float strength;varying vec3 local;void main(){float radial=(length(local.xy)-17.)/.75;vec3 spectrum=.55+.45*cos(6.28318*(radial*.72+vec3(0.,.33,.67)));float fade=sin(clamp(radial,0.,1.)*3.14159);gl_FragColor=vec4(spectrum,strength*fade*.11);}`
    });
    mesh(new THREE.RingGeometry(17,17.75,96,1,0,Math.PI),this.rainbowMaterial,[13,3,-40],this.outside);
  }

  createMotes() {
    const geometry = new THREE.BufferGeometry();
    const count = this.mobile ? 55 : 120;
    const positions = new Float32Array(count*3);
    for (let index=0;index<count;index++) positions.set([Math.sin(index*18.3)*2.5, .7+(index%37)/37*3.9, -3.4+(index%31)/31*5.6],index*3);
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    this.moteMaterial = new THREE.ShaderMaterial({
      uniforms:{time:{value:0},strength:{value:0}},transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
      vertexShader:`uniform float time;varying float fade;void main(){vec3 point=position;point.y=.6+mod(point.y+time*.034,3.8);point.x+=sin(time*.13+position.z)*.1;vec4 view=modelViewMatrix*vec4(point,1.);fade=.35+.65*sin(position.x*4.+position.z)*sin(position.x*4.+position.z);gl_PointSize=clamp(10./-view.z,1.,3.);gl_Position=projectionMatrix*view;}`,
      fragmentShader:`uniform float strength;varying float fade;void main(){float alpha=exp(-dot(gl_PointCoord-.5,gl_PointCoord-.5)*18.);gl_FragColor=vec4(1.,.92,.7,alpha*strength*fade*.7);}`
    });
    this.inside.add(new THREE.Points(geometry,this.moteMaterial));
  }

  createNeedleDrops() {
    const geometry = new THREE.SphereGeometry(.018,5,4);
    this.dropMaterial = new THREE.MeshBasicMaterial({ color:'#d3e9de',transparent:true,opacity:0 });
    for (let index=0;index<40;index++) {
      const tree=this.trees[index%this.trees.length].group;
      const canopy=tree.children.find(object=>object.geometry?.type==='PlaneGeometry');
      const height=canopy?.scale.y||12;
      const angle=index*2.4;
      const anchor=new THREE.Vector3(tree.position.x+Math.sin(angle)*height*.1,height*(.48+(index%7)*.047),tree.position.z+Math.cos(angle)*height*.1);
      const drop=mesh(geometry,this.dropMaterial,anchor.toArray(),this.outside);
      this.canopyDrops.push({drop,anchor,phase:index*.71});
    }
  }

  update(delta, time, morning, rain, wind) {
    const profile = morningProfile(rain);
    this.profile = profile;
    this.sun.intensity = morning * profile.sunlight * 5.4;
    this.fogUniforms.forEach(uniforms => {
      uniforms.time.value = time;
      uniforms.strength.value = morning * profile.mist;
      uniforms.clear.value = profile.clear;
    });
    this.mountains.forEach((material,index) => { material.opacity = morning * (1-profile.storm*.8) * (.72-index*.1); });
    this.rainbowMaterial.uniforms.strength.value = morning * profile.rainbow;
    this.moteMaterial.uniforms.time.value = time;
    this.moteMaterial.uniforms.strength.value = morning * profile.sunlight;
    this.birdMaterial.opacity = morning * Math.min(1,profile.birds*2.1);
    this.birds.forEach(({bird,leftWing,rightWing,anchor,phase,flock})=>{
      const cycle=(time*.12+phase)%6;
      const flying=flock||cycle>3.9;
      const flight=Math.max(0,cycle-3.9)/2.1;
      bird.visible=morning*profile.birds>.015;
      if(flock){
        bird.position.set(Math.sin(time*.026+phase*.015)*23,12+Math.sin(phase)*1.6+Math.sin(time*.3+phase)*.3,-18+Math.cos(time*.026+phase*.015)*5);
        bird.rotation.y=-Math.PI/2;
      }else{
        bird.position.copy(anchor);
        if(flying)bird.position.add(new THREE.Vector3(Math.sin(flight*Math.PI)*3,Math.sin(flight*Math.PI)*2.5,Math.sin(flight*Math.PI*2)*1.2));
        bird.rotation.y=flying?-flight*Math.PI:phase;
      }
      const flap=this.reducedMotion?0:flying?Math.sin(time*14+phase)*.7:.08;
      leftWing.rotation.z=flap;
      rightWing.rotation.z=-flap;
    });
    this.dropMaterial.opacity=morning*(.12+profile.clear*.25);
    this.canopyDrops.forEach(({drop,anchor,phase})=>{
      const cycle=(time*.18+phase)%4;
      drop.position.copy(anchor);
      if(cycle>3.7)drop.position.y-=(cycle-3.7)**2*15;
      drop.position.x+=wind*.05;
    });
    this.canopyMaterials.forEach(material=>{
      material.color.copy(material.userData.dryColor).lerp(new THREE.Color('#97b299'),morning*.55);
      material.roughness=.36-morning*.12;
    });
    this.outside.visible = morning > .001;
    this.inside.visible = morning > .001;
    return profile;
  }
}
