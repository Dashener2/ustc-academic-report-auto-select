#!/usr/bin/env node
/**
 * USTC 学术报告选课监控
 * ------------------------------------------------------------
 * 轮询「未选报告」接口，发现新出现的、属于白名单院系、且仍在选课窗口内的
 * 学术报告时，通过 提示音 + 弹窗（+ 可选微信 webhook）通知。
 *
 * 只做读取，不选课。
 *
 * 用法：
 *   node monitor.js --init      首次初始化基线（把当前已有的记为"已见"，不报警）
 *   node monitor.js             开始持续监控
 *   node monitor.js --once      只查一次（调试用）
 *   node monitor.js --reset     清空已见记录
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const LOG_PATH = path.join(DIR, 'monitor.log');

// ---------- 配置 ----------
// 首次运行：没有 config.json 就从模板生成一份
const EXAMPLE_PATH = path.join(DIR, 'config.example.json');
if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_PATH)) {
  fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  console.log('[提示] 未找到 config.json，已从 config.example.json 生成，请按需修改。');
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const COOKIE_PATH = path.join(DIR, config.cookieFile || 'cookie.txt');
// Cookie 可能还没有（全新克隆首次运行），此时留空，靠浏览器自动获取
function readCookieFile() {
  try {
    return fs.readFileSync(COOKIE_PATH, 'utf8').trim();
  } catch (_) {
    return '';
  }
}
let cookie = readCookieFile();
function reloadCookie() {
  cookie = readCookieFile();
}

const HOST = 'yjs1.ustc.edu.cn';
const API = '/gsapp/sys/xsbgglappustc/modules/xsbgxk/wxbgbgdz.do';
const PAGE_URL = 'https://yjs1.ustc.edu.cn/gsapp/sys/xsbgglappustc/*default/index.do#/xsbgxk';
const REFERER = PAGE_URL.replace('#/xsbgxk', '');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

// 构建标识：改动代码后就更新它，方便从日志判断运行的到底是哪个版本
const BUILD = 'v1.2.0 / 2026-10-26 / 失效提醒节流 + 恢复节流 + 微信告警';

// ---------- 日志 ----------
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (_) {}
}

// ---------- 请求 ----------
function post(body) {
  return new Promise((resolve) => {
    const headers = {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      origin: 'https://' + HOST,
      referer: REFERER,
      'user-agent': UA,
      cookie,
      'content-length': Buffer.byteLength(body),
    };
    const req = https.request({ hostname: HOST, port: 443, path: API, method: 'POST', headers }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.setTimeout(30000, () => req.destroy(new Error('请求超时 30s')));
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.write(body);
    req.end();
  });
}

// ---------- 拉取某院系全部报告 ----------
async function fetchDept(code) {
  // 先拿一页确定总数，再分页取全
  const pageSize = config.pageSize || 200;
  const first = await post(`*json=1&pageSize=${pageSize}&pageNumber=1&YXDM=${code}`);
  if (first.status !== 200) return { code, error: `HTTP ${first.status} ${first.error || ''}` };

  let json;
  try {
    json = JSON.parse(first.body);
  } catch (e) {
    return { code, error: `响应不是 JSON（可能 Cookie 失效）: ${first.body.slice(0, 120)}` };
  }
  const model = json.datas && json.datas.wxbgbgdz;
  if (!model) return { code, error: '响应缺少 datas.wxbgbgdz（接口结构变化或未登录）' };

  const rows = [...model.rows];
  const total = model.totalSize;
  const pages = Math.ceil(total / pageSize);
  for (let p = 2; p <= pages; p++) {
    const r = await post(`*json=1&pageSize=${pageSize}&pageNumber=${p}&YXDM=${code}`);
    if (r.status !== 200) continue;
    try {
      const j = JSON.parse(r.body);
      if (j.datas && j.datas.wxbgbgdz) rows.push(...j.datas.wxbgbgdz.rows);
    } catch (_) {}
  }
  return { code, total, rows };
}

// ---------- 过滤 ----------
function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(/-/g, '/'));
  return isNaN(d.getTime()) ? null : d;
}

function isEligible(row, now) {
  // 1) 白名单院系
  if (!config.departments[row.YXDM]) return false;
  // 2) 选课截止时间必须晚于现在
  if (config.requireFutureDeadline) {
    const dl = parseDate(row.JZSJ);
    if (!dl || dl <= now) return false;
  }
  // 3) 服务端「是否可选课」标记
  if (config.requireSelectable && String(row.SFKXK) !== '1') return false;
  // 4) 剩余名额
  const remain = Number(row.KXRS || 0) - Number(row.YXRS || 0);
  if (config.minRemainingSeats > 0 && remain < config.minRemainingSeats) return false;
  return true;
}

// ---------- 提交选课 ----------
const API_SELECT = '/gsapp/sys/xsbgglappustc/xsbgxkController/selectBg.do';

function submitOne(bgbm) {
  return new Promise((resolve) => {
    // 框架 XGJSUTIL.convertParam 把参数包成 { data: JSON.stringify(obj) }
    const body = 'data=' + encodeURIComponent(JSON.stringify({ BGBM: bgbm }));
    const headers = {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      origin: 'https://' + HOST,
      referer: REFERER,
      'user-agent': UA,
      cookie,
      'content-length': Buffer.byteLength(body),
    };
    const req = https.request(
      { hostname: HOST, port: 443, path: API_SELECT, method: 'POST', headers },
      (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => {
          const text = Buffer.concat(c).toString('utf8');
          let ok = false;
          let msg = '';
          try {
            const j = JSON.parse(text);
            ok = j.code === '0';
            msg = ok ? '' : j.msg || j.message || j.returnData || '未知原因';
          } catch (_) {
            msg = '响应非 JSON';
          }
          resolve({ ok, msg, raw: text });
        });
      }
    );
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, msg: e.message, raw: '' }));
    req.write(body);
    req.end();
  });
}

// ---------- 微信推送（多 provider） ----------
function postBody(url, bodyStr, ctype, label) {
  return new Promise((resolve) => {
    let u;
    try {
      u = url instanceof URL ? url : new URL(url);
    } catch (e) {
      log(`[${label}] 配置有误: ${e.message}`);
      return resolve({ ok: false, msg: e.message });
    }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? require('https') : require('http');
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': ctype,
          'Content-Length': Buffer.byteLength(bodyStr),
          'User-Agent': UA,
        },
      },
      (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => {
          const t = Buffer.concat(c).toString('utf8');
          const ok =
            res.statusCode >= 200 &&
            res.statusCode < 300 &&
            /"code":\s*0|"errno":\s*0|"errcode":\s*0/.test(t);
          log(`[${label}] 推送响应 HTTP ${res.statusCode}: ${t.slice(0, 200)}`);
          resolve({ ok, status: res.statusCode, body: t });
        });
      }
    );
    req.setTimeout(20000, () => req.destroy(new Error('timeout 20s')));
    req.on('error', (e) => {
      log(`[${label}] 推送失败: ${e.message}`);
      resolve({ ok: false, msg: e.message });
    });
    req.write(bodyStr);
    req.end();
  });
}

async function sendWechat(text, attempt = 1) {
  const n = config.notify || {};
  const w = n.wechat || {};
  const title = 'USTC 学术报告：有新的可选！';

  let res = null;
  if ((!w.type || !w.key) && n.wechatWebhook) {
    res = await postBody(
      n.wechatWebhook,
      JSON.stringify({ msgtype: 'text', text: { content: text } }),
      'application/json',
      '企业微信'
    );
  } else if (!w.type || !w.key) {
    return { ok: false, msg: '未配置微信推送' };
  } else if (w.type === 'wecom') {
    res = await postBody(
      w.key,
      JSON.stringify({ msgtype: 'text', text: { content: text } }),
      'application/json',
      '企业微信'
    );
  } else if (w.type === 'serverchan') {
    const body =
      'title=' + encodeURIComponent(title) + '&desp=' + encodeURIComponent(text.replace(/\n/g, '\n\n'));
    res = await postBody(`https://sctapi.ftqq.com/${w.key}.send`, body, 'application/x-www-form-urlencoded', 'Server酱');
  } else if (w.type === 'pushplus') {
    const body = JSON.stringify({
      token: w.key,
      title,
      content: text.replace(/\n/g, '<br>'),
      template: 'html',
    });
    res = await postBody('https://www.pushplus.plus/send', body, 'application/json', 'PushPlus');
  } else {
    log(`[微信] 未知的 type: ${w.type}（可选 serverchan / pushplus / wecom）`);
    return { ok: false, msg: '未知 type' };
  }

  if (res && !res.ok && attempt < 2) {
    log(`[微信] 第 ${attempt} 次推送未成功，2 秒后重试一次`);
    await new Promise((r) => setTimeout(r, 2000));
    return sendWechat(text, attempt + 1);
  }
  return res || { ok: false };
}

// ---------- 通知 ----------
async function notify(items, submitResults) {
  const n = config.notify || {};
  const results = submitResults || {};
  const lines = items.map((r) => {
    const remain = Number(r.KXRS || 0) - Number(r.YXRS || 0);
    let extra = '';
    if (results[r.BGBM]) {
      const st = results[r.BGBM];
      if (st.status === 'ok') extra = '  >> 已自动选课成功 ✅';
      else if (st.status === 'skip') extra = '  >> 需你手动选课';
      else extra = `  >> 自动选课失败: ${st.msg} ❌`;
    }
    return [
      `【${config.departments[r.YXDM]}】${r.BGTMZW || '(无标题)'}`,
      `  报告人: ${r.BGRZW || '-'}   截止: ${r.JZSJ || '-'}`,
      `  名额: 已选 ${r.YXRS} / 计划 ${r.KXRS}${Number(r.YXRS) < Number(r.KXRS) ? `，剩余 ${Number(r.KXRS) - Number(r.YXRS)}` : '（已满）'}${extra}`,
    ].join('\n');
  });
  const text = `发现 ${items.length} 条新的可选学术报告\n\n` + lines.join('\n\n') + `\n\n选课页: ${PAGE_URL}`;

  log('--- 通知内容 ---\n' + text);

  if (n.sound) {
    try {
      spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        '[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -m 300; [System.Media.SystemSounds]::Exclamation.Play();'],
        { detached: true, stdio: 'ignore' }).unref();
    } catch (_) {}
  }
  if (n.popup) {
    try {
      const safe = text.replace(/'/g, "''").slice(0, 1200);
      spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${safe}','新的学术报告可选','OK','Information') | Out-Null`],
        { detached: true, stdio: 'ignore' }).unref();
    } catch (_) {}
  }
  if (n.openPage) {
    try {
      spawn('cmd', ['/c', 'start', '', PAGE_URL], { detached: true, stdio: 'ignore' }).unref();
    } catch (_) {}
  }
  const wr = await sendWechat(text);
  if (wr && wr.ok) log('[微信] 推送成功 ✅');
  else log(`[微信] 推送未成功：${(wr && (wr.msg || wr.status)) || '未知原因'}`);
}

// ---------- 登录态失效提醒（带节流，避免每轮都弹窗轰炸） ----------
const SESSION_NOTIFY_INTERVAL = 2 * 3600 * 1000; // 2 小时内只提醒一次
const RECOVER_INTERVAL = 15 * 60 * 1000; // 自动恢复最多 15 分钟试一次
let lastSessionNotifyAt = 0;
let lastRecoverAt = 0;

async function notifySessionLost() {
  const n = config.notify || {};
  const text =
    '登录态已失效，监控已停止选课。\n\n请回到电脑，双击 login-manual.bat 重新登录一次\n（在弹出的 Chrome 窗口里登录，不用复制 Cookie）';

  const throttled = Date.now() - lastSessionNotifyAt < SESSION_NOTIFY_INTERVAL;
  if (throttled) {
    log('[提醒] 2 小时内已提醒过登录失效，本轮不再弹窗/推送');
    return;
  }
  lastSessionNotifyAt = Date.now();

  if (n.sound) {
    try {
      spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        '[System.Media.SystemSounds]::Hand.Play(); Start-Sleep -m 300; [System.Media.SystemSounds]::Hand.Play();'],
        { detached: true, stdio: 'ignore' }).unref();
    } catch (_) {}
  }
  if (n.popup) {
    try {
      const safe = text.replace(/'/g, "''");
      spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${safe}','需要重新登录','OK','Warning') | Out-Null`],
        { detached: true, stdio: 'ignore' }).unref();
    } catch (_) {}
  }
  // 同时推微信，人不在电脑前也能知道
  const wr = await sendWechat(text);
  if (wr && wr.ok) log('[微信] 登录失效提醒已推送 ✅');
  else log('[微信] 登录失效提醒推送未成功');
}

// ---------- 状态 ----------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return { seen: {} };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// ---------- 单轮检查 ----------
async function checkOnce({ initMode = false } = {}) {
  const now = new Date();
  const state = loadState();
  const firstRun = Object.keys(state.seen).length === 0;

  const codes = Object.keys(config.departments);

  // 扫描所有白名单院系
  const scanAll = async () => {
    const rows = [];
    const errs = [];
    for (const code of codes) {
      const d = await fetchDept(code);
      if (d.error) {
        errs.push(`${code} ${config.departments[code]}: ${d.error}`);
        continue;
      }
      rows.push(...d.rows);
    }
    return { rows, errs };
  };

  let { rows: all, errs: errors } = await scanAll();

  if (errors.length) {
    errors.forEach((e) => log('采集失败 ' + e));

    if (errors.length === codes.length) {
      // 先区分：是登录态失效(401/403)，还是网络断/超时/服务器 5xx
      const isAuthProblem = errors.some((e) => /HTTP\s*(401|403)|登录|Cookie/i.test(e));
      const isNetworkProblem = errors.some((e) =>
        /HTTP\s*0\b|HTTP\s*5\d\d|timeout|超时|ECONN|ENOTFOUND|ETIMEDOUT|socket|getaddrinfo/i.test(e)
      );

      if (!isAuthProblem && isNetworkProblem) {
        log('疑似网络问题（断网/超时/服务器异常），不是登录态失效');
        log('跳过登录刷新，等待下一轮自动重试');
        return { ok: false };
      }

      // 登录态失效 → 尝试用浏览器 profile 自动恢复
      if (Date.now() - lastRecoverAt < RECOVER_INTERVAL) {
        const mins = Math.round((Date.now() - lastRecoverAt) / 60000);
        log(`上次自动恢复在 ${mins} 分钟前，未满 15 分钟，跳过本轮（不重复启动浏览器）`);
        return { ok: false };
      }
      lastRecoverAt = Date.now();

      log('全部院系采集失败，尝试自动恢复登录态...');
      const r = spawnSync(process.execPath, [path.join(DIR, 'browser-session.js'), '--auto'], {
        cwd: DIR,
        stdio: 'inherit',
        timeout: 180000,
      });
      if (r.status === 0) {
        reloadCookie();
        log('登录态已自动刷新，重试采集...');
        ({ rows: all, errs: errors } = await scanAll());
        if (errors.length === codes.length) {
          log('刷新后仍然失败，可能需要人工登录');
          await notifySessionLost();
          return { ok: false };
        }
        log(`重试成功，采集 ${all.length} 条`);
      } else {
        log('自动恢复失败：浏览器 profile 里也没有有效登录态');
        log('>>> 请双击 login-manual.bat 重新登录一次（只需登录，不用再复制 Cookie）');
        await notifySessionLost();
        return { ok: false };
      }
    }
  }

  if (errors.length) errors.forEach((e) => log('部分院系采集失败 ' + e));

  // 去重
  const byId = new Map();
  all.forEach((r) => {
    if (!byId.has(r.BGBM)) byId.set(r.BGBM, r);
  });

  const eligible = [...byId.values()].filter((r) => isEligible(r, now));
  log(`采集 ${byId.size} 条，符合条件 ${eligible.length} 条`);

  const fresh = eligible.filter((r) => !state.seen[r.BGBM]);

  if (initMode || (firstRun && config.silentFirstRun)) {
    eligible.forEach((r) => {
      state.seen[r.BGBM] = { first: new Date().toISOString(), title: r.BGTMZW, dept: r.YXDM_DISPLAY };
    });
    saveState(state);
    log(`初始化基线：记录 ${eligible.length} 条，不发出通知`);
    return { ok: true, fresh: [] };
  }

  if (fresh.length) {
    const results = {};
    const kws = config.autoSelectKeywords || [];
    if (config.autoSelect) {
      for (const r of fresh) {
        if (kws.length && !kws.some((k) => String(r.BGTMZW || '').includes(k))) {
          results[r.BGBM] = { status: 'skip', msg: '标题未命中关键词，跳过自动选课' };
          log(`跳过（未命中关键词）: ${r.BGTMZW}`);
          continue;
        }
        log(`自动选课: ${r.BGTMZW} (${r.BGBM})`);
        const res = await submitOne(r.BGBM);
        results[r.BGBM] = { status: res.ok ? 'ok' : 'fail', msg: res.msg };
        log(res.ok ? '  提交成功' : `  提交失败: ${res.msg}`);
      }
    }
    await notify(fresh, results);
    fresh.forEach((r) => {
      state.seen[r.BGBM] = { first: new Date().toISOString(), title: r.BGTMZW, dept: r.YXDM_DISPLAY };
    });
  }
  // 顺手清理：已过截止时间 30 天以上的记录
  for (const id of Object.keys(state.seen)) {
    const t = new Date(state.seen[id].first).getTime();
    if (Date.now() - t > 30 * 24 * 3600 * 1000) delete state.seen[id];
  }
  saveState(state);

  return { ok: true, fresh };
}

// ---------- 主流程 ----------
(async () => {
  const arg = process.argv[2];
  log('=== 学术报告监控 ' + BUILD + ' ===');

  if (arg === '--reset') {
    saveState({ seen: {} });
    log('已清空 state.json');
    return;
  }
  if (arg === '--init') {
    log('初始化模式：把当前符合条件的报告记为基线');
    await checkOnce({ initMode: true });
    log('初始化完成');
    return;
  }
  if (arg === '--once') {
    const r = await checkOnce();
    log(`单次检查完成，新增 ${(r.fresh || []).length} 条`);
    return;
  }
  if (arg === '--test-wechat') {
    const w = (config.notify && config.notify.wechat) || {};
    if (!w.type || !w.key) {
      log('微信推送还没配置：请编辑 config.json 的 notify.wechat（type + key）');
      log('当前为空，未发送任何消息');
      return;
    }
    log(`测试微信推送（type=${w.type}）...`);
    sendWechat('这是一条测试推送\n\n看到这条说明微信通道已打通 ✅\n来自 USTC 学术报告监控');
    log('已发起推送，观察上面的响应日志（大约几秒内出结果）');
    return;
  }

  if (arg === '--test') {
    log('发送测试通知（假数据，不会写入 state.json）');
    await notify([
      {
        YXDM: '011',
        BGTMZW: '【测试】这是一条模拟的新报告通知',
        BGRZW: '测试报告人',
        JZSJ: '2026-12-31 23:59:59',
        KXRS: '100',
        YXRS: '37',
      },
    ]);
    log('测试通知已发送。若没看到弹窗/没听到声音，请检查系统通知设置。');
    return;
  }

  const intervalMs = (config.pollIntervalMinutes || 5) * 60 * 1000;

  // 防止任何未捕获异常导致进程静默退出
  process.on('unhandledRejection', (e) => {
    log('未处理的 Promise 异常（已忽略，进程继续）: ' + (e && e.message ? e.message : String(e)));
  });
  process.on('uncaughtException', (e) => {
    log('未捕获异常（已忽略，进程继续）: ' + (e && e.message ? e.message : String(e)));
  });

  log(`监控启动，间隔 ${config.pollIntervalMinutes} 分钟，白名单 ${Object.keys(config.departments).length} 个院系`);
  log('构建: ' + BUILD);
  log('提示：请保持此窗口开启，关掉窗口 = 停止监控');

  let round = 0;
  const runRound = async () => {
    round++;
    try {
      await checkOnce();
    } catch (e) {
      log(`第 ${round} 轮检查异常: ${e.message}`);
    }
    const next = new Date(Date.now() + intervalMs);
    log(`第 ${round} 轮结束，下次检查 ${next.toLocaleTimeString('zh-CN')}`);
  };

  await runRound();
  setInterval(runRound, intervalMs);
})();
