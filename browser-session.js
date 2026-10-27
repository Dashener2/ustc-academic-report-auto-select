#!/usr/bin/env node
/**
 * 浏览器会话管理 —— 彻底解决 Cookie 过期问题
 * ------------------------------------------------------------
 * 用一个独立的 Chrome 配置目录（.chrome-profile）保存 USTC 登录态。
 * 每次运行会把 cookie.txt 里现有的 Cookie 先"灌"进浏览器，
 * 所以只要现有 Cookie 还有效，就是全自动的、不需要你登录。
 *
 * 只有 Cookie 真失效时，才会打开 CAS 登录页让你登一次。
 *
 * 用法：
 *   node browser-session.js            交互式：先静默尝试，必要时弹窗登录
 *   node browser-session.js --auto     只跑无头；需要登录则退出码 2（供监控调用）
 *   node browser-session.js --login    直接打开窗口
 *   node browser-session.js --seedonly 只灌 Cookie 不导出（调试用）
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const DIR = __dirname;
const PROFILE = path.join(DIR, '.chrome-profile');
const COOKIE_FILE = path.join(DIR, 'cookie.txt');
const MODULE_URL = 'https://yjs1.ustc.edu.cn/gsapp/sys/xsbgglappustc/*default/index.do#/xsbgxk';
// 走 CAS 的门户入口，和无会话时的 dbLogin 不同
const CAS_ENTRY = 'https://yjs1.ustc.edu.cn/gsapp/sys/yjsemaphome/portal/index.do?forceCas=1';
const LOGIN_TIMEOUT_MS = 300000;

const args = process.argv.slice(2);
const AUTO = args.includes('--auto');
const FORCE_LOGIN = args.includes('--login');
const RESET = args.includes('--reset');
const MANUAL = args.includes('--manual');
const DEBUG = process.env.BS_DEBUG === '1';

// --reset：删掉整个 profile 重新来（登录态彻底乱掉时用，比如重定向死循环）
if (RESET) {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch (_) {}
}

process.on('uncaughtException', (e) => {
  log('❌ 未捕获异常: ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  try { console.log(e && e.stack ? e.stack : e); } catch (_) {}
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log('❌ 未处理的 Promise 拒绝: ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  try { console.log(e && e.stack ? e.stack : e); } catch (_) {}
});

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(DIR, 'setup-login.log'), line + '\n');
  } catch (_) {}
}

// 每次运行清空日志
try {
  fs.writeFileSync(path.join(DIR, 'setup-login.log'), '');
} catch (_) {}

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return null;
}

/** 把 cookie.txt 里的 Cookie 灌进浏览器 */
async function seedCookies(page) {
  let raw = '';
  try {
    raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  } catch (_) {
    return 0;
  }
  if (!raw) return 0;

  const pairs = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf('=');
      return { name: s.slice(0, i), value: s.slice(i + 1) };
    })
    .filter((p) => p.name && p.value);

  const client = await page.createCDPSession();
  try {
    await client.send('Network.enable');
  } catch (_) {}
  let n = 0;
  for (const p of pairs) {
    try {
      await client.send('Network.setCookie', {
        name: p.name,
        value: p.value,
        domain: '.ustc.edu.cn',
        path: '/',
        secure: true,
      });
      n++;
    } catch (_) {}
  }
  return n;
}

