# 中科大学术报告自动选课

> USTC Academic Report Auto-Select

监控中国科学技术大学研究生综合服务平台（`yjs1.ustc.edu.cn`）的「学术报告选课」，发现**指定院系新开放的、仍有名额的**学术报告时，自动提交选课并通过**微信 / 桌面弹窗**通知。

---

## ⚠️ 免责声明

本项目为个人学习用途的技术实践，**使用者需自行承担全部后果**：

- 请务必先确认学校的相关规定，部分院系对「学术报告」的选课有明确要求
- 自动选课可能选到你并不想听的报告，请定期核对
- 高频轮询会给服务器带来压力，默认已设为较保守的 5 分钟
- 因使用本工具导致的任何后果，作者不承担责任

**建议**：先用 `autoSelect: false` 只观察一段时间，确认过滤规则符合预期后再开启自动提交。

---

## 功能

- 🔍 **定时监控** — 默认每 5 分钟扫描一次白名单院系
- 🎯 **精准过滤** — 院系白名单 ∧ 未过选课截止 ∧ 系统标记可选 ∧ 仍有余位
- ✅ **自动选课** — 命中即提交，并校验服务器返回码
- 📱 **多渠道通知** — 提示音、桌面弹窗、自动打开选课页、微信推送
- 🔐 **登录态自动续期** — 托管独立浏览器配置，无需反复手动复制 Cookie
- 🧾 **去重不打扰** — 已通知过的报告不会重复推送

---

## 工作原理

平台是金智 EMAP 框架，接口逆向结论：

| 动作 | 接口 | 参数 |
|---|---|---|
| 未选报告列表 | `POST /gsapp/sys/xsbgglappustc/modules/xsbgxk/wxbgbgdz.do` | `*json=1&pageSize=N&pageNumber=M&YXDM=院系代码` |
| 已选报告列表 | `POST /gsapp/sys/xsbgglappustc/modules/xsbgxk/yxbgbgdz.do` | `*json=1&pageSize=N&pageNumber=M` |
| 选课 | `POST /gsapp/sys/xsbgglappustc/xsbgxkController/selectBg.do` | `data={"BGBM":"报告编码"}` |
| 退课 | `POST /gsapp/sys/xsbgglappustc/xsbgxkController/cancelBg.do` | `data={"BGBM":"报告编码"}` |

几个踩过的坑，供后来者参考：

1. **模块在 iframe 里** — 无法直接操作，但可以直连 `.../xsbgglappustc/*default/index.do` 独立打开
2. **控制器参数要包一层** — 框架的 `XGJSUTIL.convertParam` 会把参数转成 `{data: JSON.stringify(obj)}`，传裸 `BGBM=` 会得到 `code:-1 SwException`
3. **`KXRS` 是计划名额不是硬上限** — 库里能看到「已选 > 计划」的历史记录（事后调整或管理员补录），但提交时满了就选不上
4. **无会话时跳的是 `dbLogin` 而非 CAS** — 要走 `portal/index.do?forceCas=1` 才会进统一身份认证
5. **静态 JS 以 `application/stream` 附件下发** — 浏览器打开会触发下载，用 HTTP 客户端直接取才能读到

---

## 环境要求

- Windows（用到 PowerShell 弹窗与提示音；核心逻辑跨平台）
- Node.js ≥ 18
- 本机已安装 Chrome 或 Edge

---

## 快速开始

```bash
npm install
```

1. **登录授权**（只需一次）
   ```
   双击 setup-login.bat
   ```
   会先静默尝试用已有登录态进站；失败才弹出 Chrome 让你走统一身份认证登录。

2. **配置微信推送**（可选）— 编辑 `config.json`：
   ```jsonc
   "notify": {
     "wechat": { "type": "serverchan", "key": "SCT你的SendKey" }
   }
   ```
   支持 `serverchan` / `pushplus` / `wecom`（企业微信群机器人）。

3. **测试通知**
   ```
   双击 test-notify.bat
   ```

4. **启动监控**
   ```
   双击 start-monitor.bat
   ```
   窗口保持开启即监控中。

> 首次运行会自动从 `config.example.json` 生成 `config.json`，按需修改即可。

---

## 常用命令

```bash
node monitor.js                # 持续监控
node monitor.js --once         # 只查一次
node monitor.js --test         # 发一条假通知测试渠道
node monitor.js --test-wechat  # 只测微信通道
node monitor.js --reset        # 清空"已见"记录

node submit.js list            # 列出当前可选的报告（带序号）
node submit.js mine            # 列出已选报告
node submit.js select 1        # 选第 1 条
node submit.js cancel 1        # 退第 1 条
node submit.js selftest        # 验证接口连通性（不会选上任何东西）

node browser-session.js        # 静默续期，失败则弹窗登录
node browser-session.js --auto # 仅静默（供脚本调用，退出码 2 = 需人工登录）
```

