# TCG+ 采集试验记录

2026-11-17。状态：试验程序与离线测试已完成；当前环境实时获取失败，尚未通过真实采集验收。

2026-11-18 后续进展：从公共前端缓存核实单场列表接口并实现了[日本 ONE PIECE 单场采集器](TCG_PLUS_COLLECTOR.md)。下文保留早期系列试验记录；新的单场程序同样尚未通过实时网络验收。

## 已有真实证据

本机成功运行的 Playwright 会话在 2026-11-17 12:34 UTC 记录了以下 GET 请求返回 HTTP 200。日志只有 JSON 字段形状，不能用作完整 API 响应样本：

- `https://api.bandai-tcg-plus.com/api/masterdata`：`success.code` 为数字，`success.game_title` 为数组；游戏字段包括 `id`、`title`、`language_code`、`game_title_code`。
- `https://api.bandai-tcg-plus.com/api/user/eventseries?game_title_id=8&country_code=JP&limit=11&offset=0`：`success.event_series_list` 为 11 条记录的数组，`success.total` 为字符串。系列字段包括 `event_series_id`、`title`、`apply_start_date`、`apply_end_date`、`display_apply_period`、`series_type`。

同一会话的可见页面包含「スタンダードバトル（12月開催）」「交流会（12月開催）」等系列和 ONE PIECE 版权文本。这支持继续核对 game ID 8，但正式映射仍需用 masterdata 的实际游戏名称与语言版本确认。页面同时显示「ログイン」；这不能独立证明接口完全不依赖会话。

界面语言、游戏版本和国家是独立概念。`apply_*` 表示申请相关字段，不能作为单场举办时间。尚未观察到单场列表/详情接口，不猜测其路径或参数。

## 可重复执行的试验

在仓库根目录执行：

```bash
bash tools/event-collectors/tcg-plus/trial.sh
```

程序只向已观察的两个接口发送 GET。先读取游戏目录并校验 ONE PIECE 名称，再请求系列页面，默认最多三页，每页 11 条；每个请求超时 15 秒，系列页间隔 750 毫秒。支持 `--game-title-id` 和 `--max-pages`；前者必须通过实时目录名称检查，不能据此自动认定游戏语言版本。

输出为忽略提交的 `tools/event-collectors/tcg-plus/out/trial-*/report.json`，不修改数据库、`data/`、缩略图或部署配置。游戏与系列只输出允许的公开字段，失败不输出半批系列。报告记录 HTTP 状态和来源数值 code；code 语义尚未确认，因此样本采集成功不代表生产接口契约验证成功。

每次运行还会复制 `tools/event-collectors/tcg-plus/trial-report.schema.json` 为同目录的 `report.schema.json`。报告通过 `$schema` 引用该文件，使用 JSON Schema Draft 4，分别定义非空样本、空列表和失败三种结果；失败分支禁止包含 `series`。2026-11-17 14:58 UTC 再次实测仍以 `ENOTFOUND` 失败，但实际失败报告已通过本机 jsonschema 2.6.0 的 Draft4Validator 结构校验；错误报告含半批 series、或缺少必需字段却标记采集成功，均被拒绝。该结果证明输出格式与错误处理，不证明赛事采集成功。

`complete_series_listing` 表示本次取得数量是否等于来源 total；`multiple_pages_fetched` 只表示确实取得多页。重复 ID、total 改变、提前空页/短页会失败，不能静默宣称完整。到达页数上限时允许返回部分样本，覆盖状态明确为不完整。

## 本轮结果

- 13 项自动测试通过，包括原有浏览器工具测试及新增采集试验测试。新增响应均为明确标记的合成夹具，不是实时赛事数据。
- 实际执行 `trial.sh`：`/api/masterdata` 请求以 `ENOTFOUND` 失败，退出码 1；失败报告已保存在本地忽略目录。
- 比较执行前后的 183 个现有数据及缩略图文件：哈希均未变化。
- 当前没有活动的浏览器文件控制服务。此前沙箱内启动 Chrome 被 macOS IPC 权限拒绝。TinyFish 工具本轮已不可用，网页读取工具也未能读取该 API。

## 进入导入器开发前的验收

1. 在具备正常网络的执行环境运行同一命令，取得真实目录和系列样本，确认来源游戏名称、语言版本及数值 code 语义。
2. 实测第二页请求，并与正常页面显示及 total 核对。结果仅有一页时，不声称分页已实测。
3. 在正常赛事查询流程中观察单场接口，取得至少两个都道府县、多个日期的样本，核对场次 ID、地点、时区和报名状态。
4. 在上述证据齐备后才增加字段映射、数据库导入和定时运行。本轮没有配置定时任务或生产资源。
