const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const G = require('./guard');

const WORK = path.join(os.homedir(), 'contrib'); // clones live here (must be writable by the desktop user)
const file = (n) => path.join(app.getPath('userData'), n);
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
const writeJson = (n, v) => fs.writeFileSync(file(n), JSON.stringify(v, null, 2));

const run = (cmd, args, opts = {}) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 50e6, ...opts }, (e, out, err) => e ? rej(new Error((err || e.message).trim())) : res(out)));
const gh = (...a) => run('gh', a, { cwd: os.homedir() }); // not the app dir: root-owned, git there says 'dubious ownership'
const git = (dir, ...a) => run('git', a, { cwd: dir });
const locks = {};
const withLock = (k, fn) => { const p = (locks[k] || Promise.resolve()).then(fn); locks[k] = p.catch(() => {}); return p; };
const dirOf = (repo) => path.join(WORK, repo.replace('/', '__'));

// ---- brain: logged-in `claude` CLI. Read-only mode for ideas/drafts; edit mode (files only, no Bash => cannot commit) for fixes ----
const READ_TOOLS = 'Read,Glob,Grep,WebFetch'; // WebFetch: public docs sites linked from the README (e.g. laravel.com/docs)
const short = (v) => String(v || '').replace(os.homedir(), '~').replace(WORK, '').slice(0, 110);
const procs = {}, aborted = new Set(); // running claude children per job, and jobs the user stopped
const chk = (job) => { if (aborted.has(job)) throw new Error('Stopped by you'); };
function claude(prompt, { cwd = os.tmpdir(), edit = false, read = false, onLog = () => {}, job } = {}) {
  const tools = edit ? 'Read,Edit,Write,Glob,Grep,WebFetch' : read ? READ_TOOLS : '';
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--no-session-persistence', '--model', 'opus',
    ...(edit ? ['--permission-mode', 'acceptEdits'] : []), ...(tools ? ['--allowedTools', tools] : []), '--tools', tools];
  return new Promise((res, rej) => {
    const p = spawn('claude', args, { cwd }); let buf = '', err = '', final = '', failed = null;
    if (job) (procs[job] ||= new Set()).add(p);
    p.stdout.on('data', d => {
      buf += d; let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'assistant') for (const b of ev.message?.content || []) {
          if (b.type === 'tool_use') onLog(`→ ${b.name} ${short(b.input.file_path || b.input.pattern || b.input.path || b.input.url || '')}`);
          else if (b.type === 'text' && b.text.trim()) onLog(b.text.trim());
        } else if (ev.type === 'result') { if (ev.is_error) failed = ev.result || ev.subtype; else final = ev.result || ''; }
      }
    });
    p.stderr.on('data', d => err += d);
    p.on('error', rej);
    p.on('close', c => { procs[job]?.delete(p); return aborted.has(job) ? rej(new Error('Stopped by you')) : failed ? rej(new Error(failed)) : c && !final ? rej(new Error(err.trim() || `claude exited ${c}`)) : res(final.trim()); });
    p.stdin.end(prompt);
  });
}
// shared by triage, ideas and fixing: understand the project before judging or touching it
const DOCS_RULE = `FIRST, understand the project properly. Use your tools to find and carefully read: every README*, CONTRIBUTING*, ARCHITECTURE*, docs/doc/documentation folders (all .md/.rst), UPGRADE/CHANGELOG notes, and the test setup. If the README links to official documentation (for a framework like Laravel, its docs site), WebFetch the pages relevant to the area you are about to touch. Learn the project's purpose, conventions, public API and what maintainers accept. Only then continue. Say briefly what you learned.\n\n`;

ipcMain.handle('stop', (e, job) => { aborted.add(job); for (const p of procs[job] || []) p.kill(); return true; });

// ---- account ----
ipcMain.handle('account', async () => {
  const u = JSON.parse(await gh('api', 'user'));
  return { login: u.login, name: u.name, id: u.id, status: (await gh('auth', 'status').catch(e => e.message)) };
});
ipcMain.handle('login', () => { execFile('gnome-terminal', ['--title=GitHub login', '--', 'bash', '-c', 'gh auth login --web -h github.com; echo; gh auth status; read -r']); return true; });

// ---- repo docs + AI-policy check ----
const DOCS = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', 'AI_POLICY.md', '.github/AI_POLICY.md',
  'CODE_OF_CONDUCT.md', '.github/CODE_OF_CONDUCT.md', '.github/PULL_REQUEST_TEMPLATE.md', 'SECURITY.md', '.github/SECURITY.md'];
