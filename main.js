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
const pendingLock = {};
const withLock = (k, fn, onWait) => { if (pendingLock[k] > 0) onWait?.(); pendingLock[k] = (pendingLock[k] || 0) + 1; const p = (locks[k] || Promise.resolve()).then(fn); locks[k] = p.catch(() => {}).then(() => { pendingLock[k]--; }); return p; };
const dirOf = (repo) => path.join(WORK, repo.replace('/', '__'));

// ---- brain: logged-in `claude` CLI. Read-only mode for ideas/drafts; edit mode (files only, no Bash => cannot commit) for fixes ----
const DELETE_NOTE = '\n\nYou cannot delete or move files. If a file must be REMOVED (for example after moving or renaming it), end your answer with one line per file: "DELETE: path/relative/to/repo/root". Only delete files that belong to this change.';
function applyDeletes(dir, text, log) {
  const root = path.resolve(dir); let n = 0;
  for (const m of String(text).matchAll(/^DELETE:\s*(.+?)\s*$/gm)) {
    if (n >= 20) break;
    const rel = m[1].replace(/^`|`$/g, ''), abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) || /(^|\/)\.git(\/|$)/.test(path.relative(root, abs)) || !fs.existsSync(abs)) continue;
    try { fs.rmSync(abs, { recursive: false, force: true }); n++; log?.(`Deleted ${rel}`); } catch {}
  }
  return n;
}
const READ_TOOLS = 'Read,Glob,Grep,WebFetch'; // WebFetch: public docs sites linked from the README (e.g. laravel.com/docs)
const short = (v) => String(v || '').replace(os.homedir(), '~').replace(WORK, '').slice(0, 110);
const procs = {}, aborted = new Set(); // running claude children per job, and jobs the user stopped
const chk = (job) => { if (aborted.has(job)) throw new Error('Stopped by you'); };
function claude(prompt, { cwd = os.tmpdir(), edit = false, read = false, onLog = () => {}, job } = {}) {
  const tools = edit ? 'Read,Edit,Write,Glob,Grep,WebFetch' : read ? READ_TOOLS : '';
  if (edit) prompt += DELETE_NOTE;
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
    p.on('close', c => { procs[job]?.delete(p); if (edit && !failed && !aborted.has(job)) applyDeletes(cwd, final, onLog); return aborted.has(job) ? rej(new Error('Stopped by you')) : failed ? rej(new Error(failed)) : c && !final ? rej(new Error(err.trim() || `claude exited ${c}`)) : res(final.trim()); });
    p.stdin.end(prompt);
  });
}
// shared by triage, ideas and fixing: understand the project before judging or touching it
const DOCS_RULE = `FIRST, understand the project properly. Use your tools to find and carefully read: every README*, CONTRIBUTING*, ARCHITECTURE*, docs/doc/documentation folders (all .md/.rst), UPGRADE/CHANGELOG notes, and the test setup. If the README links to official documentation (for a framework like Laravel, its docs site), WebFetch the pages relevant to the area you are about to touch. Learn the project's purpose, conventions, public API and what maintainers accept. Only then continue. Say briefly what you learned.\n\n`;


