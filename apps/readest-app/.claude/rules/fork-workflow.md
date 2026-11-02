## Fork workflow (andrewgribben/readest)

This fork tracks upstream `readest/readest`. These rules cover branching, merging and pushing in the fork.

### Branches

- `develop` is the integration branch: the newest working code, used for test builds. Start feature and fix branches from `origin/develop` and open PRs into `develop`.
- `main` mirrors upstream. Never commit to it. Update it only with `gh repo sync andrewgribben/readest --branch main`.
- `pnpm worktree:new <branch>` creates new branches from `origin/main` and rebases onto `origin/main`. For a new branch, run `git reset --hard origin/develop` straight afterwards. Never point it at a branch that's already pushed.

### Merging

- Bring a published branch up to date by merging (`git merge origin/develop` or `git merge origin/main`), not rebasing. No force-pushes and no history rewrites.
- For stacked branches, resolve conflicts once at the lowest branch, then merge it upward.
- Port upstream behaviour into our code during a merge rather than reverting it. Our refactors must keep upstream's fixes, especially security, TLS and CORS.
- Never use `--no-verify`. If the pre-push hook fails, fix the cause.

### Before committing or pushing

- Follow `verification.md`. At minimum, `pnpm -C apps/readest-app format:check`, `lint` and `test` must pass. Add the Rust checks when `src-tauri/` changes.
- Keep `core.autocrlf=false` on Windows. CRLF working files make `format:check` fail.

### Building features

- Before building, check whether upstream already has the feature (`git log upstream/main --grep=...`, recent readest/readest PRs). Adopt theirs rather than duplicating it.
- For new features, write a short plan (problem, approach, files, test plan) and get approval before implementing.
- Never bypass TLS unconditionally. Use `allowsSelfSignedCertAt(catalog, url)` from `@/utils/tls`.
- Use conventional commits (`feat(opds): …`, `fix(android): …`).
