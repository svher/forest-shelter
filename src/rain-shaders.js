export const glassVertex = `
  uniform mat4 reflectionMatrix;
  varying vec2 surfaceUv;
  varying vec3 worldPosition;
  varying vec3 worldNormal;
  varying vec3 worldTangent;
  varying vec3 worldBitangent;
  varying vec4 reflectionPosition;
  void main() {
    surfaceUv = uv;
    worldPosition = (modelMatrix * vec4(position, 1.)).xyz;
    worldNormal = normalize(mat3(modelMatrix) * vec3(0., 0., 1.));
    worldTangent = normalize(mat3(modelMatrix) * vec3(1., 0., 0.));
    worldBitangent = normalize(mat3(modelMatrix) * vec3(0., 1., 0.));
    reflectionPosition = reflectionMatrix * vec4(worldPosition, 1.);
    gl_Position = projectionMatrix * viewMatrix * vec4(worldPosition, 1.);
  }
`;

export const glassFragment = `
  uniform float time;
  uniform float rain;
  uniform float film;
  uniform float wind;
  uniform float lightning;
  uniform float morning;
  uniform float lamp;
  uniform float fire;
  uniform float reservoir;
  uniform float slopeSpeed;
  uniform float refractionStrength;
  uniform float flowTravel;
  uniform vec2 pane;
  uniform vec2 texel;
  uniform vec2 resolution;
  uniform sampler2D heightMap;
  uniform sampler2D clearedMap;
  uniform sampler2D background;
  uniform sampler2D reflectionMap;
  uniform vec4 impacts[12];
  varying vec2 surfaceUv;
  varying vec3 worldPosition;
  varying vec3 worldNormal;
  varying vec3 worldTangent;
  varying vec3 worldBitangent;
  varying vec4 reflectionPosition;
  float hash(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 fraction = fract(point);
    fraction = fraction * fraction * (3. - 2. * fraction);
    return mix(mix(hash(cell), hash(cell + vec2(1.,0.)), fraction.x),
      mix(hash(cell + vec2(0.,1.)), hash(cell + 1.), fraction.x), fraction.y);
  }
  vec2 atlas(vec2 point) {
    point = clamp(point, texel * 1.5, 1. - texel * 1.5);
    return vec2((pane.x + point.x) / 3., (1. - pane.y + point.y) / 2.);
  }
  float flowingFilm(vec2 point) {
    vec2 identity = vec2(pane.x * 17.31, pane.y * 21.17);
    vec2 flow = vec2(point.x * 8. + wind * (1. - point.y) * .4, point.y * 3.2 + flowTravel * 3.1);
    float turbulence = noise(flow * vec2(.8, 1.7) + identity);
    flow.x += (turbulence - .5) * .75;
    float broad = noise(flow + identity);
    float secondary = noise(flow * vec2(2.6, 2.1) + identity * 1.7 + vec2(.1, flowTravel * 1.4));
    float capillary = noise(flow * vec2(7.2, 4.8) + identity * 3.1 + vec2(secondary, flowTravel * 2.));
    float ridges = 1. - abs(secondary * 2. - 1.);
    return broad * .47 + secondary * .26 + ridges * .17 + capillary * .1;
  }
  float channels(vec2 point) {
    float total = 0.;
    vec2 paneSeed = pane * vec2(7.9, 13.4);
    for (int channel = 0; channel < 3; channel++) {
      float identity = float(channel);
      float random = hash(paneSeed + vec2(identity * 9.3, 4.1));
      float center = (identity + .28 + random * .45) / 3.;
      float bend = (noise(vec2(point.y * 3.8 + flowTravel * .19, identity * 9. + paneSeed.x)) - .5) * .13;
      bend += wind * (1. - point.y) * .024;
      float width = mix(.008, .035 + random * .04, film) * (.7 + (1. - point.y) * .6);
      float crossSection = exp(-pow((point.x - center - bend) / width, 2.));
      float pulse = noise(vec2(identity * 4.7 + paneSeed.y, point.y * 11. + flowTravel * 9.));
      total += crossSection * (.62 + pulse * .38);
    }
    return total;
  }
  float waterHeight(vec2 point) {
    float bead = texture2D(heightMap, atlas(point)).r * (1. - film * .985);
    float sheet = flowingFilm(point) * film;
    float streams = channels(point) * smoothstep(.5, .88, rain);
    float pool = exp(-point.y * 70.) * (.008 + reservoir * .022 + film * .035);
    float edges = exp(-min(point.x, 1. - point.x) * 130.) * rain * .016;
    return bead * .3 + sheet * .42 + streams * (.012 + film * .18) + pool + edges;
  }
  void main() {
    vec2 point = surfaceUv;
    vec2 epsilon = mix(texel * 1.25, vec2(.0018, .0015), film);
    float height = waterHeight(point);
    vec2 gradient = vec2(
      waterHeight(point + vec2(epsilon.x, 0.)) - waterHeight(point - vec2(epsilon.x, 0.)),
      waterHeight(point + vec2(0., epsilon.y)) - waterHeight(point - vec2(0., epsilon.y))
    );
    float impactSpark = 0.;
    for (int index = 0; index < 12; index++) {
      vec4 impact = impacts[index];
      float age = time - impact.z;
      if (age > 0. && age < .65) {
        vec2 difference = (point - impact.xy) * vec2(1., 1.36);
        float distanceToImpact = length(difference);
        float radius = age * (.055 + film * .07);
        float ring = exp(-pow((distanceToImpact - radius) / (.0019 + age * .003), 2.));
        float envelope = exp(-age * 8.) * impact.w;
        gradient += normalize(difference + .00001) * ring * envelope * (.004 + film * .014);
        impactSpark += ring * envelope * .018;
        float splash = exp(-distanceToImpact * 350.) * exp(-age * 30.);
        impactSpark += splash * .07;
      }
    }
    vec3 perturbed = normalize(worldNormal + worldTangent * gradient.x * 4. + worldBitangent * gradient.y * 4.);
    vec3 viewDirection = normalize(cameraPosition - worldPosition);
    float facing = abs(dot(viewDirection, perturbed));
    float fresnel = .035 + .965 * pow(1. - facing, 5.);
    vec3 viewTangent = (viewMatrix * vec4(worldTangent, 0.)).xyz;
    vec3 viewBitangent = (viewMatrix * vec4(worldBitangent, 0.)).xyz;
    float perspective = clamp(5. / length(cameraPosition - worldPosition), .6, 1.9);
    vec2 refraction = (viewTangent.xy * gradient.x + viewBitangent.xy * gradient.y) * refractionStrength * perspective;
    refraction.x *= resolution.y / resolution.x;
    float maximumRefraction = .018 + film * .015;
    refraction /= 1. + length(refraction) / maximumRefraction;
    vec2 screen = gl_FragCoord.xy / resolution;
    float clearMask = texture2D(clearedMap, atlas(point)).r;
    float edgeDistance = min(min(point.x, 1. - point.x), min(point.y, 1. - point.y));
    float fog = (.008 + rain * .018 + exp(-edgeDistance * 14.) * (.11 + rain * .13)) * (1. - clearMask);
    float clearMorning = 1. - smoothstep(.18, .53, rain);
    fog *= mix(1., .08 + exp(-edgeDistance * 38.) * .14, morning);
    fog *= 1. - morning * clearMorning * .7;
    float mainStream = channels(point);
    fog *= 1. - smoothstep(.2, .7, mainStream) * film * .6;
    vec2 backgroundUv = clamp(screen + refraction, vec2(.002), vec2(.998));
    vec3 transmitted = texture2D(background, backgroundUv).rgb;
    vec2 slopeDirection = normalize(viewBitangent.xy + vec2(.001));
    vec2 acrossDirection = vec2(-slopeDirection.y, slopeDirection.x);
    float spread = (.0005 + film * (.003 + flowingFilm(point) * .005) + fog * .012) * perspective;
    vec2 downBlur = slopeDirection * spread * vec2(resolution.y / resolution.x, 1.);
    vec2 sideBlur = acrossDirection * spread * .42 * vec2(resolution.y / resolution.x, 1.);
    vec3 softened = transmitted * .22;
    softened += texture2D(background, clamp(backgroundUv + downBlur * .52, .002, .998)).rgb * .17;
    softened += texture2D(background, clamp(backgroundUv - downBlur * .52, .002, .998)).rgb * .17;
    softened += texture2D(background, clamp(backgroundUv + downBlur * 1.5, .002, .998)).rgb * .10;
    softened += texture2D(background, clamp(backgroundUv - downBlur * 1.5, .002, .998)).rgb * .10;
    softened += texture2D(background, clamp(backgroundUv + sideBlur, .002, .998)).rgb * .12;
    softened += texture2D(background, clamp(backgroundUv - sideBlur, .002, .998)).rgb * .12;
    transmitted = mix(transmitted, softened, clamp(film * .92 + fog * 2., 0., 1.));
    vec3 tint = mix(vec3(.16,.23,.28), vec3(.64,.74,.77), morning);
    transmitted = mix(transmitted, tint, fog + film * .1);
    vec2 reflectionUv = reflectionPosition.xy / reflectionPosition.w + refraction * .08;
    vec3 reflected = texture2D(reflectionMap, clamp(reflectionUv, .002, .998)).rgb;
    reflected = reflected / (vec3(1.) + reflected * 1.8);
    float waterMask = smoothstep(.006, .09, texture2D(heightMap, atlas(point)).r) * (1. - film) + film;
    float reflectionAmount = clamp(.009 + fresnel * .04, 0., .045) * (1. - film * .65);
    vec3 result = mix(transmitted, reflected, reflectionAmount);
    vec3 reflectedDirection = reflect(-viewDirection, perturbed);
    vec3 lampDirection = normalize(vec3(-2.19,1.49,-3.02) - worldPosition);
    vec3 fireDirection = normalize(vec3(-4.22,1.04,-2.89) - worldPosition);
    float lampGlint = pow(max(dot(reflectedDirection, lampDirection), 0.), 72.) * lamp;
    float fireGlint = pow(max(dot(reflectedDirection, fireDirection), 0.), 40.) * fire;
    float coldGlint = pow(max(dot(perturbed, normalize(worldNormal + worldTangent * .8 + worldBitangent * .9)), 0.), 36.);
    float rim = clamp(length(gradient) * 8., 0., 1.);
    result += vec3(1.,.58,.23) * (lampGlint + fireGlint * .6) * (.008 + waterMask * .055) * (1. - film * .83);
    result += vec3(.36,.47,.57) * coldGlint * rim * (.09 + lightning * 1.2);
    result -= vec3(.014,.019,.023) * rim * (1. - coldGlint) * (1. - film);
    result += vec3(.52,.67,.86) * (impactSpark * (.3 + film) + lightning * (.055 + rim * .18));
    float sheen = clamp(gradient.x * -.6 + gradient.y * 1.9, -.045, .065);
    result += vec3(.35,.47,.56) * sheen * film;
    result += vec3(.11,.15,.18) * mainStream * film * .035;
    float daylightRim = coldGlint * rim * morning;
    result += vec3(.65,.75,.8) * daylightRim * (.3 + film * .22);
    vec3 prismatic = .55 + .45 * cos(6.28318 * (height * 3. + vec3(0., .33, .67)));
    result += prismatic * daylightRim * clearMorning * (1. - film) * .075;
    gl_FragColor = vec4(max(result, vec3(0.)), 1.);
  }
`;

