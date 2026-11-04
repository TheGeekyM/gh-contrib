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
