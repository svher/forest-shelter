import { rainProfile } from './water-simulation.js';
import { morningProfile } from './daylight.js';

export class ForestAudio {
  constructor() {
    this.context = null;
    this.enabled = false;
    this.volume = 0.55;
    this.rain = 0.58;
    this.fire = true;
    this.nextCrackle = 0.5;
    this.nextDrop = 0.2;
    this.wind = 0;
    this.mix = rainProfile(this.rain);
    this.syncTimer = 0;
    this.morning = 0;
    this.nextBird = .8;
    this.nextLeafDrop = 1.4;
    this.birdActivity = 0;
    this.previousBirdActivity = 0;
    this.birdCalls = 0;
  }

  makeNoise(seconds, brown = false) {
    const buffer = this.context.createBuffer(2, this.context.sampleRate * seconds, this.context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let previous = 0;
      for (let sample = 0; sample < data.length; sample++) {
        const white = Math.random() * 2 - 1;
        previous = (previous + 0.02 * white) / 1.02;
        data[sample] = brown ? previous * 3.5 : white;
      }
    }
    return buffer;
  }

  loop(buffer, type, frequency, gain) {
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const level = this.context.createGain();
    source.buffer = buffer;
    source.loop = true;
    filter.type = type;
    filter.frequency.value = frequency;
    level.gain.value = gain;
    source.connect(filter).connect(level).connect(this.master);
    source.start();
    return { source, filter, level };
  }

