# 每一次 Generate 的调用链和费用

选一个模型点 Generate 之后，中间报错、取消、或者跑完容器没缩下来，远程 GPU / CPU 都会继续计费。这一页是**开发者怎么读账本**、**维护者怎么止血**。

`useApi` / Generate / JobStatus **没有改**。桌面还是每秒 `GET /generate/status/{id}`。账本是 overlay 自己记的。

## 一次运行长什么样

```
Electron UI
  POST /generate/from-image          useApi，未改
        │
        ▼
127.0.0.1:8765 网关                   /health 本地；/runs 不缓存
        │
        ▼
CPU ASGI  api/main.py
  open_run → spawn GpuGenerator.generate
        │                         FunctionCall.object_id 写入账本
        ▼
GPU Cls   gpu_enter → generate → finally gpu_leave
        │
        ▼
GET /generate/status  每秒            touch_poll + 超时则 cancel
POST /generate/cancel                 FunctionCall.cancel(terminate_containers=True)
GET /runs  /  GET /runs/{job_id}      调用链 + span + 估算 USD
```

`chain` 字段按发生顺序记 hop，例如：

`desktop.8765 → gateway → cpu.asgi → cpu.accept → gpu.worker → cpu.spawn_gpu → gpu.generate`

`spans` 是时间轴。状态轮询**不会**每人一次 span，只延长一条 `cpu.poll`，并记 `cpu_polls`。

## 钱怎么算

Modal 按**容器窗口**收钱：该类 span 第一次开始 → 最后一次结束，再加上缩容秒数。重叠的 `gpu.step` **不**加总。

| 项 | 默认 | 来源 |
|----|------|------|
| L40S | $0.000542 / s | [modal.com/pricing](https://modal.com/pricing)（2026-08） |
| CPU ASGI | $0.000047 / s | 估算，不是发票 |
| GPU 缩容 | 5 s | `MODLY_GPU_SCALEDOWN` |
| CPU 缩容 | 8 s | `MODLY_CPU_SCALEDOWN` |
| GPU 函数超时 | **20 min** | `MODLY_GPU_TIMEOUT`（以前是 1 小时） |

`bill.estimated_usd` 是估算。GPU span 如果还开着，估算**封顶**在超时秒数，避免你三小时后打开 `/runs` 看到三小时的假账单。

本地跑（没有 `MODLY_RUNTIME=modal`）`gpu` 为空，GPU 项为 $0。

## 谁负责把机器停掉

以前 `spawn()` 的返回值被丢掉。报错或点取消之后，`FunctionCall` 还在，L40S 可以空转到函数超时。

现在：

| 事件 | 动作 |
|------|------|
| 客户端取消 | `stop_run_compute` → `FunctionCall.cancel(terminate_containers=True)` |
| 状态轮询发现 GPU 超过 20 min | 同上，JobStatus = error |
| spawn 了但 GPU 一直没 `gpu_enter` | `spawn_hung`，同样 cancel |
| 任务已结束但 GPU span 还开着 | `GET /runs` / `dump_recent_runs` 会 **heal**：cancel + 关掉 span |
| Modal 上 spawn 失败 | **不会**回退到 CPU ASGI 里跑 generate（那会把模型加载到 CPU 上并钉住 ASGI） |

`terminate_containers=True` 是必须的：`generate()` 只在 progress 回调里看取消标志，模型内部卡住时看不到。

## 怎么看

桌面在跑的时候：

```bash
curl -s http://127.0.0.1:8765/runs | python -m json.tool
curl -s http://127.0.0.1:8765/runs/<job_id> | python -m json.tool
```

ASGI 已经缩到 0 之后：

```bash
modal run modal/app.py::dump_recent_runs
```

网关**不会**缓存 `/runs`。打开桌面仍然不唤醒 Modal（`/health` 本地）。

## 代码从哪读（维护者）

三层，互不倒进口 `modal` 到账本：

| 模块 | 职责 |
|------|------|
| `api/services/run_ledger.py` | `Span` / `Bill` / `RunRecord`。纯数据。 |
| `api/services/run_store.py` | 本地内存；Modal 上 `modal.Dict` `modly-runs` |
| `api/services/run_tracker.py` | 门面，**永不抛错**。`heal_run` 在读账本时止血。 |
| `api/services/modal_runtime.py` | `spawn` + `FunctionCall.cancel` |
| `api/routers/runs.py` | `GET /runs`，不进 `useApi` |

CodeGraph：`callers spawn_gpu_generation` 只有 `generate_from_image` 和 `create_run_from_image`。`callers useApi` 仍是那 6 条边。不要把 Modal `if` 写回 Generate。