export const rainVertex = `
  attribute vec4 particle;
  uniform float time;
  uniform float rain;
  uniform float wind;
  uniform float rainTravel;
  varying vec2 streakUv;
  varying float opacity;
  varying vec3 particleWorld;
  void main() {
    float identity = particle.w;
    float roof = 3.1 + (particle.z + 4.4) * .66;
    float floorHeight = particle.z > -4.4 && abs(particle.x) < 5.8 ? roof + .12 : 1.;
    float height = floorHeight + mod(particle.y - rainTravel * (1. + identity * .35), 26.);
    vec3 center = vec3(particle.x + wind * (30. - height) * .28, height, particle.z);
    float nearAmount = 1. - smoothstep(7., 24., -center.z);
    float streakLength = mix(.31, .68, nearAmount) * (.55 + rain * .65);
    vec3 direction = normalize(vec3(-.1 - wind * .24, 1., .035));
    vec3 viewing = normalize(cameraPosition - center);
    vec3 across = normalize(cross(viewing, direction));
    float width = mix(.022, .009, nearAmount);
    vec3 world = center + direction * position.y * streakLength + across * position.x * width;
    particleWorld = world;
    streakUv = uv;
    opacity = (1. - smoothstep(pow(rain, 1.2) - .07, pow(rain, 1.2) + .07, identity)) * smoothstep(0., .025, rain);
    opacity *= mix(.19,.5,nearAmount);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.);
  }
`;