  async toggle() {
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('当前浏览器不支持环境音，请使用新版 Chrome 或 Safari。');
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0;
      this.limiter = this.context.createDynamicsCompressor();
      this.limiter.threshold.value = -12;
      this.limiter.ratio.value = 5;
      this.master.connect(this.limiter).connect(this.context.destination);
      this.whiteNoise = this.makeNoise(6);
      this.brownNoise = this.makeNoise(7, true);
      this.rainLayer = this.loop(this.whiteNoise, 'lowpass', 2700, 0.16);
      this.roofLayer = this.loop(this.whiteNoise, 'bandpass', 950, 0.09);
      this.windLayer = this.loop(this.brownNoise, 'lowpass', 310, 0.12);
      this.fireLayer = this.loop(this.brownNoise, 'lowpass', 620, 0.075);
      this.waterLayer = this.loop(this.brownNoise, 'lowpass', 1600, 0);
      this.sprayLayer = this.loop(this.whiteNoise, 'bandpass', 2800, 0);
      this.pineLayer = this.loop(this.brownNoise, 'bandpass', 780, 0);
      this.roofRumble = this.loop(this.brownNoise, 'lowpass', 220, 0);
    }
    await this.context.resume();
    this.enabled = !this.enabled;
    this.sync();
    return this.enabled;
  }

  sync() {
    if (!this.context) return;
    this.mix = rainProfile(this.rain);
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(this.enabled ? this.volume * 0.68 : 0, now, 0.3);
    this.rainLayer.level.gain.setTargetAtTime(this.mix.rustle * 0.25 + this.mix.torrent * 0.06, now, 0.35);
    this.rainLayer.filter.frequency.setTargetAtTime(1600 + this.rain * 3200, now, 0.6);
    this.roofLayer.level.gain.setTargetAtTime(this.mix.rustle * (1 - this.mix.torrent * 0.65) * 0.1, now, 0.35);
    this.windLayer.level.gain.setTargetAtTime(0.014 + this.mix.wind * 0.2 + Math.abs(this.wind) * 0.09, now, 0.6);
    this.fireLayer.level.gain.setTargetAtTime(Number(this.fire) * .12, now, 0.3);
    this.waterLayer.level.gain.setTargetAtTime(this.mix.torrent * 0.64, now, 0.4);
    this.sprayLayer.level.gain.setTargetAtTime(this.mix.torrent * 0.16, now, 0.4);
    this.pineLayer.level.gain.setTargetAtTime(this.morning * (.025 + Math.abs(this.wind) * .075), now, .7);
    this.roofRumble.level.gain.setTargetAtTime(this.mix.torrent * .16, now, .5);
  }

  oneShot(buffer, frequency, duration, volume, pan = 0) {
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const panner = this.context.createStereoPanner();
    const now = this.context.currentTime;
    source.buffer = buffer;
    filter.type = 'lowpass';
    filter.frequency.value = frequency;
    panner.pan.value = pan;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), now + Math.min(0.35, duration * 0.08));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(gain).connect(panner).connect(this.master);
    source.start(now, Math.random() * Math.max(0, buffer.duration - duration));
    source.stop(now + duration);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
      panner.disconnect();
    };
  }

  glassDrop() {
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const pan = this.context.createStereoPanner();
    oscillator.type = 'sine';
    const frequency = 620 + Math.random() * 1600;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.38, now + 0.065);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime((0.02 + Math.random() * 0.045) * (1 - this.mix.torrent * 0.82), now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    pan.pan.value = Math.random() * 1.7 - 0.85;
    oscillator.connect(gain).connect(pan).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.1);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      pan.disconnect();
    };
    this.oneShot(this.whiteNoise, 1800, 0.019, 0.025 * (1 - this.mix.torrent * 0.7), pan.pan.value);
  }

  thunder(strength, delay) {
    if (!this.enabled || !this.context || this.context.state !== 'running') return;
    const near = Math.max(0, Math.min(1, (4 - delay) / 2));
    this.oneShot(this.brownNoise, 110 + near * 330, 5.7, 0.22 + strength * 0.55, Math.random() * 1.3 - 0.65);
    if (near > 0.4) this.oneShot(this.whiteNoise, 220 + near * 450, 1.4, strength * 0.09, 0.2);
  }

  birdSong() {
    this.birdCalls++;
    const now = this.context.currentTime;
    const direction = Math.random() * 1.7 - .85;
    const base = 2200 + Math.random() * 1600;
    const noteCount = this.rain < .32 ? 3 + Math.floor(Math.random() * 3) : 2;
    for (let note = 0; note < noteCount; note++) {
      const start = now + note * (.13 + Math.random() * .075);
      const duration = .06 + Math.random() * .13;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      const pan = this.context.createStereoPanner();
      const frequency = base + Math.sin(note * 2.1) * 600;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.28, start + duration * .25);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * .79, start + duration);
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(.0002, (.018 + Math.random() * .026) * this.birdActivity), start + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
      pan.pan.value = direction;
      oscillator.connect(gain).connect(pan).connect(this.master);
      oscillator.start(start);
      oscillator.stop(start + duration + .02);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
        pan.disconnect();
      };
    }
  }

  update(delta, time) {
    const dawn = morningProfile(this.rain);
    this.birdActivity = this.morning * dawn.birds;
    if (this.birdActivity > .04 && this.previousBirdActivity <= .04) this.nextBird = Math.min(this.nextBird, 1.2);
    this.previousBirdActivity = this.birdActivity;
    if (!this.enabled || !this.context) return;
    this.syncTimer += delta;
    if (this.syncTimer >= 0.12) {
      this.sync();
      this.syncTimer = 0;
    }
    this.windLayer.filter.frequency.setTargetAtTime(260 + Math.sin(time * 0.15) * 90, this.context.currentTime, 1);
    this.waterLayer.filter.frequency.setTargetAtTime(1250 + Math.sin(time * 0.47) * 340, this.context.currentTime, 0.5);
    this.nextCrackle -= delta;
    this.nextDrop -= delta;
    this.nextBird -= delta;
    this.nextLeafDrop -= delta;
    if (this.nextBird <= 0) {
      this.nextBird = (.8 + Math.random() * 3.5) / Math.max(.1, this.birdActivity);
      if (this.birdActivity > .01) this.birdSong();
    }
    if (this.nextLeafDrop <= 0) {
      this.nextLeafDrop = 1.5 + Math.random() * 6;
      if (this.morning > .01) this.oneShot(this.whiteNoise, 1400, .05, this.morning * (1 - dawn.storm) * .028, Math.random() * 2 - 1);
    }
    if (this.nextDrop <= 0) {
      const rate = this.rain * (1.8 + this.rain * 15);
      this.nextDrop = -Math.log(0.01 + Math.random() * 0.98) / Math.max(0.1, rate);
      if (this.rain > 0.005) this.glassDrop();
    }
    if (this.nextCrackle <= 0) {
      this.nextCrackle = 0.15 + Math.random() * 1.3;
      if (this.fire > .01) this.oneShot(this.whiteNoise, 600 + Math.random() * 2300, 0.025 + Math.random() * 0.11, (0.04 + Math.random() * 0.12) * Number(this.fire), -0.48);
    }
  }
}
