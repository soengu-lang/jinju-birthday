#!/usr/bin/env node
/* ============================================================
   StockLens 미리 받아 두기 — GitHub 이 대신 시세를 받아 옵니다
   ------------------------------------------------------------
   왜 필요한가
     앱은 서버가 없는 정적 페이지라, 폰에서 네이버·야후를 직접 부르면
     브라우저 보안(CORS)에 막힙니다. 남의 공개 중계는 자주 죽습니다.
     그래서 GitHub Actions 가 2시간마다 여기서 받아 같은 주소에 올려 둡니다.
     앱은 그 파일을 그냥 읽으면 되므로 중계가 아예 필요 없습니다.

   무엇을 만드나
     data/prices.json        모든 종목의 시세 (매번 갱신, 작음)
     data/fund/<코드>.json   투자지표·연간재무·일봉·뉴스 (바뀔 때만 다시 씀)
     data/index.json         목록과 갱신 시각

   실행:  node stocklens/tools/fetch-data.mjs
   ============================================================ */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/,/g, '').replace(/%/g, '').replace(/[^\d.\-]/g, '');
  return s === '' || s === '-' || s === '.' ? NaN : Number(s);
};
const has = v => v != null && Number.isFinite(v);
const round = (v, d = 2) => has(v) ? Math.round(v * 10 ** d) / 10 ** d : null;