// ---- cloning big repos safely: blobless (history without file contents, files fetched on demand), atomic, killable, with progress ----
function gitLogged(args, { cwd, log, job }) {
  return new Promise((res, rej) => {
    const p = spawn('git', args, { cwd }); let err = '', last = 0;
    if (job) (procs[job] ||= new Set()).add(p);
    p.stderr.on('data', d => { // git progress uses \r; show the latest line at most every 3s
      const t = String(d); err = (err + t).slice(-4000);
      const line = t.split(/[\r\n]+/).filter(Boolean).pop();
      if (line && Date.now() - last > 3000) { last = Date.now(); log(line.slice(0, 200)); }
    });
    p.on('error', rej);
    p.on('close', c => { procs[job]?.delete(p); aborted.has(job) ? rej(new Error('Stopped by you')) : c ? rej(new Error(err.trim().split(/[\r\n]+/).pop() || `git exited ${c}`)) : res(); });
  });
}
async function ensureBase({ base, url, log, job }) {
  const ok = fs.existsSync(base) && await git(base, 'rev-parse', '--verify', 'HEAD').then(() => true).catch(() => false);
  if (ok) return log('Shared clone already exists, reusing it.');
  // a folder without commits is a broken or half-finished clone: start clean. Clone into .partial and rename, so "exists" always means "complete".
  fs.rmSync(base, { recursive: true, force: true });
  const tmp = base + '.partial'; fs.rmSync(tmp, { recursive: true, force: true });
  log('Cloning without file contents first (shared by all issues of this repo). Big repos take a few minutes…');
  await gitLogged(['clone', '--filter=blob:none', '--no-tags', '--progress', url, tmp], { log, job });
  fs.renameSync(tmp, base);
}
app.on('before-quit', () => { for (const set of Object.values(procs)) for (const p of set) { try { p.kill(); } catch {} } }); // no orphaned git/claude/test processes

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
  const ok = flagged.filter(r => !r.policy.length);
  await Promise.all(ok.map(async r => { r.noPr = (await access(r.fullName)).blocked; })); // flagged, not hidden: you can still read and scan them
  return { ok, hidden: flagged.filter(r => r.policy.length).map(r => r.fullName) };
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
ipcMain.handle('ideas', async (e, { repo, job, rejected = [] }) => {
  aborted.delete(job);
  const step = (i, status, detail = '') => e.sender.send('step', { job, i, status, detail });
  const log = (t) => e.sender.send('log', { job, t: t + '\n' });
  let i = 0;
  try {
    if ((await access(repo)).blocked) throw new Error(prBlockedMsg(repo).replace(' Nothing was started.', '') + ' Ideas are turned off for it.');
    step(i = 0, 'run'); log(`Reading ${repo} metadata and open issues…`);
    const [meta, issues] = await Promise.all([
      gh('repo', 'view', repo, '--json', 'description,primaryLanguage,stargazerCount,url'),
      gh('issue', 'list', '-R', repo, '-L', '40', '--json', 'number,title,labels'),
    ]);
    // PRs maintainers closed without merging: ideas like these are not wanted
    const declined = JSON.parse(await gh('pr', 'list', '-R', repo, '-s', 'closed', '-L', '60', '--json', 'number,title,mergedAt').catch(() => '[]'))
      .filter(p => !p.mergedAt).map(p => ({ title: p.title, reason: `A similar PR (#${p.number} "${p.title}") was closed without being merged.` }));
    step(0, 'done', `${JSON.parse(issues).length} open issues, ${declined.length} declined PRs listed`);
    step(i = 1, 'run'); const dir = path.join(WORK, '_read', repo.replace('/', '__'));
    const okDir = fs.existsSync(dir) && await git(dir, 'rev-parse', '--verify', 'HEAD').then(() => true).catch(() => false);
    if (!okDir) { // atomic: clone to .partial, then rename, so a stopped run never leaves a broken folder behind
      log('Shallow clone for reading…'); fs.mkdirSync(path.dirname(dir), { recursive: true }); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir + '.partial', { recursive: true, force: true });
      await gitLogged(['clone', '--depth', '1', '--no-tags', '--progress', `https://github.com/${repo}.git`, dir + '.partial'], { log, job }); fs.renameSync(dir + '.partial', dir);
    } else { log('Updating existing read-only clone…'); await git(dir, 'pull', '--ff-only').catch(() => {}); }
    step(1, 'done', 'ready');
    step(i = 2, 'run', 'docs + code'); log('Reading README, docs and code (this is the long step)…');
    const out = await claude(DOCS_RULE + `You are a senior engineer and product thinker advising a contributor to ${repo}. After you understand the project deeply, explore the code and find
contributions that would REALLY help its users and maintainers. Be creative and ambitious, think out of the box, not a list of typo fixes and tiny refactors.
Propose 6 ideas with a deliberate MIX: at least 2 ambitious new features or capabilities, 1 developer-experience or tooling improvement, 1 performance or reliability idea,
and others as you see fit (architecture, testing infrastructure, integrations, better defaults, observability). Risk may be low, medium or high; do NOT bias toward safe ones.
Ground every idea in evidence: a gap, limitation, repeated pattern, TODO or recurring open issue that you actually saw in the code or issues (cite paths / issue numbers).
Never invent APIs or files; if unsure say so in "evidence". Skip anything already covered by an open issue unless you would take it much further.
DO NOT propose anything that was already rejected or declined (listed below), or a near-identical variant of it. Maintainers closed those without merging; propose something different.
Reply with ONLY a JSON array (no prose before or after), each item:
{"title":"short imperative title","kind":"feature|performance|dx|architecture|tooling|testing|docs","pitch":"1-2 sentences: what users get and why they would love it","evidence":"what you saw in the code/issues, with paths","change":"the approach: files to touch, the public API sketch, how it fits the architecture","impact":"who benefits and how much","risk":"low|medium|high","effort":"hours|days|weeks","security":false}
Set "security":true for any suspected vulnerability and put NO exploit details: only "report privately via SECURITY.md" in "pitch".

${meta}\nOpen issues: ${issues}\n\nALREADY REJECTED OR DECLINED (do not propose again):\n${[...rejected, ...declined].slice(0, 80).map(x => '- ' + x.title).join('\n') || '(none)'}`, { cwd: dir, read: true, onLog: log, job });
    step(2, 'done', 'analysed');
    let out2 = out; // second line of defence: flag any proposed idea that matches a rejected idea or a declined PR
    try { const list = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)), pool = [...rejected, ...declined];
      for (const x of list.slice()) { const h = G.matchIdea(x.title, pool); if (h?.kind === 'sent') { list.splice(list.indexOf(x), 1); log(`Dropped "${x.title}": already sent to Forge.`); continue; } if (h) { x.rejected = h.reason; x.rejectedKind = h.kind || 'declined'; log(`Rejected automatically: "${x.title}": ${h.reason}`); } } out2 = JSON.stringify(list); } catch {} step(i = 3, 'done', 'ideas ready');
    return out2;
  } catch (err) { step(i, 'fail', err.message.slice(0, 60)); log('FAILED: ' + err.message); throw err; }
});

// ---- prepare a clone: fork, branch off upstream, set the user's identity locally, hide AI tooling files ----
ipcMain.handle('prepare', async (e, { repo, number, idea, user, force, job, ck: saved, auto }) => {
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
        chk(job); // a job stopped while waiting for the lock must not carry on
        step(i = 0, 'run');
        // write access (your own repo or a team repo): no fork needed, push the branch to the repo itself
        const acc = await access(repo); direct = acc.direct;
        if (acc.blocked) throw new Error(prBlockedMsg(repo));
        if (direct) log(`You have write access to ${repo}: skipping the fork, the branch will be pushed to the repo itself.`);
        else { log(`Forking ${repo} to ${user.login}…`); if (!fs.existsSync(base)) await gh('repo', 'fork', repo, '--clone=false'); }
        step(0, 'done', direct ? 'direct push (write access)' : `${user.login}/${repo.split('/')[1]}`);
        chk(job); step(i = 1, 'run');
        await ensureBase({ base, url: direct ? `https://github.com/${repo}.git` : `https://github.com/${user.login}/${repo.split('/')[1]}.git`, log, job });
        // always make sure upstream exists (a half-finished earlier run can leave a clone without it)
        if (!direct) await git(base, 'remote', 'get-url', 'upstream').catch(() => git(base, 'remote', 'add', 'upstream', `https://github.com/${repo}.git`));
        step(1, 'done', base.replace(os.homedir(), '~'));
        chk(job); step(i = 2, 'run');
        const d = (await gh('repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name')).trim();
        const up = direct ? 'origin' : 'upstream';
        log(`Fetching ${up}/${d}…`); await gitLogged(['fetch', '--filter=blob:none', '--no-tags', '--progress', up, d], { cwd: base, log, job });
        if (fs.existsSync(dir)) await git(base, 'worktree', 'remove', '--force', dir).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
        await git(base, 'worktree', 'prune');
        await git(base, 'worktree', 'add', '-B', branch, dir, `${up}/${d}`);
        // noreply address: counts on the profile without needing the `user` token scope; global git config untouched
        await git(base, 'config', 'user.name', user.name || user.login);
        await git(base, 'config', 'user.email', `${user.id}+${user.login}@users.noreply.github.com`);
        const ex = path.join(base, '.git/info/exclude'); if (!fs.readFileSync(ex, 'utf8').includes('CLAUDE.md')) fs.appendFileSync(ex, '\n.claude/\nCLAUDE.md\n');
        return d;
      }, () => log('Another run is already setting up this repo (clone/fetch). Waiting for it to finish…'));
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
If the verdict would be "skip" only because the proposal is TOO BIG (new public API, cross-cutting redesign, needs maintainer design sign-off), also look for a SMALL FIRST SLICE: one focused, self-contained change (no new public API, no redesign, touches a few files, useful on its own, and consistent with what maintainers would welcome). If such a slice exists put it in "slice"; otherwise null. Never offer a slice for: security issues, things already fixed or by design, duplicates, or anything a maintainer declined.
{"verdict":"fix"|"skip"|"unclear","real":true|false,"reason":"one sentence","plan":"files and change you would make, or empty","slice":{"title":"short imperative title","plan":"exactly what the small slice changes, which files"} or null}

