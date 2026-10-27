# 本机 Qwen Image 2.1

Vertex → 图片 → 模型菜单选 **Qwen Image 2.1 · 本机**，打开「本机部署」启动。
支持文字生成、上传图片编辑和连续修改；连续修改以最近一张生成图为参考。
结果按登录用户保存到现有媒体历史，不需要 Vertex/Gemini 的凭据。

## 安装

Windows、Python 3.12、支持 CUDA 13 的 NVIDIA 驱动：

```powershell
powershell -File modules/vertex/local-image/install.ps1
```

模型目录用 `install.ps1 -ModelHome <目录>` 指定（约 33.13 GB 权重 + 独立 venv，放在空间充足的数据盘上），
并给 Bridge 进程设同一个 `BRIDGE_LOCAL_IMAGE_HOME`；两边都不设时用 `<数据根>/local-image/qwen-image-2.1`
（源码直跑时数据根就是仓库目录，这个目录已在 `.gitignore` 里）。
下载脚本从官方 ModelScope 仓库逐文件核对大小和 SHA-256，成功后写 `.verified.json`。
安装过程需要网络；运行时设置离线模式，模型读取本地文件。
实现采用 [官方 QwenImage21Pipeline](https://github.com/QwenLM/Qwen-Image-2.1)，
依赖版本固定在 `modules/vertex/local-image/requirements.txt`，权重遵循下载目录中的官方 LICENSE。

Bridge 进程可用 `BRIDGE_LOCAL_IMAGE_HOME` 改目录、`BRIDGE_LOCAL_IMAGE_PORT` 改内部端口（默认 8190）。
安装到其他目录后须同时设置 HOME；不要把模型/venv/key 放进 Git。

## 参数和运行边界

- 部署参数：BF16/FP16、按模型卸载/逐层卸载、VAE 分块及分块尺寸（256/512/768，25% 重叠）、TF32、CPU 线程（1–32）。保存到模型目录的 `settings.json`，运行中保存会重启模型；旧设置文件自动补齐默认字段。
- 生成参数：1K/2K/实验 4K、自定义宽高、比例、1–100 步、种子（-1 随机）、CFG（1–10）与负面提示词、出图数量（1–4）、透明背景、参考图编码预算（512/1024/2048）、前缀 KV 缓存和自定义 Sigma 序列。生成设置在本设备记住，并可恢复默认。
- 默认原生 2K、40 步、CFG=1、开启 KV 缓存；CFG>1 才传入负面提示词（留空仍传空字符串启用 CFG）。自定义 Sigma 必须逐步严格递减且位于 (0,1]，个数必须等于步数。
- 自定义宽高保留输入值，须为 256–6144 之间的 32 倍数，总像素最多 1700 万；不静默缩小。4K 方图为 4096×4096；横屏快捷预设为 3840×2176（满足 32 对齐），可交换宽高。
- 自动比例：文生图为正方形，编辑跟随最后一张参考图。最多 10 张上传参考图，总大小最多 20 MB，顺序即模型读取顺序。已生成图片可直接选择为下一轮参考；内部历史参考预算为 100 MB，以容纳 4K PNG。
- 一次只接一个任务，批量按种子递增逐张生成，降低显存峰值。每张独立保存尺寸、步数、实际种子、耗时及生成参数；历史按批次还原为一轮，批量中任一张可选为下一轮参考。
- 透明背景开关补充官方 RGBA 提示词，不保证所有提示词都生成透明背景；PNG 保留模型的 Alpha 通道。
- 生成期间拒绝停止或改部署参数；不会停止其他模型，也不会杀任意 Python 进程。进度区分编码、采样、解码与保存阶段。
- 与 dimensio 本机聊天模型共用 GPU，跑图前可在 dimensio 停止聊天模型以腾出显存。
- Worker 只绑定 `127.0.0.1`，所有接口需模型目录中的随机令牌；浏览器通过 Bridge 鉴权访问，部署控制仅管理员可用。
- 本机 image-chat 请求用 SSE 心跳和采样进度。手机断线不取消生成，完成后仍进历史。普通 image JSON 接口和媒体 MCP 也能路由本机型号。

点击「停止并释放显存」会退出 worker；再次启动重新加载。Bridge 重启后通过带令牌的健康检查认领原 worker。
日志在模型目录 `worker.log`。启动失败先看日志；不要把服务仅响应 health 当作能出图的验证。

## 验证

```powershell
node --import ./src/modules/register.mjs --test modules/vertex/server/local-image.test.mjs
node web/scripts/i18n-check.mjs web/src/components/VImagePanel.svelte web/src/components/LocalImageSettings.svelte web/src/components/LocalImageDeployment.svelte web/src/lib/vertexMedia.svelte.js web/src/lib/localImageSettings.js --compile
```

发版还需实测出图、编辑、启停、部署参数保存，以及 APK 版本/校验和。

参考实测（2026-10-03，RTX 5090 32GB）：BF16、按模型卸载、VAE 256 分块、CFG=1、4096×4096、40 步成功，耗时 1316.22 秒，PNG 22.27 MB，PyTorch 峰值 allocated 22909 MiB（不含其他进程和 CUDA 保留显存）。画面有少量竖向细纹，4K 保持实验标记，不承诺比 2K 更优。另已实测 512×512、双参考图、CFG=2、负面提示词、4 步自定义 Sigma、关闭 KV 缓存、透明提示、两张批量（种子 100/101）、批次历史还原及连续修改。VAE 512 分块、TF32 关闭、CPU 4 线程的保存重启也已真跑，随后恢复原部署设置。22.27 MB 的 4K 结果直接通过 `referenceId` 继续编辑已实测成功，未经过上传大小限制，也未丢失参考图。