async function docs(repo) {
  const got = {};
  await Promise.all(DOCS.map(async f => {
    try { got[f] = Buffer.from(await gh('api', `repos/${repo}/contents/${f}`, '--jq', '.content'), 'base64').toString(); } catch {}
  }));
  return got;
}
const policyOf = (d) => G.hasPolicy(Object.fromEntries(Object.entries(d).filter(([f]) => !/SECURITY|PULL_REQUEST/.test(f))));

// ---- suggestions: popular repos per language, AI-policy repos dropped ----
ipcMain.handle('suggest', async (e, { languages, minStars = 5000 }) => {
  const out = [];
  for (const lang of languages) {
    const r = JSON.parse(await gh('search', 'repos', '--language', lang, '--stars', `>${minStars}`, '--sort', 'stars', '--limit', '15',
      '--archived=false', '--json', 'fullName,description,stargazersCount,openIssuesCount,language,url'));
    out.push(...r);
  }
  const flagged = await Promise.all(out.map(async r => ({ ...r, policy: policyOf(await docs(r.fullName)) })));
  return { ok: flagged.filter(r => !r.policy.length), hidden: flagged.filter(r => r.policy.length).map(r => r.fullName) };
});

// ---- scan: unassigned good-first / help-wanted issues with no open PR mentioning them ----
ipcMain.handle('scan', async (e, repo) => {
  const d = await docs(repo);
  const seen = new Map();
  for (const label of ['good first issue', 'help wanted']) {
    const l = JSON.parse(await gh('issue', 'list', '-R', repo, '-l', label, '-s', 'open', '-L', '20', '--json', 'number,title,assignees,url,comments,createdAt'));
    l.filter(i => !i.assignees.length).forEach(i => seen.set(i.number, { ...i, label }));
  }
  const issues = [...seen.values()].slice(0, 15);
  await Promise.all(issues.map(async i => {
    const prs = JSON.parse(await gh('pr', 'list', '-R', repo, '-S', String(i.number), '-s', 'open', '--json', 'title,body', '-L', '10').catch(() => '[]'));
    i.hasPr = prs.some(p => `${p.title} ${p.body}`.includes('#' + i.number));
  }));
  const c = d['CONTRIBUTING.md'] || d['.github/CONTRIBUTING.md'] || '';
  return {
    policy: policyOf(d), hasSecurity: !!(d['SECURITY.md'] || d['.github/SECURITY.md']),
    claimFirst: /comment.{0,40}(claim|assign|work on)|(claim|assign).{0,40}comment|ask to be assigned/i.test(c),
    issues: issues.filter(i => !i.hasPr),
  };
});

// ---- ideas: features + security, one read-only model pass. Security items are never filed publicly ----
ipcMain.handle('ideas', async (e, { repo, job }) => {
  aborted.delete(job);
  const step = (i, status, detail = '') => e.sender.send('step', { job, i, status, detail });
  const log = (t) => e.sender.send('log', { job, t: t + '\n' });
  let i = 0;
  try {
    step(i = 0, 'run'); log(`Reading ${repo} metadata and open issues…`);
    const [meta, issues] = await Promise.all([
      gh('repo', 'view', repo, '--json', 'description,primaryLanguage,stargazerCount,url'),
      gh('issue', 'list', '-R', repo, '-L', '40', '--json', 'number,title,labels'),
    ]);
    step(0, 'done', `${JSON.parse(issues).length} open issues listed`);
    step(i = 1, 'run'); const dir = path.join(WORK, '_read', repo.replace('/', '__'));
    if (!fs.existsSync(dir)) { log('Shallow clone for reading…'); fs.mkdirSync(path.dirname(dir), { recursive: true }); await run('git', ['clone', '--depth', '1', `https://github.com/${repo}.git`, dir]); }
    else { log('Updating existing read-only clone…'); await git(dir, 'pull', '--ff-only').catch(() => {}); }
    step(1, 'done', 'ready');
    step(i = 2, 'run', 'docs + code'); log('Reading README, docs and code (this is the long step)…');
    const out = await claude(DOCS_RULE + `You are a senior engineer and product thinker advising a contributor to ${repo}. After you understand the project deeply, explore the code and find
contributions that would REALLY help its users and maintainers. Be creative and ambitious, think out of the box, not a list of typo fixes and tiny refactors.
Propose 6 ideas with a deliberate MIX: at least 2 ambitious new features or capabilities, 1 developer-experience or tooling improvement, 1 performance or reliability idea,
and others as you see fit (architecture, testing infrastructure, integrations, better defaults, observability). Risk may be low, medium or high; do NOT bias toward safe ones.
Ground every idea in evidence: a gap, limitation, repeated pattern, TODO or recurring open issue that you actually saw in the code or issues (cite paths / issue numbers).
Never invent APIs or files; if unsure say so in "evidence". Skip anything already covered by an open issue unless you would take it much further.
Reply with ONLY a JSON array (no prose before or after), each item:
{"title":"short imperative title","kind":"feature|performance|dx|architecture|tooling|testing|docs","pitch":"1-2 sentences: what users get and why they would love it","evidence":"what you saw in the code/issues, with paths","change":"the approach: files to touch, the public API sketch, how it fits the architecture","impact":"who benefits and how much","risk":"low|medium|high","effort":"hours|days|weeks","security":false}
Set "security":true for any suspected vulnerability and put NO exploit details: only "report privately via SECURITY.md" in "pitch".

${meta}\nOpen issues: ${issues}`, { cwd: dir, read: true, onLog: log, job });
    step(2, 'done', 'analysed'); step(i = 3, 'done', 'ideas ready');
    return out;
  } catch (err) { step(i, 'fail', err.message.slice(0, 60)); log('FAILED: ' + err.message); throw err; }
});

