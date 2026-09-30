import { smoothRange } from './water-simulation.js';

export function morningProfile(rain) {
  const amount = Math.max(0, Math.min(1, rain));
  const clear = 1 - smoothRange(amount, 0.18, 0.53);
  const storm = smoothRange(amount, 0.65, 1);
  return {
    clear,
    storm,
    sunlight: clear * clear,
    diffuse: 3.6 - clear * 0.6 - storm * 2.0,
    ambient: 3.3 - clear * 0.5 - storm * 0.9,
    mist: 0.42 + amount * 0.3 - clear * 0.18,
    visibility: 0.011 + storm * 0.043,
    birds: (1 - smoothRange(amount, 0.12, 0.96)) ** 1.6,
    rainbow: (1 - smoothRange(amount, 0.22, 0.4)) * smoothRange(amount, 0.01, 0.09),
    evaporation: clear * 0.075,
    headline: amount < 0.32 ? '晨光，落在被角。' : amount < 0.75 ? '一场安静的晨雨。' : '今天，不用出门。'
  };
}

export class DaylightTransition {
  constructor(initial = 0, duration = 4) {
    this.value = initial;
    this.start = initial;
    this.target = initial;
    this.elapsed = duration;
    this.duration = duration;
  }

  set(target) {
    if (target === this.target) return;
    this.start = this.value;
    this.target = target;
    this.elapsed = 0;
  }

  update(delta) {
    this.elapsed = Math.min(this.duration, this.elapsed + delta);
    const progress = this.elapsed / this.duration;
    const ease = progress * progress * (3 - 2 * progress);
    this.value = this.start + (this.target - this.start) * ease;
    return this.value;
  }
}