---

## 配置说明（`config.json`）

| 参数 | 说明 |
|---|---|
| `departments` | 白名单院系，键是系统 `YXDM` 代码 |
| `pollIntervalMinutes` | 轮询间隔，默认 5 |
| `minRemainingSeats` | `1` = 已满的排除；`0` = 已满也通知 |
| `requireSelectable` | 只认系统标记 `SFKXK=1` |
| `requireFutureDeadline` | 只认未过选课截止的 |
| `autoSelect` | `true` = 自动提交；`false` = 只通知 |
| `autoSelectKeywords` | 空 = 全选；填了则只有标题命中的自动选 |
| `notify.sound` / `popup` / `openPage` | 提示音 / 弹窗 / 自动打开选课页 |
| `notify.wechat` | 微信推送：`type` + `key` |

### 院系代码

内置的信息与智能学部各院系：

| 代码 | 院系 |
|---|---|
| `210` | 信息科学技术学院 |
| `006` | 电子工程与信息科学系 |
| `010` | 自动化系 |
| `011` | 计算机科学与技术学院 |
| `229` | 人工智能与数据科学学院 |
| `221` | 网络空间安全学院 |
| `219` | 微电子学院 |
| `225` | 软件学院 |

---

## 项目结构

```
ustc-monitor/
├── monitor.js            # 主程序：轮询 + 过滤 + 自动选课 + 通知
├── submit.js             # 选课 / 退课 / 查询
├── browser-session.js    # 登录态管理（puppeteer-core 驱动本机 Chrome）
├── config.example.json   # 配置模板
├── config.json           # 你的配置（已被 .gitignore 忽略）
├── cookie.txt            # 自动导出的 Cookie（已被忽略）
├── .chrome-profile/      # 持久化登录态（已被忽略，勿删）
├── state.json            # 已通知记录（已被忽略）
├── start-monitor.bat     # 启动监控
├── setup-login.bat       # 登录 / 续期
├── reset-login.bat       # 登录态重置（重定向死循环时用）
└── test-notify.bat       # 测试通知
```

---

## 登录态是怎么维持的

脚本用**独立的 Chrome 配置目录** `.chrome-profile` 保存登录态：

1. 每次运行把 `cookie.txt` 里现有的 Cookie **注入**浏览器
2. 打开模块页，确认登录有效后，通过 CDP `Network.getAllCookies` 导出全部 Cookie
3. 导出的 Cookie 含 `rememberToken`，比手动粘贴的更长寿

监控发现接口返回 401 时，会自动调 `browser-session.js --auto` 静默重取；只有 profile 也失效时才弹窗让你重新登录。

**已区分登录失效与网络故障**：`HTTP 401/403` 才触发刷新，`HTTP 0/5xx`、超时、DNS 失败等按网络问题处理，不会误打扰。

---

## 常见问题

**Q：窗口关了会怎样？**
监控停止。重新双击 `start-monitor.bat` 即可，状态记录在 `state.json` 中不会丢。

**Q：电脑睡眠时还在跑吗？**
不会。系统休眠会挂起进程，建议把电源计划设为「从不睡眠」。

**Q：微信收不到推送？**
先在 `config.json` 填好 `notify.wechat`，再跑 `node monitor.js --test-wechat` 看返回。Server酱 免费额度为 5 条/天，超额会失败但选课照常执行。

**Q：担心自动选到不想要的报告？**
把 `autoSelect` 设为 `false` 只观察，或给 `autoSelectKeywords` 填关键词。选错了用 `node submit.js cancel <序号>` 退掉。

**Q：浏览器报 `ERR_TOO_MANY_REDIRECTS`（重定向次数过多）？**

失效但服务器仍认得的旧 Cookie 会让模块页和登录页互相弹来弹去。双击 `reset-login.bat`，它会删掉 `.chrome-profile` 并重新走一次登录。

**Q：为什么过几天就要重新登录？**

学校会话有服务器端的绝对有效期（实测约 5 天），本地怎么续期都绕不过。到期后监控会弹窗并推微信提醒，双击 `setup-login.bat` 花 30 秒重登即可。

**Q：Cookie 一直失效？**
删掉 `.chrome-profile` 目录，重新跑 `setup-login.bat` 完整登录一次。

---

## 安全

以下文件**已被 `.gitignore` 排除**，切勿提交：

- `cookie.txt` — 等同账号会话凭证
- `config.json` — 可能含微信推送密钥
- `.chrome-profile/` — 完整登录态

---

## License

MIT
