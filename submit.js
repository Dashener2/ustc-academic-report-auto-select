#!/usr/bin/env node
/**
 * USTC 学术报告 —— 选课 / 退课 / 查询
 * ------------------------------------------------------------
 *   node submit.js list              列出白名单内当前可选的报告（带序号）
 *   node submit.js mine              列出我已选的报告
 *   node submit.js select <序号|BGBM> 提交选课
 *   node submit.js cancel <序号|BGBM> 退课
 *   node submit.js selftest          用无效编码验证接口连通性（不会选上任何东西）
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const EXAMPLE_PATH = path.join(DIR, 'config.example.json');
if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_PATH)) {
  fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  console.log('[提示] 未找到 config.json，已从 config.example.json 生成');
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
let cookie = '';
try {
  cookie = fs.readFileSync(path.join(DIR, config.cookieFile || 'cookie.txt'), 'utf8').trim();
} catch (_) {
  cookie = '';
}

const HOST = 'yjs1.ustc.edu.cn';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const REFERER = 'https://yjs1.ustc.edu.cn/gsapp/sys/xsbgglappustc/*default/index.do';

const API_WXBG = '/gsapp/sys/xsbgglappustc/modules/xsbgxk/wxbgbgdz.do';
const API_YXBG = '/gsapp/sys/xsbgglappustc/modules/xsbgxk/yxbgbgdz.do';
const API_SELECT = '/gsapp/sys/xsbgglappustc/xsbgxkController/selectBg.do';
const API_CANCEL = '/gsapp/sys/xsbgglappustc/xsbgxkController/cancelBg.do';

/**
 * 控制器接口的参数格式：框架 XGJSUTIL.convertParam 会把对象包成
 *   { data: JSON.stringify(obj) }
 * 再作为表单字段提交，所以请求体是 data={"BGBM":"..."}
 */
function payload(obj) {
  return 'data=' + encodeURIComponent(JSON.stringify(obj));
}

function post(apiPath, body) {
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
    const req = https.request({ hostname: HOST, port: 443, path: apiPath, method: 'POST', headers }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.write(body);
    req.end();
  });
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(/-/g, '/'));
  return isNaN(d.getTime()) ? null : d;
}

