# Modly × Modal：不必一直开着，而且要比 ComfyUI 方案更省

参考：[xiaoqianran/modal-ashleykza-comfyui](https://github.com/xiaoqianran/modal-ashleykza-comfyui)

## 先回答：这个 Modal 是要一直 deploy 吗？

**要 `modal deploy` 一次（注册应用），不要一直跑容器。**

| 动作 | 账单 | 该不该做 |
|------|------|----------|
| `modal deploy modal/app.py` | 几乎为零：只登记 App / 公网 URL / `GpuGenerator` 名字 | **要。** 改代码后再 deploy |
| 部署之后容器 `min_containers=0` | 空闲 = **0** 个 CPU、**0** 张 GPU | 默认就是这样 |
| `modal serve modal/app.py` 开着不关 | 容器不缩容，CPU 一直计费；也没有持久 memory snapshot | **不要。** 只在改 `modal/app.py` 时用，Ctrl-C 立刻停 |
| 桌面一直开着、空闲不点 Generate | 本机网关自己回 `/health`，**不唤醒** Modal | 打开 App ≠ 烧云端 |
| 点 Generate / 下模型 / 装插件 | CPU ASGI 醒几秒，GPU 只在 `GpuGenerator.generate` 期间醒 | 这才是该付钱的窗口 |
| 生成成功 | GPU **再留 60 秒**（看结果、改参数再点一次不必重新 load）；然后缩到 0。Settings 可改 | 默认 |
| 取消 / 卡住超时 | 立刻停 FunctionCall，GPU **2 秒**内卸掉 | 用户说停就停 |

`deploy` 留下的是一份**说明书**（函数名、URL、Volume 名），不是一台 24h 开机的机器。ComfyUI 仓库里同一句话：冒烟用 `modal deploy`，不要用 `modal serve` 保活。

---

## ComfyUI 仓库里已经验证过的省钱点

他们的 GPU **就是** ComfyUI 网页。浏览器一开 WebSocket / 轮询 `/system_stats`，L40S 就不会缩。所以他们强制：

1. **GPU idle 5s** → 0：`scaledown_window=5`，`min_containers=0`，`buffer_containers=0`
2. **默认只有 L40S**。`gpu=["L40S","A100"]` 这种 tuple 在 Modal 里是静默降级/升级；贵卡必须 `MODAL_GPU=…` 显式写
3. **CPU hydrate**：模型下载、锁文件写 Volume，不占 GPU Image、不占 GPU 秒
4. **`modal deploy` 之后才有 memory / GPU snapshot**；`serve` 没有持久快照
5. 本机 Studio（`127.0.0.1:8787`）当控制面，GPU 只在真正跑图时出现
6. 130 个 GitHub 节点默认不打进 Image

这些全部成立。Modly 还能再省一截，因为我们的网页**不在 GPU 上**。

---

## 为什么直接抄 ComfyUI 还不够省

ComfyUI：浏览器 ⇄ **GPU web_server**。空闲策略再狠，只要 UI 连着，GPU 就在。

Modly 现在的拓扑本来就更便宜：

```
Electron UI  →  本机 127.0.0.1:8765 网关  →  CPU ASGI（FastAPI + job Dict）
                                              └ spawn → GPU Cls（只跑 generate / setup.py）
```

但 PR #2 之前的默认值会把这个优势吃掉：

| 旧默认 | 实际效果 |
|--------|----------|
| CPU `scaledown_window=5min` | 任何一次请求都会让 CPU 再挂 5 分钟 |
| GPU `scaledown_window=10min` | 一次生成之后 L40S 再空转 10 分钟 |
| `gpu=["L40S","L4","A100"]` | L40S 没货时**静默开 A100** |
| 启动时 `GET /health` 打到 Modal | 打开桌面 = 叫醒 CPU ASGI |
| `setup_official_extensions` 整段在 GPU 上 clone + pip | 把 GitHub/HF 下载算进 GPU 账单 |
| 没有 memory snapshot | 每次冷启动重新 import registry |

更糟的是：前端 `useGeneration` 在任务期间每秒 `GET /generate/status`。这没问题（必须打 CPU Dict）。**有问题的是把 `/health` 也打到云上**，以及把 ASGI 误接到 GPU 上（文档里已经禁止，代码里也没接）。

---

## 更省的 Modly 方案（已按这个落地）

原则：**打开 App 免费；点 Generate 才唤醒；权重在 CPU 下；GPU 只推理。**

### 1. 部署模型

```bash
pip install -r modal/requirements.txt
modal token set
modal deploy modal/app.py                          # 登记，容器仍是 0
modal run modal/app.py::bake_official_extensions   # CPU clone + CPU 下权重 + GPU 只跑 setup.py
```

不要 `modal serve` 挂过夜。改 stub 时再用，用完关掉。

### 2. 空闲窗口（按桌面用法，不是抄 ComfyUI 的 5 秒）

用户真正的循环是：**出图 → 转一转看 → 改个参数再 Generate**。Hunyuan 装进显存往往要几十秒。GPU 5 秒就拆，等于每次重点都重新 load，人等的时间比那 5 秒 GPU 钱贵得多。

| 容器 | 空闲策略 | min / buffer |
|------|----------|----------------|
| CPU ASGI | **8s**（`MODLY_CPU_SCALEDOWN`） | 0 / 0 |
| GPU 推理（`GpuGenerator`） | 成功后 **60s 留着模型和显存**（Settings 或 `MODLY_GPU_SCALEDOWN`）；取消/超时 **2s 卸掉** | 0 / 0 |
| GPU `setup.py` 烘焙 | 跑完即毁（`single_use_containers`） | 0 / 0 |

打开 App、看 GLB、smooth/remesh **不会**保活 GPU。Viewer 吃本机缓存的文件。只有 Generate / 取消超时动 GPU 层。

L40S 60 秒大约 **$0.03**。同一次会话里连点 3 次 Generate，只付一次 load。走开喝杯水，GPU 回到 0。桌面 Settings → Compute backend 可以改停留秒数；换卡要下一次 `modal deploy`。

### 3. 默认卡：L40S only

`MODLY_GPU` 为空就是 `("L40S",)`。要 A100 必须 `MODLY_GPU=A100 modal deploy modal/app.py`。

### 4. 本机网关当 ComfyUI Studio 用

- `GET /health` **只在网关本地回答** `{status: ok}`。打开 Modly **不唤醒** Modal。
- `GET /model/all`、`/model/status`、`/extensions/catalog` 短缓存 8 秒，并把并发请求合成一次。Models 页连打多次 `isDownloaded` 不会把 CPU 钉住。
- 任何 POST（生成、下载、安装）清掉这份缓存。
- 任务中的 `/generate/status` 仍然每秒打 CPU（Dict），**打不到 GPU**。
- Process 节点（smooth / remesh / export）继续吃网关缓存的本地 GLB。

### 5. Hydrate 在 CPU，setup.py 才上 GPU

| 命令 | 机器 | 做什么 |
|------|------|--------|
| `hydrate_official_extensions` | CPU | clone 官方 Hunyuan / TripoSG / TRELLIS 源码到 Volume |
| `hydrate_official_models` | CPU | `snapshot_download` 权重到 `modly-models`（**不要在 L40S 上下 10GB**） |
| `setup_official_extensions` | GPU | 只跑各扩展 `setup.py`（CUDA wheel / SM） |
| `bake_official_extensions` | 上面三个串起来 | 一条命令 |

这比 ComfyUI 还多挡了一枪：他们已经 CPU hydrate 模型；我们连扩展源码 clone 也不放 GPU。

### 6. Memory snapshot（deploy 之后才有）

`GpuGenerator`：`enable_memory_snapshot=True`，`@modal.enter(snap=True)` 拍 registry，restore 后再 `Volume.reload()` 以便看见 CPU hydrate 的新权重。

GPU snapshot 默认关（`MODLY_GPU_SNAPSHOT=1` 才开）：我们不在 `enter()` 里把 Hunyuan 装进显存，空 CUDA context 的 GPU 快照不值钱。哪天要把默认模型 load 进 `enter()`，再打开。

### 7. 明确不做什么（那些才是真·包月）

- 不设 `min_containers=1`
- 不把 FastAPI 挂到 GPU web_server（那会变成 ComfyUI 的计费形状）
- 不改 `useApi` / `useGeneration` / Generate 页来“省钱”——overlay 已经把空闲流量挡在 8765
- 不用 `modal serve` 当生产

---

## 和 ComfyUI 方案比，再省在哪

| | ComfyUI on Modal | Modly overlay（本方案） |
|--|------------------|-------------------------|
| 控制面 | 本机 Studio :8787，但 GPU 仍是网页 | 本机 Electron :8765，**网页永不在 GPU** |
| 打开 UI | 若连 GPU web，L40S 不缩 | `/health` 本地，云端继续 0 |
| 空闲 GPU | 5s，但 WS 会钉住 | **60s 重试窗口**（无 WS，Settings 可改）；取消则 2s 卸 |
| 下模型 | CPU hydrate | CPU hydrate（扩展源码也 CPU） |
| 默认 GPU | L40S | L40S（禁止静默 A100） |
| 快照 | memory + GPU（Comfy 进程整包） | memory（registry）；GPU 快照可选 |
| 生成中轮询 | 打在 GPU 网页上 | 打在 CPU Dict 上 |

一次 2 分钟的 Hunyuan 生成：你付的是 **2 分钟 L40S + 大约 2 分钟很便宜的 CPU**，不是“App 开着的那一小时”。

---

## 操作备忘

```bash
# 生产（登记完即可关终端）
MODLY_GPU=L40S modal deploy modal/app.py

# 第一次 / 换官方模型
modal run modal/app.py::bake_official_extensions

# 只要下权重，不要 GPU
modal run modal/app.py::hydrate_official_models

# 只有改 modal/app.py 时
modal serve modal/app.py   # 用完 Ctrl-C
```

环境变量：

| 变量 | 默认 | 含义 |
|------|------|------|
| `MODLY_GPU` | `L40S` | 逗号分隔；空 = 只有 L40S |
| `MODLY_CPU_SCALEDOWN` | `8` | CPU ASGI 空闲秒 |
| `MODLY_GPU_SCALEDOWN` | `60` | 生成**成功**后 GPU 再留多少秒给下一次 Generate（Settings 可覆盖；取消/超时是 2s） |
| `MODLY_MEMORY_SNAPSHOT` | `1` | deploy 后给 GpuGenerator 拍内存快照 |
| `MODLY_GPU_SNAPSHOT` | `0` | 实验性 GPU 快照；没在 enter() 里 load 模型就别开 |
| `MODLY_GPU_TIMEOUT` | `1200` | GPU `generate` 函数超时（秒）。卡住就杀，不再空转 1 小时 |

桌面 Settings → Application → Compute backend（Modal）可以改停留秒数和想用的卡。停留秒数走 `POST /settings/modal`，下次 Generate 就按新窗口留 GPU。换卡只记在本机 `settings.json`，要 `MODLY_GPU=… modal deploy modal/app.py` 才换上。这两项都不在 Generate 页。

改 linger / 选卡 **不必每次打 Windows exe**。这两项在 `userData/settings.json`，`npm run dev` 和已装的 exe 读同一份。Modal CLI token（`ak-` / `as-`）不要写进这个文件：用 Settings / 首次启动的 **Connect this session**，只活在当前进程。只有 Settings 界面本身是新代码时，才需要打一版带这个 UI 的安装包。默认 60s 在 `modal deploy` 之后就会生效，旧 exe 没有这项 Settings 也能用。

冷启动（第一次 Generate 当天）仍可能要几十秒：snapshot restore + 扩展 venv + 把权重 load 进显存。这是**付一次**，不是包月。觉得冷启动不可接受再考虑 `min_containers=1`——那才是“一直 deploy 着一台机器”。

---

## 8. 跑一次就要能对账

报错、取消、或跑完容器没缩，都会让 GPU / CPU 继续占着。每一次 Generate 的调用链、时间轴、估算 USD 记在账本里：[`docs/modal-run-ledger.md`](modal-run-ledger.md)。

```bash
curl -s http://127.0.0.1:8765/runs
modal run modal/app.py::dump_recent_runs
```

取消和超时会 `FunctionCall.cancel(terminate_containers=True)`。Modal 上 spawn 失败**不会**回退到 CPU ASGI 里跑推理。
