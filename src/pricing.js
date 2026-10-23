// GitHub-hosted runner list prices in USD per minute (public pricing, 2026). Override with the `rates` input.
// Keys are "<os>-<cores>"; "arm" is Linux on Arm. Self-hosted runners use `self-hosted-rate`.
export const DEFAULT_RATES = {
  'linux-2': 0.008, 'linux-4': 0.016, 'linux-8': 0.032, 'linux-16': 0.064, 'linux-32': 0.128, 'linux-64': 0.256, 'linux-96': 0.384,
  'arm-2': 0.005, 'arm-4': 0.01, 'arm-8': 0.02, 'arm-16': 0.04, 'arm-32': 0.08, 'arm-64': 0.16,
  'windows-2': 0.016, 'windows-4': 0.032, 'windows-8': 0.064, 'windows-16': 0.128, 'windows-32': 0.256, 'windows-64': 0.512, 'windows-96': 0.768,
  'macos-3': 0.08, 'macos-4': 0.08, 'macos-12': 0.12, 'macos-6': 0.16,
  'gpu-linux-4': 0.07, 'gpu-windows-4': 0.14,
};

// Classify a job from its runner labels (and runner name as a fallback).
// Returns { os, cores, key, hosted, label } where hosted=false means self-hosted (or unknown).
export function classifyRunner(labels = [], runnerName = '') {
  const all = labels.map((l) => String(l).toLowerCase());
  const text = all.join(' ');
  const hostedLabel = all.find((l) => /^(ubuntu|windows|macos)-/.test(l) || l === 'self-hosted');
  if (all.includes('self-hosted') || (!hostedLabel && !/^github(-| )actions/i.test(runnerName) && !/^GitHub Actions/.test(runnerName))) {
    return { os: 'self-hosted', cores: 0, key: 'self-hosted', hosted: false, label: labels.join(', ') || runnerName || 'self-hosted' };
  }
  const label = hostedLabel || all[0] || '';
  let os = 'linux';
  if (/windows/.test(text)) os = 'windows';
  else if (/macos/.test(text)) os = 'macos';
  const arm = /\barm(64)?\b|-arm/.test(text);
  const gpu = /gpu/.test(text);
  let cores = null;
  const m = /(\d+)[ -]?cores?\b/.exec(text) || /-(\d+)core/.exec(text) || /(?:xl|large)-(\d+)/.exec(text);
  if (m) cores = parseInt(m[1], 10);
  if (cores === null) {
    if (os === 'macos') cores = /xlarge/.test(text) ? 6 : /large/.test(text) ? 12 : 4; // macos-latest-large = Intel 12-core, xlarge = M-series 6-core
    else cores = 2;
  }
  const key = gpu ? `gpu-${os}-${cores}` : arm && os === 'linux' ? `arm-${cores}` : `${os}-${cores}`;
  return { os: arm && os === 'linux' ? 'linux (arm)' : os, cores, key, hosted: true, label };
}

export function rateFor(cls, rates = DEFAULT_RATES, selfHostedRate = 0) {
  if (!cls.hosted) return selfHostedRate;
  if (rates[cls.key] !== undefined) return rates[cls.key];
  // Nearest known tier for the same family
  const fam = cls.key.replace(/-\d+$/, '');
  const tiers = Object.keys(rates).filter((k) => k.startsWith(fam + '-')).map((k) => [parseInt(k.split('-').pop(), 10), rates[k]]).sort((a, b) => a[0] - b[0]);
  const above = tiers.find(([c]) => c >= cls.cores);
  if (above) return above[1];
  if (tiers.length) return tiers[tiers.length - 1][1];
  return rates['linux-2'] || 0.008;
}