async function get(url, { json = true, tries = 3 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = AbortSignal.timeout(20000);
      const r = await fetch(url, { signal: ctl, headers: { 'User-Agent': UA, 'Referer': 'https://finance.naver.com/', 'Accept': '*/*' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (!t.trim()) throw new Error('빈 응답');
      return json ? JSON.parse(t) : t;
    } catch (e) { last = e; await sleep(400 * (i + 1)); }
  }
  throw last;
}

/* ---------- 네이버 국내 ---------- */
const NV = {
  basic: c => `https://m.stock.naver.com/api/stock/${c}/basic`,
  integ: c => `https://m.stock.naver.com/api/stock/${c}/integration`,
  annual: c => `https://m.stock.naver.com/api/stock/${c}/finance/annual`,
  news: c => `https://m.stock.naver.com/api/news/stock/${c}?pageSize=12&page=1`,
  chart: c => {
    const f = d => d.toISOString().slice(0, 10).replace(/-/g, '') + '0000';
    return `https://api.stock.naver.com/chart/domestic/item/${c}/day`
      + `?startDateTime=${f(new Date(Date.now() - 400 * 864e5))}&endDateTime=${f(new Date())}`;
  },
};
/* ---------- 네이버 해외 / 야후 ---------- */
const NVU = {
  basic: s => `https://api.stock.naver.com/stock/${s}/basic`,
  integ: s => `https://api.stock.naver.com/stock/${s}/integration`,
  annual: s => `https://api.stock.naver.com/stock/${s}/finance/annual`,
  /* 확인된 경로 (2026-09 진단): 뉴스는 news/stock, 일봉은 chart/foreign 입니다 */
  news: s => `https://api.stock.naver.com/news/stock/${s}?pageSize=12&page=1`,
  chart: s => {
    const f = d => d.toISOString().slice(0, 10).replace(/-/g, '') + '0000';
    return `https://api.stock.naver.com/chart/foreign/item/${s}/day`
      + `?startDateTime=${f(new Date(Date.now() - 400 * 864e5))}&endDateTime=${f(new Date())}`;
  },
};
const YH = {
  /* 야후는 한 주소가 429(너무 잦음)를 내면 다른 주소로 바꿔 봅니다 */
  hosts: ['query1', 'query2'],
  chart: (t, h = 'query1') => `https://${h}.finance.yahoo.com/v8/finance/chart/${t}?range=1y&interval=1d`,
};
async function yhChart(code) {
  let last;
  for (const h of YH.hosts) {
    try { return parseYhChart(await get(YH.chart(code, h), { tries: 2 })); }
    catch (e) { last = e; await sleep(1500); }
  }
  throw last;
}

/* ---------- 파서 (앱과 같은 형태로 만듭니다) ---------- */
function parseBasic(j) {
  const b = j?.datas?.[0] || j || {};
  const price = num(b.closePrice);
  let diff = num(b.compareToPreviousClosePrice);
  if (has(diff) && diff > 0 && String(b?.compareToPreviousPrice?.code || '') === '5') diff = -diff;
  return {
    price, prev: has(diff) ? price - diff : NaN,
    name: b.stockName || b.itemName || '',
    market: b.stockExchangeType?.name || b.stockExchangeName || '',
    marketCap: num(b.marketValue),
    industry: b.industryCodeType?.industryGroupKor || '',
  };
}
const INTEG_MAP = {
  marketValue: 'marketCap', 시가총액: 'marketCap', per: 'per', PER: 'per', pbr: 'pbr', PBR: 'pbr',
  eps: 'eps', EPS: 'eps', bps: 'bps', BPS: 'bps', dividendYieldRatio: 'divYield', 배당수익률: 'divYield',
  highPriceOf52Weeks: 'high52', '52주최고': 'high52', lowPriceOf52Weeks: 'low52', '52주최저': 'low52',
  industryPer: 'indPer', 동일업종PER: 'indPer', foreignRatio: 'foreignRatio', 외국인소진율: 'foreignRatio',
  cnsEps: 'epsE', cnsPer: 'perE',
};
function parseInteg(j) {
  const out = {};
  for (const it of (j?.totalInfos || j?.stockInfos || [])) {
    const k = INTEG_MAP[it.code] || INTEG_MAP[String(it.key || '').replace(/\s/g, '')];
    if (k) out[k] = num(it.value);
  }
  const c = j?.consensusInfo || j?.consensus || {};
  out.target = num(c.priceTargetMean ?? c.targetPrice ?? c.priceTargetAvg);
  out.recomm = num(c.recommMean ?? c.recommendation);
  if (!has(out.epsE)) out.epsE = num(c.eps ?? c.epsMean);
  out.industry = j?.industryCompareInfo?.industryName || j?.industryInfo?.industryName || j?.industryName || '';
  out.corpSummary = String(j?.corporationSummary || j?.stockInfo?.corporationSummary || '').slice(0, 400);
  for (const k of Object.keys(out)) if (typeof out[k] === 'number' && !has(out[k])) delete out[k];
  return out;
}
const FIN_ROWS = [
  ['revenue', ['매출액', '수익(매출액)', '매출', '영업수익']], ['op', ['영업이익', '영업이익(발표기준)', 'EBIT']],
  ['ni', ['당기순이익', '당기순이익(지배)', '지배주주순이익', '세후손익']], ['opm', ['영업이익률']], ['npm', ['순이익률']],
  ['roe', ['ROE(%)', 'ROE', '자기자본이익률']], ['debt', ['부채비율']], ['quick', ['당좌비율']],
  ['reserve', ['자본유보율', '유보율']], ['eps', ['EPS(원)', 'EPS']], ['per', ['PER(배)', 'PER']],
  ['bps', ['BPS(원)', 'BPS']], ['pbr', ['PBR(배)', 'PBR']], ['dps', ['현금DPS(원)', '주당배당금', 'DPS(원)', 'DPS']],
  ['divy', ['현금배당수익률', '배당수익률']], ['roa', ['ROA']], ['ebitda', ['EBITDA']],
];
function finKey(title) {
  const t = String(title || '').replace(/\s/g, '');
  if (!t) return null;
  for (const [k, alias] of FIN_ROWS) if (alias.includes(t)) return k;
  let best = null, len = 0;
  for (const [k, alias] of FIN_ROWS) for (const a of alias) if (t.startsWith(a) && a.length > len) { best = k; len = a.length; }
  return best;
}
function parseFinance(j) {
  const fi = j?.financeInfo || j || {};
  const rows = fi.rowList || fi.rows || [];
  let cols = (fi.trTitleList || fi.titleList || []).map(t => ({
    key: t.key || t.code || t.title, title: t.title || t.key, est: /E|예상|추정/.test(String(t.title || t.key)),
  }));
  const table = {};
  for (const r of rows) {
    const key = finKey(r.title || r.name);
    if (!key || table[key]) continue;
    const vals = {}, colsObj = r.columns || r.values || {};
    for (const [ck, cv] of Object.entries(colsObj)) { const v = num(cv?.value ?? cv); if (has(v)) vals[ck] = round(v, 2); }
    table[key] = vals;
    if (!cols.length) cols = Object.keys(colsObj).map(k => ({ key: k, title: k, est: /E/.test(k) }));
  }
  cols = cols.filter(c => Object.values(table).some(v => v[c.key] != null));
  return { cols, table };
}
function parseChart(j) {
  const arr = Array.isArray(j) ? j : (j?.priceInfos || j?.result || []);
  return arr.map(x => ({
    d: String(x.localDate || x.localDateTime || x.date || '').replace(/\D/g, '').slice(0, 8),
    c: num(x.closePrice ?? x.close), v: num(x.accumulatedTradingVolume ?? x.volume),
  }))
    .filter(x => has(x.c) && x.d).slice(-260);
}
function parseYhChart(j) {
  const r = j?.chart?.result?.[0]; if (!r) throw new Error('시세 없음');
  const m = r.meta || {}, closes = r.indicators?.quote?.[0]?.close || [], stamps = r.timestamp || [];
  const chart = [];
  for (let i = 0; i < stamps.length; i++) {
    const c = num(closes[i]); if (!has(c)) continue;
    chart.push({ d: new Date(stamps[i] * 1000).toISOString().slice(0, 10).replace(/-/g, ''), c: round(c, 2), v: num(r.indicators?.quote?.[0]?.volume?.[i]) });
  }
  const price = num(m.regularMarketPrice);
  const prev = chart.length > 1 ? chart[chart.length - 2].c : num(m.chartPreviousClose);
  return { price, prev, name: m.longName || m.shortName || '', market: m.fullExchangeName || '', chart: chart.slice(-260), high52: num(m.fiftyTwoWeekHigh), low52: num(m.fiftyTwoWeekLow) };
}
function decodeEnt(s) {
  return String(s).replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
}
function parseNews(j) {
  const groups = Array.isArray(j) ? j : (j?.items ? [j] : []);
  const items = [];
  for (const g of groups) for (const a of (g.items || (g.title ? [g] : []))) {
    items.push({
      id: String(a.articleId || a.id || a.title), title: decodeEnt(a.title || ''), office: a.officeName || '',
      dt: String(a.datetime || a.date || ''),
      url: (a.officeId && a.articleId) ? `https://n.news.naver.com/mnews/article/${a.officeId}/${a.articleId}` : (a.url || ''),
    });
  }
  const seen = new Set();
  return items.filter(x => x.title && !seen.has(x.id) && seen.add(x.id)).slice(0, 12);
}

/* ---------- 한 종목 ---------- */
async function fetchKr(code) {
  const basic = parseBasic(await get(NV.basic(code)));
  if (!(basic.price > 0)) throw new Error('시세 없음');
  const [integ, annual, chart, news] = await Promise.all([
    get(NV.integ(code)).then(parseInteg).catch(() => ({})),
    get(NV.annual(code)).then(parseFinance).catch(() => ({ cols: [], table: {} })),
    get(NV.chart(code)).then(parseChart).catch(() => []),
    get(NV.news(code)).then(parseNews).catch(() => []),
  ]);
  if (!integ.industry && basic.industry) integ.industry = basic.industry;
  return { mk: 'kr', ccy: 'KRW', basic, integ, annual, chart, news };
}
/* 미국 연간표: 매출·EBIT·세후손익만 오므로 영업이익률·순이익률은 직접 냅니다 */
function usAnnual(fin) {
  const a = parseFinance(fin);
  const t = a.table;
  if (t.revenue) {
    const marg = (src, key) => {
      if (!src || t[key]) return;
      const out = {};
      for (const [c, v] of Object.entries(src)) { const r = t.revenue[c]; if (has(r) && r > 0 && has(v)) out[c] = round(v / r * 100, 2); }
      if (Object.keys(out).length) t[key] = out;
    };
    marg(t.op, 'opm'); marg(t.ni, 'npm');
  }
  return a;
}
/* 네이버가 쓰는 심볼 후보 — 되는 것을 찾을 때까지 차례로 봅니다 */
function usSymbols(code) {
  const out = [code + '.O', code, code.replace('-', '.')];
  const cls = code.replace(/-([A-Za-z])$/, (m, c) => c.toLowerCase());   /* BRK-B → BRKb */
  if (cls !== code) out.push(cls);
  return [...new Set(out)];
}
/* stooq — 열쇠도 제한도 없는 무료 일봉 CSV (마지막 예비) */
async function stooq(code) {
  const csv = await get(`https://stooq.com/q/d/l/?s=${encodeURIComponent(code.replace('-', '.').toLowerCase())}.us&i=d`, { json: false, tries: 2 });
  const rows = csv.trim().split('\n').slice(1);
  const chart = [];
  for (const r of rows) {
    const c = r.split(',');
    const close = num(c[4]);
    if (c.length < 5 || !has(close)) continue;
    chart.push({ d: c[0].replace(/-/g, ''), c: round(close, 2), v: num(c[5]) });
  }
  if (chart.length < 30) throw new Error('stooq 자료 부족');
  const last = chart.slice(-260);
  return { chart: last, price: last[last.length - 1].c, prev: last[last.length - 2].c };
}
async function fetchUs(code) {
  let nsym = '', basic = null, raw = null, integ = {}, annual = { cols: [], table: {} }, news = [];
  /* 나스닥은 .O, 뉴욕은 접미사 없음, 클래스주는 소문자 (BRK-B → BRKb). .K/.N 은 409 입니다 */
  for (const s of usSymbols(code)) {
    try {
      const j = await get(NVU.basic(s));
      const b = parseBasic(j);
      if (b.price > 0) { nsym = s; basic = b; raw = j?.datas?.[0] || j; break; }
    } catch (e) { }
  }
  let chart = [], high52 = NaN, low52 = NaN;
  /* 일봉은 네이버 해외 차트를 먼저 씁니다 — 야후는 깃허브에서 자주 429(너무 잦음)를 냅니다 */
  if (nsym) chart = await get(NVU.chart(nsym)).then(parseChart).catch(() => []);
  if (chart.length < 30) {
    try {
      const y = await yhChart(code);
      if (y.chart.length > chart.length) chart = y.chart;
      high52 = y.high52; low52 = y.low52;
      if (!basic || !(basic.price > 0)) basic = { price: y.price, prev: y.prev, name: y.name, market: y.market, marketCap: NaN };
    } catch (e) { }
  }
  /* 네이버에도 야후에도 없으면 stooq(무료 CSV)로 받아 옵니다 — SCHD 같은 ETF */
  if ((!basic || !(basic.price > 0)) || chart.length < 30) {
    const st = await stooq(code).catch(() => null);
    if (st && st.chart.length > chart.length) {
      chart = st.chart;
      if (!basic || !(basic.price > 0)) basic = { price: st.price, prev: st.prev, name: '', market: '', marketCap: NaN };
    }
  }
  if (!basic || !(basic.price > 0)) throw new Error('시세 없음');
  /* 52주 최고·최저를 못 받았으면 일봉에서 직접 셉니다 */
  if (!has(high52) && chart.length > 20) {
    const cs = chart.slice(-260).map(x => x.c);
    high52 = Math.max(...cs); low52 = Math.min(...cs);
  }
  if (nsym) {
    const ij = await get(NVU.integ(nsym)).catch(() => null);
    if (ij) {
      integ = parseInteg(ij);
      /* 시가총액·배당은 같이 오는 '같은 업종 종목들' 목록에서 내 것을 찾아 씁니다 */
      const me = (ij.industryCompareInfo?.globalStocks || []).find(x => x.reutersCode === nsym || x.symbolCode === code);
      if (me) {
        const cap = num(me.marketValueRaw ?? me.marketValue);
        if (has(cap) && cap > 0) integ.marketCap = cap;
        const dy = num(me.dividendYield); if (has(dy)) integ.divYield = dy;
      }
    }
    annual = await get(NVU.annual(nsym)).then(usAnnual).catch(() => ({ cols: [], table: {} }));
    /* PER·PBR·배당은 연간표의 가장 최근 열에서 끌어옵니다 */
    const lastCol = annual.cols.length ? annual.cols[annual.cols.length - 1].key : null;
    if (lastCol) for (const [k, row] of [['per','per'], ['pbr','pbr'], ['divYield','divy']]) {
      const v = annual.table[row]?.[lastCol];
      if (!has(integ[k]) && has(v)) integ[k] = v;
    }
    news = await get(NVU.news(nsym)).then(parseNews).catch(() => []);
  }
  if (!integ.industry && basic?.industry) integ.industry = basic.industry;
  if (has(integ.marketCap) && integ.marketCap > 0 && integ.marketCap < 1e8) integ.marketCap *= 1e6;
  /* 시가총액은 basic 의 marketValueFullRaw(달러 그대로)가 가장 정확합니다 */
  const capUsd = num(raw?.marketValueFullRaw);
  if (has(capUsd) && capUsd > 0) integ.marketCap = capUsd;
  const shares = num(raw?.countOfListedStock);
  if (has(shares) && shares > 0) integ.shares = shares;
  if (!has(integ.high52) && has(high52)) integ.high52 = high52;
  if (!has(integ.low52) && has(low52)) integ.low52 = low52;
  return { mk: 'us', ccy: 'USD', sym: nsym || code, basic, integ, annual, chart, news };
}

/* ---------- 진단 모드 ----------
   DEBUG_CODE 를 주면 그 종목의 원본 응답을 찍고 끝냅니다 (파싱을 고칠 때 씁니다) */
/* 미국 종목의 '시가총액·뉴스' 를 어디서 가져올지 찾을 때 쓰는 집중 진단 */
async function debugUsFields(code) {
  for (const s of [code + '.O', code, code.replace('-', '.'), code.replace(/-([A-Za-z])$/, (m, c) => c.toLowerCase()), code + '.P']) {
    let b = null;
    try { b = await get(NVU.basic(s)); } catch (e) { console.log(`basic ${s} → ${e.message}`); continue; }
    const d = b?.datas?.[0] || b || {};
    console.log(`basic ${s} → ${d.stockName || '?'} / reuters=${d.reutersCode || '?'} / 키: ${Object.keys(d).join(',')}`);
    const cap = Object.entries(d).filter(([k]) => /market|cap|value|amount/i.test(k));
    if (cap.length) console.log('   시총 후보: ' + JSON.stringify(cap));
    let ij = null;
    try { ij = await get(NVU.integ(s)); } catch (e) { console.log(`   integration → ${e.message}`); }
    if (ij) {
      console.log('   integration 키: ' + Object.keys(ij).join(','));
      const g = ij.industryCompareInfo?.globalStocks || ij.industryCompareInfo?.stocks || [];
      console.log('   globalStocks ' + g.length + '개' + (g[0] ? ' 첫 항목: ' + JSON.stringify(g[0]).slice(0, 400) : ''));
      for (const [k, v] of Object.entries(ij)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const hit = Object.entries(v).filter(([kk]) => /market|cap/i.test(kk));
          if (hit.length) console.log(`   ${k}: ` + JSON.stringify(hit).slice(0, 300));
        }
      }
      const rc = d.reutersCode || s;
      try {
        const n = await get(`https://api.stock.naver.com/news/stock/${rc}?pageSize=5&page=1`);
        console.log(`   뉴스(${rc}) → ${Array.isArray(n) ? n.length + '개' : typeof n}`);
      } catch (e) { console.log(`   뉴스(${rc}) → ${e.message}`); }
      break;
    }
    await sleep(300);
  }
}
/* 국내 종목의 '업종' 이 어디 있는지 찾는 진단 */
async function debugKrIndustry(code) {
  for (const [name, u] of [['basic', NV.basic(code)], ['integration', NV.integ(code)]]) {
    try {
      const j = await get(u);
      const seen = [];
      const walk = (o, at, depth) => {
        if (!o || typeof o !== 'object' || depth > 3) return;
        for (const [k, v] of Object.entries(o)) {
          if (/industry|업종/i.test(k)) seen.push(`${at}${k} = ${JSON.stringify(v).slice(0, 200)}`);
          else if (v && typeof v === 'object') walk(v, `${at}${k}.`, depth + 1);
        }
      };
      walk(j?.datas?.[0] || j, '', 0);
      console.log(`${name}: ${seen.length ? '\n  ' + seen.join('\n  ') : '업종 비슷한 칸 없음'}`);
    } catch (e) { console.log(`${name} → ${e.message}`); }
    await sleep(300);
  }
}
async function debugOne(code) {
  if (process.env.DEBUG_US === '1') return /^\d{6}$/.test(code) ? debugKrIndustry(code) : debugUsFields(code);
  const isKr = /^\d{6}$/.test(code);
  const urls = isKr
    ? [['basic', NV.basic(code)], ['integration', NV.integ(code)], ['annual', NV.annual(code)], ['news', NV.news(code)], ['chart', NV.chart(code)]]
    : (() => {
        const f = d => d.toISOString().slice(0, 10).replace(/-/g, '') + '0000';
        const s = f(new Date(Date.now() - 400 * 864e5)), e = f(new Date());
        const sym = code + '.O';
        return [
          ['chart foreign', `https://api.stock.naver.com/chart/foreign/item/${sym}/day?startDateTime=${s}&endDateTime=${e}`],
          ['chart worldstock', `https://api.stock.naver.com/chart/worldstock/item/${sym}/day?startDateTime=${s}&endDateTime=${e}`],
          ['chart overseas', `https://api.stock.naver.com/chart/overseas/item/${sym}/day?startDateTime=${s}&endDateTime=${e}`],
          ['news A', `https://api.stock.naver.com/news/worldstock/stock/${sym}?pageSize=8&page=1`],
          ['news B', `https://m.stock.naver.com/api/news/worldstock/${sym}?pageSize=8&page=1`],
          ['news C', `https://api.stock.naver.com/news/stock/${sym}?pageSize=8&page=1`],
          ['news D', `https://m.stock.naver.com/api/news/stock/${sym}?pageSize=8&page=1`],
        ];
      })();
  const full = process.env.DEBUG_FULL === '1';
  for (const [name, u] of urls) {
    try {
      const t = await get(u, { json: false, tries: 1 });
      let hint = '';
      try {
        const j = JSON.parse(t);
        const arr = Array.isArray(j) ? j : (j.rowList || j.financeInfo?.rowList || j.totalInfos || j.priceInfos || null);
        hint = Array.isArray(arr) ? `배열 ${arr.length}개` : '객체 ' + Object.keys(j).slice(0, 6).join(',');
      } catch (e) { hint = 'JSON 아님'; }
      console.log(`OK   ${name.padEnd(18)} ${String(t.length).padStart(7)}자 · ${hint}  ← ${u}`);
      if (full) console.log('     ' + t.slice(0, 600).replace(/\n/g, ' '));
    } catch (e) { console.log(`실패 ${name.padEnd(18)} ${e.message}  ← ${u}`); }
    await sleep(300);
  }
}

/* ---------- 본체 ---------- */
async function main() {
  if (process.env.DEBUG_CODE) { for (const c of process.env.DEBUG_CODE.split(',')) await debugOne(c.trim()); return; }
  const list = JSON.parse(await readFile(path.join(ROOT, 'watchlist.json'), 'utf8'));
  const targets = [
    ...list.kr.map(x => ({ code: x.code, name: x.name, mk: 'kr' })),
    ...list.us.map(x => ({ code: x.code, name: x.name, mk: 'us' })),
  ];
  await mkdir(path.join(DATA, 'fund'), { recursive: true });
  const prices = { updated: new Date().toISOString(), items: {} };
  const index = { updated: prices.updated, codes: [] };
  let ok = 0, fail = 0, rewrote = 0;

  for (const t of targets) {
    try {
      const d = t.mk === 'kr' ? await fetchKr(t.code) : await fetchUs(t.code);
      const name = d.basic.name || t.name;
      prices.items[t.code] = {
        p: round(d.basic.price, 2), prev: round(d.basic.prev, 2), mk: d.mk, n: name,
        cap: has(d.integ.marketCap) ? Math.round(d.integ.marketCap) : null,
      };
      const fund = {
        code: t.code, mk: d.mk, ccy: d.ccy, sym: d.sym || '', name,
        market: d.basic.market || '', integ: d.integ, annual: d.annual, chart: d.chart, news: d.news,
      };
      const file = path.join(DATA, 'fund', t.code + '.json');
      const next = JSON.stringify(fund);
      const cur = existsSync(file) ? await readFile(file, 'utf8') : '';
      if (cur !== next) { await writeFile(file, next); rewrote++; }
      index.codes.push({ code: t.code, mk: d.mk, name });
      ok++;
      process.stdout.write(`✓ ${t.code} ${name} ${d.basic.price}\n`);
    } catch (e) {
      fail++;
      process.stdout.write(`✗ ${t.code} ${t.name} — ${e.message}\n`);
    }
    await sleep(250);                       /* 네이버·야후에 부담을 주지 않게 */
  }
  await writeFile(path.join(DATA, 'prices.json'), JSON.stringify(prices));
  await writeFile(path.join(DATA, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`\n끝: 성공 ${ok} · 실패 ${fail} · 재무 다시 쓴 종목 ${rewrote}`);
  if (!ok) process.exit(1);                 /* 하나도 못 받았으면 실패로 알립니다 */
}
main().catch(e => { console.error('실패:', e); process.exit(1); });
