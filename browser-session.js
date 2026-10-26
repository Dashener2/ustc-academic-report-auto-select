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

// --reset：删掉整个 profile 重新来（登录态彻底乱掉时用，比如重定向死循环）
if (RESET) {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch (_) {}
}

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

(async () => {
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
    const page = (await browser.pages())[0] || (await browser.newPage());

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
