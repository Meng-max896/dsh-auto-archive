# dsh-auto-archive

给 [DSH](https://github.com/deepseek-ai) 用的**工作区自动归档插件**：按对话轮次归档文档、识别本轮产生的缓存、判断根目录归属、并在会话静默一周后归档。

## 四条能力

| # | 能力 |
|---|---|
| ① | **每轮结束归档**：监听 `turn/end`，只提交**本轮**新增/修改的文件（轮次归属靠 `turn/start` 时的 mtime 基线 diff，不是整仓 `add -A`） |
| ② | **缓存只报告不删除**：本轮新建且命中噪音规则的文件会被列出，但**不删、也不提交** |
| ③ | **静默期归档**：会话超过 N 天（默认 7 天）无新内容时，先做一次工作区快照，再调用 `workspaceRegistry.archiveSession` 归档会话 |
| ④ | **根目录归属判断**：扫描仓库根的文件，分成「应留根」「可移动」「需人工判断」并给出建议目录，**只判断不移动** |

设计底线：**永不 force push、不删文件、不存凭据、任何能力缺失都降级并记录**。

## 安装

```bash
dsh plugin --profile web add dsh-auto-archive        # 发布后
dsh plugin --profile web add ./dsh-auto-archive      # 本地目录
```

> 兼容性：DSH `>= 0.2.0-rc.2`

## 工具

| 工具 | 说明 |
|---|---|
| `archive_now` | 手动提交并推送整仓。`repo` / `message` / `push` / `dry_run` |
| `archive_status` | 只读：分支、待提交数、未推送数、远端与身份就绪情况、上一轮归档摘要 |
| `archive_cleanup_report` | 只读：列出本轮被判为缓存的候选文件（`destructive: false`） |
| `archive_root_policy` | 只读：根目录文件归属判断 + 建议目标目录（`destructive: false`） |

## 配置

```yaml
- insert:
    - id: auto-archive
      name: dsh-auto-archive
      config:
        locale: auto            # auto | zh-CN | en-US
        push: true
        repo: ''                # 留空则用会话 cwd；建议显式指定工作区
        turnArchive: true       # ①
        minFileAgeSeconds: 0    # 跳过最近 N 秒内改动过的文件（0 = 不过滤）
        cleanup:                # ② 只报告
          enabled: true
          rules:                # 可选：覆盖默认噪音规则
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

## 时间常量一览

插件**没有按时间窗的归档宽限**——它按轮次边界工作，本轮产生的文件在本轮结束即归档。下面是与时间相关的全部常量：

| 常量 | 值 | 作用 |
|---|---|---|
| `minFileAgeSeconds` | **0（默认不过滤）** | 可配置：跳过最近 N 秒内改动过的文件，避免提交到仍在写入的半截内容 |
| `LOCK_TTL_MS` | 30 分钟 | 锁过期时间，防进程崩溃后永久锁死 |
| `GIT_TIMEOUT_MS` | 10 分钟 | 单条 git 命令的超时上限 |
| 推送重试间隔 | 5s / 15s / 30s | 瞬时网络失败的三次退避重试 |
| 网络预检超时 | 6 秒 | 推送前探测代理隧道；不通即快速失败，不做无意义重试 |
| 状态横幅延迟 | 50 毫秒 | 等异步注入完成后再报服务可用性 |
| `idleDays` | 7 天 | **会话**静默阈值（不是文件宽限） |
| `scanMinutes` | 60 分钟 | 静默扫描频率 |

> 对照：仓库自带的 `tidy-workspace.ps1` 用 **2 分钟**宽限（避免和正在编辑的文件抢），本插件默认 **0**（轮次结束即归档）。

## 根目录归属规则

`archive_root_policy` 把这些判断固化下来，规则见 `src/root-policy.js`：

**应留根**
- 仓库元数据：`.gitignore`、`.gitattributes`、`.gitmodules`（根级才对全仓生效）
- 说明文件：`README*`、`LICENSE`、`CHANGELOG.md`、`CLAUDE.md`、`AGENTS.md`
- 工程文件：`package.json`、`pnpm-workspace.yaml`、`tsconfig.json`、`Makefile`、`Dockerfile`
- 工程/入口扩展名：`.eproj` `.epro2` `.eprj` `.ProPrj` `.sln` `.csproj` `.code-workspace` `.cmd` `.bat` `.ps1` `.json` `.yml` `.yaml`

**可移动（附建议目录）**
- 文档 `.md` `.docx` `.pdf` `.pptx` `.xlsx` `.txt` → `docs/`
- 素材 `.png` `.jpg` `.gif` `.webp` `.svg` `.mp4` `.wav` → `assets/`
- 脚本 `.py` `.js` `.mjs` `.sh` → `scripts/`
- 临时 `.tmp` `.bak` `.log` `.jsonl` → `tmp/`

**需人工判断**：不在上述任何规则的扩展名，插件不猜，直接列出来。

## 权限与安全边界

- 不执行 `force push`，不删除、不改写历史
- 不自动解决冲突
- 不读取、不存储、不上传任何凭据（认证完全复用系统凭据管理器）
- 可选服务（`timer` / `workspaceRegistry`）走 Cordis 按需注入，缺失时自动降级，不影响其余能力

## 认证

首次推送前，在你自己的终端对目标仓库执行一次 `git push` 完成授权即可，凭据由系统凭据管理器保存，插件复用。

## 错误码

| 码 | 含义 | 修法 |
|---|---|---|
| `GIT_MISSING` | 没装 git / 不在 PATH | 安装 git |
| `NOT_A_REPO` | 目录不是仓库 | `git init` + `git remote add origin <url>` |
| `NO_REMOTE` | 没有远端 | `git remote add origin <url>` |
| `IDENTITY_MISSING` | 没配提交身份 | `git config user.name` / `user.email` |
| `AUTH_REQUIRED` | 认证失败 | 终端执行一次 `git push` |
| `OFFLINE` | 网络/代理不可达 | 本地提交已保留，恢复后再跑自动补推 |
| `DIVERGED` | 远端冲突、rebase 失败 | 手动解决后重试（未 force push） |
| `PUSH_FAILED` | 其他推送失败 | 修好后重试，会自动补推 |

## 诊断

```bash
node scripts/doctor.mjs      # 27 项安装体检，每项带证据；exit 0 = 全部通过
```

## 开发

```bash
node --test test/archive.test.js    # 内核 8 项
node --test test/features.test.js   # 轮次/缓存/静默期/根目录 10 项
node test/smoke-plugin.mjs          # 插件层冒烟（4 个工具）
```

## License

MIT