export const rainFragment = `
  uniform float lightning;
  uniform float morning;
  uniform float lamp;
  uniform float fire;
  varying vec2 streakUv;
  varying float opacity;
  varying vec3 particleWorld;
  void main() {
    float sides = exp(-pow((streakUv.x - .5) * 3.3, 2.));
    float ends = pow(sin(streakUv.y * 3.14159), .85);
    float warmBand = exp(-length((particleWorld - vec3(-2.7,5.,-3.)) * vec3(.35,.28,.3)));
    vec3 color = mix(vec3(.31,.43,.53), vec3(.88,.58,.25), warmBand * min(1., lamp * .7 + fire * .5));
    color = mix(color, vec3(.76,.86,.9), morning);
    color += lightning * vec3(.65,.8,1.);
    gl_FragColor = vec4(color, opacity * sides * ends);
  }
`;

export const curtainFragment = `
  uniform float time;
  uniform float rain;
  uniform float film;
  uniform float wind;
  uniform float lightning;
  uniform float reservoir;
  uniform float seed;
  varying vec2 surfaceUv;
  float random(vec2 point) {
    return fract(sin(dot(point,vec2(127.1,311.7)))*43758.5453);
  }
  float turbulent(vec2 point) {
    vec2 cell=floor(point);
    vec2 weight=fract(point);
    weight=weight*weight*(3.-2.*weight);
    return mix(mix(random(cell),random(cell+vec2(1.,0.)),weight.x),
      mix(random(cell+vec2(0.,1.)),random(cell+1.),weight.x),weight.y);
  }
  void main() {
    vec2 point = surfaceUv;
    float broad = turbulent(vec2(point.x*9.+seed,point.y*2.+time*2.2));
    float detail = turbulent(vec2(point.x*35.+broad,point.y*5.+time*5.4+seed));
    float jets = smoothstep(.46,.76,broad);
    float shimmer = smoothstep(.62,.91,detail) * (.24 + jets*.7);
    float edge = smoothstep(0.,.07,point.x) * smoothstep(0.,.07,1. - point.x);
    float weight = smoothstep(.27,.76,rain) * min(1., reservoir + .35);
    float sheet = film * (.08 + jets*.15 + shimmer*.2);
    float droplets = (1. - film) * jets * weight * .2;
    float fade = smoothstep(0.,.3,point.y) * smoothstep(0.,.18,1.-point.y);
    vec3 color = vec3(.12,.19,.23) + shimmer*vec3(.1,.14,.17) + vec3(.6,.76,1.) * lightning;
    gl_FragColor = vec4(color, (sheet + droplets) * edge * fade);
  }
`;

