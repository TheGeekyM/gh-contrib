# gh-contrib

A desktop app (Electron) for contributing to popular open-source repos, with you in the loop.

- **Find repos**: popular projects by language and stars. Repos whose docs mention AI are hidden.
- **Scan**: open `good first issue` / `help wanted` issues with no assignee and no open PR, plus AI-generated feature ideas grounded in the code.
- **Forge**: parallel runs. Each run forks (or pushes directly if you have write access), branches, validates the issue, makes the change, writes unit tests, and leaves the diff for you.
- **You ship**: review the diff, run the tests, edit the PR text, then click open PR. Commits and PRs are made with plain `git` and `gh` as you; nothing is pushed automatically, and there is a one-PR-per-repo-per-24h cap.
- Security findings are never filed publicly; the app opens the repo's private advisory page.
- Scans, ideas and Forge runs are saved between launches. Runs can be stopped and resumed from the step they reached.

## Requirements
- [`gh`](https://cli.github.com) logged in (`gh auth login`)
- [`claude`](https://claude.com/claude-code) CLI logged in (the AI brain)
- Node 20+, git

## Run
```
npm install
npm start
```
If `gh` returns HTTP 401 inside the app on Linux, launch with your session bus so it can read the keyring: `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus npm start`.

Clones and worktrees live in `~/contrib`. `npm test` runs the guard checks.

Many projects restrict or require disclosure of AI-assisted contributions. Read each repo's CONTRIBUTING and AI policy, and review every change yourself before opening a PR.