TITLE: ${issue.title}\nSTATE: ${issue.state}\nLABELS: ${issue.labels.map(l => l.name).join(', ')}\n\n${issue.body}\n\nTHREAD:\n${thread}`, { cwd: dir, read: true, onLog: log, job });
      let vv; try { vv = G.lastJson(raw); } catch { throw new Error('Could not read the validation answer (not skipped): resume to retry.'); }
      log(`Verdict: ${vv.verdict.toUpperCase()}: ${vv.reason}`); save({ verdict: vv });
    }
    const v = ck.verdict;
    let task = issue; // what actually gets built
    if (v.verdict !== 'fix' && !force) {
      if (v.slice?.title && v.slice?.plan) {
        log(`Too big as proposed (${v.reason}). Narrowing to a small first slice: ${v.slice.title}`);
        task = { ...issue, title: v.slice.title, body: `${v.slice.plan}\n\nBackground, NOT in scope (the larger original proposal): ${issue.title}` };
        step(4, 'done', 'narrowed to a small slice');
      } else {
        // nothing sensible to do here: skip automatically and clean up the folder and branch
        log(`Skipping automatically: ${v.reason}`);
        await withLock(repo, async () => { await git(base, 'worktree', 'remove', '--force', dir).catch(() => {}); await git(base, 'branch', '-D', branch).catch(() => {}); });
        step(4, 'done', 'skipped'); return { dir, branch, def, direct, issue, verdict: v, stopped: true, autoSkipped: true };
      }
    } else step(4, 'done', v.verdict === 'fix' ? 'real & fixable' : v.verdict + ' (forced)');
    chk(job);

    // step 5: the change itself
    if (!ck.fixed) {
      step(i = 5, 'run', ck.fixStarted ? 'continuing…' : 'AI is editing files…'); log(ck.fixStarted ? 'Continuing the change from where it stopped…' : 'AI is editing files (a few minutes)…');
      const resumeNote = ck.fixStarted ? '\n\nNOTE: an earlier attempt was interrupted. Part of the change may already be in the working tree. Read the relevant files, check what is already done, and COMPLETE the work without duplicating edits.' : '';
      save({ fixStarted: true });
      const out = await claude(DOCS_RULE + `${idea ? 'Implement this contribution idea' : 'Fix this GitHub issue'} in the repository in the current directory. Make the smallest correct change, follow the repo's existing style
and any CONTRIBUTING guidance. Edit files only; do not run git. Do not add comments or text mentioning AI tools. A separate step writes the unit tests, so focus on the source change.
${task !== issue ? 'IMPORTANT: this is deliberately a SMALL first slice of a bigger idea. Implement ONLY the slice below, nothing from the larger proposal.\n' : ''}A prior triage found: ${v.reason}\nPlan: ${task !== issue ? v.slice.plan : v.plan}\n\n${idea ? 'Idea' : 'Issue #' + number}: ${task.title}\n\n${task.body}${resumeNote}`, { cwd: dir, edit: true, onLog: log, job });
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
    step(6, tests.length ? 'done' : 'fail', tests.length ? `${tests.length} test file(s)` : 'no tests written'); chk(job);

    // step 7: run the tests (installs dependencies, up to 2 AI repair rounds if they fail)
    if (!ck.testRun) {
      step(i = 7, 'run');
      const tr0 = await verifyTests({ dir, files: tests, job, log, step, idx: 7 });
      save({ testRun: { v: 3, ok: tr0.ok, env: tr0.env, cmd: tr0.cmd, reason: tr0.reason } });
      if (!tr0.ok) log(`Tests did not pass: ${tr0.reason}`);
    }
    const tr = ck.testRun;
    step(7, tr.ok || tr.env ? 'done' : 'fail', tr.ok ? 'passed' : tr.env ? 'skipped here, project CI will run them' : tr.reason); chk(job);

    // step 8: with auto on and everything green, commit and open the PR. Any guard that trips falls back to your review.
    const res = { dir, branch, def, direct, issue: task, verdict: v, tests, testCmd: tr.cmd, testsOk: tr.ok };
    if (ck.prUrl) { step(8, 'done', 'PR opened'); return { ...res, pr: ck.prUrl }; }
    const asDraft = !tr.ok && (tr.env || !tests.length); // tests could not be run (or written) here: open as a draft and let the project's CI check it
    if (auto && (tr.ok || asDraft)) {
      step(i = 8, 'run', asDraft ? 'opening draft PR…' : 'opening PR…'); log(asDraft ? `Tests could not be run here (${tr.reason}). Opening a DRAFT PR so the project's CI checks it.` : 'Tests passed: drafting the description and opening the PR…');
      try {
        const dr = await makeDraft({ dir, number, issue: task, tests, testCmd: tr.cmd, job });
        const url = await shipPr({ repo, dir, branch, def, direct, title: dr.title, body: dr.body, user, draft: asDraft });
        save({ prUrl: url }); log('PR opened: ' + url); step(8, 'done', asDraft ? 'draft PR opened' : 'PR opened');
        return { ...res, pr: url, draft: asDraft };
      } catch (err) {
        if (/Stopped by you/.test(err.message)) throw err;
        log('Auto-open blocked: ' + err.message); step(8, 'run', 'your review'); return { ...res, autoBlocked: err.message };
      }
    }
    step(i = 8, 'run', 'your review');
    return { ...res, autoBlocked: !auto ? null : tr.ok ? 'the change has no test files' : `tests did not pass (${tr.reason})` };
  } catch (err) { step(i, 'fail', err.message.slice(0, 60)); log((/Stopped by you/.test(err.message) ? 'STOPPED: ' : 'FAILED: ') + err.message); throw err; }
});

