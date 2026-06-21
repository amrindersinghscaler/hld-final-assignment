// score = log(1 + count) + GAMMA * recent_score
//
// `count` is the all-time popularity. `recent_score` is a decaying counter
// updated on each /search and periodically multiplied by an exponential decay
// factor (half-life HALF_LIFE_MS). That way:
//   - a query popular long ago can't dominate forever (recent_score → 0)
//   - a query trending right now gets a boost on top of its log(count)
//   - log() flattens the head so a moderately popular query that's spiking
//     can overtake a very popular one that's gone cold

export const GAMMA = 2.5;
export const HALF_LIFE_MS = 30 * 60 * 1000; // 30 minutes
export const RECENT_INCREMENT = 1.0;

export function score(count, recent) {
  return Math.log(1 + count) + GAMMA * recent;
}

export function decayFactor(elapsedMs) {
  return Math.pow(0.5, elapsedMs / HALF_LIFE_MS);
}
