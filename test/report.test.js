import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunner, rateFor, DEFAULT_RATES } from '../src/pricing.js';
import { priceJob, analyse, renderMarkdown, MARKER } from '../src/report.js';

const T = (min) => new Date(Date.UTC(2026, 9, 20, 10, 0, 0) + min * 60000).toISOString();
const job = (name, labels, startMin, durSec, extra = {}) => ({ name, labels, runner_name: 'GitHub Actions 12', started_at: T(startMin), completed_at: new Date(new Date(T(startMin)).getTime() + durSec * 1000).toISOString(), conclusion: 'success', ...extra });
const run = (id, over = {}) => ({ id, name: 'CI', workflow_id: 1, path: '.github/workflows/ci.yml', event: 'push', conclusion: 'success', status: 'completed', head_branch: 'main', head_sha: 'a', run_attempt: 1, run_started_at: T(0), created_at: T(0), jobs: [], ...over });

test('runner labels map to pricing tiers', () => {
  assert.equal(classifyRunner(['ubuntu-latest']).key, 'linux-2');
  assert.equal(classifyRunner(['windows-2022']).key, 'windows-2');
  assert.equal(classifyRunner(['macos-14']).key, 'macos-4');
  assert.equal(classifyRunner(['macos-latest-large']).key, 'macos-12');
  assert.equal(classifyRunner(['macos-latest-xlarge']).key, 'macos-6');
  assert.equal(classifyRunner(['ubuntu-latest-8-cores']).key, 'linux-8');
  assert.equal(classifyRunner(['ubuntu-24.04-arm']).key, 'arm-2');
  assert.equal(classifyRunner(['windows-latest-16core']).key, 'windows-16');
  assert.equal(classifyRunner(['self-hosted', 'linux', 'x64']).hosted, false);
  assert.equal(classifyRunner(['my-k8s-pool'], 'runner-abc').hosted, false);
  assert.equal(rateFor(classifyRunner(['ubuntu-latest-6-cores'])), DEFAULT_RATES['linux-8'], 'unknown core count rounds up to the next tier');
  assert.equal(rateFor(classifyRunner(['self-hosted']), DEFAULT_RATES, 0.003), 0.003);
});

test('jobs are billed in whole minutes', () => {
  const j = priceJob(job('build', ['ubuntu-latest'], 0, 61));
  assert.equal(j.billedMinutes, 2);
  assert.equal(j.usd, 0.016);
  assert.equal(priceJob(job('skipped', ['ubuntu-latest'], 0, 0)).billedMinutes, 0);
  assert.equal(priceJob(job('mac', ['macos-14'], 0, 600)).usd, 0.8);
});

test('analyse aggregates, finds superseded and scheduled-unchanged waste', () => {
  const runs = [
    run(1, { jobs: [job('build', ['ubuntu-latest'], 0, 600), job('test (ubuntu)', ['ubuntu-latest'], 10, 300), job('test (mac)', ['macos-14'], 10, 300)] }),
    // PR run superseded by a newer run on the same branch that started before it finished
    run(2, { event: 'pull_request', head_branch: 'feat', run_started_at: T(20), created_at: T(20), jobs: [job('build', ['ubuntu-latest'], 20, 1200)] }),
    run(3, { event: 'pull_request', head_branch: 'feat', run_started_at: T(25), created_at: T(25), jobs: [job('build', ['ubuntu-latest'], 25, 1200)] }),
    // failed run
    run(4, { conclusion: 'failure', run_started_at: T(60), created_at: T(60), jobs: [job('build', ['ubuntu-latest'], 60, 120, { conclusion: 'failure' })] }),
    // scheduled runs on the same commit
    run(5, { event: 'schedule', head_sha: 'z', run_started_at: T(100), created_at: T(100), jobs: [job('nightly', ['ubuntu-latest'], 100, 600)] }),
    run(6, { event: 'schedule', head_sha: 'z', run_started_at: T(200), created_at: T(200), jobs: [job('nightly', ['ubuntu-latest'], 200, 600)] }),
    run(7, { event: 'schedule', head_sha: 'y', run_started_at: T(300), created_at: T(300), jobs: [job('nightly', ['ubuntu-latest'], 300, 600)] }),
  ];
  const a = analyse(runs);
  assert.equal(a.totals.runs, 7);
  assert.equal(a.totals.billedMinutes, 10 + 5 + 5 + 20 + 20 + 2 + 10 + 10 + 10);
  assert.equal(a.waste.superseded.runs, 1);
  assert.equal(a.waste.superseded.minutes, 20);
  assert.equal(a.waste.failed.runs, 1);
  assert.equal(a.waste.scheduledUnchanged.runs, 1);
  assert.equal(a.waste.scheduledUnchanged.scheduledRuns, 3);
  assert.equal(a.runners[0].name, 'linux 2-core');
  assert.ok(a.runners.some((r) => r.name === 'macos 4-core'));
  assert.equal(a.topJobs[0].name, 'CI / test', 'five macOS minutes outprice fifty Linux minutes');
  assert.equal(a.topJobs.find((j) => j.name === 'CI / test').count, 2, 'matrix variants collapse into one job');
  const md = renderMarkdown(a, analyse([runs[0]]), { repo: 'acme/app', days: 30, isPublic: true, budget: 1, concurrency: new Map([[1, false]]) });
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /superseded runs/);
  assert.match(md, /no `cancel-in-progress`/);
  assert.match(md, /scheduled runs/);
  assert.match(md, /Over budget/);
  assert.match(md, /public, so GitHub-hosted/);
  assert.match(md, /▲/);
});

test('empty input renders without errors', () => {
  const md = renderMarkdown(analyse([]), null, { repo: 'acme/app', days: 7 });
  assert.match(md, /0 runs/);
  assert.match(md, /Nothing obvious/);
});
