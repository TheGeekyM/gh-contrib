const assert = require('assert'); const g = require('./guard');
assert(g.findTrace('fix bug', 'Co-Authored-By: Claude <x>'));
assert(g.findTrace('🤖 Generated with Claude Code'));
assert.strictEqual(g.findTrace('fix null check', 'Fixes #12'), null);
assert.strictEqual(g.addedLines('+++ b/a\n+hi\n-claude\n ctx'), '+hi');
assert.deepStrictEqual(g.hasPolicy({ 'CONTRIBUTING.md': 'No AI-generated PRs', 'SECURITY.md': 'email us' }), ['CONTRIBUTING.md']);
assert(!g.rateOk(Date.now() - 1000)); assert(g.rateOk(Date.now() - 9e7)); assert(g.rateOk(undefined));
console.log('ok');