ipcMain.handle('diff', async (e, dir) => { await git(dir, 'add', '-N', '.'); return git(dir, 'diff'); });
ipcMain.handle('test', (e, { dir, cmd }) => new Promise(res => execFile('bash', ['-c', cmd], { cwd: dir, timeout: 600000, maxBuffer: 50e6 },
  (err, out, se) => res(`${err ? 'FAILED' : 'PASSED'}\n${(out + se).slice(-4000)}`))));

// ---- draft title + body from the diff and the repo's PR template; the user edits it before shipping ----
async function makeDraft({ dir, number, issue, tests = [], testCmd, job }) {
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

${issue ? `CONTEXT (${number ? 'issue #' + number : 'idea'}): ${issue.title}\n${String(issue.body || '').slice(0, 4000)}\n\n` : ''}DIFF:\n${(await git(dir, 'diff')).slice(0, 40000)}`, { cwd: dir, read: true, job });
  const pt = G.pickTitle(out.trim().split('\n')); if (!pt) throw new Error('The AI did not return a usable PR title. Run it again.'); return { title: pt.title, body: pt.rest.join('\n').trim() };
}
ipcMain.handle('draft', (e, a) => makeDraft(a));


// ---- ship: guards, then plain git + gh. No model is involved in commit/push/PR, so nothing can add a trailer ----
const topicalOf = (repo, dir) => { let rd = ''; try { rd = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => /^readme/i.test(f)) || '-'), 'utf8').slice(0, 4000); } catch {} return G.aboutAi(repo, rd); };
const authorOf = (dir) => git(dir, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>');
// write access? and does the repo accept PRs from non-collaborators? (anthropics/claude-code: collaborators_only)
async function access(repo) {
  const j = JSON.parse(await gh('api', `repos/${repo}`).catch(() => '{}'));
  const direct = !!j.permissions?.push, blocked = G.prBlocked(j) || (!direct && !!j.archived);
  return { direct, blocked, why: j.archived ? `${repo} is archived (read-only).` : prBlockedMsg(repo) };
}
ipcMain.handle('access', (e, repo) => access(repo));
ipcMain.handle('rejectKind', (e, reason) => G.rejectKind(reason));
const prBlockedMsg = (repo) => `${repo} only accepts pull requests from collaborators (its "pull request creation" setting), so GitHub rejects PRs from your account. Nothing was started. Skip this repo or ask the maintainers for access.`;
async function shipPr({ repo, dir, branch, def, direct, title, body, user, draft }) {
  const prs = readJson('prs.json', {}), cap = readJson('settings.json', {}).prCap ?? 3;
  const times = [].concat(prs[repo] || []); // older files stored a single timestamp
  if (!G.rateOk(times, cap)) throw new Error(`Rate cap: ${times.filter(t => Date.now() - t < 864e5).length} PR(s) already opened to ${repo} in the last 24h (limit ${cap}; change it in Forge).`);
  if ((await access(repo)).blocked) throw new Error(prBlockedMsg(repo));
  await git(dir, 'add', '-A');
  const names = await git(dir, 'diff', '--cached', '--name-only');
  if (!names.trim()) throw new Error('Nothing staged: the AI made no changes.');
  const top = topicalOf(repo, dir), hit = G.findTraceT(top, title, body, names, G.addedLines(await git(dir, 'diff', '--cached')));
  if (hit) throw new Error(`Blocked, AI/co-author trace found: "${hit}"`);
  const lead = (body.split(/\n\s*\n/).find(p => p.trim() && !/^#/.test(p.trim())) || '').trim(); // first prose paragraph, not a heading
  await git(dir, 'commit', '-m', title, ...(lead ? ['-m', lead] : []));
  const hit2 = G.findTraceT(top, await git(dir, 'log', '-1', '--format=%B')) || G.findTrace(await authorOf(dir)); if (hit2) { await git(dir, 'reset', '--soft', 'HEAD~1'); throw new Error(`Blocked after commit (undone): "${hit2}"`); }
  await git(dir, 'push', '-u', 'origin', branch, '--force-with-lease');
  const url = (await gh('pr', 'create', '-R', repo, '--head', direct ? branch : `${user.login}:${branch}`, '--base', def, '--title', title, '--body', body, ...(draft ? ['--draft'] : []))).trim();
  prs[repo] = [...times.filter(t => Date.now() - t < 864e5), Date.now()]; writeJson('prs.json', prs);
  return url;
}
ipcMain.handle('ship', (e, a) => shipPr(a));


// ---- running tests: detect the runner, install deps, run the changed tests, let the AI repair real failures (max 2x) ----
function sh(cmd, cwd, log, job, timeout) {
  return new Promise((res) => {
    const p = spawn('bash', ['-c', cmd], { cwd }); let out = '';
    if (job) (procs[job] ||= new Set()).add(p);
    const t = setTimeout(() => p.kill(), timeout);
    const feed = (d) => { const x = String(d); out = (out + x).slice(-60000); x.split('\n').filter(l => l.trim()).forEach(l => log(l.slice(0, 300))); };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('close', (code) => { clearTimeout(t); procs[job]?.delete(p); res({ code: aborted.has(job) ? 130 : code, out }); });
    p.on('error', (e) => { clearTimeout(t); res({ code: 127, out: String(e) }); });
  });
}
function detectTests(dir, files) {
  const has = (f) => fs.existsSync(path.join(dir, f)), q = (a) => a.map(f => `'${f.replace(/'/g, "'\\''")}'`).join(' ');
  if (has('composer.json')) return { install: has('vendor/autoload.php') ? '' : 'composer install --no-interaction --prefer-dist --no-progress',
    cmd: ['pest', 'phpunit', 'simple-phpunit'].map((b, n) => `${n ? 'elif' : 'if'} [ -x vendor/bin/${b} ]; then vendor/bin/${b} ${q(files)}`).join('; ') + '; else echo "no PHP test runner in vendor/bin" >&2; exit 127; fi' };
  if (has('package.json')) {
    let pj = {}; try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
    const deps = { ...pj.dependencies, ...pj.devDependencies }, pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    return { install: has('node_modules') ? '' : pm === 'npm' ? 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund' : `${pm} install`,
      cmd: deps.vitest ? `npx vitest run ${q(files)}` : deps.jest ? `npx jest ${q(files)}` : pj.scripts?.test ? 'npm test' : null };
  }
  if (['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'requirements.txt'].some(has)) return { install: '', cmd: `python3 -m pytest -q ${q(files)}` };
  // plain unittest suites (often in a sub-folder like scripts/tests): run each test file from the folder above its tests/ dir
  const py = files.filter(f => /\.py$/.test(f)); if (py.length) return { install: '', cmd: py.map(f => `(cd ${q([path.dirname(path.dirname(f))])} && python3 -m unittest discover -s tests -p ${q([path.basename(f)])})`).join(' && ') };
  return null;
}
const TEST_RE = /(^|\/)(tests?|spec|__tests__)\/|[._-](test|spec)\.|Test\.(php|java|cs)$/i;
const RUNNABLE = (f) => TEST_RE.test(f) && (!/\.php$/i.test(f) || /Test\.php$/.test(f)); // PHPUnit only runs *Test.php; scripts and helpers under tests/ are not tests
async function verifyTests({ dir, files, job, log, step, idx }) {
  if (!files.length) return { ok: false, reason: 'no test files were written' };
  files = [...new Set(files)].filter(RUNNABLE);
  if (!files.length) return { ok: false, env: true, reason: 'no runnable test files in the change (the project CI will check it)' };
  const d = detectTests(dir, files);
  if (!d || !d.cmd) return { ok: false, env: true, reason: 'no test runner detected for this repo' };
  if (d.install) {
    step(idx, 'run', 'installing dependencies…'); log('$ ' + d.install);
    const r = await sh(d.install, dir, log, job, 20 * 60e3); chk(job);
    if (r.code) return { ok: false, env: true, cmd: d.cmd, reason: 'dependency install failed on this machine' };
  }
  for (let n = 0; ; n++) {
    step(idx, 'run', n ? `re-running (${n}/2)…` : 'running tests…'); log('$ ' + d.cmd);
    const r = await sh(d.cmd, dir, log, job, 15 * 60e3); chk(job);
    if (!r.code) return { ok: true, cmd: d.cmd };
    const envErr = /command not found|vendor\/bin\/\S+: No such file|no PHP test runner|is missing from your system|Cannot find module|No module named|Failed opening required|ext-\S+ .*missing/i.test(r.out);
    if (envErr) return { ok: false, env: true, cmd: d.cmd, reason: 'environment problem running the tests (missing tool or extension)' };
    if (n >= 2) return { ok: false, cmd: d.cmd, reason: 'tests still fail after 2 repair attempts' };
    step(idx, 'run', `fixing failures (${n + 1}/2)…`); log('Tests failed, asking for a fix…');
    await claude(`Unit tests for a change in the repository in the current directory FAIL. Output (tail):\n${r.out.slice(-10000)}
Work out whether the TEST or the SOURCE change is wrong and fix the real cause. Never delete, skip, or weaken tests or assertions just to make them pass. Edit files only; do not run git. No text mentioning AI tools. End with one line saying what you fixed.`, { cwd: dir, edit: true, onLog: log, job });
    chk(job);
    await git(dir, 'add', '-N', '.');
    const names = (await git(dir, 'diff', '--name-only')).split('\n').filter(f => TEST_RE.test(f)); if (names.length) files = names;
  }
}

// ---- replies on my PRs: comments, reviews, inline comments, CI checks ----
const isBot = G.isBot;
async function collectReplies(repo, number, login) {
  const pr = JSON.parse(await gh('pr', 'view', String(number), '-R', repo, '--json', 'comments,reviews,state'));
  const inline = JSON.parse(await gh('api', `repos/${repo}/pulls/${number}/comments?per_page=50`).catch(() => '[]'));
  const all = [
    ...pr.comments.map(c => ({ who: c.author?.login, body: c.body, at: c.createdAt, kind: 'comment' })),
    ...pr.reviews.map(r => ({ who: r.author?.login, body: r.body, at: r.submittedAt, kind: 'review ' + String(r.state).toLowerCase().replace('_', ' ') })),
    ...inline.map(c => ({ who: c.user?.login, body: c.body, at: c.created_at, kind: 'inline', path: c.path })),
  ].filter(x => x.who && (x.body || '').trim() || x.kind?.startsWith('review '));
  const mine = all.filter(x => x.who === login).map(x => +new Date(x.at)).sort((a, b) => b - a)[0] || 0;
  const others = all.filter(x => x.who !== login).map(x => ({ ...x, bot: isBot(x.who) })).sort((a, b) => new Date(b.at) - new Date(a.at));
  return { replies: others, needs: others.some(x => !x.bot && +new Date(x.at) > mine) };
}
ipcMain.handle('prs', async (e, { repo, login }) => {
  const list = JSON.parse(await gh('pr', 'list', '-R', repo, '--author', login, '--state', 'all', '-L', '20', '--json',
    'number,title,url,state,isDraft,mergedAt,closedAt,updatedAt,reviewDecision,statusCheckRollup,headRefName,isCrossRepository'));
  return Promise.all(list.map(async pr => {
    const k = { pass: 0, fail: 0, pend: 0 };
    for (const c of pr.statusCheckRollup || []) {
      const v = String(c.conclusion || c.state || '').toUpperCase(), done = !c.status || c.status === 'COMPLETED';
      if (!done || v === 'PENDING' || v === '') k.pend++; else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) k.pass++; else k.fail++;
    }
    const r = pr.state === 'OPEN' ? await collectReplies(repo, pr.number, login).catch(() => ({ replies: [], needs: false })) : { replies: [], needs: false };
    return { number: pr.number, title: pr.title, url: pr.url, state: pr.mergedAt ? 'MERGED' : pr.state, draft: pr.isDraft, updatedAt: pr.updatedAt,
      review: pr.reviewDecision, checks: k, branch: pr.headRefName, cross: pr.isCrossRepository, replies: r.replies.slice(0, 15), needs: r.needs };
  }));
});