/** 清掉所有 ustc 域的 Cookie（解决 ERR_TOO_MANY_REDIRECTS 死循环） */
async function clearUstcCookies(page) {
  const client = await page.createCDPSession();
  try {
    await client.send('Network.enable');
  } catch (_) {}
  let n = 0;
  try {
    const { cookies } = await client.send('Network.getAllCookies');
    for (const c of cookies) {
      if (/ustc\.edu\.cn/.test(String(c.domain || ''))) {
        try {
          await client.send('Network.deleteCookies', {
            name: c.name,
            domain: c.domain,
            path: c.path,
          });
          n++;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return n;
}

/** 判断是否已经进入学术报告选课页 */
async function isModulePage(page) {
  const url = page.url();
  if (/dbLogin|cas\/login|passport\.ustc\.edu\.cn/.test(url)) return false;
  if (!/xsbgglappustc/.test(url)) return false;
  try {
    const txt = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    return /未选报告|学术报告选课/.test(txt);
  } catch (_) {
    return false;
  }
}

/** 登录成功的判定：进了门户或进了模块页，且不在任何登录页 */
async function isLoggedInAnywhere(page) {
  let url = '';
  try {
    url = page.url();
  } catch (_) {
    return false;
  }
  if (/dbLogin|cas\/login|passport\.ustc\.edu\.cn/i.test(url)) return false;
  if (/yjsemaphome\/portal/.test(url)) return true;
  if (/xsbgglappustc/.test(url)) return isModulePage(page);
  return false;
}

async function waitLogin(page, timeoutMs) {
  const start = Date.now();
  let last = 0;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      if (page.isClosed && page.isClosed()) {
        log('❌ Chrome 窗口已关闭，登录中断');
        return false;
      }
    } catch (_) {}
    if (await isLoggedInAnywhere(page)) return true;
    const el = Date.now() - start;
    if (el - last > 20000) {
      last = el;
      let url = '';
      try {
        url = page.url();
      } catch (_) {}
      log(`  等待中… (${Math.round(el / 1000)}s) 当前: ${url.slice(0, 100)}`);
    }
  }
  return false;
}

async function dumpCookies(page) {
  const client = await page.createCDPSession();
  try {
    await client.send('Network.enable');
  } catch (_) {}
  const { cookies } = await client.send('Network.getAllCookies');
  const wanted = cookies.filter((c) => /ustc\.edu\.cn/.test(c.domain));
  const list = (wanted.length ? wanted : cookies).filter((c) => c.name && c.value);
  const str = list.map((c) => `${c.name}=${c.value}`).join('; ');
  fs.writeFileSync(COOKIE_FILE, str + '\n');
  return { count: list.length, bytes: str.length };
}

async function launch(headless) {
  const chrome = findChrome();
  if (!chrome) throw new Error('没找到 Chrome/Edge，可用环境变量 CHROME_PATH 指定');
  fs.mkdirSync(PROFILE, { recursive: true });
  return puppeteer.launch({
    executablePath: chrome,
    headless,
    dumpio: DEBUG,
    userDataDir: PROFILE,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 860 },
  });
}

/**
 * 一次静默尝试，分两轮：
 *   第一轮：直接用 profile 里浏览器自己维护的登录态（可能已自动续期，比 cookie.txt 新）
 *   第二轮：失败才注入 cookie.txt 的 Cookie 再试
 * 顺序很重要——先注入旧 Cookie 会把 profile 里更新鲜的会话冲掉。
 */
async function silentAttempt() {
  let browser;
  try {
    browser = await launch(true);
    const page = (await browser.pages())[0] || (await browser.newPage());

    // ---- 第一轮：profile 现有登录态 ----
    log('第一轮：使用浏览器 profile 里的现有登录态...');
    await page.goto(MODULE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    if (await isModulePage(page)) {
      const info = await dumpCookies(page);
      await browser.close();
      return { ok: true, ...info, via: 'profile' };
    }
    log('   profile 登录态无效');

    // ---- 第二轮：注入 cookie.txt ----
    const seeded = await seedCookies(page);
    log(`第二轮：已注入 ${seeded} 个 Cookie，重试...`);
    await page.goto(MODULE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    if (await isModulePage(page)) {
      const info = await dumpCookies(page);
      await browser.close();
      return { ok: true, ...info };
    }
    let url = '';
    try {
      url = page.url();
    } catch (_) {}
    await browser.close();
    return { ok: false, reason: '未进入模块页', url };
  } catch (e) {
    if (browser) try { await browser.close(); } catch (_) {}
    return { ok: false, reason: e.message };
  }
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 连上已经在跑的 Chrome（通过调试端口），从内存里导出 Cookie —— 关键是不能等它关闭 */
async function exportFromDebugPort(port) {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null });
  try {
    const pages = await browser.pages();
    const page = pages.find((p) => /yjs1\.ustc\.edu\.cn/.test(p.url())) || pages[0];
    if (!page) throw new Error('没有可用页面');
    const url = page.url();
    log('  当前页面: ' + url.slice(0, 110));
    if (/dbLogin|cas\/login|passport\.ustc\.edu\.cn/i.test(url)) {
      throw new Error('页面还停在登录页，请先在 Chrome 里完成登录再按回车');
    }
    const info = await dumpCookies(page);
    return { ok: true, ...info, url };
  } finally {
    try {
      await browser.disconnect();
    } catch (_) {}
  }
}

/** 用导出的 Cookie 立刻打一次接口，确认真的能用 */
function verifyCookie(cookieStr) {
  const https = require('https');
  return new Promise((resolve) => {
    const body = '*json=1&pageSize=1&pageNumber=1&YXDM=210';
    const req = https.request(
      {
        hostname: 'yjs1.ustc.edu.cn',
        port: 443,
        path: '/gsapp/sys/xsbgglappustc/modules/xsbgxk/wxbgbgdz.do',
        method: 'POST',
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
          origin: 'https://yjs1.ustc.edu.cn',
          referer: 'https://yjs1.ustc.edu.cn/gsapp/sys/xsbgglappustc/*default/index.do',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
          cookie: cookieStr,
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => {
          const t = Buffer.concat(c).toString('utf8');
          let total = null;
          try {
            const j = JSON.parse(t);
            if (j.datas && j.datas.wxbgbgdz) total = j.datas.wxbgbgdz.totalSize;
          } catch (_) {}
          resolve({ ok: res.statusCode === 200 && total != null, status: res.statusCode, total });
        });
      }
    );
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, msg: e.message }));
    req.write(body);
    req.end();
  });
}

