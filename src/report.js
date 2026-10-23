// Pure analysis of workflow runs (with their jobs) into a cost report. No I/O here, so it is easy to test.
import { DEFAULT_RATES, classifyRunner, rateFor } from './pricing.js';

export const MARKER = '<!-- ci-cost-report -->';
const sec = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 1000) : 0);
export const usd = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);
export const mins = (m) => (m >= 6000 ? `${(m / 60).toFixed(0)} h` : m >= 600 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m).toLocaleString('en-US')} min`);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '');

// Price one job. GitHub bills every job separately, rounded up to the next whole minute.
export function priceJob(job, { rates = DEFAULT_RATES, selfHostedRate = 0 } = {}) {
  const cls = classifyRunner(job.labels || [], job.runner_name || '');
  const seconds = sec(job.started_at, job.completed_at);
  const billedMinutes = seconds > 0 ? Math.ceil(seconds / 60) : 0;
  const rate = rateFor(cls, rates, selfHostedRate);
  return { name: job.name, seconds, minutes: seconds / 60, billedMinutes, rate, usd: billedMinutes * rate, runner: cls, conclusion: job.conclusion || job.status };
}

export function analyse(runs, opts = {}) {
  const { rates = DEFAULT_RATES, selfHostedRate = 0 } = opts;
  const totals = { runs: 0, jobs: 0, minutes: 0, billedMinutes: 0, usd: 0, selfHostedMinutes: 0 };
  const workflows = new Map(), runners = new Map(), jobsAgg = new Map();
  const waste = {
    failed: { runs: 0, minutes: 0, usd: 0 },
    superseded: { runs: 0, minutes: 0, usd: 0, byWorkflow: new Map() },
    rounding: { minutes: 0, usd: 0 },
    scheduledUnchanged: { runs: 0, minutes: 0, usd: 0, byWorkflow: new Map(), scheduledRuns: 0 },
    retries: { runs: 0, minutes: 0, usd: 0 },
  };
  const priced = [];
  for (const run of runs) {
    const jobs = (run.jobs || []).map((j) => priceJob(j, { rates, selfHostedRate }));
    const r = { run, jobs, minutes: 0, billedMinutes: 0, usd: 0, started: run.run_started_at || run.created_at, finished: null };
    for (const j of jobs) {
      r.minutes += j.minutes; r.billedMinutes += j.billedMinutes; r.usd += j.usd;
      if (!j.runner.hosted) totals.selfHostedMinutes += j.billedMinutes;
      waste.rounding.minutes += j.billedMinutes - j.minutes; waste.rounding.usd += (j.billedMinutes - j.minutes) * j.rate;
      const rk = j.runner.hosted ? `${j.runner.os} ${j.runner.cores}-core` : 'self-hosted';
      const ra = runners.get(rk) || { name: rk, label: j.runner.label, jobs: 0, billedMinutes: 0, usd: 0, rate: j.rate };
      ra.jobs++; ra.billedMinutes += j.billedMinutes; ra.usd += j.usd; runners.set(rk, ra);
      const jk = `${run.name} / ${j.name.replace(/\s*\(.*\)\s*$/, '')}`; // collapse matrix variants
      const ja = jobsAgg.get(jk) || { name: jk, count: 0, billedMinutes: 0, usd: 0, seconds: 0 };
      ja.count++; ja.billedMinutes += j.billedMinutes; ja.usd += j.usd; ja.seconds += j.seconds; jobsAgg.set(jk, ja);
      const end = (run.jobs || []).map((x) => x.completed_at).filter(Boolean).sort().pop();
      if (end) r.finished = end;
    }
    totals.runs++; totals.jobs += jobs.length; totals.minutes += r.minutes; totals.billedMinutes += r.billedMinutes; totals.usd += r.usd;
    const wa = workflows.get(run.workflow_id) || { id: run.workflow_id, name: run.name, path: run.path, runs: 0, success: 0, billedMinutes: 0, usd: 0, events: new Map() };
    wa.runs++; if (run.conclusion === 'success') wa.success++; wa.billedMinutes += r.billedMinutes; wa.usd += r.usd;
    wa.events.set(run.event, (wa.events.get(run.event) || 0) + 1);
    workflows.set(run.workflow_id, wa);
    if (run.conclusion && run.conclusion !== 'success' && run.conclusion !== 'skipped' && run.conclusion !== 'cancelled') { waste.failed.runs++; waste.failed.minutes += r.billedMinutes; waste.failed.usd += r.usd; }
    if ((run.run_attempt || 1) > 1) { waste.retries.runs++; }
    priced.push(r);
  }
  // Superseded runs: a newer run of the same workflow on the same branch started before this one finished, and this one was not cancelled.
  const groups = new Map();
  for (const r of priced) {
    if (!['pull_request', 'push', 'pull_request_target'].includes(r.run.event)) continue;
    const k = `${r.run.workflow_id}|${r.run.head_branch}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => new Date(a.started) - new Date(b.started));
    for (let i = 0; i < list.length - 1; i++) {
      const cur = list[i], next = list[i + 1];
      if (cur.finished && new Date(next.started) < new Date(cur.finished) && cur.run.conclusion !== 'cancelled') {
        waste.superseded.runs++; waste.superseded.minutes += cur.billedMinutes; waste.superseded.usd += cur.usd;
        const w = waste.superseded.byWorkflow.get(cur.run.workflow_id) || { id: cur.run.workflow_id, name: cur.run.name, path: cur.run.path, runs: 0, usd: 0, minutes: 0 };
        w.runs++; w.usd += cur.usd; w.minutes += cur.billedMinutes; waste.superseded.byWorkflow.set(cur.run.workflow_id, w);
      }
    }
  }
  // Scheduled runs that built the same commit as the previous scheduled run of that workflow.
  const sched = new Map();
  for (const r of priced.filter((x) => x.run.event === 'schedule').sort((a, b) => new Date(a.started) - new Date(b.started))) {
    waste.scheduledUnchanged.scheduledRuns++;
    const prev = sched.get(r.run.workflow_id);
    if (prev && prev.run.head_sha && prev.run.head_sha === r.run.head_sha) {
      waste.scheduledUnchanged.runs++; waste.scheduledUnchanged.minutes += r.billedMinutes; waste.scheduledUnchanged.usd += r.usd;
      const w = waste.scheduledUnchanged.byWorkflow.get(r.run.workflow_id) || { id: r.run.workflow_id, name: r.run.name, path: r.run.path, runs: 0, usd: 0, minutes: 0 };
      w.runs++; w.usd += r.usd; w.minutes += r.billedMinutes; waste.scheduledUnchanged.byWorkflow.set(r.run.workflow_id, w);
    }
    sched.set(r.run.workflow_id, r);
  }
  const byUsd = (a, b) => b.usd - a.usd || b.billedMinutes - a.billedMinutes;
  return {
    totals,
    workflows: [...workflows.values()].sort(byUsd),
    runners: [...runners.values()].sort(byUsd),
    topJobs: [...jobsAgg.values()].sort(byUsd).slice(0, 10),
    waste,
    period: opts.period || null,
  };
}