// ---- address feedback on an open PR: same branch, apply changes, run tests, you review and push ----
ipcMain.handle('feedback', async (e, { repo, number, user, job, ck: saved, auto }) => {
  const step = (i, status, detail = '') => e.sender.send('step', { job, i, status, detail });
  const log = (t) => e.sender.send('log', { job, t: t + '\n' });
  const ck = saved || {}, save = (p) => { Object.assign(ck, p); e.sender.send('ckpt', { job, ck }); };
  aborted.delete(job); let i = 0;
  try {
    if (!ck.fb) {
      step(i = 0, 'run'); log(`Reading the PR #${number} conversation and checks…`);
      const pr = JSON.parse(await gh('pr', 'view', String(number), '-R', repo, '--json', 'title,body,headRefName,isCrossRepository,statusCheckRollup'));
      const { replies } = await collectReplies(repo, number, user.login);
      const human = replies.filter(r => !r.bot).slice(0, 20);
      const bad = (pr.statusCheckRollup || []).filter(c => ['FAILURE', 'TIMED_OUT', 'CANCELLED'].includes(String(c.conclusion).toUpperCase()) || String(c.state).toUpperCase() === 'FAILURE');
      const failing = bad.map(c => c.name || c.context);
      // the actual failure output of the failing CI runs (not just their names)
      const runIds = [...new Set(bad.map(c => (String(c.detailsUrl || '').match(/\/actions\/runs\/(\d+)/) || [])[1]).filter(Boolean))].slice(0, 3);
      let ci = ''; for (const id of runIds) { log(`Fetching the failure log of CI run ${id}…`); ci += `\n--- failed CI run ${id} ---\n` + (await gh('run', 'view', id, '-R', repo, '--log-failed').catch(() => '')).slice(-5000); }
      const text = human.map(r => `@${r.who} (${r.kind}${r.path ? ', ' + r.path : ''}): ${String(r.body).slice(0, 1500)}`).join('\n---\n');
      log(`${human.length} human comment(s), ${failing.length} failing check(s).`);
      const cla = replies.some(x => x.bot && /\bCLA\b|contributor license agreement/i.test(x.body)); // a legal step only you can take
      if (cla) log('A bot is asking for a Contributor License Agreement. Agreeing is a legal step, so it is flagged for you and never done automatically.');
      save({ cla, fb: { title: pr.title, branch: pr.headRefName, cross: pr.isCrossRepository, text, failing, ci } });
    }
    const fb = ck.fb; step(0, 'done', `${fb.text ? 'feedback read' : 'no comments'}${fb.failing.length ? ', ' + fb.failing.length + ' failing' : ''}`); chk(job);

    const base = dirOf(repo), dir = `${base}--${fb.branch}`;
    if (!ck.prepared || !fs.existsSync(dir)) {
      step(i = 1, 'run'); log(`Getting branch ${fb.branch}…`);
      await withLock(repo, async () => {
        await ensureBase({ base, url: fb.cross ? `https://github.com/${user.login}/${repo.split('/')[1]}.git` : `https://github.com/${repo}.git`, log, job });
        await gitLogged(['fetch', '--filter=blob:none', '--no-tags', '--progress', 'origin', fb.branch], { cwd: base, log, job });
        if (fs.existsSync(dir)) await git(dir, 'reset', '--hard', `origin/${fb.branch}`);
        else { await git(base, 'worktree', 'prune'); await git(base, 'worktree', 'add', '-B', fb.branch, dir, `origin/${fb.branch}`); }
        await git(base, 'config', 'user.name', user.name || user.login);
        await git(base, 'config', 'user.email', `${user.id}+${user.login}@users.noreply.github.com`);
      });
      save({ prepared: true });
    } else log('Resuming: the branch folder is still there.');
    step(1, 'done', fb.branch); chk(job);

    if (!ck.applied) {
      step(i = 2, 'run', 'AI is addressing it…'); log('Applying the feedback…');
      const out = await claude(DOCS_RULE + `This is an open pull request ("${fb.title}") on ${repo}; its branch is checked out in the current directory. Maintainers and/or CI gave feedback. Address it:
- Make the requested changes with minimal, focused edits that follow the repo's style. Update or add tests when behaviour changes.
- If a comment is only a question or you disagree with it, do NOT change code for it; explain in the reply instead.
- If a CI check failed (${fb.failing.join(', ') || 'none'}), find the cause in the code and fix it.
- Edit files only; do not run git. No text mentioning AI tools.
${ck.appliedStarted ? 'An earlier attempt was interrupted; some edits may exist already. Check and complete without duplicating.\n' : ''}
End with the marker line "REPLY:" followed by a short first-person comment to post on the PR (what you changed, answers to questions, anything you left as is and why). No emojis.

FEEDBACK:\n${fb.text || '(no human comments; focus on the failing checks)'}\n\nFAILED CI OUTPUT (tail):${fb.ci || ' (not available)'}`, { cwd: dir, edit: true, onLog: log, job });
      const k = out.lastIndexOf('REPLY:');
      save({ applied: true, reply: (k >= 0 ? out.slice(k + 6) : '').trim() });
    }
    step(2, 'done', 'changes applied'); chk(job);

    if (!ck.testRun) {
      step(i = 3, 'run');
      await git(dir, 'add', '-N', '.');
      const names = (await git(dir, 'diff', '--name-only')).split('\n').filter(f => TEST_RE.test(f));
      const prFiles = (await gh('pr', 'diff', String(number), '-R', repo, '--name-only').catch(() => '')).split('\n').filter(f => TEST_RE.test(f));
      const tr = await verifyTests({ dir, files: [...names, ...prFiles], job, log, step, idx: 3 });
      save({ testRun: { v: 3, ok: tr.ok, env: tr.env, cmd: tr.cmd, reason: tr.reason } });
    }
    const tr = ck.testRun; step(3, tr.ok || tr.env ? 'done' : 'fail', tr.ok ? 'passed' : tr.env ? 'skipped here, project CI will run them' : tr.reason); chk(job);
    const res = { dir, branch: fb.branch, direct: !fb.cross, reply: ck.reply, testCmd: tr.cmd, testsOk: tr.ok, issue: { title: fb.title, body: fb.text }, followup: true };
    if (ck.pushed) { step(4, 'done', 'update pushed'); return { ...res, pushed: true, noPush: !!ck.noPush, cla: !!ck.cla }; }
    const changed = (await git(dir, 'status', '--porcelain')).trim();
    // auto: push the update (and post the reply) when the tests passed, or could not run here and CI will check. Pure replies with no code change stay for your review.
    if (auto && !changed) { // nothing to push: answer the humans (if any) with the drafted reply, never reply to bots
      step(i = 4, 'run', 'posting reply…'); const reply = fb.text.trim() ? (ck.reply || '').trim() : '';
      const hit = reply && G.findTraceT(topicalOf(repo, dir), reply);
      if (hit) { log('Reply held back (trace check): ' + hit); step(4, 'run', 'your review'); return { ...res, autoBlocked: 'the drafted reply tripped the no-AI-trace check: edit it and post it yourself' }; }
      if (reply) { await gh('pr', 'comment', String(number), '-R', repo, '--body', reply); log('Reply posted on the PR.'); }
      else log('Nothing to answer (the feedback came from bots / CI only).');
      save({ pushed: true, noPush: true }); step(4, 'done', reply ? 'reply posted' : 'nothing to answer');
      return { ...res, pushed: true, noPush: true, replied: !!reply, cla: !!ck.cla };
    }
    if (auto && changed && (tr.ok || tr.env)) {
      step(i = 4, 'run', 'pushing update…'); log(tr.ok ? 'Tests passed: committing and pushing the update…' : `Tests could not run here (${tr.reason}): pushing so CI checks it…`);
      try {
        await pushUpdate({ repo, number, dir, branch: fb.branch, message: 'Address review feedback', reply: fb.text.trim() ? ck.reply : '' });
        save({ pushed: true }); log('Update pushed to ' + fb.branch + (ck.reply ? ' and the reply was posted.' : '.')); step(4, 'done', 'update pushed');
        return { ...res, pushed: true };
      } catch (err) {
        if (/Stopped by you/.test(err.message)) throw err;
        log('Auto-push blocked: ' + err.message); step(4, 'run', 'your review'); return { ...res, autoBlocked: err.message };
      }
    }
    step(i = 4, 'run', 'your review');
    return { ...res, autoBlocked: !auto ? null : !changed ? 'the feedback needed no code change, so nothing to push: review the reply and post it yourself' : `tests did not pass (${tr.reason})` };
  } catch (err) { step(i, 'fail', err.message.slice(0, 60)); log((/Stopped by you/.test(err.message) ? 'STOPPED: ' : 'FAILED: ') + err.message); throw err; }
});
async function pushUpdate({ repo, number, dir, branch, message, reply }) {
  await git(dir, 'add', '-A');
  const names = await git(dir, 'diff', '--cached', '--name-only');
  if (!names.trim()) throw new Error('Nothing staged: there are no changes to push.');
  const top = topicalOf(repo, dir), hit = G.findTraceT(top, message, reply, names, G.addedLines(await git(dir, 'diff', '--cached')));
  if (hit) throw new Error(`Blocked, AI/co-author trace found: "${hit}"`);
  await git(dir, 'commit', '-m', message);
  const hit2 = G.findTraceT(top, await git(dir, 'log', '-1', '--format=%B')) || G.findTrace(await authorOf(dir)); if (hit2) { await git(dir, 'reset', '--soft', 'HEAD~1'); throw new Error(`Blocked after commit (undone): "${hit2}"`); }
  await git(dir, 'push', 'origin', branch);
  if ((reply || '').trim()) await gh('pr', 'comment', String(number), '-R', repo, '--body', reply);
  return true;
}
ipcMain.handle('push', (e, a) => pushUpdate(a));