/**
 * 手动模式：绕过 puppeteer 的有头启动（部分 Chrome 版本会闪退），
 * 但通过 --remote-debugging-port 连进去，在**浏览器仍然打开**时导出 Cookie。
 * 这一点很关键：会话级 Cookie 在 Chrome 关闭时会被销毁。
 */
async function manualFlow() {
  if (RESET) {
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
    } catch (_) {}
  }
  const chrome = findChrome();
  if (!chrome) {
    log('❌ 没找到 Chrome/Edge');
    return process.exit(1);
  }
  const { spawn } = require('child_process');
  fs.mkdirSync(PROFILE, { recursive: true });

  let port = 9222;
  for (let i = 0; i < 5; i++) {
    const p = 9222 + i;
    const inUse = await new Promise((resolve) => {
      const https = require('http');
      const rq = https.request({ hostname: '127.0.0.1', port: p, path: '/json/version', method: 'GET' }, () => resolve(true));
      rq.setTimeout(800, () => rq.destroy());
      rq.on('error', () => resolve(false));
      rq.end();
    });
    if (!inUse) {
      port = p;
      break;
    }
  }

  log('正在用普通方式打开 Chrome 窗口（不经过自动化控制）...');
  log('调试端口: ' + port);
  spawn(
    chrome,
    [
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + port,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      CAS_ENTRY,
    ],
    { detached: true, stdio: 'ignore' }
  ).unref();

  log('====================================================');
  log('  1. 在弹出的 Chrome 里完成登录（学号密码 / 微信扫码）');
  log('  2. 确认能看到门户或课程页面');
  log('  3. ⚠️ 不要关闭这个 Chrome 窗口！直接回到这里按回车');
  log('     （关闭窗口会销毁会话 Cookie，导致导入失败）');
  log('====================================================');
  await prompt('登录完成并停在门户页后，按回车 > ');

  for (let attempt = 1; attempt <= 3; attempt++) {
    log('第 ' + attempt + ' 次尝试连接 Chrome 导出 Cookie...');
    try {
      const r = await exportFromDebugPort(port);
      if (!r.ok) throw new Error(r.reason || '导出失败');
      log('✅ 已导出 ' + r.count + ' 个 Cookie（' + r.bytes + ' 字节）');

      const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
      log('正在用这份 Cookie 实测接口...');
      const v = await verifyCookie(raw);
      if (v.ok) {
        log('✅ 接口验证通过，采集到 ' + v.total + ' 条记录');
        log('✅ 登录态已就绪，现在可以关闭那个 Chrome 窗口了');
        process.exit(0);
      }
      log('❌ 接口验证失败 HTTP ' + v.status + '，Cookie 可能不完整');
    } catch (e) {
      log('❌ ' + e.message);
    }
    if (attempt < 3) {
      await sleep(3000);
      await prompt('请确认 Chrome 已登录并停在门户页，然后按回车重试 > ');
    }
  }
  log('❌ 三次尝试均失败');
  process.exit(1);
}