async function grid(api, extra) {
  const r = await post(api, `*json=1&pageSize=500&pageNumber=1${extra || ''}`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${r.error || ''}`);
  const j = JSON.parse(r.body);
  const k = Object.keys(j.datas || {})[0];
  if (!k) throw new Error('响应缺少 datas');
  return j.datas[k].rows;
}

async function listEligible() {
  const now = new Date();
  const out = [];
  for (const code of Object.keys(config.departments)) {
    const rows = await grid(API_WXBG, `&YXDM=${code}`);
    rows.forEach((r) => {
      if (!config.departments[r.YXDM]) return;
      if (String(r.SFKXK) !== '1') return;
      const dl = parseDate(r.JZSJ);
      if (config.requireFutureDeadline && (!dl || dl <= now)) return;
      const remain = Number(r.KXRS || 0) - Number(r.YXRS || 0);
      if (config.minRemainingSeats > 0 && remain < config.minRemainingSeats) return;
      out.push(r);
    });
  }
  return out;
}

// KXRS = 计划名额。已选 >= 计划 视为「已满」，不再算作可选。
function quota(r) {
  const plan = Number(r.KXRS || 0);
  const taken = Number(r.YXRS || 0);
  const remain = plan - taken;
  return `已选 ${taken} / 计划 ${plan}` + (remain > 0 ? `，剩余 ${remain}` : '（已满）');
}

function fmt(r, i) {
  return (
    `${i !== undefined ? `[${i}] ` : ''}${r.BGTMZW || '(无标题)'}\n` +
    `     院系: ${r.YXDM_DISPLAY || ''}   报告人: ${r.BGRZW || '-'}\n` +
    `     截止: ${r.JZSJ || '-'}   ${quota(r)}\n` +
    `     编码: ${r.BGBM}`
  );
}

async function resolveTarget(arg) {
  if (/^[0-9a-f]{32}$/i.test(arg)) return { BGBM: arg, BGTMZW: '(按编码指定)' };
  const n = parseInt(arg, 10);
  if (isNaN(n)) throw new Error(`无法识别的目标: ${arg}`);
  const list = await listEligible();
  if (n < 1 || n > list.length) throw new Error(`序号超出范围，当前可选 ${list.length} 条`);
  return list[n - 1];
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);

  try {
    switch (cmd) {
      case 'list': {
        const list = await listEligible();
        if (!list.length) {
          console.log('当前没有符合条件的报告。');
          break;
        }
        console.log(`当前可选 ${list.length} 条：\n`);
        list.forEach((r, i) => console.log(fmt(r, i + 1) + '\n'));
        break;
      }

      case 'mine': {
        const rows = await grid(API_YXBG);
        if (!rows.length) {
          console.log('你还没有选任何学术报告。');
          break;
        }
        console.log(`已选 ${rows.length} 条：\n`);
        rows.forEach((r, i) => {
          console.log(
            `[${i + 1}] ${r.BGTMZW}\n     院系: ${r.YXDM_DISPLAY || ''}  报告时间: ${r.BGSJ || '-'}\n` +
              `     成绩: ${r.SFTG || '-'}  状态: ${r.ZT || '-'}  可退课: ${r.SFKTK === '1' ? '是' : '否'}\n` +
              `     编码: ${r.BGBM}\n`
          );
        });
        break;
      }

      case 'select': {
        if (!arg) throw new Error('用法: node submit.js select <序号|BGBM>');
        const t = await resolveTarget(arg);
        console.log(`准备选课：${t.BGTMZW || '(按编码)'}\n  编码: ${t.BGBM}`);
        const r = await post(API_SELECT, payload({ BGBM: t.BGBM }));
        console.log(`HTTP ${r.status}`);
        let j = null;
        try {
          j = JSON.parse(r.body);
        } catch (_) {}
        if (j) {
          console.log('响应:', JSON.stringify(j).slice(0, 500));
          if (j.code === '0') console.log('\n✅ 选课成功');
          else console.log('\n❌ 选课失败:', j.msg || j.message || j.returnData || '(服务器未给原因)');
        } else {
          console.log('响应(非 JSON):', r.body.slice(0, 400));
        }
        break;
      }

      case 'cancel': {
        if (!arg) throw new Error('用法: node submit.js cancel <序号|BGBM>');
        const t = await resolveTarget(arg);
        const r = await post(API_CANCEL, payload({ BGBM: t.BGBM }));
        console.log(`HTTP ${r.status}  响应:`, r.body.slice(0, 400));
        break;
      }

      case 'selftest': {
        console.log('=== 用无效编码调用 selectBg（验证接口连通性，不会选上任何课）===');
        const r = await post(API_SELECT, payload({ BGBM: '00000000000000000000000000000000' }));
        console.log('HTTP', r.status);
        console.log('原始响应:', r.body.slice(0, 600));
        try {
          const j = JSON.parse(r.body);
          console.log('\n解析: code =', JSON.stringify(j.code), ' 说明 =', j.msg || j.message || j.returnData || '(无)');
          console.log('判定: 接口可达。非成功码说明传输格式正确（服务器接受了请求并给出业务错误）。');
        } catch (_) {
          console.log('\n非 JSON —— 可能参数格式或登录态有问题。');
        }
        break;
      }

      default:
        console.log(
          '用法:\n' +
            '  node submit.js list              列出可选的报告\n' +
            '  node submit.js mine              列出已选报告\n' +
            '  node submit.js select <序号|BGBM> 选课\n' +
            '  node submit.js cancel <序号|BGBM> 退课\n' +
            '  node submit.js selftest          验证接口连通性'
        );
    }
  } catch (e) {
    console.error('错误:', e.message);
    process.exitCode = 1;
  }
})();