// ---- prepare a clone: fork, branch off upstream, set the user's identity locally, hide AI tooling files ----
ipcMain.handle('prepare', async (e, { repo, number, idea, user, force, job, ck: saved }) => {
  // Forge pipeline. Every finished stage is checkpointed (`ck`, sent to the UI and saved), so a stopped or interrupted run resumes at the stage it reached.
  const step = (i, status, detail = '') => e.sender.send('step', { job, i, status, detail });
  const log = (t) => e.sender.send('log', { job, t: t + '\n' });
  const ck = saved || {};
  const save = (p) => { Object.assign(ck, p); e.sender.send('ckpt', { job, ck }); };
  aborted.delete(job);
  let i = 0;
  try {
    fs.mkdirSync(WORK, { recursive: true });
    const slug = idea ? idea.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) : '';
    const base = dirOf(repo), branch = idea ? `feat-${slug}` : `fix-${number}`, dir = `${base}--${branch}`;
    let direct = ck.direct, def = ck.def;

    // steps 0-2: fork, clone, worktree. On resume the worktree (with the edits so far) is kept as is.
    if (ck.setup && fs.existsSync(dir)) {
      log('Resuming: the working folder is still there, skipping setup.');
      step(0, 'done', direct ? 'direct push (write access)' : 'fork ready'); step(1, 'done', 'cloned'); step(2, 'done', branch);
    } else {
      // one shared clone per repo (set up under a lock so parallel jobs don't race), one git worktree per issue
      def = await withLock(repo, async () => {
        step(i = 0, 'run');
        // write access (your own repo or a team repo): no fork needed, push the branch to the repo itself
        direct = (await gh('api', `repos/${repo}`, '--jq', '.permissions.push').catch(() => 'false')).trim() === 'true';
        if (direct) log(`You have write access to ${repo}: skipping the fork, the branch will be pushed to the repo itself.`);
        else { log(`Forking ${repo} to ${user.login}…`); if (!fs.existsSync(base)) await gh('repo', 'fork', repo, '--clone=false'); }
        step(0, 'done', direct ? 'direct push (write access)' : `${user.login}/${repo.split('/')[1]}`);
        chk(job); step(i = 1, 'run');
        if (!fs.existsSync(base)) { log('Cloning (shared by all issues of this repo)…'); await run('git', ['clone', direct ? `https://github.com/${repo}.git` : `https://github.com/${user.login}/${repo.split('/')[1]}.git`, base]); }
        else log('Shared clone already exists, reusing it.');
        // always make sure upstream exists (a half-finished earlier run can leave a clone without it)
        if (!direct) await git(base, 'remote', 'get-url', 'upstream').catch(() => git(base, 'remote', 'add', 'upstream', `https://github.com/${repo}.git`));
        step(1, 'done', base.replace(os.homedir(), '~'));
        chk(job); step(i = 2, 'run');
        const d = (await gh('repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name')).trim();
        const up = direct ? 'origin' : 'upstream';
        log(`Fetching ${up}/${d}…`); await git(base, 'fetch', up, d);
        if (fs.existsSync(dir)) await git(base, 'worktree', 'remove', '--force', dir).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
        await git(base, 'worktree', 'prune');
        await git(base, 'worktree', 'add', '-B', branch, dir, `${up}/${d}`);
        // noreply address: counts on the profile without needing the `user` token scope; global git config untouched
        await git(base, 'config', 'user.name', user.name || user.login);
        await git(base, 'config', 'user.email', `${user.id}+${user.login}@users.noreply.github.com`);
        const ex = path.join(base, '.git/info/exclude'); if (!fs.readFileSync(ex, 'utf8').includes('CLAUDE.md')) fs.appendFileSync(ex, '\n.claude/\nCLAUDE.md\n');
        return d;
      });
      log(`Worktree ${path.basename(dir)}, committing as ${user.login}.`);
      step(2, 'done', branch); save({ setup: true, direct, def });
    }
    chk(job);

    // step 3: the issue / idea text
    if (!ck.issue) {
      step(i = 3, 'run');
      const iss = idea ? { title: idea.title, body: idea.body, state: 'open', labels: [], comments: [] }
        : JSON.parse(await gh('issue', 'view', String(number), '-R', repo, '--json', 'title,body,state,labels,comments'));
      const thread = iss.comments.slice(-15).map(c => `@${c.author?.login}: ${String(c.body).slice(0, 1500)}`).join('\n---\n');
      log(`${idea ? 'Idea' : 'Issue #' + number}: ${iss.title} (${iss.comments.length} comments)`);
      save({ issue: { ...iss, comments: [] }, thread });
    }
    const issue = ck.issue, thread = ck.thread || '', what = idea ? 'a contribution idea' : `GitHub issue #${number}`;
    step(3, 'done', issue.title.slice(0, 40)); chk(job);

    // step 4: validate before spending effort: read the docs, the thread AND the code
    if (!ck.verdict) {
      step(i = 4, 'run', 'reading the code…'); log('Validating: is it a real, current, fixable issue? (read-only pass over the code)');
      const raw = await claude(DOCS_RULE + `You triage ${what} for ${repo} for a first-time contributor. The repo is checked out in the current directory (default branch).
Read the issue and thread below, then INVESTIGATE THE CODE with your tools. Decide:
- real: does the code actually have this bug / lack this feature today? (it may already be fixed, be a misuse, a duplicate, or by design)
- fixable: can it be fixed with a small, safe change that a newcomer can finish? Or is it a big design decision, needs maintainer sign-off, or touches security (never fix security issues publicly)?
- maintainers: did a maintainer decline it, ask for discussion first, or say they will handle it?
Be skeptical, cite file paths. Reply with a short analysis, then as the LAST line only JSON:
{"verdict":"fix"|"skip"|"unclear","real":true|false,"reason":"one sentence","plan":"files and change you would make, or empty"}

TITLE: ${issue.title}\nSTATE: ${issue.state}\nLABELS: ${issue.labels.map(l => l.name).join(', ')}\n\n${issue.body}\n\nTHREAD:\n${thread}`, { cwd: dir, read: true, onLog: log, job });
      let vv; try { vv = JSON.parse(raw.slice(raw.lastIndexOf('{'))); } catch { vv = { verdict: 'unclear', reason: 'could not parse the triage answer', plan: '' }; }
      log(`Verdict: ${vv.verdict.toUpperCase()}: ${vv.reason}`); save({ verdict: vv });
    }
    const v = ck.verdict;
    if (v.verdict !== 'fix' && !force) { step(4, 'done', v.verdict); return { dir, branch, def, direct, issue, verdict: v, stopped: true }; }
    step(4, 'done', v.verdict === 'fix' ? 'real & fixable' : v.verdict + ' (forced)'); chk(job);

    // step 5: the change itself
    if (!ck.fixed) {
      step(i = 5, 'run', ck.fixStarted ? 'continuing…' : 'AI is editing files…'); log(ck.fixStarted ? 'Continuing the change from where it stopped…' : 'AI is editing files (a few minutes)…');
      const resumeNote = ck.fixStarted ? '\n\nNOTE: an earlier attempt was interrupted. Part of the change may already be in the working tree. Read the relevant files, check what is already done, and COMPLETE the work without duplicating edits.' : '';
      save({ fixStarted: true });
      const out = await claude(DOCS_RULE + `${idea ? 'Implement this contribution idea' : 'Fix this GitHub issue'} in the repository in the current directory. Make the smallest correct change, follow the repo's existing style
and any CONTRIBUTING guidance. Edit files only; do not run git. Do not add comments or text mentioning AI tools. A separate step writes the unit tests, so focus on the source change.
A prior triage found: ${v.reason}\nPlan: ${v.plan}\n\n${idea ? 'Idea' : 'Issue #' + number}: ${issue.title}\n\n${issue.body}${resumeNote}`, { cwd: dir, edit: true, onLog: log, job });
      log(out); save({ fixed: true });
    }
    step(5, 'done', 'files edited'); chk(job);

    // step 6: every change ships with unit tests, a separate pass that only writes tests in the repo's own conventions
    if (!ck.tested) {
      step(i = 6, 'run', ck.testStarted ? 'continuing…' : 'writing tests…'); log('Writing unit tests for the change…');
      await git(dir, 'add', '-N', '.');
      const patch = (await git(dir, 'diff')).slice(0, 40000);
      save({ testStarted: true });
      const tout = await claude(`You write unit tests for a change already made in the repository in the current directory (the diff is below).
1. Find the existing test suite (Glob test/, tests/, spec/, __tests__, *Test.php, *.test.*, *_test.*). Read 2-3 tests next to the changed code and COPY their conventions: framework, base classes, helpers, factories, naming, file location.
2. Write focused unit tests for the change: the main behaviour, edge cases, and the bug/feature itself, so they would FAIL without the change and PASS with it. Prefer several small tests over one big one.
3. Only create or edit test files. Do not touch source files. Do not run git. No comments or text mentioning AI tools.
4. If the repo truly has no test setup, say so in one line and write nothing.
${ck.testStarted ? '5. An earlier attempt was interrupted: some tests may already exist in the diff; extend them, do not duplicate.\n' : ''}End with a one-line list of the test files you added or changed.

DIFF:\n${patch}`, { cwd: dir, edit: true, onLog: log, job });
      log(tout);
      await git(dir, 'add', '-N', '.');
      const files = (await git(dir, 'diff', '--name-only')).split('\n').filter(Boolean);
      save({ tested: true, tests: files.filter(f => /(^|\/)(tests?|spec|__tests__)\/|[._-](test|spec)\.|Test\.(php|java|cs)$/i.test(f)) });
    }
    const tests = ck.tests || [];
    step(6, tests.length ? 'done' : 'fail', tests.length ? `${tests.length} test file(s)` : 'no tests written');
    step(i = 7, 'run', 'your review');
    return { dir, branch, def, direct, issue, verdict: v, tests };
  } catch (err) { step(i, 'fail', err.message.slice(0, 60)); log((/Stopped by you/.test(err.message) ? 'STOPPED: ' : 'FAILED: ') + err.message); throw err; }
});