(async () => {
  // 手动模式：完全绕过 puppeteer 的有头启动
  if (MANUAL) {
    await manualFlow();
    return;
  }

  // 1) 静默尝试
  if (!FORCE_LOGIN && !RESET) {
    log('静默尝试（注入现有 Cookie，无头模式）...');
    const r = await silentAttempt();
    if (r.ok) {
      log(`✅ 登录态有效，已回写 ${r.count} 个 Cookie（${r.bytes} 字节）到 cookie.txt`);
      process.exit(0);
    }
    log(`静默尝试未通过：${r.reason}${r.url ? ' | ' + r.url.slice(0, 90) : ''}`);
    if (AUTO) {
      log('需要人工登录一次，请双击 setup-login.bat');
      process.exit(2);
    }
  }

  // 2) 打开窗口走 CAS 登录
  log('正在打开 Chrome 窗口（走 CAS 统一身份认证）...');
  let browser;
  try {
    browser = await launch(false);
    browser.on('disconnected', () => log('⚠️ 浏览器连接断开（Chrome 窗口被关闭或进程退出）'));
    const page = (await browser.pages())[0] || (await browser.newPage());
    page.on('error', (e) => log('⚠️ 页面崩溃: ' + e.message));
    page.on('close', () => log('⚠️ 页面已关闭'));

    // 关键：先清掉 ustc 域的旧 Cookie。
    // 否则"失效但服务器仍认得"的 Cookie 会让 模块↔登录页 之间无限重定向
    // （浏览器报 ERR_TOO_MANY_REDIRECTS）。
    const cleared = await clearUstcCookies(page);
    log(`已清理 ${cleared} 个旧的 ustc Cookie（避免重定向死循环）`);

    await page.goto(CAS_ENTRY, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    // 进了门户说明登录态够用
    let url = '';
    try { url = page.url(); } catch (_) {}
    if (/yjsemaphome\/portal/.test(url)) {
      log('已直接进入门户（登录态有效），前往模块页...');
    } else {
      log('====================================================');
      log('  请在弹出的 Chrome 窗口里完成统一身份认证登录');
      log('  （学号密码 或 微信扫码，和你平时一样）');
      log(`  最多等待 ${LOGIN_TIMEOUT_MS / 60000} 分钟，登录成功会自动保存`);
      log('  ⚠️ 登录完不要手动关窗口，脚本会自动检测');
      log('====================================================');
      // 不要在这里主动跳转——会把你正在登录的 CAS 页面顶掉，
      // 登录成功后 CAS 自己会跳回门户。
      const ok = await waitLogin(page, LOGIN_TIMEOUT_MS);
      if (!ok) {
        log('❌ 超时未检测到登录成功');
        await browser.close();
        process.exit(1);
      }
      log('检测到登录成功，正在进入模块页...');
    }

    await page.goto(MODULE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    if (await isModulePage(page)) {
      const info = await dumpCookies(page);
      log(`✅ 登录成功，已保存 ${info.count} 个 Cookie（${info.bytes} 字节）`);
      log('   登录态已存入 .chrome-profile，之后无需再手动操作');
      await browser.close();
      process.exit(0);
    }
    log('❌ 已登录但没能进入模块页，请检查是否有权限或页面结构变化');
    await browser.close();
    process.exit(1);
  } catch (e) {
    log('❌ 出错: ' + e.message);
    if (browser) try { await browser.close(); } catch (_) {}
    process.exit(1);
  }
})();
