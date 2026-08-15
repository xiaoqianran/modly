# Modly × Modal：把本地 FastAPI / 模型搬上云

> 配套 ADR：[`arch/decisions/MODAL-REMOTE-BACKEND.md`](../arch/decisions/MODAL-REMOTE-BACKEND.md)
>
> **上游更新能不能几乎不用改？能，前提是走 overlay，而不是改 Generate / `useApi` / Models 页。**
>
> 前端永远以为后端是 `http://127.0.0.1:8765`。Remote 时 Electron 在这个端口起一个网关，转发到 Modal。
> 上游新加的 HTTP 路由、新 UI、新轮询，合并进来就会自动打到云端。
> 只有“扫本机磁盘 / 传本机绝对路径”这类新 IPC，才需要在 `ipc-handlers.ts` 加一行 shim。
>
> 你画的拓扑是对的；“改 4 块就够”不够。CodeGraph 全库索引（173 files / 2,305 nodes / 5,672 edges）之后，真正要动的是 **8 个耦合面**，但它们被收进 overlay，而不是散落到 React。

---

## 0. 安全（先做这一步）

对话里出现过 Modal token。按泄露处理：

1. 立刻在 [Modal tokens](https://modal.com/settings) **轮换 / 作废**旧 token。
2. 只在你自己的机器上执行 `modal token set`，不要贴到聊天、Issue、PR、仓库。
3. HuggingFace token、Modal token、将来的 API bearer **全部走 Modal Secret / 本机 settings.json**，禁止进 git。

本仓库的 `modal/` 骨架**不会**读取、写入或部署任何 token。

---

## 1. 先自己分析：现在的程序到底怎么跑

### 1.1 启动链（Electron → FastAPI → 前端）

```
App.tsx
  checkSetup() ──IPC──► setup:check  (有没有本地 Python venv)
  setupStatus === 'done' ──► initApp()
                                │
appStore.initApp()              │
  window.electron.python.start()
                                ▼
python-bridge.ts
  spawn(venvPython, uvicorn main:app --host 127.0.0.1 --port 8765)
  env: MODELS_DIR, WORKSPACE_DIR, EXTENSIONS_DIR, HF_TOKEN
  轮询 GET /health
                                ▼
app:info 返回 apiUrl = http://127.0.0.1:8765
appStore.backendStatus = 'ready'  → 才渲染 MainLayout
```

关键事实：

- 前端 axios **已经**是 `axios.create({ baseURL: apiUrl })`。Generate / 轮询 / optimize 这条线，换 URL 就能打到 Modal。
- **主进程不读 `appStore`。** `electron/main` 里大量 axios 写死 `API_BASE_URL = http://127.0.0.1:8765`。只改 `appStore.apiUrl`，模型下载、卸载、export、extension reload、HF token 同步全部还会打本地。
- 首次启动被 `FirstRunSetup` 绑死：没装本地 Python 就不进主界面。Remote 模式必须跳过这步。

### 1.2 两套“后端”，不是一套

| 子系统 | 跑在哪 | 例子 |
|--------|--------|------|
| Model extension | FastAPI `GeneratorRegistry` → 每个模型一个 venv + `runner.py` | Hunyuan / TRELLIS.2 |
| Process extension | Electron `process-runner.ts`（Node worker 或本地 Python） | mesh-optimizer / smoother / remesher / repair / exporter |
| 文件与目录 | Electron `fs:*` + `settings-store` | 选图、选 mesh、For-Each 扫文件夹 |
| 模型是否已下载 | Electron **扫本地磁盘** `modelsDir` | `ModelsPage.refreshInstalledIds` |
| 生成任务状态 | FastAPI **进程内 dict** `_jobs` | `POST /generate` + `GET /generate/status/{id}` |

所以：“FastAPI 整包搬到 Modal”只覆盖 **model 生成 + optimize + workspace HTTP**。
Workflow 里的 CPU 网格节点、选文件、For-Each，仍然属于你的电脑。

### 1.3 三条路径语言（这是 remote 最容易踩的坑）

| 种类 | 例子 | 谁能读 |
|------|------|--------|
| 本机绝对路径 | `C:\Users\me\cat.png` | 只有 Electron `fs:*` |
| workspace 相对路径 | `Default/mesh.glb` | 只有 FastAPI 的 `WORKSPACE_DIR` |
| HTTP 产物 | `/workspace/Default/mesh.glb` | Viewer：`apiUrl + url` |

现在两处默认“服务器和客户端是同一块磁盘”：

1. `POST /optimize/import-by-path` 在 **FastAPI 进程里** `Path(body.path).is_file()`。路径是你电脑的，Modal 上一定 404。
2. `workflowRunStore` 生成结束后执行 `nodeInputPath = workspaceDir + rel`，再把这个本机路径塞给下一个 **process** 节点。GLB 如果只在 Modal Volume 上，本机 process 节点打不开。

Viewer 本身没问题：`Viewer3D` 已经用 `${apiUrl}${outputUrl}` 拉 GLB。

### 1.4 模型下载并不走 `useApi()`

`useApi().downloadModel` 几乎没人用。Models 页走的是：

```
ModelsPage → window.electron.model.download
          → model-downloader.downloadModelFromHF
          → GET http://127.0.0.1:8765/model/hf-download  (写死)
          → 文件落到本机 modelsDir
          → isDownloaded() 再扫本机目录
```

Remote 时“已安装”必须以 `GET /model/all` 为准，下载必须打 Modal，权重必须进 Volume。

### 1.5 Extension 安装也不走 FastAPI

`/extensions/setup/{id}` 存在，但 UI 从未把它当主路径。
真正的安装在 `ipc-handlers.ts` 的 `extensions:installFromGitHub`：

GitHub tarball → 解压 → 校验 manifest → 原子替换目录 → **在本机 GPU SM 上跑 setup.py** → `POST /extensions/reload`。

目录列表同样是 Electron 扫 `extensionsDir` + builtin。Remote 的 Models 页如果还扫本机文件夹，会显示“没装任何云端模型”。

### 1.6 任务状态不能跟着容器走

`generation.py` 的 `_jobs` 是进程内存。Modal 可能把 `POST /generate` 和下一次 `GET /status` 打到不同容器 → 前端一直 pending。

必须用 `modal.Dict`（或 Volume 上的 job JSON），并且 **ASGI 不要绑 GPU**。

---

## 2. 对照你提的 4 块：哪些对，哪些要补

| 你的 4 块 | 判断 | 补丁 |
|-----------|------|------|
| 1. `appStore` 增加 local/remote，remote 设 `apiUrl` | 对，但是不够 | 还要改 `App.tsx` / `FirstRunSetup`（跳过本地 Python），以及 **整个 Electron 主进程的 `API_BASE_URL`** |
| 2. Extension 改为 Modal 安装 / 预装 Image+Volume | 方向对 | v1 **预装官方 model extension**，不要从笔记本远程跑 setup.py。Process extension 留在本地 |
| 3. 模型下载到 Modal Volume | 对 | UI 必须改：`isDownloaded` / 进度 / 删除都改走 HTTP，不能再扫 `~/.modly/models` |
| 4. 区分本地路径 vs 远程 workspace | 对，而且比看起来大 | import 改为上传；workflow 的 process 节点先把 GLB 拉回本机缓存；`serve-file` 必须锁在 `WORKSPACE_DIR` |

**基本不用动（同意）：** Generate 页、参数 UI、Workflow 画布、3D Viewer、axios 生成/轮询、进度条、GLB 查看、大部分 `/optimize/*`（在路径已是 workspace-relative 的前提下）。

**你没写、但必须动：**

5. Electron 主进程所有 `127.0.0.1:8765`
6. `_jobs` 进程内存 → Modal Dict
7. 公网 API 鉴权（现在是“只绑 localhost 所以没鉴权”）
8. Agent / Asset Library 第一期不做 remote

---

## 3. 推荐拓扑（比“整个 FastAPI 挂一张 GPU”更合适）

```
你的电脑                         Modal
┌──────────────────┐           ┌─────────────────────────────┐
│ Modly Electron   │   HTTPS   │ CPU ASGI  ← 唯一公网 URL     │
│ React / 3D / WF  │ ────────► │ FastAPI + Bearer + job Dict │
│ 选文件           │           │ /health /generate /optimize │
│ process 节点     │ ◄──────── │              │              │
└──────────────────┘    GLB    │              ▼              │
                               │ GPU Cls  L40S / L4 / A100   │
                               │ TRELLIS.2 / Hunyuan venv    │
                               │ Volume: models/workspace/ext│
                               └─────────────────────────────┘
```

为什么拆 CPU / GPU：

- 前端每秒 poll `/generate/status`。如果 ASGI 在 L40S 上，空等也在烧 GPU。
- 模型加载很重，应该 `@modal.enter` 一次，而不是每个 HTTP 请求加载。
- 官方建议权重放 Volume，不放 Image。

三块盘：

| Volume | 挂载 | 用途 |
|--------|------|------|
| `modly-models` | `/modly/models` | HF 权重（写一次，读多次） |
| `modly-workspace` | `/modly/workspace` | 生成的 GLB / splat |
| `modly-extensions` | `/modly/extensions` | 官方模型插件源码 + venv |

GPU 选择：先 `gpu=["L40S", "L4", "A100"]` 自动降级。Hunyuan / TRELLIS 优先 L40S（48 GB）。`min_containers=0`，冷启动不可接受再加 1。

`api/requirements.txt` 只装 FastAPI / trimesh / huggingface_hub。**Torch 继续待在每个 extension 的 venv 里**，不要打进 ASGI 镜像。

---

## 4. 分阶段落地（按这个顺序，不要一上来改 Generate 页）

### Phase 0 — 现在就能做：Modal 包一层现有 FastAPI

仓库里已有 `modal/app.py`：

```bash
# 只在你自己的机器上
pip install modal
modal token set          # 不要把 token 发给任何人
modal serve modal/app.py # 临时 URL，打 GET /health
modal deploy modal/app.py
```

验收：浏览器打开 `https://<workspace>--modly-backend-fastapi-app.modal.run/health` 返回 `{"status":"ok"}`。
这一阶段 **不改前端**，证明 Image + Volume 挂载能起来。

### Phase 1 — Overlay（已落地，前端几乎不改）

原则：**不要改 `appStore.initApp` / `useApi` / Generate 页。** 让它们继续打 `127.0.0.1:8765`。

已落地：

1. `electron/main/remote-backend.ts` — `MODLY_REMOTE_API_URL` 或 settings 打开 remote。
2. `electron/main/remote-gateway.ts` — 本机 8765 反代到 Modal；拦截 `import-by-path`、把 `/workspace` GLB 缓存到本机，好让 process 节点继续吃本地路径。
3. `electron/main/python-bridge.ts` — remote 时起网关，不启 uvicorn。`start()` 签名不变。
4. `ipc-handlers.ts` — 只 shim 扫磁盘的 IPC：`setup:check`、`model:isDownloaded` / `listDownloaded` / `delete`、`extensions:list`。
5. 加法 FastAPI：`GET /extensions/catalog`、`POST /optimize/import`、`POST /model/delete/{id}`。
6. 设置里的 Backend 开关 + 首次启动的 “Use Modal” 入口。

验收：设好 Modal URL 后重启，主界面能进来，`GET http://127.0.0.1:8765/health` 实际打到 Modal。这时还没有预装模型，生成会失败，这是预期。

上游以后加 `POST /something-new`：网关默认 `proxy`，**不用改代码**。

### Phase 2 — 官方模型预装 + 目录 API

- 写一个 Modal `setup_official_extensions`：clone 官方 Hunyuan / TRELLIS repo 到 extensions Volume，在 GPU 容器里跑它们的 `setup.py`。
- FastAPI 增加 `GET /extensions/catalog`（已有）。把官方 Hunyuan / TRELLIS 预装进 Volume 后，现有 `extensions:list` shim 会自动列出它们。
- **不要改** `extensionsStore` / `ModelsPage`。`isDownloaded` 已经走 `GET /model/all`；Download 的 SSE 已经打 `127.0.0.1:8765`，网关会转到 Modal。

验收：Models 页能看到云端的 Hunyuan / TRELLIS，点下载进度能走完，Volume 里出现权重。

### Phase 3 — 生成闭环

- `_jobs` 迁到 `modal.Dict`。
- CPU ASGI 收图 → 写 workspace Volume → `.spawn()` GPU worker → worker 更新 Dict。
- 前端 **不用改** `useGeneration` / 轮询（仍然是 job_id + `/generate/status`）。
- `POST /generate/from-image` 已经是 multipart 上传，这条线天然适合 remote。

验收：本机选一张图 → Generate → 进度条动 → Viewer 里出现 GLB。

### Phase 4 — 路径与 import

- `useApi.importMesh`：remote 时改 `multipart` 上传，不要再 POST 本机路径。
- `workflowRunStore`：model 节点成功后，把 `/workspace/...` 下载到本机 temp，再交给 process 节点。
- `serve-file` 限制在 `WORKSPACE_DIR` 内（本地也该修，remote 是硬性安全要求）。
- Storage 页在 remote 下隐藏“移动本机 models/workspace 目录”。

### Phase 5 — 鉴权与生产

- FastAPI Bearer（Modal Secret）。
- `@modal.asgi_app(requires_proxy_auth=True)` 作为第二道门。
- axios / Electron `net.fetch` 统一带头。
- Agent、Asset Library、本机 Ollama 明确标成 local-only。

---

## 5. 每个阶段改哪些文件（给下一步直接开干）

### Overlay 文件清单（刻意不碰渲染层核心）

| 文件 | 角色 |
|------|------|
| `electron/main/remote-backend.ts` | 解析 env / settings |
| `electron/main/remote-gateway.ts` | 8765 → Modal 反代 + 路径翻译 |
| `electron/main/python-bridge.ts` | remote 起网关，签名不变 |
| `electron/main/ipc-handlers.ts` | 只 shim 扫磁盘的 IPC |
| `api/services/extension_catalog.py` | 加法 catalog |
| `api/routers/optimize.py` | 加法 `POST /optimize/import` |
| `src/areas/settings/components/ApplicationSection.tsx` | 开关（可在上游冲突时重放） |
| `src/areas/setup/FirstRunSetup.tsx` | 首次启动的 Modal 入口 |

**不要改：** `appStore.ts`、`useApi.ts`、`GeneratePage.tsx`、`Viewer3D.tsx`、`ModelsPage.tsx`、`extensionsStore.ts`、`useGeneration.ts`、Workflow 画布。这是“上游更新几乎不用改”的前提。

---

## 6. 验收清单

- [ ] `modal serve modal/app.py` 的 `/health` 为 200
- [ ] Remote 模式启动 **零** 本地 `uvicorn` 进程
- [ ] `appStore.apiUrl` 仍是 `http://127.0.0.1:8765`，网关把请求转到 Modal
- [ ] Models 页的“已下载”来自 `GET /model/all`，不是本机文件夹
- [ ] 生成一张图，Viewer 能加载 `https://…/workspace/…glb`
- [ ] 本机 workflow 的 Smooth / Optimize 仍可用（先下载 GLB）
- [ ] 未带 Bearer 的公网请求 401
- [ ] 仓库、日志、PR 里没有 token

---

## 7. 和“整包搬 FastAPI 上 GPU”比，为什么选这套

| 方案 | 优点 | 为什么不采用 |
|------|------|----------------|
| 一个 GPU ASGI 装下整个 FastAPI | 改动最少 | 轮询绑 GPU；`_jobs` 跨容器丢失；空闲也计费 |
| 只把 generate 改成独立 Modal 函数，前端直调 Modal SDK | 更“云原生” | 要重写 axios / 轮询 / Electron 导出，违背“useApi 已可换地址” |
| **CPU ASGI + GPU worker + 3 Volume（本方案）** | 现有 HTTP 契约不变；费用可控；和现在的 job 模型同构 | Image / Volume 初次搭建成本高，但这是一次性的 |

第一期目标不是“任意 GitHub extension 一键装到云上”，而是：**官方 Hunyuan / TRELLIS 在 Modal 上可生成，笔记本只负责 UI 和 CPU 后处理。**