ipcMain.handle('diff', async (e, dir) => { await git(dir, 'add', '-N', '.'); return git(dir, 'diff'); });
ipcMain.handle('test', (e, { dir, cmd }) => new Promise(res => execFile('bash', ['-c', cmd], { cwd: dir, timeout: 600000, maxBuffer: 50e6 },
  (err, out, se) => res(`${err ? 'FAILED' : 'PASSED'}\n${(out + se).slice(-4000)}`))));

// ---- draft title + body from the diff and the repo's PR template; the user edits it before shipping ----
ipcMain.handle('draft', async (e, { dir, number, issue, tests = [], testCmd }) => {
  // find the repo's PR template (any common location / casing)
  const cands = ['.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md'];
  const tf = cands.map(c => path.join(dir, c)).find(f => fs.existsSync(f));
  const tpl = tf ? fs.readFileSync(tf, 'utf8') : '';
  await git(dir, 'add', '-N', '.');
  const out = await claude(`Write a detailed, professional pull request description as the human author (first person, plain, confident, no hype, no emojis).
You may read the code around the change to explain it accurately. Output format: line 1 = the PR title only (imperative, under 72 chars, no prefix like "feat:" unless the repo's history uses it). Then a blank line, then the body in Markdown.

The body must cover, in this order (skip a section only if truly irrelevant):
## Summary: 2-3 sentences, what this PR does.
## Motivation: the problem or gap, who is affected, and why it matters. ${number ? `Reference the issue and include the line "Fixes #${number}".` : 'This implements a contribution idea; explain the need with concrete evidence from the code.'}
## What changed: bullet list by file or area, each saying what and why.
## How it works: the approach and key design decisions, plus alternatives you considered and why you did not pick them.
## Tests: list the test files added (${tests.join(', ') || 'none'}), what each case covers, and how to run them${testCmd ? ` (\`${testCmd}\`)` : ''}. Do NOT claim the tests were run or passed unless told.
## Compatibility & risk: backwards compatibility, performance impact, migration notes, anything reviewers should look at closely.
${tpl ? `\nThe repo has a PR template. Keep ALL its headings and checkboxes, fill every section with the content above, and leave checkboxes you cannot honestly tick unticked:\n---\n${tpl}\n---\n` : ''}
Never mention AI tools, assistants, or generated code anywhere.

${issue ? `CONTEXT (${number ? 'issue #' + number : 'idea'}): ${issue.title}\n${String(issue.body || '').slice(0, 4000)}\n\n` : ''}DIFF:\n${(await git(dir, 'diff')).slice(0, 40000)}`, { cwd: dir, read: true });
  const [title, ...rest] = out.trim().split('\n'); return { title: title.replace(/^#+\s*/, ''), body: rest.join('\n').trim() };
});


// ---- ship: guards, then plain git + gh. No model is involved in commit/push/PR, so nothing can add a trailer ----
ipcMain.handle('ship', async (e, { repo, dir, branch, def, direct, title, body, user }) => {
  const prs = readJson('prs.json', {});
  if (!G.rateOk(prs[repo])) throw new Error(`Rate cap: already opened a PR to ${repo} in the last 24h.`);
  await git(dir, 'add', '-A');
  const names = await git(dir, 'diff', '--cached', '--name-only');
  if (!names.trim()) throw new Error('Nothing staged: the AI made no changes.');
  const hit = G.findTrace(title, body, names, G.addedLines(await git(dir, 'diff', '--cached')));
  if (hit) throw new Error(`Blocked, AI/co-author trace found: "${hit}"`);
  const lead = (body.split(/\n\s*\n/).find(p => p.trim() && !/^#/.test(p.trim())) || '').trim(); // first prose paragraph, not a heading
  await git(dir, 'commit', '-m', title, ...(lead ? ['-m', lead] : []));
  const msg = await git(dir, 'log', '-1', '--format=%B%n%an <%ae>');
  const hit2 = G.findTrace(msg); if (hit2) { await git(dir, 'reset', '--soft', 'HEAD~1'); throw new Error(`Blocked after commit (undone): "${hit2}"`); }
  await git(dir, 'push', '-u', 'origin', branch, '--force-with-lease');
  const url = (await gh('pr', 'create', '-R', repo, '--head', direct ? branch : `${user.login}:${branch}`, '--base', def, '--title', title, '--body', body)).trim();
  prs[repo] = Date.now(); writeJson('prs.json', prs);
  return url;
});

ipcMain.handle('open', (e, { url, copy }) => { if (copy) clipboard.writeText(copy); return shell.openExternal(url); });
// Forge runs survive restarts (steps, log, status, branch/worktree info)
ipcMain.handle('jobs:get', () => readJson('jobs.json', []));
ipcMain.handle('jobs:set', (e, list) => { writeJson('jobs.json', list); return true; });
// scan + ideas results survive restarts: cache.json = { 'owner/name': { scan: {data, at}, ideas: {result, log, at} } }
ipcMain.handle('cache:get', () => readJson('cache.json', {}));
ipcMain.handle('cache:set', (e, { repo, key, value }) => {
  const c = readJson('cache.json', {}); c[repo] ||= {};
  if (value === null) delete c[repo][key]; else c[repo][key] = value;
  if (!Object.keys(c[repo]).length) delete c[repo];
  writeJson('cache.json', c); return true;
});
ipcMain.handle('settings:get', () => readJson('settings.json', { languages: ['PHP', 'JavaScript', 'Python'], minStars: 5000, testCmd: '' }));
ipcMain.handle('settings:set', (e, s) => { writeJson('settings.json', s); return true; });

app.disableHardwareAcceleration(); // GPU process crashes on this box otherwise
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1600, height: 1000, minWidth: 1100, backgroundColor: '#090909', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true, contextIsolation: true } });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});
app.on('window-all-closed', () => app.quit());