// ---- CI watch: wait for the PR's GitHub checks; green = done, flaky = re-run, real failure = fix, push and wait again ----
const sleepJob = async (job, ms) => { for (let t = 0; t < ms; t += 4000) { chk(job); await new Promise(r => setTimeout(r, Math.min(4000, ms - t))); } chk(job); };
const FLAKY = /Bus error|Segmentation fault|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|rate limit|Could not resolve host|Temporary failure|502 Bad Gateway|503 Service|runner has received a shutdown|lost communication with the server|No space left on device|The operation was canceled|Connection reset by peer|TLS handshake timeout|failed to download|Unable to download/i;
function tally(cs) {
  const k = { pass: 0, fail: 0, pend: 0, bad: [] };
  for (const c of cs) {
    const v = String(c.conclusion || c.state || '').toUpperCase(), done = !c.status || c.status === 'COMPLETED';
    if (!done || v === 'PENDING' || v === '') k.pend++;
    else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) k.pass++;
    else { k.fail++; k.bad.push(c); }
  }
  return k;
}
async function waitChecks({ repo, number, job, log, step, idx, expectSha }) {
  const t0 = Date.now(); let last = '';
  for (;;) {
    chk(job);
    const pr = JSON.parse(await gh('pr', 'view', String(number), '-R', repo, '--json', 'headRefOid,statusCheckRollup,state'));
    if (pr.state === 'MERGED') return { state: 'pass' };
    if (pr.state === 'CLOSED') return { state: 'closed' };
    // a pending CLA check waits for YOU (a legal agreement), so it never blocks the run: flag it instead
    const all = pr.statusCheckRollup || [], isCla = c => /\bcla\b/i.test(c.name || c.context || ''), cs = all.filter(c => !isCla(c)), k = tally(cs);
    const cla = all.some(c => isCla(c) && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(c.conclusion || c.state).toUpperCase()));
    if (expectSha && pr.headRefOid !== expectSha) { /* the push is not visible on GitHub yet */ }
    else if (!cs.length) { if (Date.now() - t0 > (cla ? 20e3 : 4 * 60e3)) return { state: 'none', cla }; }
    else if (!k.pend) return k.fail ? { state: 'fail', bad: k.bad, k, sha: pr.headRefOid } : { state: 'pass', k, cla };
    const m = cs.length ? `${k.pass} passed, ${k.fail} failed, ${k.pend} running` : 'waiting for checks to start…';
    if (m !== last) { last = m; log('CI: ' + m); step(idx, 'run', m); }
    if (Date.now() - t0 > 120 * 60e3) return { state: 'timeout' };
    await sleepJob(job, 40000);
  }
}
async function ciLogs(repo, bad) {
  const ids = [...new Set(bad.map(c => (String(c.detailsUrl || '').match(/\/actions\/runs\/(\d+)/) || [])[1]).filter(Boolean))].slice(0, 4);
  let text = ''; for (const id of ids) text += `\n--- failed CI run ${id} ---\n` + (await gh('run', 'view', id, '-R', repo, '--log-failed').catch(() => '')).slice(-5000);
  return { ids, text };
}
ipcMain.handle('ci', async (e, { repo, number, job, ck: saved, cur, idx, draft }) => {
  const step = (i, status, detail = '') => e.sender.send('step', { job, i, status, detail });
  const log = (t) => e.sender.send('log', { job, t: t + '\n' });
  const ck = saved || {}, save = (p) => { Object.assign(ck, p); e.sender.send('ckpt', { job, ck }); };
  const ci = ck.ci || { round: 0, reruns: 0 }; aborted.delete(job);
  try {
    let expectSha = null;
    for (;;) {
      step(idx, 'run', 'waiting for checks…'); log(`Waiting for the GitHub checks of PR #${number}…`);
      const w = await waitChecks({ repo, number, job, log, step, idx, expectSha }); chk(job);
      if (w.state === 'pass' || w.state === 'none') {
        if (w.state === 'none') log('No CI checks are configured for this PR.'); else log('All checks passed.');
        if (draft) { await gh('pr', 'ready', String(number), '-R', repo).then(() => log('The PR was a draft: marked it ready for review.')).catch(err => log('Could not mark it ready: ' + err.message)); }
        step(idx, 'done', w.state === 'none' ? 'no CI configured' : 'all checks passed'); if (w.cla) { log('The CLA check is waiting for you to agree to the Contributor License Agreement (a legal step, not done automatically).'); save({ cla: true }); } return { green: true, cla: !!w.cla };
      }
      if (w.state !== 'fail') { step(idx, 'fail', w.state === 'closed' ? 'PR was closed' : 'timed out waiting'); return { green: false, reason: w.state === 'closed' ? 'the PR was closed' : 'the checks did not finish in 2 hours' }; }
      const failing = w.bad.map(c => c.name || c.context); log(`${failing.length} failing: ${failing.slice(0, 6).join(', ')}${failing.length > 6 ? '…' : ''}`);
      const { ids, text } = await ciLogs(repo, w.bad);
      const onlyCancelled = w.bad.every(c => String(c.conclusion).toUpperCase() === 'CANCELLED');
      // flaky infrastructure: re-run the failed jobs instead of changing code (max 2x)
      if ((onlyCancelled || FLAKY.test(text)) && ci.reruns < 2 && ids.length) {
        ci.reruns++; save({ ci }); log(`Looks like an infrastructure/flaky failure: re-running the failed jobs (${ci.reruns}/2)…`);
        for (const id of ids) await gh('run', 'rerun', id, '-R', repo, '--failed').catch(err => log('rerun: ' + err.message));
        expectSha = null; await sleepJob(job, 30000); continue;
      }
      if (ci.round >= 3) { step(idx, 'fail', 'still failing after 3 fix rounds'); return { green: false, reason: `still failing after 3 fix rounds: ${failing.slice(0, 4).join(', ')}` }; }
      ci.round++; save({ ci }); step(idx, 'run', `fixing CI (round ${ci.round}/3)…`); log(`Fixing the failing checks (round ${ci.round}/3)…`);
      const dir = cur.dir;
      const out = await claude(`A pull request's CI checks FAILED. Its branch is checked out in the current directory. Failing checks: ${failing.join(', ')}.
Read the failure output, find the REAL cause in the code (static analysis such as PHPStan/ESLint types, coding-style, a failing test, a version-specific API difference like an older PHP/Node version, etc.) and fix it with a minimal, focused edit that matches the repo's style.
Never disable or weaken a check, skip or delete a test, or add ignore rules just to turn it green. Edit files only; do not run git. No text mentioning AI tools.
If the failure is clearly unrelated to this PR's changes (broken on the base branch too), change nothing and say so.
End with the marker line "COMMIT:" followed by a one-line commit message describing the fix.

FAILED CI OUTPUT (tail):${text || ' (not available)'}`, { cwd: dir, edit: true, onLog: log, job });
      chk(job);
      await git(dir, 'add', '-N', '.');
      if (!(await git(dir, 'status', '--porcelain')).trim()) { step(idx, 'fail', 'no fix found'); return { green: false, reason: 'the AI found no code change that fixes the failing checks (they may be unrelated to this PR)' }; }
      const tfiles = (await git(dir, 'diff', '--name-only', 'HEAD')).split('\n').filter(f => TEST_RE.test(f)).concat(cur.tests || []);
      const tr = await verifyTests({ dir, files: [...new Set(tfiles)], job, log, step, idx });
      if (!tr.ok && !tr.env && tfiles.length) { step(idx, 'fail', 'fix did not pass local tests'); return { green: false, reason: `my fix did not pass the local tests (${tr.reason})` }; }
      const k = out.lastIndexOf('COMMIT:'), msg = ((k >= 0 ? out.slice(k + 7) : '').trim().split('\n')[0] || 'Fix CI failures').slice(0, 100);
      step(idx, 'run', 'pushing the fix…'); log(`Committing and pushing: ${msg}`);
      await pushUpdate({ repo, number, dir, branch: cur.branch, message: msg, reply: '' });
      expectSha = (await git(dir, 'rev-parse', 'HEAD')).trim(); save({ ci });
      await sleepJob(job, 20000);
    }
  } catch (err) { step(idx, 'fail', err.message.slice(0, 60)); log((/Stopped by you/.test(err.message) ? 'STOPPED: ' : 'FAILED: ') + err.message); throw err; }
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
