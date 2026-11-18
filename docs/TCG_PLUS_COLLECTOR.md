# ONE PIECE 日本单场赛事采集器

2026-11-18。用户确认范围：ONE PIECE，日本全部场次。网络权限已恢复，正常 Chrome 页面已实际取得单场响应；完整采集运行中，尚未作为完成结果交付。

## 来源契约

从之前成功浏览 TCG+ 留下的公共 HTTP 缓存恢复前端 `https://www.bandai-tcg-plus.com/dist/js/bundle.js`，核实网站调用：

- GET `/api/user/event/list`：读取 `success.event_list` 与 `success.total`。
- GET `/api/user/event/list/params`：读取可搜索系列目录。本版完整列表不依赖逐系列请求。
- GET `/api/user/event/{id}`：单场详情；本版只采集列表实际提供的公开字段，不请求可能包含个人信息的详情扩展。
- 单场 URL 为 `/event/{id}`，不同于系列 URL `/series/{id}`。

前端使用 `game_title_id`、数组 `country_code`（Axios 序列化为 `country_code[]`）、`limit`、`offset`、`application_open_flg`、`order`；实际成功请求的日期过滤为 `start_date=2026-11-18`。旧缓存中的表单日期格式函数为 `YYYY/MM/DD`，但不能代替对实际查询的核对；新版保留成功请求的 `YYYY-MM-DD`。前端每页选项为 20/40/60/80/100，已在正常浏览器中实测每页 100。

实际响应的名称字段为 `event_series_title`，费用为 `entryFee`，公开报名标记为 `applicationOpen`。列表可包含 BANDAI CARD GAMES 共通活动，原始 `game_title_id` 不同于 8；只有 `/api/user/event/list/params` 的 `event_series_game_title_ids` 明确包含 8，且系列的来源游戏 ID 与记录一致，才纳入 ONE PIECE 清单。例如系列 9093 的关联为 `6,7,8,9,14,15`。导出保留 `source_game_title_id` 与 `game_scope_match`，不把所有其他游戏记录放行。

同一浏览器缓存恢复真实系列第一页：11 条，来源声明 total 为 27，API code 为 200。只投影公开系列字段并保存在忽略目录 `tools/event-collectors/tcg-plus/out/source-evidence-2026-11-18/series-first-page.json`。`source-contract.json` 保存公共缓存哈希与契约摘要，没有保存 cookie、身份信息或原始响应头。该文件是历史缓存证据，不是新的完整采集结果，也不是单场数据。

## 执行与产物

```bash
bash tools/event-collectors/tcg-plus/scrape.sh
```

默认校验 masterdata 中 ID 8 的名称为 ONE PIECE、语言为 JA，然后查询日本、全部都道府县，不过滤工作日和报名状态。已实测目录值为 `ONE PIECE CARD GAME / JA / one_piece_card_game.ja`。Chrome 入口默认开始日期为 Asia/Tokyo 今天，匹配正常页面；可选 `--from` / `--until`，但结束日期包含端点的规则仍需实测。

入口自动启动正常 Chrome、打开已保存偏好的专用 profile、等待页面单场请求成功，再发出公开只读 GET 完成分页，最后关闭浏览器。无需用户逐页操作，不提交申请，不使用登录凭证。直接 Node 请求在本环境返回 HTTP 403，Chrome 请求返回 200；原因尚未归结为特定防护规则。默认采用 Chrome，不使用伪装、代理轮换或挑战绕过。游戏目录使用已验证可用的直接请求，避免独立出现的浏览器目录读取失败。

默认每页 20 条，页间隔 750 毫秒；请求 15 秒超时，不自动重试。按 offset 前进直到取得来源 total 条不同 ID 的场次。最多 10000 页是安全上限，触顶未达到 total 时失败，不输出部分清单。

只有完成后才写出：

- `competitions.json`：具体比赛对象数组，可用于后续数据库导入审阅。
- `competitions.schema.json`：Draft 4 JSON Schema，定义数组结构与允许的公开字段。
- `report.json`：来源、查询条件、请求记录、页数、数量和覆盖局限。

字段包括来源 ID、内部游戏码 OPCG、名称、系列 ID/名称、单场 URL、源开始时间和时区、门店/地址、费用、容量、报名起止时间、取消标识和原始状态。未提供的值为 null；费用未知不等于免费，定员不等于余位。隐藏日期/费用/定员的标志同时保留，后续展示必须尊重它们。当前未核实的时间格式与状态码不转换成假定的 UTC 或开放报名状态。

“完整”仅表示本次查询取得的不同 ID 数量等于来源声明总数。不代表未公开赛事、任意历史赛事、其他语言版本、其他游戏或全球比赛。数量一致也不是服务端原子快照的证明；来源若发生同总量替换仍需后续审计机制。

## 历史失败与本轮验证

- PASS：Node 22.23.5 下 25 项测试；新增测试使用明确标记的合成数据，覆盖多页穷尽、异常页/重复 ID/总数漂移、游戏/国家混入、共通系列游戏关联、页数预算、空结果、字段投影、浏览器 GET 范围与磁盘输出。
- 历史 FAIL：真实执行在 `/api/masterdata` 发生 ENOTFOUND，退出码 1。网络权限调整后 DNS 与目录 HTTP 200 已实测恢复。
- PASS：正常页面中 `game_title_id=8 / country_code[]=JP / start_date=2026-11-18` 返回 `success.total=13587`，20 条单场样本可与正常网页核对；后续采集使用每页 100 条。
- PASS：实际执行前后 183 个商品数据及缩略图文件哈希未变。
- 仍待验证：完整清单数量、最终 Schema 校验、报名状态与隐藏字段语义。当前原始报名标记不等于保证可参加。

失败报告：`tools/event-collectors/tcg-plus/out/events-2026-11-17T15-09-15.169Z-748f89b6/report.json`。时间戳为 UTC，东京已是 11 月 18 日。

本轮完整采集完成后在此追加最终数量和产物路径。没有启动定时任务、创建云资源、提交或发布。
