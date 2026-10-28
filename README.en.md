# dsh-auto-archive

A **workspace auto-archive plugin** for [DSH](https://github.com/deepseek-ai): archives documents per conversation turn, flags cache produced by the turn, judges root-directory layout, and archives idle sessions after a week.

## Four behaviours

| # | Behaviour |
|---|---|
| ① | **Archive per turn**: listen to `turn/end` and commit only the files **this turn** created or modified (attribution comes from an mtime baseline taken at `turn/start`, never a repo-wide `add -A`) |
| ② | **Cache is reported, never deleted**: files created this turn that match the noise rules are listed, then neither deleted nor committed |
| ③ | **Idle archive**: when a session has had no new content for N days (default 7), take a final workspace snapshot and call `workspaceRegistry.archiveSession` |
| ④ | **Root layout judgement**: group the files at the repo root into keep-at-root / movable (with a suggested directory) / needs-a-human. **Judges only, moves nothing** |

Hard rules: **never force-push, never delete files, never store credentials, degrade and log whenever a capability is missing**.

## Install

```bash
dsh plugin --profile web add dsh-auto-archive        # once published
dsh plugin --profile web add ./dsh-auto-archive      # local checkout
```

> Compatibility: DSH `>= 0.2.0-rc.2`

## Tools

| Tool | Purpose |
|---|---|
| `archive_now` | Manual commit + push of the whole repo. `repo` / `message` / `push` / `dry_run` |
| `archive_status` | Read-only: branch, pending files, unpushed commits, remote and identity readiness, last turn summary |
| `archive_cleanup_report` | Read-only: files from this turn classified as cache (`destructive: false`) |
| `archive_root_policy` | Read-only: root layout judgement with suggested targets (`destructive: false`) |

## Configuration

```yaml
- insert:
    - id: auto-archive
      name: dsh-auto-archive
      config:
        locale: auto            # auto | zh-CN | en-US
        push: true
        repo: ''                # empty = the session cwd; pinning it is recommended
        turnArchive: true       # ①
        minFileAgeSeconds: 0    # skip files modified in the last N seconds (0 = no filter)
        cleanup:                # ② report-only
          enabled: true
          rules:
            dirs: [node_modules, __pycache__, .pytest_cache, .ruff_cache, .mypy_cache, .next, .turbo, .cache]
            extensions: [.tmp, .bak, .pyc, .pyo, .log, .swp, .swo, .crdownload, .part]
            names: [.DS_Store, Thumbs.db, desktop.ini]
            globs: []
        inactivity:             # ③
          enabled: true
          idleDays: 7
          scanMinutes: 60
          maxBatch: 20
          stopActivity: true
```

## Timing constants

The plugin has **no time-window grace period for archiving** — it works on turn boundaries, so a file produced this turn is archived when the turn ends. Every time-related constant:

| Constant | Value | Purpose |
|---|---|---|
| `minFileAgeSeconds` | **0 (no filter by default)** | Optional: skip files modified within the last N seconds so half-written files are not committed |
| `LOCK_TTL_MS` | 30 minutes | Lock expiry, so a crashed run cannot lock forever |
| `GIT_TIMEOUT_MS` | 10 minutes | Per-command git timeout |
| Push retry delays | 5s / 15s / 30s | Three backoff retries for transient network failures |
| Network probe timeout | 6 seconds | Probe the proxy tunnel before pushing; fail fast instead of retrying blindly |
| Status banner delay | 50 ms | Wait for async injection before reporting service availability |
| `idleDays` | 7 days | **Session** idle threshold (not a file grace period) |
| `scanMinutes` | 60 minutes | Idle sweep interval |

> For comparison, the bundled `tidy-workspace.ps1` uses a **2-minute** grace period (it competes with files being edited); this plugin defaults to **0** (archive as soon as the turn ends).

## Root layout rules

`archive_root_policy` fixes these judgements; the rules live in `src/root-policy.js`:

**Keep at root**
- Repository metadata: `.gitignore`, `.gitattributes`, `.gitmodules` (only the root level applies repo-wide)
- Documentation: `README*`, `LICENSE`, `CHANGELOG.md`, `CLAUDE.md`, `AGENTS.md`
- Project files: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `Makefile`, `Dockerfile`
- Project/entry extensions: `.eproj` `.epro2` `.eprj` `.ProPrj` `.sln` `.csproj` `.code-workspace` `.cmd` `.bat` `.ps1` `.json` `.yml` `.yaml`

**Movable (with a suggested directory)**
- Docs `.md` `.docx` `.pdf` `.pptx` `.xlsx` `.txt` → `docs/`
- Assets `.png` `.jpg` `.gif` `.webp` `.svg` `.mp4` `.wav` → `assets/`
- Scripts `.py` `.js` `.mjs` `.sh` → `scripts/`
- Temp `.tmp` `.bak` `.log` `.jsonl` → `tmp/`

**Needs a human**: anything whose extension matches no rule. The plugin does not guess — it lists them.

## Safety boundaries

- No `force push`, no history rewriting or deletion
- No automatic conflict resolution
- No credential reading, storage, or transmission (authentication reuses the system credential manager)
- Optional services (`timer`, `workspaceRegistry`) are obtained through Cordis scoped injection; when missing the plugin degrades instead of failing

## Authentication

Run `git push` once in your own terminal for the target repo; the system credential manager keeps it and the plugin reuses it.

## Error codes

| Code | Fix |
|---|---|
| `GIT_MISSING` | install git / add it to PATH |
| `NOT_A_REPO` | `git init` + `git remote add origin <url>` |
| `NO_REMOTE` | `git remote add origin <url>` |
| `IDENTITY_MISSING` | `git config user.name` / `user.email` |
| `AUTH_REQUIRED` | run `git push` once in a terminal |
| `OFFLINE` | local commit preserved; push resumes on the next run |
| `DIVERGED` | resolve the conflict manually (no force-push) |
| `PUSH_FAILED` | fix the cause and retry; the commit is pushed automatically |

## Diagnostics

```bash
node scripts/doctor.mjs      # 27 install checks with evidence; exit 0 = all passed
```

## Development

```bash
node --test test/archive.test.js    # core (8)
node --test test/features.test.js   # turn / cache / idle / root (10)
node test/smoke-plugin.mjs          # plugin-layer smoke (4 tools)
```

## License

MIT
