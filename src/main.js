import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { analyse, renderMarkdown, MARKER, usd, mins } from './report.js';
import { DEFAULT_RATES } from './pricing.js';

const input = (name, def = '') => { const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`]; return v === undefined || v === '' ? def : v; };
const log = { info: (m) => console.log(m), warn: (m) => console.log(`::warning::${m}`), error: (m) => console.log(`::error::${m}`) };
const setOutput = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const token = input('token', process.env.GITHUB_TOKEN || '');
async function gh(path, opts = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${api}${path}`, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ci-cost-report', ...(opts.headers || {}) },
  });
  if (!res.ok) { const body = await res.text().catch(() => ''); const err = new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${body.slice(0, 200)}`); err.status = res.status; throw err; }
  if (opts.raw) return res.text();
  return res.status === 204 ? null : res.json();
}
const day = (d) => d.toISOString().slice(0, 10);

async function runsBetween(repo, from, to, maxRuns) {
  const out = [];
  let truncated = false;
  for (let page = 1; page <= 10; page++) {
    const r = await gh(`/repos/${repo}/actions/runs?created=${day(from)}..${day(to)}&per_page=100&page=${page}`);
    out.push(...(r.workflow_runs || []));
    if (out.length >= maxRuns) { truncated = out.length < r.total_count; out.length = maxRuns; break; }
    if ((r.workflow_runs || []).length < 100) break;
    if (page === 10 && out.length < r.total_count) truncated = true;
  }
  return { runs: out.filter((x) => x.status === 'completed'), truncated };
}
async function withJobs(repo, runs, label) {
  let n = 0;
  for (const run of runs) {
    n++;
    if (n % 25 === 0) log.info(`${label}: fetched jobs for ${n}/${runs.length} runs`);
    try {
      const jobs = [];
      for (let page = 1; page <= 5; page++) {
        const r = await gh(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100&page=${page}&filter=all`);
        jobs.push(...(r.jobs || []));
        if (jobs.length >= (r.total_count || 0) || (r.jobs || []).length < 100) break;
      }
      run.jobs = jobs;
    } catch (e) { log.warn(`Skipping run ${run.id}: ${e.message}`); run.jobs = []; }
  }
  return runs;
}

async function upsertIssue(repo, title, body) {
  let found = null;
  for (let page = 1; page <= 3 && !found; page++) {
    const list = await gh(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`);
    found = list.find((i) => !i.pull_request && typeof i.body === 'string' && i.body.includes(MARKER));
    if (list.length < 100) break;
  }
  if (found) { await gh(`/repos/${repo}/issues/${found.number}`, { method: 'PATCH', body: JSON.stringify({ title, body }) }); return { url: found.html_url, updated: true }; }
  const created = await gh(`/repos/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title, body }) });
  return { url: created.html_url, updated: false };
}