export const splashVertex = `
  attribute vec4 launch;
  attribute vec3 origin;
  uniform float time;
  uniform float rain;
  uniform float wind;
  varying vec2 splashUv;
  varying float splashAlpha;
  void main() {
    float phase = fract(time * (.7 + launch.w) + launch.z);
    float visibility = (1. - smoothstep(rain - .08, rain + .08, fract(launch.z * 7.))) * smoothstep(0.,.04,rain);
    vec3 center = origin + vec3(cos(launch.x) * phase * launch.y + wind * phase * .16, phase * 1.15 - phase * phase * 2.3, sin(launch.x) * phase * launch.y);
    vec4 viewPosition = viewMatrix * vec4(center,1.);
    viewPosition.xy += position.xy * vec2(.017,.05) * (1. - phase * .5);
    splashUv = uv;
    splashAlpha = (1. - smoothstep(.15,.7,phase)) * visibility;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

export const splashFragment = `
  uniform float lightning;
  varying vec2 splashUv;
  varying float splashAlpha;
  void main() {
    float bead = exp(-dot((splashUv - .5) * vec2(4.,3.), (splashUv - .5) * vec2(4.,3.)));
    gl_FragColor = vec4(vec3(.48,.58,.63) + lightning * .6, bead * splashAlpha * .4);
  }
`;
