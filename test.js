const assert = require('assert'); const g = require('./guard');
assert(g.findTrace('fix bug', 'Co-Authored-By: Claude <x>'));
assert(g.findTrace('🤖 Generated with Claude Code'));
assert.strictEqual(g.findTrace('fix null check', 'Fixes #12'), null);
assert.strictEqual(g.addedLines('+++ b/a\n+hi\n-claude\n ctx'), '+hi');
assert.deepStrictEqual(g.hasPolicy({ 'CONTRIBUTING.md': 'No AI-generated PRs', 'SECURITY.md': 'email us' }), ['CONTRIBUTING.md']);
const now = Date.now();
assert(!g.rateOk([now - 1000], 1)); assert(g.rateOk([now - 1000], 3)); assert(g.rateOk([now - 9e7], 1)); assert(g.rateOk(undefined, 1)); assert(g.rateOk([now, now, now, now], 0));
assert(!g.rateOk([now - 1, now - 2, now - 3], 3));
console.log('ok');

// topical repos: subject-matter mentions pass, authorship markers still blocked
assert(g.aboutAi('x/mod', 'pins Claude Code in CI') && !g.aboutAi('laravel/framework', 'PHP framework'));
assert.strictEqual(g.findTraceT(true, 'Make mod CI pin Claude Code and fail instead of skipping tests'), null);
assert(g.findTraceT(true, 'fix', 'Co-Authored-By: Claude <noreply@anthropic.com>'));
assert(g.findTraceT(true, '🤖 Generated with Claude Code'));
assert(g.findTraceT(false, 'Make mod CI pin Claude Code'));
console.log('ok topical');

assert.strictEqual(g.lastJson('analysis {x}\n{"verdict":"skip","slice":{"title":"a","plan":"b"}}').slice.title, 'a');
assert(g.prBlocked({ permissions: { push: false }, pull_request_creation_policy: 'collaborators_only' }));
assert(!g.prBlocked({ permissions: { push: true }, pull_request_creation_policy: 'collaborators_only' }) && !g.prBlocked({ pull_request_creation_policy: 'all' }));
console.log('ok access');

const pool = [{ title: 'Add a transactional outbox so jobs dispatched inside a transaction are never lost', reason: 'declined' }];
assert(g.matchIdea('Transactional outbox so jobs dispatched in a transaction are never lost', pool));
assert(!g.matchIdea('Add query duplicate detection to the profiler', pool) && !g.matchIdea('x', []));
console.log('ok match');

assert.strictEqual(g.rejectKind('Taylor closed the near-identical PR #59553, citing framework scope'), 'declined');
assert.strictEqual(g.rejectKind('needs a new public API and maintainer design sign-off'), 'toobig');
assert.strictEqual(g.rejectKind('A similar PR (#1 "x") was closed without being merged.'), 'declined');
console.log('ok kind');

['microsoft-github-policy-service', 'copilot-pull-request-reviewer', 'github-actions', 'codecov-commenter', 'dependabot[bot]'].forEach(n => assert(g.isBot(n), n));
['taylorotwell', 'afourney', 'Seldaek', 'TheGeekyM'].forEach(n => assert(!g.isBot(n), n));
console.log('ok bots');

assert(g.isBot('meta-cla'));
assert.deepStrictEqual(g.pickTitle(["I've read the helper. Here's the PR description.", '', 'Add contract tests', '', 'body']).title, 'Add contract tests');
assert.strictEqual(g.pickTitle(['Only chatter here.']), null);
console.log('ok title');

assert.deepStrictEqual(g.replyThreads([{ kind: 'inline', id: 5, root: 3 }, { kind: 'inline', id: 6, root: 3 }]), [3]);
assert.deepStrictEqual(g.replyThreads([{ kind: 'inline', id: 5 }, { kind: 'comment' }]), []);
assert.deepStrictEqual(g.replyThreads([{ kind: 'inline', id: 5, bot: true }]), []);
console.log('ok threads');

assert(g.promises("The snapshot itself gets added to the PR from a real run"));
assert(g.promises("I'll regenerate it"));
assert.strictEqual(g.promises('I removed the skip guards and added the fixture.'), null);
console.log('ok promises');
