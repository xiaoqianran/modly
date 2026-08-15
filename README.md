<p align="center">
  <img src="resources/icons/icon.png" width="96" alt="Modly logo" />
</p>

# Modly

**Local, open source, AI-powered image-to-3D mesh generation.**
Turn any photo into a 3D model using open source AI models running entirely on your GPU.
Modly is a desktop application for Windows, Linux, and Apple Silicon macOS.

> Created by [Lightning Pixel](https://github.com/lightningpixel)

<p align="center">
  <img src="docs/app-screenshot.png" alt="Modly screenshot" />
</p>

---

## 在 Windows 上启动（本 fork / Modal）

**不要下官方 App。** [lightningpixel/modly Releases](https://github.com/lightningpixel/modly/releases) 是官方的本地 GPU 安装包，没有这套 Modal Settings。本 fork 也还没有打好的 Windows 安装包。

走 **Modal 云端 GPU** 时，本机 **不用装 CUDA、不用装 Python 后端**。Windows 只跑 Electron 窗口，推理在 Modal 上。

### 1. 本机要有的

- [Node.js](https://nodejs.org)：推荐 **22 LTS**。Node 24 也可以（`mesh-optimizer` 已改走 npm 上的 sharp 预编译包，不再从 GitHub 下 libvips）。
- Git

如果 `npm run dev` 在 `mesh-optimizer` / `sharp` 处失败（`Installation error: aborted` 或 `EPERM`），先清掉半成品再开一次：

```powershell
Remove-Item -Recurse -Force .\out\builtin-extensions -ErrorAction SilentlyContinue
npm run dev
```

国内若 npm 也拉不下 GitHub，可先设镜像再装（不必退回 Node 22）：

```powershell
$env:SHARP_DIST_BASE_URL="https://npmmirror.com/mirrors/sharp-libvips"
npm run dev
```

### 2. 拉代码并启动

PowerShell 或 cmd：

```bat
git clone https://github.com/xiaoqianran/modly.git
cd modly
git checkout main
npm install
npm run dev
```

会弹出 Electron 窗口。这就是日常启动方式，不是去 Releases 下 exe。

### 3. 第一次：先登记云端空壳，再开 App

**`modal deploy` 不是一直开着的机器。** 它只在你的 Modal 账号里登记 `modly-backend`（CPU FastAPI + GPU 工人的名字和 URL）。空闲是 **0 个 CPU、0 张 GPU**，不按「部署着」按小时收费。关掉 `npm run dev` **不会删掉**这次登记；正在跑的 GPU 会在退出时被要求 2 秒内卸掉，CPU 几秒后缩到 0。

Windows 上双击（需要已安装 [uv](https://docs.astral.sh/uv/)）：

```bat
scripts\deploy-modal.bat
```

脚本用 uv 在项目里建临时 `.venv-modal`，只往这个 venv 装 `modal[api-proxy-support]`，然后让你登录 Modal，再 `modal deploy modal/app.py`。日常跑 Electron **不用**这个 venv，也 **不用**本机再装 modal。

然后 `npm run dev`，选 **Use a Modal cloud backend instead** / Settings → Connect this session：

- 把 `token-id` / `token-secret`（或整行 `modal token set …`）贴进 App。只活在这一次打开的进程里，不写 settings 文件夹。
- 或者贴 deploy 打印出来的 `https://…modal.run` URL。

下面那个 **API token / Bearer** 是可选的 FastAPI 口令，**不是** `ak-` / `as-` 那一对。

已经进主界面了，也可以：**Settings → Application → Compute backend → Modal → Connect this session**。停留秒数（默认 60）和 GPU 卡仍可「Save backend」记在这台电脑；CLI token 不会进 `settings.json`。

### 4. 和云端的关系

桌面永远只连本机 `http://127.0.0.1:8765`。Remote 模式会在这个端口起网关，转发到 Modal。打开 App **不会**叫醒 GPU。点 Generate 才会。

云端默认 60s 要这次代码已经 `modal deploy` 过才生效。没 deploy 的话，桌面能开，但云端还是旧策略。计费和 deploy 见 [`docs/modal-cost.md`](docs/modal-cost.md)。

### 什么时候才打 exe

想给别人双击安装时，在这台 Windows 上：

```bat
npm run package
```

安装包在 `dist\`。你自己用，`npm run dev` 就够。

---

## Getting started

Local GPU on this machine (no Modal). For the Modal overlay on Windows, use the section above instead.

### Download / launch without Modal

Official upstream installers: [lightningpixel/modly Releases](https://github.com/lightningpixel/modly/releases).

Alternatively, clone and run without packaging:

```bash
# Windows
launch.bat

# Linux / macOS
./launch.sh
```


### 1. Install JS dependencies

```bash
npm install
```

### 2. Set up Python backend

```bash
cd api
python -m venv .venv
.venv\Scripts\activate     # Windows
source .venv/bin/activate  # Linux / macOS
pip install -r requirements.txt
```

### 3. Run in development

```bash
npm run dev
```

### 4. Test

```bash
npm test
./node_modules/.bin/tsc --noEmit -p tsconfig.node.json
npm run build
```

## Platform notes

- macOS support targets Apple Silicon only.
- macOS uses native window controls. Windows and Linux keep the existing custom controls.
- The top bar includes a live RAM indicator sourced from the main process.
- Workflow wiring is validated before run; invalid graphs stay in place and surface inline/toast warnings instead of dropping the current mesh view.
- Package Apple Silicon macOS with `npm run package:mac`.
- Imported meshes can be smoothed and decimated in-app; optimized results are written back into the workspace.

---

## Extension system

Modly supports external model and process extensions. Each extension is a GitHub repository containing a `manifest.json` plus the runtime entry files required by its type.

### Official extensions

| Extension | Model | URL |
|-----------|-------|-----|
| [modly-hunyuan3d-mini-extension](https://github.com/lightningpixel/modly-hunyuan3d-mini-extension) | Hunyuan3D 2 Mini | https://github.com/lightningpixel/modly-hunyuan3d-mini-extension |
| [modly-hunyuan3d-mini-turbo-extension](https://github.com/lightningpixel/modly-hunyuan3d-mini-turbo-extension) | Hunyuan3D 2 Mini Turbo | https://github.com/lightningpixel/modly-hunyuan3d-mini-turbo-extension |
| [modly-hunyuan3d-mini-fast-extension](https://github.com/lightningpixel/modly-hunyuan3d-mini-fast-extension) | Hunyuan3D 2 Mini Fast | https://github.com/lightningpixel/modly-hunyuan3d-mini-fast-extension |
| [modly-triposg-extension](https://github.com/lightningpixel/modly-triposg-extension) | TripoSG | https://github.com/lightningpixel/modly-triposg-extension |
| [modly-trellis2-gguf-extension](https://github.com/lightningpixel/modly-trellis2-gguf-extension) | Trellis2 GGUF | https://github.com/lightningpixel/modly-trellis2-gguf-extension |

### How to install an extension

**1.** Go to the **Models** page and click **Install from GitHub**.

![Install from GitHub](docs/install-from-github.png)

**2.** Enter the HTTPS URL of the extension repository and confirm.

![Enter extension URL](docs/install-extension.png)

**3.** If the extension exposes model nodes, download the model or one of its variants. Process extensions are ready once installation and setup complete.

![Install models](docs/install-models.png)

---

## Workflows
Start with a basic workflow first. For example, on the "Workflows" tab, try: Image -> Generate Mesh -> Add to Scene. Make sure there is a connection between each of the steps. Go to the "Generate" tab, make sure the workflow is selected, then click on "Generate 3D Model". Click on "Settings/Logs/Errors" to see any issues.


## Modly CLI

Agents and scripts can call a running Modly desktop app without using the UI via the stdlib-only CLI. The CLI is a thin helper over Modly's canonical automation concepts and keeps final machine-readable JSON on stdout:

```bash
python tools/modly-cli/agent.py health
python tools/modly-cli/agent.py model list
python tools/modly-cli/agent.py workflow-run status <run_id>
python tools/modly-cli/agent.py generate --image ./input.png --output ./export.glb
```

Canonical commands are `health`, `model`, `workflow-run`, `capability`, and `process-run`. The friendly `generate` command starts `POST /workflow-runs/from-image`, polls the returned run, exports the final mesh when requested, and includes recovery metadata such as `workflow-run status ...` and `workflow-run cancel ...` in the JSON response.

Compatibility and helper surfaces are intentionally separated: `legacy` wraps old `/generate/*` job endpoints, `dev serve-api` / `dev ensure-server` start only the FastAPI backend and do not prove Electron/Desktop bridge readiness, and `experimental comfy-image` / `experimental generate-from-workflow` are external ComfyUI orchestration helpers rather than the canonical Modly agent contract. Hidden helper aliases such as `status`, `export`, and `batch` remain parseable for scripts, but they are not presented as canonical root commands.

`experimental generate-from-workflow --workflow <name> --output <path>` treats `--output` as the final artifact location. When the ComfyUI workflow produces a downloadable 3D asset, the CLI downloads it directly; image-only workflows remain a compatibility path through Modly image-to-3D generation.

See `tools/modly-cli/SKILL.md` for the agent workflow and output contract.

---

### Community

Join the [Discord server](https://discord.gg/BvjDCvS3yr) to stay up to date with the latest news, report bugs, and share feedback.

---

## Sponsors

<p align="center">
  Thanks to our early sponsors for believing in Modly and helping make local AI 3D generation more accessible.
</p>

<p align="center">
  <kbd>
    <img src="https://images.weserv.nl/?url=github.com/DrHepa.png&w=96&h=96&fit=cover&mask=circle" width="40" height="40" alt="DrHepa" />
    <br />
    <sub><a href="https://github.com/DrHepa">DrHepa</a></sub>
  </kbd>
  &nbsp;&nbsp;
  <kbd>
    <img src="https://images.weserv.nl/?url=github.com/benjapenjamin.png&w=96&h=96&fit=cover&mask=circle" width="40" height="40" alt="benjapenjamin" />
    <br />
    <sub><a href="https://github.com/benjapenjamin">benjapenjamin</a></sub>
  </kbd>
  &nbsp;&nbsp;
  <kbd>
    <img src="https://images.weserv.nl/?url=github.com/iammojogo-sudo.png&w=96&h=96&fit=cover&mask=circle" width="40" height="40" alt="iammojogo-sudo" />
    <br />
    <sub><a href="https://github.com/iammojogo-sudo">iammojogo-sudo</a></sub>
  </kbd>
</p>

---

## License

MIT License — see [LICENSE](LICENSE) for details.

**If you fork this project and build your own app from it, you must credit the original project and its creator:**

> Based on [Modly](https://github.com/lightningpixel/modly) by [Lightning Pixel](https://github.com/lightningpixel)

This is a requirement of the MIT license attribution clause. Please keep this credit visible in your app's UI or documentation.