async function main() {
  const currentRepo = process.env.GITHUB_REPOSITORY;
  if (!token) throw new Error('A token is required (the default github.token works for the current repository).');
  const repos = input('repos', '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!repos.length) { if (!currentRepo) throw new Error('GITHUB_REPOSITORY is not set and no `repos` input was given.'); repos.push(currentRepo); }
  const days = Math.max(1, Math.min(90, parseInt(input('days', '30'), 10) || 30));
  const comparePrevious = input('compare-previous', 'true') === 'true';
  const maxRuns = Math.max(10, Math.min(1000, parseInt(input('max-runs', '600'), 10) || 600));
  const selfHostedRate = parseFloat(input('self-hosted-rate', '0')) || 0;
  let rates = DEFAULT_RATES;
  if (input('rates')) { try { rates = { ...DEFAULT_RATES, ...JSON.parse(input('rates')) }; } catch (e) { log.warn(`Ignoring invalid \`rates\` JSON: ${e.message}`); } }
  const budget = input('budget-usd') ? parseFloat(input('budget-usd')) : null;
  const commentOnPr = input('comment-on-pr', 'true') === 'true';
  const issueMode = input('issue', 'false') === 'true';
  const issueTitle = input('issue-title', 'CI cost report');
  const failOverBudget = input('fail-over-budget', 'true') === 'true';

  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);
  const prevFrom = new Date(from.getTime() - days * 86400000);
  const allCur = [], allPrev = [];
  let truncated = false, isPublic = true;
  const concurrency = new Map();
  for (const repo of repos) {
    const meta = await gh(`/repos/${repo}`);
    if (meta.private) isPublic = false;
    const cur = await runsBetween(repo, from, now, maxRuns);
    truncated = truncated || cur.truncated;
    log.info(`${repo}: ${cur.runs.length} completed runs in the last ${days} days${cur.truncated ? ' (truncated)' : ''}.`);
    await withJobs(repo, cur.runs, repo);
    for (const r of cur.runs) r.repo = repo;
    allCur.push(...cur.runs);
    if (comparePrevious) {
      const prev = await runsBetween(repo, prevFrom, new Date(from.getTime() - 1), maxRuns);
      await withJobs(repo, prev.runs, `${repo} (previous period)`);
      allPrev.push(...prev.runs);
    }
  }
  const period = { from, to: now, days };
  const cur = analyse(allCur, { rates, selfHostedRate, period });
  const prev = comparePrevious ? analyse(allPrev, { rates, selfHostedRate }) : null;

  // For workflows with superseded runs, check whether the workflow file already has cancel-in-progress.
  for (const w of cur.waste.superseded.byWorkflow.values()) {
    const run = allCur.find((r) => r.workflow_id === w.id);
    if (!run || !run.path) continue;
    try {
      const text = await gh(`/repos/${run.repo}/contents/${run.path}`, { raw: true, headers: { Accept: 'application/vnd.github.raw+json' } });
      concurrency.set(w.id, /cancel-in-progress:\s*true/.test(text));
    } catch { /* no contents permission; say nothing */ }
  }

  const md = renderMarkdown(cur, prev, { repo: repos[0], repoCount: repos.length, days, isPublic, budget, concurrency, truncated, maxRuns, selfHostedRate });
  const outDir = process.env.RUNNER_TEMP || '.';
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, 'ci-cost-report.md');
  writeFileSync(reportPath, md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  log.info(`Last ${days} days: ${cur.totals.runs} runs, ${mins(cur.totals.billedMinutes)} billed, about ${usd(cur.totals.usd)}.`);
  setOutput('total-usd', cur.totals.usd.toFixed(2));
  setOutput('total-minutes', String(cur.totals.billedMinutes));
  setOutput('previous-usd', prev ? prev.totals.usd.toFixed(2) : '');
  setOutput('superseded-usd', cur.waste.superseded.usd.toFixed(2));
  setOutput('report-path', reportPath);

  if (issueMode && currentRepo) {
    try { const r = await upsertIssue(currentRepo, issueTitle, md); log.info(`${r.updated ? 'Updated' : 'Opened'} issue ${r.url}`); }
    catch (e) { log.warn(`Could not write the issue: ${e.message}${e.status === 403 ? ' (the token needs "issues: write")' : ''}`); }
  }
  const prNumber = process.env.GITHUB_EVENT_NAME?.startsWith('pull_request') ? Number(process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)/)?.[1]) : null;
  if (commentOnPr && prNumber && currentRepo) {
    try {
      const comments = await gh(`/repos/${currentRepo}/issues/${prNumber}/comments?per_page=100`);
      const mine = comments.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
      if (mine) await gh(`/repos/${currentRepo}/issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body: md }) });
      else await gh(`/repos/${currentRepo}/issues/${prNumber}/comments`, { method: 'POST', body: JSON.stringify({ body: md }) });
      log.info(`${mine ? 'Updated' : 'Posted'} the report on PR #${prNumber}.`);
    } catch (e) { log.warn(`Could not comment on PR #${prNumber}: ${e.message}${e.status === 403 ? ' (the token needs "pull-requests: write")' : ''}`); }
  }
  if (budget !== null && cur.totals.usd > budget) {
    const msg = `CI spend ${usd(cur.totals.usd)} in the last ${days} days exceeds the budget of ${usd(budget)}.`;
    if (failOverBudget) { log.error(msg); process.exitCode = 1; } else log.warn(msg);
  }
}

main().catch((e) => { log.error(e.message); process.exitCode = 1; });
