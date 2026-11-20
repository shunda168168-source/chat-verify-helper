// ==UserScript==
// @name         客服对话 · 核对信息提取
// @namespace    local.chat-verify-helper
// @version      1.0.3
// @description  自动读取当前对话里访客提供的帐号、卡号、姓名、钱包地址，集中显示在悬浮面板，可一键复制、点击定位到原消息。资料只在本页面内存中处理，不上传、不保存。
// @match        *://c.bicsin.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 用法一（Chrome 扩充功能）：chrome://extensions → 打开「开发人员模式」→「载入未封装项目」
 *       → 选这个文件所在的文件夹。系统还有其他网址时，改 manifest.json 里的 "matches"。
 * 用法二（Tampermonkey）：新建脚本，把本文件整段贴上后保存。
 *       系统还有其他网址时，在上面照样加一行 // @match *://其他网址/*
 * 打开客服系统进入任一对话，右侧会出现「核对信息」面板。
 *
 * 隐私：脚本不发出任何网络请求，读到的资料只存在当前分页的内存里，
 *       关闭或刷新页面就清空。localStorage 里只记面板位置和是否收起。
 */

(function () {
  'use strict';
  if (window.__cvhLoaded) return;
  window.__cvhLoaded = true;

  /* =========================================================
   * 一、识别规则
   * ========================================================= */

  // 消息标题：「发送者 于 2026/11/13 08:43:58」
  const HEADER_RE = /^(.{1,60}?)\s*于\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)$/;
  const DATE_RE = /\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s+\d{1,2}:\d{2}/;

  // 这种名字一定是访客
  const VISITOR_NAME_RE = /^guest[_\-]?\d+/i;
  // 这种名字一定是客服/机器人（只在看不出左右位置时才用）
  const AGENT_NAME_RE = /客服|^bot$|机器人|系统|管理员/i;

  // 客服上一句问了什么 → 判断访客下一句回的是什么
  const ASK_RE = {
    account: /[帐账]\s*号|用户名|会员\s*(?:名|号|ID)|登[录陆]名|游戏\s*ID/i,
    name: /姓名|名字|持卡人|户名|实名/,
    card: /卡号|银行卡/,
    wallet: /钱包|地址|USDT|TRC|ERC|虚拟币/i,
  };

  const RE_TRON = /(?<![A-Za-z0-9])T[1-9A-HJ-NP-Za-km-z]{33}(?![A-Za-z0-9])/g;
  const RE_EVM = /(?<![A-Za-z0-9])0x[0-9a-fA-F]{40}(?![A-Za-z0-9])/g;
  const RE_BTC = /(?<![A-Za-z0-9])(?:bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})(?![A-Za-z0-9])/g;
  // 15~19 位数字，允许中间有空格或横线（6222 0243 ...）
  const RE_CARD = /(?<![0-9A-Za-z])\d(?:[ \-]?\d){14,18}(?![0-9A-Za-z])/g;
  const RE_LABELED_ACCOUNT = /(?:[帐账]\s*号|用户名|会员\s*(?:名|号|ID)?|登[录陆]名|游戏\s*ID)\s*(?:是|为|:|：|=)?\s*([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])/gi;
  const RE_LABELED_NAME = /(?:真实姓名|姓名|名字|持卡人(?:姓名)?|开户[人名]|户名|我叫|本人叫)\s*(?:是|为|叫|:|：|=)?\s*([一-龥]+(?:[·•．][一-龥]+)?)/g;

  // 没上下文时，用来推测「这是不是人名」的常见姓氏（刻意去掉了「安、关、常、平、都…」这类常当普通词开头的字）
  const SURNAMES = new Set(Array.from(
    '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付傅方白邹孟熊秦邱江尹薛闫阎段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔汤温康施文牛樊葛邢齐易乔伍庞颜倪庄聂章鲁岳翟殷詹欧耿兰焦俞柳甘祝宁符舒阮柯纪梅童凌毕季裴霍涂苗谷盛曲翁冉骆蓝游辛靳柴蒙鲍华喻祁蒲滕屈饶牟艾尤阳穆卓缪褚娄窦戚岑佟臧闵苟邬卞姬栾隋刁巫甄敖巩佘邝匡鞠荆冀郁胥储栗燕楚鄢谌奚粟冼蔺厉仝郜阚屠朴廉禹卿狄晋芮阙鹿邸雍辜裘亓邰赫杭逯茹'
  ));
  const COMPOUND_SURNAMES = ['欧阳', '司马', '诸葛', '上官', '东方', '皇甫', '慕容', '令狐', '夏侯', '尉迟', '长孙', '宇文', '司徒', '公孙', '端木', '澹台', '西门', '南宫', '独孤', '轩辕', '呼延', '万俟', '闻人', '申屠', '钟离', '太史', '百里', '濮阳'];
  // 名字里几乎不会出现的字（语气词、代词、和钱/帐号相关的字等）
  const NON_NAME_CHARS = /[了吗呢吧啊么呀嘛哦啦呗咯哈嗯噢喔诶哎唉呃额的不没是我你他她它们这那啥谁哪怎钱卡号码帐账密登录充提款转块请问能要去说看过还就已读未在个与谢总哥姐叔姨嫂爷奶妈爸等下]/;
  const TITLE_SUFFIX_RE = /(先生|女士|老师|经理|老板|小姐|美女|帅哥|同学|师傅|客服)$/;
  const NAME_STOP = new Set((
    '稍等 等等 等下 等一下 稍等一下 马上 好的 可以 收到 明白 明白了 知道 知道了 什么 哪个 为啥 为何 干嘛 怎样 忘了 忘记 记得 本人 是我 自己 一样 对的 正确 没错 确认 确定 上面 下面 前面 刚才 刚刚 已经 看看 行了 在吗 你好 您好 哈哈 嗯嗯 哦哦 好吧 对对 是是 没有 有的 不是 不对 不用 不要 算了 怎么 咋办 ' +
    '手机 电脑 网页 页面 登录 登陆 密码 验证码 拒绝访问 账号 帐号 卡号 姓名 名字 银行卡 银行 余额 金额 提款 提现 充值 出款 到账 客服 人工 人工客服 处理 处理中 谢谢 谢谢你 谢谢您 辛苦 辛苦了 麻烦 麻烦了 拜托 请问 平台 游戏 游客 网站 彩票 时时彩 中奖 输了 赢了 退款 解封 冻结 封号 申诉 投诉 ' +
    '无语 郁闷 厉害 牛逼 晚安 早安 再见 拜拜 好久 多久 多少 几天 今天 明天 昨天 后天 周末 周一 周二 周三 周四 周五 周六 周日 一会 一会儿 待会 回头 万一 方便 方式 方法 时间 文件 文字 华为 金币 黄金 于是 许多 何时 任何 任务 尤其 凌晨 舒服 符合 颜色 严重 毛病 顾客 顾问 付款 付钱 付出 曾经 白天 温馨 江湖 胡说 胡扯 龙虎 庄家 段位 晋级 储值 程序 高手 高兴 夏天 范围 陆续 毕竟 石头 祝你 祝福 欧美 欧洲 杭州 兰州 阳光 戴着 苏宁 ' +
    '储存 生成 链接 生成链接 下载 分享 转账 转给 赠送 返现 兑换 领取 通知 推送 确认中 待审核 已审核 已完成 未提供 尚未 提供 新增 编辑 删除 保存 修改 更新 刷新'
  ).split(/\s+/));
  const ACCOUNT_STOP_RE = /^(?:(?:trc|erc|bep|omni|hrc)\d*|usd[tc]?|btc|eth|tron|vip\d*|lv\d+|iphone\w*|ipad\w*|android\d*|ios\d*|app|apk|wifi|[2-5]g|oppo\w*|vivo\w*|huawei\w*|honor\w*|xiaomi\w*|redmi\w*|samsung\w*|mate\d{1,2}(?:pro)?|nova\d{1,2}|p\d{2}(?:pro|plus)?|chrome\d*|qq|wechat|weixin|alipay|ok|okay|hello|hi|yes|no|thanks?|thx|please|sorry|wait|help|https?|www|com|html?)$/i;

  /* =========================================================
   * 二、读取对话
   * ========================================================= */

  const cleanText = (s) => (s || '')
    .replace(/[-​-‏⁠﻿]/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t 　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const oneLine = (s) => cleanText(s).replace(/\s+/g, ' ');

  function normTime(s) {
    const m = s.match(/(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return s;
    const p = (x) => String(x || '0').padStart(2, '0');
    return `${m[1]}/${p(m[2])}/${p(m[3])} ${p(m[4])}:${m[5]}:${p(m[6])}`;
  }

  // 找出所有「XXX 于 日期时间」的消息标题
  function findHeaders() {
    const out = [];
    if (!document.body) return out;
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.length < 200 && DATE_RE.test(n.nodeValue))
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    let node;
    while ((node = walker.nextNode())) {
      let el = node.parentElement;
      for (let i = 0; el && el !== document.body && i < 4; i++, el = el.parentElement) {
        if (/^(SCRIPT|STYLE|TEXTAREA|INPUT)$/.test(el.tagName)) break;
        const t = oneLine(el.textContent);
        if (t.length > 120) break;
        const m = HEADER_RE.exec(t);
        if (m) {
          if (!seen.has(el)) {
            seen.add(el);
            const sender = m[1].replace(/^[ℹⓘ\s·•:：|]+/, '').trim();
            out.push({ el, sender, time: normTime(m[2]) });
          }
          break;
        }
      }
    }
    return out;
  }

  // 消息标题后面紧跟的就是消息内容（气泡）
  function findBubble(headerEl, hcount) {
    let el = headerEl;
    for (let depth = 0; el && el !== document.body && depth < 6; depth++) {
      const nodes = [];
      for (let s = el.nextSibling; s; s = s.nextSibling) {
        if (s.nodeType === 1) {
          if (hcount.has(s)) break; // 下一条消息了
          if (/^(SCRIPT|STYLE)$/.test(s.tagName)) continue;
          nodes.push(s);
        } else if (s.nodeType === 3 && s.nodeValue.trim()) {
          nodes.push(s);
        }
      }
      const text = cleanText(nodes.map((n) => (n.nodeType === 1 ? n.innerText : n.nodeValue)).join('\n'));
      if (text || nodes.some((n) => n.nodeType === 1 && n.querySelector('img,svg,video,audio,canvas'))) {
        return { nodes, text };
      }
      const p = el.parentElement;
      if (!p || (hcount.get(p) || 0) > 1) break;
      el = p;
    }
    return { nodes: [], text: '' };
  }

  // 消息列表的外框，用来判断标题在左边（访客）还是右边（客服）
  function findListBox(headerEls, hcount) {
    const total = headerEls.length;
    let a = headerEls[0];
    if (total > 1) {
      while (a && (hcount.get(a) || 0) < total) a = a.parentElement;
    } else {
      a = a.parentElement;
    }
    while (a && a !== document.documentElement && a.getBoundingClientRect().width < 280) a = a.parentElement;
    return a || document.documentElement;
  }

  function sideOf(el, box) {
    if (!box || box.width < 50) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const cx = (left + right) / 2;
    const mid = box.left + box.width / 2;
    if (Math.abs(cx - mid) < box.width * 0.03) return null;
    return cx < mid ? 'left' : 'right';
  }

  function assignRoles(msgs) {
    // 用 guest_ 访客的位置校准「访客在哪一边」，默认左边
    let l = 0, r = 0;
    for (const m of msgs) {
      if (VISITOR_NAME_RE.test(m.sender) && m.side) m.side === 'left' ? l++ : r++;
    }
    const visitorSide = r > l ? 'right' : 'left';
    const votes = new Map();
    for (const m of msgs) {
      let role = null;
      if (VISITOR_NAME_RE.test(m.sender)) role = 'visitor';
      else if (m.side) role = m.side === visitorSide ? 'visitor' : 'agent';
      else if (AGENT_NAME_RE.test(m.sender)) role = 'agent';
      const v = votes.get(m.sender) || { visitor: 0, agent: 0 };
      if (role) v[role]++;
      votes.set(m.sender, v);
    }
    for (const m of msgs) {
      const v = votes.get(m.sender);
      m.role = v.visitor > v.agent ? 'visitor'
        : v.agent > v.visitor ? 'agent'
        : (AGENT_NAME_RE.test(m.sender) ? 'agent' : 'visitor');
    }
  }

  /* =========================================================
   * 三、从访客消息里提取资料
   * ========================================================= */

  function luhn(d) {
    let sum = 0, alt = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = d.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  const normalizeName = (s) => s.replace(/[•．・]/g, '·');

  // 返回 'sure' | 'guess' | null
  function nameCheck(raw, asked) {
    const s = normalizeName(raw);
    const minority = /^[一-龥]{1,8}·[一-龥]{1,10}$/.test(s);
    if (!minority && !/^[一-龥]{2,4}$/.test(s)) return null;
    if (NAME_STOP.has(s) || TITLE_SUFFIX_RE.test(s)) return null;
    if (minority) return asked ? 'sure' : null;
    const sur = COMPOUND_SURNAMES.find((c) => s.startsWith(c)) || (SURNAMES.has(s[0]) ? s[0] : '');
    const given = sur ? s.slice(sur.length) : s.slice(1);
    if (!given) return null;
    if (NON_NAME_CHARS.test(given)) return null;
    if (!sur && NON_NAME_CHARS.test(s[0])) return null;
    if (asked) return 'sure';
    if (sur && given.length <= 2) return 'guess';
    return null;
  }

  function accountCheck(tok, ctx) {
    if (tok.length < 4 || tok.length > 20) return null;
    if (ACCOUNT_STOP_RE.test(tok) || VISITOR_NAME_RE.test(tok)) return null;
    const L = /[A-Za-z]/.test(tok), D = /\d/.test(tok);
    if (L && D) return ctx.account ? 'sure' : 'guess';
    if (L && ctx.account && tok.length >= 5) return 'guess';
    if (!L && D && ctx.account && tok.length >= 5 && tok.length <= 14) return 'guess';
    return null;
  }

  function extract(raw, ctx) {
    const out = [];
    let t = ' ' + cleanText(raw).replace(/\n+/g, ' ; ') + ' ';

    // 识别身份信息（会员、代理等）
    const identityMatch = t.match(IDENTITY_RE);
    if (identityMatch) {
      out.push({ type: 'identity', value: identityMatch[0], sure: true });
    }

    t = t.replace(RE_TRON, (m) => { out.push({ type: 'wallet', value: m, sub: 'TRC20', sure: true }); return ' ; '; });
    t = t.replace(RE_EVM, (m) => { out.push({ type: 'wallet', value: m, sub: 'ERC20/BEP20', sure: true }); return ' ; '; });
    t = t.replace(RE_BTC, (m) => {
      if (!/[A-Za-z]/.test(m.slice(1))) return m;
      out.push({ type: 'wallet', value: m, sub: 'BTC', sure: true });
      return ' ; ';
    });

    t = t.replace(RE_CARD, (m) => {
      const d = m.replace(/\D/g, '');
      if (d.length < 15 || d.length > 19) return m;
      const ok = luhn(d);
      out.push({ type: 'card', value: d, sure: ok || ctx.card, flags: ok ? [] : ['luhn'] });
      return ' ; ';
    });

    // 帐号中间多打了空格（如「wanghao 0219」「WjP 2446」）→ 去掉空格合并成一个帐号
    const joined = new Set();
    t = t.replace(/[A-Za-z0-9_]+(?: +[A-Za-z0-9_]+)+/g, (run) => {
      const parts = run.split(/ +/);
      if (parts.length > 4) return run;
      if (parts.filter((p) => /[A-Za-z]/.test(p) && /\d/.test(p)).length > 1) return run; // 两个都是完整帐号，就不合并
      if (parts.some((p) => ACCOUNT_STOP_RE.test(p))) return run; // iPhone 13、vip 3、TRC20 USDT 之类
      const s = parts.join('');
      if (s.length < 4 || s.length > 20 || !/[A-Za-z]/.test(s) || !/\d/.test(s)) return run;
      joined.add(s);
      return s;
    });

    t = t.replace(RE_LABELED_ACCOUNT, (m, v) => {
      if (ACCOUNT_STOP_RE.test(v) || VISITOR_NAME_RE.test(v)) return m;
      out.push({ type: 'account', value: v, sure: true });
      return ' ; ';
    });

    t = t.replace(RE_LABELED_NAME, (m, v) => {
      const name = v.split(/卡号|[帐账]号|银行|手机|电话|钱包|地址|身份证|谢谢|的|和/)[0];
      if (!nameCheck(name, true)) return m;
      out.push({ type: 'name', value: normalizeName(name), sure: true });
      return ' ; ';
    });

    const toks = t.match(/[一-龥]+(?:[·•．][一-龥]+)?|[A-Za-z0-9_]+/g) || [];
    for (const tok of toks) {
      if (/^[A-Za-z0-9_]+$/.test(tok)) {
        const a = accountCheck(tok, ctx);
        if (a) out.push({ type: 'account', value: tok, sure: a === 'sure' });
      } else {
        const n = nameCheck(tok, ctx.name);
        if (n) out.push({ type: 'name', value: normalizeName(tok), sure: n === 'sure' });
      }
    }
    for (const f of out) if (f.type === 'account' && joined.has(f.value)) f.flags = ['joined'];
    return out;
  }

  /* =========================================================
   * 四、按对话保存（只在内存）
   * ========================================================= */

  const store = new Map(); // 访客名 → { key, isGuest, items, dismissed }

  function currentConversation(msgs) {
    const cnt = new Map();
    for (const m of msgs) if (m.role === 'visitor') cnt.set(m.sender, (cnt.get(m.sender) || 0) + 1);
    const names = [...cnt.keys()];
    const guests = names.filter((n) => VISITOR_NAME_RE.test(n));
    const pool = guests.length ? guests : names;
    pool.sort((a, b) => cnt.get(b) - cnt.get(a));
    const key = pool[0] || '';
    let conv = store.get(key);
    if (!conv) {
      conv = { key, isGuest: VISITOR_NAME_RE.test(key), items: new Map(), dismissed: new Set(), pageIdentity: null };
      store.set(key, conv);
    }
    return conv;
  }

  function extractInto(conv, msgs) {
    const present = new Set();
    const found = [];
    let lastAsk = '';
    for (const m of msgs) {
      m.id = m.sender + '|' + m.time + '|' + m.text.slice(0, 40);
      present.add(m.id);
      if (m.role === 'agent') { if (m.text) lastAsk = m.text; continue; }
      if (!m.text) continue;
      const ctx = {
        account: ASK_RE.account.test(lastAsk),
        name: ASK_RE.name.test(lastAsk),
        card: ASK_RE.card.test(lastAsk),
        wallet: ASK_RE.wallet.test(lastAsk),
      };
      for (const f of extract(m.text, ctx)) found.push(Object.assign(f, { msg: m }));
      // 从访客名中提取账号（有下划线时取前半部分，如 qiangf520_乱码 → qiangf520；无下划线时整个名字作为账号，如 kk2017）
      if (m.role === 'visitor') {
        const underscoreMatch = m.sender.match(/^([A-Za-z0-9_]+?)_/);
        const account = underscoreMatch ? underscoreMatch[1] : m.sender;
        // 排除掉 "guest" 这样的系统访客名
        if (account.toLowerCase() !== 'guest' && accountCheck(account, { account: true })) {
          found.push({ type: 'account', value: account, msg: m, sure: true });
        }
      }
    }
    // 页面上还在的消息重新计算；已经不在页面上的旧消息（被系统卸载）保留之前读到的结果
    for (const it of conv.items.values()) {
      for (const id of [...it.occ.keys()]) if (present.has(id)) it.occ.delete(id);
    }
    for (const f of found) {
      const k = f.type + ':' + f.value;
      let it = conv.items.get(k);
      if (!it) {
        it = { key: k, type: f.type, value: f.value, sub: f.sub || '', flags: f.flags || [], occ: new Map() };
        conv.items.set(k, it);
      }
      it.occ.set(f.msg.id, { time: f.msg.time, nodes: f.msg.nodes, headerEl: f.msg.headerEl, sure: !!f.sure });
    }
    for (const [k, it] of conv.items) {
      if (!it.occ.size) { conv.items.delete(k); continue; }
      const occ = [...it.occ.values()];
      it.sure = occ.some((o) => o.sure);
      const times = occ.map((o) => o.time).sort();
      it.first = times[0];
      it.last = times[times.length - 1];
      it.count = occ.length;
    }
  }

  /* =========================================================
   * 五、悬浮面板
   * ========================================================= */

  const TYPES = [
    { key: 'account', label: '帐号' },
    { key: 'card', label: '卡号' },
    { key: 'name', label: '姓名' },
    { key: 'wallet', label: '钱包地址' },
    { key: 'identity', label: '身份' },
  ];

  const IDENTITY_RE = /(?:正式|兼职|临时)?(?:会员|代理|VIP|代理商|合伙人|分销|推广员|合作伙伴)(?:[|-]?\w+)?/i;

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; top: 96px; right: 16px; width: 300px; z-index: 2147483646;
      font: 13px/1.45 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; color: #1f2937; }
    .panel { background: #fff; border: 1px solid #d5dbe6; border-radius: 10px; overflow: hidden;
      box-shadow: 0 10px 28px rgba(30, 41, 59, .18); display: flex; flex-direction: column; max-height: var(--cvh-max-height, 72vh); }
    .hd { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 12px; background: #4f5d7e; color: #fff;
      cursor: move; user-select: none; }
    .hd .title { font-weight: 600; white-space: nowrap; }
    .hd .who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; opacity: .92; }
    .tag { font-size: 11px; padding: 1px 7px; border-radius: 9px; white-space: nowrap; }
    .tag.guest { background: #f59e0b; color: #fff; }
    .tag.member { background: rgba(255,255,255,.2); color: #fff; }
    .hd button { all: unset; cursor: pointer; width: 24px; height: 22px; text-align: center; line-height: 20px;
      border-radius: 4px; color: #fff; font-size: 16px; }
    .hd button:hover { background: rgba(255,255,255,.18); }
    .bd { overflow: auto; padding: 4px 0; }
    .sec { padding: 6px 12px 4px; }
    .sec + .sec { border-top: 1px dashed #eef1f6; }
    .sec h4 { margin: 0 0 3px; font-size: 12px; color: #64748b; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .sec h4 .n { background: #eef2f7; color: #64748b; border-radius: 8px; padding: 0 6px; font-weight: 500; font-size: 11px; }
    .sec h4 .n.has { background: #dcfce7; color: #166534; }
    .empty { color: #b6c0cf; font-size: 12px; padding: 0 0 4px; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: grid; grid-template-columns: 1fr auto auto; align-items: center; column-gap: 6px;
      padding: 5px 6px; margin: 0 -6px; border-radius: 6px; }
    li:hover { background: #f5f7fb; }
    li.new { animation: flash 2.6s ease-out; }
    @keyframes flash { 0%, 35% { background: #fef3c7; } 100% { background: transparent; } }
    .val { font-family: Consolas, "Courier New", monospace; font-size: 14px; color: #0f172a; cursor: pointer;
      word-break: break-all; }
    .val:hover { color: #2563eb; text-decoration: underline; }
    .val.cn { font-family: inherit; font-size: 14px; font-weight: 600; }
    .meta { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center;
      font-size: 11px; color: #94a3b8; margin-top: 1px; }
    .b { padding: 0 5px; border-radius: 4px; font-size: 11px; line-height: 16px; }
    .b.guess { background: #f1f5f9; color: #64748b; }
    .b.warn { background: #fef3c7; color: #b45309; }
    .b.sub { background: #ede9fe; color: #6d28d9; }
    .b.info { background: #e0f2fe; color: #0369a1; }
    .copy { all: unset; cursor: pointer; font-size: 12px; padding: 1px 9px; border-radius: 5px;
      background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; white-space: nowrap; }
    .copy:hover { background: #dbeafe; }
    .copy.ok { background: #dcfce7; color: #15803d; border-color: #bbf7d0; }
    .copy.bad { background: #fee2e2; color: #b91c1c; border-color: #fecaca; }
    .x { all: unset; cursor: pointer; color: #b6c0cf; width: 18px; text-align: center; font-size: 15px; }
    .x:hover { color: #ef4444; }
    .ft { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid #eef1f6; background: #fafbfd; }
    .all { all: unset; cursor: pointer; font-size: 12px; padding: 4px 12px; border-radius: 6px; background: #22c55e;
      color: #fff; font-weight: 600; white-space: nowrap; }
    .all:hover { background: #16a34a; }
    .all.ok { background: #15803d; }
    .link { all: unset; cursor: pointer; font-size: 11px; color: #2563eb; white-space: nowrap; }
    .stat { font-size: 11px; color: #94a3b8; margin-left: auto; text-align: right; }
    .pill { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; background: #4f5d7e; color: #fff;
      padding: 6px 12px; border-radius: 18px; box-shadow: 0 6px 18px rgba(30,41,59,.25); font-size: 13px; float: right; }
    .pill b { background: #22c55e; border-radius: 9px; padding: 0 7px; font-weight: 600; }
    .toast { position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%); background: rgba(15,23,42,.9); color: #fff;
      padding: 7px 14px; border-radius: 6px; font: 13px "Microsoft YaHei", system-ui, sans-serif; opacity: 0;
      transition: opacity .2s; pointer-events: none; z-index: 2147483647; }
    .toast.on { opacity: 1; }
  `;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } };

  let ui = null;
  let lastSig = '';
  let lastConv = null;
  let lastStat = null;
  let suppressClick = false;
  let minimized = lsGet('cvh.min') === '1';
  const renderedKeys = new Map(); // 对话 → 上次显示过的项目，用来标出「新出现」
  let lastRenderedConvKey = null;

  function ensureUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.setAttribute('data-cvh', '');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="wrap"></div><div class="toast"></div>`;
    ui = { host, root, wrap: root.querySelector('.wrap'), toast: root.querySelector('.toast') };

    const saved = (lsGet('cvh.pos') || '').split(',').map(Number);
    if (saved.length === 2 && saved.every(Number.isFinite)) {
      // 读取保存的位置(left, bottom)，转换为 placeAt 期望的 y 值
      const y = window.innerHeight - saved[1] - (ui.wrap.offsetHeight || 400);
      placeAt(saved[0], y);
    }

    root.addEventListener('click', onClick);
    root.addEventListener('dblclick', onDblClick);
    setupDrag(root);

    const updateMaxHeight = () => {
      setTimeout(() => {
        // 根据面板的实际位置动态调整最大高度，防止超出屏幕
        const rect = ui.wrap.getBoundingClientRect();
        if (rect.top < 0) return; // 面板还未渲染
        const bottom = 20; // 距离屏幕底部的最小距离
        const minTop = 10; // 距离屏幕顶部的最小距离
        const availableHeight = Math.max(300, window.innerHeight - rect.top - bottom);
        ui.root.style.setProperty('--cvh-max-height', availableHeight + 'px');
      }, 50);
    };

    window.addEventListener('resize', () => {
      updateMaxHeight();
      if (ui.wrap.style.left) {
        const y = window.innerHeight - parseFloat(ui.wrap.style.bottom) - (ui.wrap.offsetHeight || 400);
        placeAt(parseFloat(ui.wrap.style.left), y);
      }
    });

    // 每次render后也更新高度
    const originalRender = render;
    render = function(conv, stat) {
      originalRender.call(this, conv, stat);
      updateMaxHeight();
    };

    updateMaxHeight();
    return ui;
  }

  function placeAt(x, y) {
    const w = ui.wrap.offsetWidth || 300;
    const h = ui.wrap.offsetHeight || 400;
    x = Math.max(0, Math.min(x, window.innerWidth - w));
    // 使用 bottom 定位，确保面板向上扩展而不是向下扩展
    const bottom = Math.max(20, window.innerHeight - y - h);
    Object.assign(ui.wrap.style, { left: x + 'px', bottom: bottom + 'px', top: 'auto', right: 'auto' });
  }

  function setupDrag(root) {
    let drag = null;
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const handle = e.target.closest('[data-drag]');
      if (!handle) return;
      if (e.target.closest('button') && !e.target.closest('.pill')) return;
      const r = ui.wrap.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return;
      drag.moved = true;
      placeAt(e.clientX - drag.dx, e.clientY - drag.dy);
    }, true);
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      if (drag.moved) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        // 保存 left 和 bottom 位置
        lsSet('cvh.pos', parseFloat(ui.wrap.style.left) + ',' + parseFloat(ui.wrap.style.bottom));
      }
      drag = null;
    }, true);
  }

  function shortTime(t) {
    const today = normTime(new Date().toLocaleString('sv').replace(/-/g, '/')).slice(0, 10);
    return t.startsWith(today) ? t.slice(11) : t.slice(5, 16);
  }

  function visibleItems(conv) {
    return [...conv.items.values()]
      .filter((it) => !conv.dismissed.has(it.key))
      .sort((a, b) => (b.first < a.first ? -1 : b.first > a.first ? 1 : 0));
  }

  function render(conv, stat) {
    if (!ui) return;
    const items = conv ? visibleItems(conv) : [];
    const sig = JSON.stringify([
      minimized, conv && conv.key, conv && conv.dismissed.size, stat,
      items.map((it) => [it.key, it.sure, it.count, it.first]),
    ]);
    if (sig === lastSig) return;
    lastSig = sig;
    lastConv = conv;
    lastStat = stat;

    if (minimized) {
      ui.wrap.innerHTML = `<button class="pill" data-act="max" data-drag title="展开（可拖动）">核对信息 <b>${items.length}</b></button>`;
      return;
    }

    const prev = conv && renderedKeys.get(conv.key);
    const isSameConv = conv && lastRenderedConvKey === conv.key;
    const who = conv && conv.key ? conv.key : '未识别访客';

    // 显示身份标签：guest 访客直接显示"访客"，其他访客显示身份
    let tag = '';
    if (conv && conv.key) {
      if (conv.isGuest) {
        // guest 访客始终显示"访客"
        tag = '<span class="tag guest">访客</span>';
      } else {
        // 非 guest 访客：优先使用页面读取的身份，其次使用对话中识别的身份
        let displayIdentity = null;
        if (conv.pageIdentity) {
          displayIdentity = conv.pageIdentity;
        } else {
          const identities = items.filter((it) => it.type === 'identity');
          if (identities.length) {
            displayIdentity = identities[0].value;
          }
        }

        if (displayIdentity) {
          const coreIdentity = displayIdentity.replace(/^(?:正式|兼职|临时)[-|]?/, '');
          tag = `<span class="tag member">${coreIdentity}</span>`;
        } else {
          tag = '<span class="tag member">会员</span>';
        }
      }
    }

    const secs = TYPES.filter((tp) => tp.key !== 'identity').map((tp) => {
      const list = items.filter((it) => it.type === tp.key);
      const rows = list.map((it) => {
        const disp = it.value; // 卡号统一不加空格显示，与复制内容一致
        const badges = [];
        if (it.sub) badges.push(`<span class="b sub">${esc(it.sub)}</span>`);
        if (it.type === 'card') badges.push(`<span>${it.value.length} 位</span>`);
        if (it.flags.includes('joined')) badges.push('<span class="b info" title="访客原文中间有空格，已自动去掉">已去空格</span>');
        if (it.flags.includes('luhn')) badges.push('<span class="b warn" title="卡号校验位不符，访客可能打错">校验未通过·可能打错</span>');
        if (!it.sure) badges.push('<span class="b guess" title="客服没有明确问到，按格式推测的">推测</span>');
        if (it.count > 1) badges.push(`<span>出现 ${it.count} 次</span>`);
        const isNew = isSameConv && prev && !prev.has(it.key);
        return `<li data-key="${esc(it.key)}"${isNew ? ' class="new"' : ''}>
            <span class="val${it.type === 'name' ? ' cn' : ''}" data-act="jump" title="单击：定位到原消息　双击：直接复制">${esc(disp)}</span>
            <button class="copy" data-act="copy">复制</button>
            <button class="x" data-act="dismiss" title="不是，移除">×</button>
            <div class="meta"><span>${esc(shortTime(it.last))}</span>${badges.join('')}</div>
          </li>`;
      }).join('');
      return `<div class="sec"><h4>${tp.label}<span class="n${list.length ? ' has' : ''}">${list.length}</span></h4>${
        rows ? `<ul>${rows}</ul>` : '<div class="empty">尚未提供</div>'}</div>`;
    }).join('');

    const restore = conv && conv.dismissed.size
      ? `<button class="link" data-act="restore">恢复已移除(${conv.dismissed.size})</button>` : '';

    ui.wrap.innerHTML = `
      <div class="panel">
        <div class="hd" data-drag title="按住可拖动">
          <span class="title">核对信息</span>
          <span class="who" title="${esc(who)}">${esc(who)}</span>${tag}
          <button data-act="min" title="收起">–</button>
        </div>
        <div class="bd">${secs}</div>
        <div class="ft">
          <button class="all" data-act="copyall">复制全部</button>${restore}
          <span class="stat">${stat ? `已读 ${stat.total} 条 · 访客 ${stat.visitor} 条` : ''}</span>
        </div>
      </div>`;

    if (conv) renderedKeys.set(conv.key, new Set(items.map((it) => it.key)));
    lastRenderedConvKey = conv && conv.key;
  }

  function forceRender() { lastSig = ''; render(lastConv, lastStat); }

  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => ui.toast.classList.remove('on'), 1800);
  }

  async function copyText(s) {
    try { await navigator.clipboard.writeText(s); return true; } catch (e) { /* 改用旧方法 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      ui.root.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function flashButton(btn, ok, okText) {
    const old = btn.textContent;
    btn.textContent = ok ? okText : '复制失败';
    btn.classList.add(ok ? 'ok' : 'bad');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('ok', 'bad'); }, 1200);
  }

  function jump(it) {
    const occ = [...it.occ.values()].sort((a, b) => (a.time < b.time ? 1 : -1));
    const o = occ.find((x) => x.headerEl && x.headerEl.isConnected);
    if (!o) { toast('原消息已不在页面上（可能需要往上滚动加载）'); return; }
    const target = o.nodes.find((n) => n.nodeType === 1 && n.isConnected) || o.headerEl;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const s = target.style;
    const prev = [s.outline, s.outlineOffset, s.borderRadius];
    s.outline = '3px solid #f59e0b';
    s.outlineOffset = '2px';
    setTimeout(() => { [s.outline, s.outlineOffset, s.borderRadius] = prev; }, 1800);
  }

  async function onClick(e) {
    if (suppressClick) return;
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const conv = lastConv;
    const li = el.closest('[data-key]');
    const it = conv && li ? conv.items.get(li.dataset.key) : null;

    if (act === 'min' || act === 'max') {
      minimized = act === 'min';
      lsSet('cvh.min', minimized ? '1' : '0');
      forceRender();
    } else if (act === 'copy' && it) {
      flashButton(el, await copyText(it.value), '已复制');
    } else if (act === 'jump' && it) {
      clearTimeout(jumpTimer);
      jumpTimer = setTimeout(() => jump(it), 260);
    } else if (act === 'dismiss' && it) {
      conv.dismissed.add(it.key);
      forceRender();
    } else if (act === 'restore' && conv) {
      conv.dismissed.clear();
      forceRender();
    } else if (act === 'copyall') {
      const items = conv ? visibleItems(conv) : [];
      const lines = [];
      if (conv && conv.key) lines.push('访客：' + conv.key);
      for (const tp of TYPES) {
        const v = items.filter((x) => x.type === tp.key).map((x) => x.value);
        lines.push(tp.label + '：' + (v.length ? v.join('、') : '（无）'));
      }
      flashButton(el, await copyText(lines.join('\n')), '已复制 ✓');
    }
  }

  let jumpTimer = 0;

  // 双击数值 → 直接复制（取消单击触发的定位，并清掉双击选中的文字）
  async function onDblClick(e) {
    const el = e.target.closest('[data-act="jump"]');
    if (!el) return;
    clearTimeout(jumpTimer);
    const conv = lastConv;
    const li = el.closest('[data-key]');
    const it = conv && li ? conv.items.get(li.dataset.key) : null;
    if (!it) return;
    e.preventDefault();
    try { window.getSelection().removeAllRanges(); } catch (err) { /* 忽略 */ }
    try { ui.root.getSelection && ui.root.getSelection().removeAllRanges(); } catch (err) { /* 忽略 */ }
    const ok = await copyText(it.value);
    const btn = li.querySelector('[data-act="copy"]');
    if (btn) flashButton(btn, ok, '已复制');
    toast(ok ? '已复制：' + it.value : '复制失败，请点「复制」按钮');
  }

  /* =========================================================
   * 六、主流程
   * ========================================================= */

  // 从页面上读取访客的身份标签（显示在访客名下方）
  function readIdentityFromPage(visitorName) {
    try {
      // 在页面上查找包含访客名的元素
      const pageText = document.body.innerText || '';
      // 查找身份标签（通常在访客名附近）
      const identityMatch = pageText.match(new RegExp(visitorName + '[\\s\\S]{0,100}?(正式[-|]?代理|兼职[-|]?代理|会员|代理|VIP)'));
      if (identityMatch) {
        const identity = identityMatch[1];
        return identity;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function scan() {
    const headers = findHeaders();
    if (!headers.length) {
      if (ui) render(null, null);
      return;
    }
    const headerEls = headers.map((h) => h.el);
    const hcount = new Map();
    for (const h of headerEls) for (let a = h; a; a = a.parentElement) hcount.set(a, (hcount.get(a) || 0) + 1);
    const box = findListBox(headerEls, hcount);
    const boxRect = box ? box.getBoundingClientRect() : null;

    const msgs = headers.map((h) => {
      const b = findBubble(h.el, hcount);
      return { sender: h.sender, time: h.time, text: b.text, nodes: b.nodes, headerEl: h.el, side: sideOf(h.el, boxRect) };
    });
    assignRoles(msgs);
    const conv = currentConversation(msgs);
    extractInto(conv, msgs);

    // 尝试从页面上读取身份信息（仅用于显示标签，不添加到列表）
    if (conv && conv.key) {
      const pageIdentity = readIdentityFromPage(conv.key);
      if (pageIdentity) {
        conv.pageIdentity = pageIdentity;
      }
    }

    ensureUI();
    render(conv, { total: msgs.length, visitor: msgs.filter((m) => m.role === 'visitor').length });

    // 调试用：在控制台输入 __cvhDebug() 可看每条消息被判成谁、内容是什么
    window.__cvhDebug = () => console.table(msgs.map((m) => ({ 发送者: m.sender, 时间: m.time, 判定: m.role, 位置: m.side, 内容: m.text })));
  }

  const safeScan = () => { try { scan(); } catch (e) { console.warn('[核对信息]', e); } };

  let pending = false;
  let lastRun = 0;
  function schedule() {
    if (pending) return;
    pending = true;
    const wait = Math.max(300, 800 - (Date.now() - lastRun));
    setTimeout(() => { pending = false; lastRun = Date.now(); safeScan(); }, wait);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setInterval(() => { if (document.visibilityState === 'visible') safeScan(); }, 4000);
  document.addEventListener('visibilitychange', schedule);
  safeScan();
})();
