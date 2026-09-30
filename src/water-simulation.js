export function smoothRange(value, minimum, maximum) {
  const amount = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  return amount * amount * (3 - 2 * amount);
}

export function rainProfile(rain) {
  const amount = Math.max(0, Math.min(1, rain));
  const film = smoothRange(amount, 0.57, 0.94);
  return {
    amount,
    film,
    beads: 1 - film * 0.985,
    spawnRate: amount * (0.3 + amount * amount * 55),
    slideSpeed: 0.35 + amount * 2.1,
    refraction: 0.006 + amount * 0.007 + film * 0.042,
    streakDensity: Math.pow(amount, 1.2),
    streakSpeed: 8 + amount * 14,
    fog: 0.025 + amount * 0.045,
    rustle: smoothRange(amount, 0.1, 0.65),
    torrent: smoothRange(amount, 0.54, 0.98),
    wind: 0.03 + amount * amount * 0.72
  };
}

export class WaterSimulation {
  constructor({ width = 384, height = 512, slope = 0.66, seed = 9512, paneCount = 6, onImpact, onTrail, onDrain } = {}) {
    this.width = width;
    this.height = height;
    this.slope = slope;
    this.seed = seed;
    this.time = 0;
    this.nextId = 1;
    this.onImpact = onImpact || (() => {});
    this.onTrail = onTrail || (() => {});
    this.onDrain = onDrain || (() => {});
    this.merges = 0;
    this.drained = 0;
    this.panes = Array.from({ length: paneCount }, () => ({ drops: [], emission: 0, reservoir: 0 }));
  }

  random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  addDrop(paneIndex, values = {}) {
    const radius = values.radius ?? 1.4 + Math.pow(this.random(), 2.3) * 5.4;
    const drop = {
      id: this.nextId++,
      x: radius + 3 + this.random() * (this.width - radius * 2 - 6),
      y: radius + 4 + this.random() * (this.height - radius * 2 - 12),
      radius,
      velocity: 0,
      age: 0,
      pinning: 4.3 + this.random() * 2.7,
      hold: 3 + this.random() * 22,
      phase: this.random() * Math.PI * 2,
      dead: false,
      ...values
    };
    this.panes[paneIndex].drops.push(drop);
    return drop;
  }

  seedDrops(amount) {
    for (let paneIndex = 0; paneIndex < this.panes.length; paneIndex++) {
      for (let index = 0; index < 7 + Math.round(amount * 90); index++) {
        this.addDrop(paneIndex, { age: this.random() * 14 });
      }
    }
  }

  update(delta, rain, wind = 0) {
    this.time += delta;
    const profile = rainProfile(rain);
    const gravity = Math.sin(Math.atan(this.slope)) / Math.sin(Math.atan(0.66));
    for (let paneIndex = 0; paneIndex < this.panes.length; paneIndex++) {
      const pane = this.panes[paneIndex];
      pane.emission += delta * profile.spawnRate;
      while (pane.emission >= 1) {
        pane.emission--;
        const impact = {
          x: 8 + this.random() * (this.width - 16),
          y: 8 + this.random() * (this.height - 16),
          size: 0.6 + this.random() * 0.8
        };
        this.onImpact(paneIndex, impact, this.time);
        if (pane.drops.length < 240) {
          this.addDrop(paneIndex, {
            x: impact.x,
            y: impact.y,
            radius: 1.25 + Math.pow(this.random(), 1.8) * (3.2 + rain * 2.4)
          });
        }
      }
      pane.reservoir *= Math.exp(-delta * (0.38 + rain * 0.5));
      pane.reservoir += delta * rain * rain * 0.38;
      for (const drop of pane.drops) {
        if (drop.dead) continue;
        drop.age += delta;
        drop.radius = Math.max(0.15, drop.radius - delta * (0.008 + (1 - smoothRange(rain, 0.05, 0.6)) * 0.15));
        if (drop.radius < 0.6) {
          drop.dead = true;
          continue;
        }
        const mobile = drop.radius > drop.pinning || (drop.age > drop.hold && drop.radius > 3.6);
        const target = mobile ? (4 + Math.max(0, drop.radius - 3.6) ** 1.7 * 5) * profile.slideSpeed * gravity : 0;
        drop.velocity += (target - drop.velocity) * (1 - Math.exp(-delta * 2.5));
        if (drop.velocity > 0.8) {
          const previousX = drop.x;
          const previousY = drop.y;
          const sway = Math.sin(drop.y * 0.037 + drop.phase) * 0.17 + Math.sin(drop.y * 0.09 + drop.phase) * 0.075;
          drop.x += (sway + wind * 0.17) * drop.velocity * delta;
          drop.y += drop.velocity * delta;
          drop.x = Math.max(drop.radius + 2, Math.min(this.width - drop.radius - 2, drop.x));
          this.onTrail(paneIndex, previousX, previousY, drop.x, drop.y, drop.radius, delta);
          drop.radius -= delta * drop.velocity * 0.00048;
          if (drop.y + drop.radius >= this.height - 4) {
            pane.reservoir = Math.min(1.5, pane.reservoir + drop.radius ** 3 / 10000);
            this.drained++;
            this.onDrain(paneIndex, drop.x / this.width, drop.radius);
            drop.dead = true;
          }
        }
      }
      const buckets = new Map();
      const bucketSize = 26;
      for (const drop of pane.drops) {
        if (drop.dead) continue;
        const column = Math.floor(drop.x / bucketSize);
        const row = Math.floor(drop.y / bucketSize);
        let merged = false;
        for (let rowOffset = -1; rowOffset <= 1 && !merged; rowOffset++) {
          for (let columnOffset = -1; columnOffset <= 1 && !merged; columnOffset++) {
            const neighbors = buckets.get(`${column + columnOffset}:${row + rowOffset}`) || [];
            for (const other of neighbors) {
              if (other.dead) continue;
              const distance = Math.hypot(drop.x - other.x, drop.y - other.y);
              if (distance > (drop.radius + other.radius) * 0.86) continue;
              const moving = drop.velocity > other.velocity ? drop : other;
              const stationary = moving === drop ? other : drop;
              const movingMass = moving.radius ** 3;
              const stationaryMass = stationary.radius ** 3;
              const totalMass = movingMass + stationaryMass;
              moving.x = (moving.x * movingMass + stationary.x * stationaryMass) / totalMass;
              moving.y = (moving.y * movingMass + stationary.y * stationaryMass) / totalMass;
              moving.radius = Math.cbrt(totalMass);
              moving.hold = Math.min(moving.hold, moving.age + 0.15);
              moving.pinning = Math.min(moving.pinning, stationary.pinning);
              stationary.dead = true;
              this.merges++;
              if (moving.radius > 15) {
                pane.reservoir += (moving.radius ** 3 - 15 ** 3) / 10000;
                moving.radius = 15;
              }
              merged = true;
              break;
            }
          }
        }
        if (!drop.dead) {
          const key = `${column}:${row}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(drop);
        }
      }
      pane.drops = pane.drops.filter(drop => !drop.dead);
    }
  }

  get statistics() {
    const drops = this.panes.flatMap(pane => pane.drops);
    return {
      drops: drops.length,
      sliding: drops.filter(drop => drop.velocity > 0.8).length,
      merges: this.merges,
      drained: this.drained,
      reservoir: this.panes.reduce((total, pane) => total + pane.reservoir, 0) / this.panes.length
    };
  }
}