function delta(now, before) {
  if (before === null || before === undefined) return '';
  if (before === 0) return now > 0 ? ' (new)' : '';
  const d = ((now - before) / before) * 100;
  if (Math.abs(d) < 1) return ' (±0%)';
  return ` (${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%)`;
}

export function renderMarkdown(cur, prev, o = {}) {
  const { repo = '', days = 30, isPublic = false, budget = null, concurrency = new Map(), truncated = false, repoCount = 1 } = o;
  const L = [MARKER, `## CI cost report: ${repoCount > 1 ? `${repoCount} repositories` : repo}`, ''];
  const t = cur.totals, p = prev && prev.totals;
  L.push(`Last **${days} days**: **${t.runs.toLocaleString('en-US')} runs**, ${t.jobs.toLocaleString('en-US')} jobs, **${mins(t.billedMinutes)}** billed${p ? delta(t.billedMinutes, p.billedMinutes) : ''}, about **${usd(t.usd)}**${p ? delta(t.usd, p.usd) : ''} at GitHub list prices${p ? ` (previous ${days} days: ${usd(p.usd)})` : ''}.`);
  if (isPublic) L.push('', '> This repository is public, so GitHub-hosted standard runners are free; the figures are what the same minutes would cost on a private repository (or what they cost if you use larger runners).');
  if (t.selfHostedMinutes) L.push('', `> ${mins(t.selfHostedMinutes)} ran on self-hosted runners, priced at the \`self-hosted-rate\` input${o.selfHostedRate ? ` ($${o.selfHostedRate}/min)` : ' (default $0; set it to your real per-minute cost)'}.`);
  if (truncated) L.push('', `> Only the most recent ${o.maxRuns} runs were analysed (\`max-runs\`); the real totals are higher.`);
  if (budget !== null) L.push('', t.usd > budget ? `### ❌ Over budget: ${usd(t.usd)} against a budget of ${usd(budget)}` : `### ✅ Within budget: ${usd(t.usd)} of ${usd(budget)}`);
  L.push('', '### Where the money goes', '', '| Workflow | Runs | Success | Billed | Cost | Share |', '|---|---:|---:|---:|---:|---:|');
  for (const w of cur.workflows.slice(0, 15)) L.push(`| ${w.name} | ${w.runs} | ${pct(w.success, w.runs)} | ${mins(w.billedMinutes)} | ${usd(w.usd)} | ${pct(w.usd, t.usd)} |`);
  if (cur.workflows.length > 15) L.push(`| …${cur.workflows.length - 15} more | | | | | |`);
  L.push('', '| Runner | Jobs | Billed | Rate | Cost |', '|---|---:|---:|---:|---:|');
  for (const r of cur.runners) L.push(`| ${r.name}${r.name === 'self-hosted' ? '' : ` (\`${r.label}\`)`} | ${r.jobs} | ${mins(r.billedMinutes)} | $${r.rate}/min | ${usd(r.usd)} |`);
  L.push('', '<details><summary>Most expensive jobs</summary>', '', '| Job | Runs | Avg | Billed | Cost |', '|---|---:|---:|---:|---:|');
  for (const j of cur.topJobs) L.push(`| ${j.name} | ${j.count} | ${(j.seconds / j.count / 60).toFixed(1)} min | ${mins(j.billedMinutes)} | ${usd(j.usd)} |`);
  L.push('', '</details>');
  const w = cur.waste;
  const items = [];
  if (w.superseded.runs) {
    const names = [...w.superseded.byWorkflow.values()].sort((a, b) => b.usd - a.usd).map((x) => `${x.name}${concurrency.get(x.id) === false ? ' (no `cancel-in-progress`)' : ''}`).slice(0, 5).join(', ');
    items.push(`**${usd(w.superseded.usd)}** (${mins(w.superseded.minutes)}) on **${w.superseded.runs} superseded run${w.superseded.runs === 1 ? '' : 's'}**: a newer push to the same branch started before they finished, and they ran to the end anyway. Add to the affected workflows (${names}):\n\n  \`\`\`yaml\n  concurrency:\n    group: \${{ github.workflow }}-\${{ github.ref }}\n    cancel-in-progress: true\n  \`\`\``);
  }
  if (w.failed.runs) items.push(`**${usd(w.failed.usd)}** (${mins(w.failed.minutes)}) on **${w.failed.runs} failed run${w.failed.runs === 1 ? '' : 's'}**. Put the fastest checks first and use \`fail-fast\` in matrices so a broken build stops early.`);
  if (w.scheduledUnchanged.runs) items.push(`**${usd(w.scheduledUnchanged.usd)}** (${mins(w.scheduledUnchanged.minutes)}) on **${w.scheduledUnchanged.runs} of ${w.scheduledUnchanged.scheduledRuns} scheduled runs** that built the same commit as the previous scheduled run (${[...w.scheduledUnchanged.byWorkflow.values()].map((x) => x.name).slice(0, 5).join(', ')}). Gate the workflow with [Skip Unchanged](https://github.com/marketplace/actions/skip-unchanged) (one \`check\` job, \`if: needs.check.outputs.skip != 'true'\`), or trigger on push instead.`);
  if (w.rounding.minutes >= 1) items.push(`**${usd(w.rounding.usd)}** (${mins(w.rounding.minutes)}) is **rounding**: every job is billed in whole minutes, so a 10-second job costs a full minute. ${t.jobs ? `Average ${(w.rounding.minutes / t.jobs * 60).toFixed(0)}s lost per job` : ''}; merge very short jobs into their neighbours.`);
  if (w.retries.runs) items.push(`**${w.retries.runs} run${w.retries.runs === 1 ? ' was' : 's were'} re-run** (attempt 2 or later); flaky tests cost real money twice.`);
  L.push('', '### Where to save', '');
  if (items.length) for (const it of items) L.push(`- ${it}`); else L.push('Nothing obvious: no superseded runs, no scheduled rebuilds of unchanged commits, failures under control.');
  L.push('', `<sub>Generated by <a href="https://github.com/Huckcity/ci-cost-report">ci-cost-report</a> from the GitHub API; durations are job wall-clock times rounded up per minute like GitHub bills them, priced at the public per-minute rates for each runner label. Spending more than you would like? The author does CI cost and migration work: <a href="https://ci2actions.dev/migration/">ci2actions.dev</a>.</sub>`);
  return L.join('\n') + '\n';
}
