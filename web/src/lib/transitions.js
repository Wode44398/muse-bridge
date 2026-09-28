import { crossfade } from 'svelte/transition';

// Gentle start, fast middle, long soft landing (先慢再快后慢，到底前明显放缓).
export const softDrop = (t) => {
  const p = 0.42;
  if (t < p) return 0.6 * (t / p) ** 3;
  const u = (t - p) / (1 - p);
  return 0.6 + 0.4 * (1 - (1 - u) ** 4);
};

// The composer flies from its greeting position down to the bottom on the first send.
export const [sendComposer, receiveComposer] = crossfade({ duration: 320, easing: softDrop });
