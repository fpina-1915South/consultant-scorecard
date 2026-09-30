// Consultant Scorecard: pure logic (no Firebase, no DOM). Safe to unit test in Node.
// Inputs are the two weekly files:
//   RSA report  (rsa_report_YYYY-MM-DD_to_YYYY-MM-DD.csv): one row per consultant, month to date,
//                ratios already computed by the report (sum first, divide once).
//   Daily report (daily-report-YYYY-MM-DD.csv): long format, one row per store x metric with
//                daily / WTD / MTD / YTD values and LY / budget comparisons.

// ---------------------------------------------------------------- basics
export function normalizeHeader(h) {
  return String(h ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
export function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim(), neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,%\s]/g, '');
  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return neg ? -n : n;
}
const numOrNull = v => (v === '' || v === null || v === undefined ? null : toNumber(v));
function pad(n) { return String(n).padStart(2, '0'); }
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400000)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${pad(m[1])}-${pad(m[2])}`; }
  return null;
}
export function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'; }
// Consultant id: their name as it appears in the RSA report.
export const cidOf = name => slug(String(name).trim());
export function daysBetween(a, b) {
  const t = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86400000) + 1;
}
// A week is 7 days of the month's goal: monthly totals (Net Sales, Credit Apps) get this share.
export const WEEK_PACE = 7 / 30.4;
export function addDaysIso(iso, n) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
export function mondayOf(iso) { const [y, m, d] = iso.split('-').map(Number); const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return addDaysIso(iso, -((wd + 6) % 7)); }
// 'month' = 1st of a month through a day in that month; 'week' = 8 days or fewer; otherwise 'other'.
export function periodOf(from, to) {
  if (!from || !to || to < from) return 'other';
  if (from.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7)) return 'month';
  if (daysBetween(from, to) <= 8) return 'week';
  return 'other';
}
export const monthsBack = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  return out;
};

// All 41 selling stores, from STORIS locations (Sept 2026). district = STORIS district code.
export const STORES = [
  ['1001', 'Tallahassee', 'CN'], ['1002', 'Thomasville', 'CN'], ['1003', 'Albany', 'CN'], ['1004', 'Macon', 'CN'],
  ['1005', 'Warner Robins', 'CN'], ['1006', 'Dothan', 'CN'], ['1007', 'Enterprise', 'CN'], ['1008', 'Panama City', 'CN'],
  ['1009', 'Valdosta', 'CN'], ['1010', 'Opelika', 'CN'], ['1011', 'Columbus', 'CN'],
  ['1012', 'Town Center', 'JX'], ['1013', 'North', 'JX'], ['1014', 'Orange Park', 'JX'], ['1015', 'Brunswick', 'JX'],
  ['1016', 'Yulee', 'JX'], ['1017', 'St. Augustine', 'JX'], ['1018', 'Outlet Regency', 'JX'],
  ['1101', 'Mobile', 'GC'], ['1102', "D'Iberville", 'GC'], ['1103', 'Spanish Fort', 'GC'], ['1104', 'Pensacola', 'GC'],
  ['1105', 'Crestview', 'GC'], ['1106', 'Ft. Walton', 'GC'], ['1107', 'Outlet Pensacola', 'GC'],
  ['1201', 'Greensboro', 'NC'], ['1202', 'Winston Salem', 'NC'], ['1203', 'Burlington', 'NC'], ['1204', 'Danville', 'NC'],
  ['1205', 'Outlet Greensboro', 'NC'],
  ['1301', 'Baton Rouge', 'LA'], ['1302', 'Lafayette', 'LA'], ['1303', 'Gonzales', 'LA'], ['1304', 'Harahan', 'LA'],
  ['1305', 'Houma', 'LA'], ['1306', 'Lake Charles', 'LA'], ['1307', 'Opelousas', 'LA'], ['1308', 'Ponchatoula', 'LA'],
  ['1309', 'Hattiesburg', 'LA'], ['1310', 'Flowood', 'LA'], ['1311', 'Harvey', 'LA']
].map(([id, name, district]) => ({ id, name, district }));
export const DISTRICTS = { CN: 'Capital / Central', JX: 'Jacksonville', GC: 'Gulf Coast', NC: 'Carolinas / VA', LA: 'Louisiana / Mississippi' };
export const OUTLETS = ['Outlet Regency', 'Outlet Pensacola', 'Outlet Greensboro'];

const storeKey = s => String(s).toLowerCase().replace(/ashley|furniture|homestore|store/g, '').replace(/d\W?i?iberville/, 'iberville').replace(/[^a-z0-9]/g, '');
const STORE_INDEX = new Map();
STORES.forEach(st => {
  STORE_INDEX.set(st.id, st.name);
  STORE_INDEX.set(storeKey(st.name), st.name);
});
STORE_INDEX.set(storeKey('Pensacola Outlet'), 'Outlet Pensacola');
STORE_INDEX.set(storeKey('Greensboro Outlet'), 'Outlet Greensboro');
STORE_INDEX.set(storeKey('Regency Outlet'), 'Outlet Regency');
STORE_INDEX.set(storeKey('Regency'), 'Outlet Regency');
STORE_INDEX.set(storeKey('Fort Walton'), 'Ft. Walton');
STORE_INDEX.set(storeKey('Fort Walton Beach'), 'Ft. Walton');
STORE_INDEX.set(storeKey('Saint Augustine'), 'St. Augustine');
STORE_INDEX.set(storeKey('Jacksonville North'), 'North');
STORE_INDEX.set(storeKey('Jax North'), 'North');
STORE_INDEX.set(storeKey('Jax Orange Park'), 'Orange Park');
STORE_INDEX.set(storeKey('Jax Town Center'), 'Town Center');
STORE_INDEX.set(storeKey('FT Walton Beach'), 'Ft. Walton');
// Maps an export's store name (or STORIS ID) to the store list name. Unknown names come back as-is.
export function canonicalStore(raw) {
  const t = String(raw ?? '').trim();
  const id = t.match(/^(\d{4})\b/);
  if (id && STORE_INDEX.has(id[1])) return STORE_INDEX.get(id[1]);
  return STORE_INDEX.get(storeKey(t)) || t;
}
export const isKnownStore = name => STORES.some(s => s.name === name);

// Region rows in the daily report (not stores). Online and Total are skipped too.
export const REGIONS = ['Big Bend', 'Capital & Acadiana', 'Central', 'Crescent', 'East', 'Fall Line', 'Golden Isles',
  'Gulf Coast', 'Magnolia', 'St. Johns', 'The Piedmont', 'West', 'Wiregrass'];

// ---------------------------------------------------------------- metrics
// Consultant card. Order follows the Core 4. lower: true means lower is better.
export const METRICS = [
  { key: 'netSales',      label: 'Net Sales',          fmt: 'money', monthly: true, col: 'net_sales' },
  { key: 'sph',           label: 'Sales / Hour',       fmt: 'money', col: 'sph' },
  { key: 'avgTicket',     label: 'Avg Ticket w/ Del',  fmt: 'money', col: 'avg_ticket_w_del' },
  { key: 'effMargin',     label: 'Eff. Margin',        fmt: 'pct',   col: 'eff_margin' },
  { key: 'financePct',    label: 'Finance %',          fmt: 'pct',   col: 'fin_of_sales' },
  { key: 'creditApps',    label: 'Credit Apps',        fmt: 'int', monthly: true, col: 'credit_apps' },
  { key: 'beddingPct',    label: 'Bedding %',          fmt: 'pct',   col: 'bed_of_sales' },
  { key: 'beddingSph',    label: 'Bedding / Hour',     fmt: 'money', derived: 'SPH x Bedding %' },
  { key: 'protectionPct', label: 'Protection %',       fmt: 'pct',   col: 'prot_of_sales' },
  { key: 'protectionSph', label: 'Protection / Hour',  fmt: 'money', derived: 'SPH x Protection %' },
  { key: 'deliveryPct',   label: 'Delivery %',         fmt: 'pct',   col: 'del_of_sales' },
  { key: 'cancelPct',     label: 'Cancellation %',     fmt: 'pct', lower: true, col: 'cancellation' },
  { key: 'discountPct',   label: 'Discount %',         fmt: 'pct', lower: true, col: 'discount' }
];
export const CONSULTANT_METRICS = METRICS;

// Store total, straight from the daily report (MTD column). budget: 'pct' = % vs budget,
// 'bps' = basis points vs budget. Where a budget exists it is the store's goal.
export const STORE_METRICS = [
  { key: 'netSales',      label: 'Net Sales',             fmt: 'money', src: 'Net Sales (Stores)', budget: 'pct', ly: true },
  { key: 'spg',           label: 'SPG w/ Cancellations',  fmt: 'money2', src: 'Sales per Guest w. Cancellations', budget: 'pct', ly: true },
  { key: 'closeRate',     label: 'Close Rate',            fmt: 'pct',   src: 'Close Rate', budget: 'bps' },
  { key: 'traffic',       label: 'Traffic',               fmt: 'int',   src: 'Traffic', budget: 'pct', ly: true },
  { key: 'sph',           label: 'Sales / Hour',          fmt: 'money', src: 'Sales per Hour' },
  { key: 'avgTicket',     label: 'Avg Ticket w/ Del',     fmt: 'money', src: 'Avg Ticket w. Del.' },
  { key: 'effMargin',     label: 'Eff. Margin',           fmt: 'pct',   src: 'Eff. Margin' },
  { key: 'financePct',    label: 'Finance %',             fmt: 'pct',   src: 'Finance % of Sales' },
  { key: 'appsToTraffic', label: 'Apps to Traffic',       fmt: 'pct',   src: 'Finance Apps to Traffic' },
  { key: 'beddingPct',    label: 'Bedding %',             fmt: 'pct',   src: 'Bedding % of Sales' },
  { key: 'beddingSph',    label: 'Bedding / Hour',        fmt: 'money', src: 'Bedding SPH' },
  { key: 'protectionPct', label: 'Protection %',          fmt: 'pct',   src: 'Protection % of Sales' },
  { key: 'protectionSph', label: 'Protection / Hour',     fmt: 'money', src: 'Protection SPH' },
  { key: 'protectionAttach', label: 'Protection Attach',  fmt: 'pct',   src: 'Protection Attachment' },
  { key: 'deliveryPct',   label: 'Delivery %',            fmt: 'pct',   src: 'Delivery % of sales' },
  { key: 'cancelPct',     label: 'Cancellation %',        fmt: 'pct', lower: true, calc: 'Cancellations / Gross Sales' }
];

export const DEFAULT_GOALS = {
  standard: { netSales: 46648, sph: 400, avgTicket: 2200, effMargin: 55.5, financePct: 65, creditApps: 18,
    beddingPct: 20, beddingSph: 60, protectionPct: 8, protectionSph: 32, protectionAttach: 60, deliveryPct: 8,
    cancelPct: 4, discountPct: 12, appsToTraffic: 10 },
  outlet: null,
  outletStores: OUTLETS,
  minSph: 250, outletMinSph: 150
};
export const isOutlet = (goals, store) => ((goals || DEFAULT_GOALS).outletStores || OUTLETS).includes(store);
export function goalsFor(goals, store) {
  const g = goals || DEFAULT_GOALS;
  const std = { ...DEFAULT_GOALS.standard, ...(g.standard || {}) };
  if (g.outlet && isOutlet(g, store)) return { ...std, ...g.outlet };
  return std;
}
export function minSphFor(goals, store) {
  const g = { ...DEFAULT_GOALS, ...(goals || {}) };
  return isOutlet(g, store) ? g.outletMinSph : g.minSph;
}

// ---------------------------------------------------------------- RSA report (consultants)
const SKIP_NAMES = /^(rsa goal|house sales.*|zzz|conv|total.*|employee discount.*)$/i;
// Reads the date range out of names like rsa_report_2026-09-01_to_2026-09-28.csv
export function rangeFromFileName(name) {
  const m = String(name || '').match(/(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/);
  return m ? { from: m[1], to: m[2] } : null;
}
export function parseRsa(rawRows) {
  const rows = rawRows.map(r => { const o = {}; for (const [k, v] of Object.entries(r)) o[normalizeHeader(k)] = v; return o; });
  const present = new Set(rows.flatMap(r => Object.keys(r)));
  const need = ['sales_associate', ...METRICS.filter(m => m.col).map(m => m.col)];
  const missing = need.filter(c => !present.has(c));
  if (missing.length) return { missing, people: [], skipped: [], nonSellers: [] };
  const people = [], skipped = [], nonSellers = [];
  let goalRow = null;
  for (const r of rows) {
    const name = String(r.sales_associate ?? '').trim();
    if (!name) continue;
    if (/^rsa goal$/i.test(name)) { goalRow = r; continue; }
    if (SKIP_NAMES.test(name)) { skipped.push(name); continue; }
    const k = {};
    METRICS.forEach(m => { if (m.col) k[m.key] = numOrNull(r[m.col]); });
    const hours = k.sph ? k.netSales / k.sph : 0;
    // No hours on the floor = not a selling consultant this month (leaders, returns only, etc.).
    if (!hours || hours < 0) { nonSellers.push({ name, netSales: k.netSales }); continue; }
    k.beddingSph = k.sph * (k.beddingPct ?? 0) / 100;
    k.protectionSph = k.sph * (k.protectionPct ?? 0) / 100;
    Object.keys(k).forEach(x => { if (k[x] !== null) k[x] = Math.round(k[x] * 100) / 100; });
    people.push({ name, cid: cidOf(name), k, hours: Math.round(hours * 100) / 100 });
  }
  return { missing: [], people, skipped, nonSellers, goalRow };
}

// Adds rank = { store: {metric: [place, of]}, company: {...} } to each person that has a store.
export function addRanks(people) {
  const list = people.filter(p => p.store);
  const place = (group, m) => {
    const vals = group.map(a => a.k[m.key]).filter(v => v !== null && v !== undefined);
    return a => {
      const v = a.k[m.key];
      if (v === null || v === undefined) return null;
      return [1 + vals.filter(x => (m.lower ? x < v : x > v)).length, vals.length];
    };
  };
  const byStore = {};
  list.forEach(a => (byStore[a.store] ||= []).push(a));
  list.forEach(a => a.rank = { store: {}, company: {} });
  for (const m of METRICS) {
    const co = place(list, m);
    list.forEach(a => { a.rank.company[m.key] = co(a); });
    for (const group of Object.values(byStore)) { const st = place(group, m); group.forEach(a => { a.rank.store[m.key] = st(a); }); }
  }
  return people;
}

// ---------------------------------------------------------------- daily report (stores)
export function parseDailyReport(rawRows) {
  const rows = rawRows.map(r => { const o = {}; for (const [k, v] of Object.entries(r)) o[normalizeHeader(k)] = v; return o; });
  const present = new Set(rows.flatMap(r => Object.keys(r)));
  const missing = ['report_date', 'segment', 'metric', 'mtd_ty'].filter(c => !present.has(c));
  if (missing.length) return { missing, stores: [] };
  const bySeg = {}, ignored = new Set(), unknown = new Set();
  let date = null;
  for (const r of rows) {
    const seg = String(r.segment ?? '').trim();
    const d = parseDate(r.report_date); if (d && (!date || d > date)) date = d;
    if (!seg || /^(total|online)$/i.test(seg) || REGIONS.includes(seg)) { ignored.add(seg); continue; }
    const store = canonicalStore(seg);
    if (!isKnownStore(store)) { unknown.add(seg); continue; }
    (bySeg[store] ||= {})[String(r.metric).trim()] = {
      mtd: { ty: numOrNull(r.mtd_ty), ly: numOrNull(r.mtd_ly), bud: numOrNull(r.mtd_budget) },
      wtd: { ty: numOrNull(r.wtd_ty), ly: numOrNull(r.wtd_ly), bud: numOrNull(r.wtd_budget) }
    };
  }
  // which = 'mtd' (tracking) or 'wtd' (week to date, for coaching)
  const build = (m, which) => {
    const k = {}, budget = {}, vsBudget = {}, vsLy = {};
    for (const sm of STORE_METRICS) {
      if (!sm.src) continue;
      const x = m[sm.src]?.[which]; if (!x) { k[sm.key] = null; continue; }
      k[sm.key] = x.ty;
      if (sm.budget && x.bud !== null && x.ty !== null) {
        if (sm.budget === 'pct') { vsBudget[sm.key] = x.bud; budget[sm.key] = x.bud > -100 ? Math.round(x.ty / (1 + x.bud / 100) * 100) / 100 : null; }
        else { vsBudget[sm.key] = x.bud; budget[sm.key] = Math.round((x.ty - x.bud / 100) * 100) / 100; }
      }
      if (sm.ly && x.ly !== null) vsLy[sm.key] = x.ly;
    }
    const canc = m['Cancellations']?.[which]?.ty, gross = m['Gross Sales']?.[which]?.ty;
    k.cancelPct = gross ? Math.round(Math.abs(canc || 0) / gross * 10000) / 100 : null;
    return { k, budget, vsBudget, vsLy };
  };
  const hasWtd = present.has('wtd_ty');
  const stores = Object.entries(bySeg).map(([store, m]) => ({ store, ...build(m, 'mtd'), week: hasWtd ? build(m, 'wtd') : null }));
  return { missing: [], date, month: date ? date.slice(0, 7) : null, weekStart: date ? mondayOf(date) : null, stores, ignored: [...ignored], unknown: [...unknown] };
}

// ---------------------------------------------------------------- goals and status
export function paceFactor(asOf) {
  if (!asOf) return 1;
  const [y, m, d] = asOf.split('-').map(Number);
  return Math.min(1, d / new Date(y, m, 0).getDate());
}
// green at or better than goal, amber within 20 percent, red beyond that.
export function status(metric, value, goal, pace = 1) {
  if (value === null || value === undefined || goal === null || goal === undefined || goal === '') return 'none';
  const target = metric.monthly ? goal * pace : goal;
  if (metric.lower) {
    if (value <= target) return 'green';
    return value <= target * 1.25 ? 'amber' : 'red';
  }
  if (!target) return 'none';
  const r = value / target;
  return r >= 1 ? 'green' : r >= 0.8 ? 'amber' : 'red';
}
export function fmt(metric, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  if (metric.fmt === 'money') return (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US');
  if (metric.fmt === 'money2') return '$' + v.toFixed(2);
  if (metric.fmt === 'pct') return v.toFixed(1) + '%';
  return Math.round(v).toLocaleString('en-US');
}
export function fmtGoal(metric, g) {
  if (g === null || g === undefined || g === '') return '--';
  if (metric.fmt === 'money' || metric.fmt === 'money2') return '$' + Math.round(Number(g)).toLocaleString('en-US');
  if (metric.fmt === 'pct') return Math.round(g * 10) / 10 + '%';
  return String(Math.round(g));
}

// ---------------------------------------------------------------- minimum standard
// Rolling SPH = last month's final sales and hours plus this month to date.
// cur / prev are consultant cards ({ k, hours, from, asOf }). prev may be missing.
export function rollingSph(cur, prev) {
  const parts = [cur, prev].filter(Boolean);
  const sales = parts.reduce((a, c) => a + (c.k.netSales || 0), 0);
  const hours = parts.reduce((a, c) => a + (c.hours || 0), 0);
  const from = (prev || cur).from;
  return { sph: hours ? sales / hours : null, sales, hours, from, to: cur.asOf, days: daysBetween(from, cur.asOf) };
}
export function minStatus(sph, min) {
  if (sph === null || sph === undefined || !min) return 'none';
  if (sph < min) return 'below';
  if (sph < min * 1.1) return 'watch';
  return 'ok';
}

// ---------------------------------------------------------------- weekly 1:1 coaching
// Talk tracks tied to the Core 4: Connection, Finance, Bedding, Presenting Every Option as
// Protected and Delivered. Net Sales is the result, so it is never picked as a focus.
// Talk tracks built from 1915 South's own selling processes: Our Core 4, Greet Like A Referral,
// Presenting Options as Protected and Delivered (Options Calculator), Sleep Made Easy, and the
// Protection Process. "source" names the process so leaders know what to pull up.
const GREET = 'Greet Like A Referral';
const OPTIONS = 'Presenting Options as Protected and Delivered';
const SLEEP = 'Sleep Made Easy';
const PROTECT = 'Protection Process';
export const COACHING = {
  sph: {
    pillar: 'Connection', source: GREET,
    why: 'Connection is how we earn the right to help. Hours turn into sales when every guest gets a real greeting and the Big 3.',
    ask: ['Walk me through your last greet. Did you make a non-business connection before anything else?', 'On your last three guests, did you give a name and get a name, ask "What project are we working on today?", and explain our tags?'],
    doThis: 'Greet every guest like a referral: non-business connection first, then the Big 3 (give a name, get a name; "What project are we working on today?"; price tag intro). A flyer in every hand.'
  },
  closeRate: {
    pillar: 'Connection', source: GREET + ' and ' + OPTIONS,
    why: 'Guests buy from people they like, and when the value is bigger than the cost. Close rate shows if we are earning the right to ask.',
    ask: ['Which guests walked this week, and did each one get the Big 3?', 'Did every guest who loved something see their options and get asked "Which one of these works best for you?"'],
    doThis: 'Big 3 with every guest, then set the stage and present the 4 payment options. Ask for the sale every time: "Which one of these works best for you?"'
  },
  avgTicket: {
    pillar: 'Presenting Every Option', source: GREET + ' and ' + PROTECT,
    why: 'We sell the set of their dreams, not a single piece. Ticket grows when we show the whole collection and build at the first buying signal.',
    ask: ['On your last sale, which pieces in the collection did you point out during the tag demo?', 'At the first buying signal, did you build the ticket ("Did you want to add the ottoman as well?")?'],
    doThis: 'In the tag demo, point out pieces in the collection and pivot to the set of their dreams. At the first buying signal, build the ticket before you close.'
  },
  effMargin: {
    pillar: 'Presenting Every Option', source: GREET + ' and ' + OPTIONS,
    why: 'Margin holds when value leads: everyday low price, the Ashley Advantage, and payment options before any discount.',
    ask: ['When price comes up, what do you show first: a discount or the Options Calculator?', 'Are you highlighting our everyday low price and the Ashley Advantage in the tag intro?'],
    doThis: 'Lead with the everyday low price and the Ashley Advantage. Present the 4 payment options before any discount. Discounts only with a leader.'
  },
  discountPct: {
    pillar: 'Presenting Every Option', source: OPTIONS,
    why: 'Every point of discount comes out of margin. When the guest sees an affordable monthly option, price stops being the question.',
    ask: ['On your last discounted sale, who brought up price first?', 'Did the guest see all 4 payment options before you went to a discount?'],
    doThis: 'Set the stage, then present the 4 most popular options from the Options Calculator before any discount is discussed. No discount without a leader.'
  },
  financePct: {
    pillar: 'Finance', source: 'Our Core 4 and ' + OPTIONS,
    why: 'Finance is not a last resort. It is the first conversation. Buying power changes everything.',
    ask: ['On your last three guests, when did you run the app: early, late, or not at all?', 'Are you pulling up the Options Calculator from the Brick Wall on every guest?'],
    doThis: 'Run the app early, every guest. Present the 4 options (12 and 24 months at 0%, 60 months at 0%, 60 months at 9.9%) and ask "Which one of these works best for you?"'
  },
  creditApps: {
    pillar: 'Finance', source: 'Our Core 4',
    why: 'Every guest deserves to know their buying power before they decide. No app, no buying power.',
    ask: ['Who did you run the app for this week, and who did you skip?', 'How are you bringing up the app early in the visit?'],
    doThis: 'Run it every time. Offer the app early in the visit so the guest shops knowing their buying power.'
  },
  appsToTraffic: {
    pillar: 'Finance', source: 'Our Core 4',
    why: 'Apps to traffic shows whether finance is the first conversation for the whole team. Ten percent is the standard.',
    ask: ['At what point in the visit is the team running the app?', 'Who on the team runs the most apps, and what are they doing differently?'],
    doThis: 'Every guest learns their buying power early. Leaders check apps at every huddle and coach anyone who is not running it every time.'
  },
  beddingPct: {
    pillar: 'Bedding', source: SLEEP,
    why: 'A home is not complete without a great night of sleep. Treat every guest like a mattress guest; every guest gets the healthy sleep conversation.',
    ask: ['How many guests did you take through a pillow fitting this week?', 'Which step of Sleep Made Easy do you skip when the floor is busy?'],
    doThis: 'Run Sleep Made Easy with every guest: our 3 commitments, pillow fitting, comfort test (memory foam, hybrid, coil), top-down in their technology, then recap and close.'
  },
  beddingSph: {
    pillar: 'Bedding', source: SLEEP,
    why: 'Bedding per hour shows whether the sleep conversation happens with every guest, not just the ones who walk in asking for a mattress.',
    ask: ['Who did you start the sleep conversation with this week who came in for something else?', 'Are you getting to an 8, 9 or 10 on the comfort scale before you move on?'],
    doThis: 'Start the healthy sleep conversation with every guest. Use the 1 to 10 scale and do not move on until you get an 8, 9 or 10. Then "Let\'s see if we can get you to a 10" with the adjustable base.'
  },
  protectionPct: {
    pillar: 'Protected and Delivered', source: PROTECT,
    why: 'We do not finish the sale until the guest is protected. Protection is presented as the complete transaction, not an add-on.',
    ask: ['At what point did you present protection on your last sale?', 'Did you use all 4 steps: feature and benefit, the Ashley story, 1 year / 4 year, then transition and close?'],
    doThis: 'At the first buying signal, run the 4 steps: feature and benefit, the Ashley story, the free 1 year warranty plus the 4 year in home service plan, then transition and close.'
  },
  protectionSph: {
    pillar: 'Protected and Delivered', source: PROTECT + ' and ' + OPTIONS,
    why: 'Protection per hour shows whether protection is presented to every guest across all your time on the floor.',
    ask: ['Who did not hear about the 4 year in home service plan this week, and why?', 'When you set the stage for options, is the service plan already included?'],
    doThis: 'Present protection every time: run the 4 steps at the first buying signal, and include the 4 year in home service plan when you set the stage for options.'
  },
  protectionAttach: {
    pillar: 'Protected and Delivered', source: PROTECT,
    why: 'Attachment shows how many guests leave protected. Six in ten is the standard.',
    ask: ['Out of your last 10 sales, how many left protected?', 'What do you say when a guest says they do not need it?'],
    doThis: 'Run the 4-step Protection Process at the first buying signal on every sale, and build the service plan into the options you present.'
  },
  deliveryPct: {
    pillar: 'Protected and Delivered', source: OPTIONS,
    why: 'We offer a white-glove experience that matches the quality of what our guests are buying. Delivery is part of the complete transaction.',
    ask: ['When you set the stage for options, do you include white glove delivery every time?', 'Why did your last carry-out guest pass on delivery?'],
    doThis: 'Set the stage with delivery included: "our white glove delivery service, so we will bring everything in, set it up and remove all of the packing materials."'
  },
  cancelPct: {
    pillar: 'Connection', source: SLEEP + ' (Recap and close the gap)',
    why: 'A cancellation is a sale we already had. Recapping before the guest leaves locks in comfort, confidence and value.',
    ask: ['Walk me through your last cancellation. When did you first know it was at risk?', 'Before the guest leaves, do you recap what they bought, their delivery day, and their payment option?'],
    doThis: 'Recap and close the gap on every sale: comfort, confidence, value. Confirm the delivery day ("weekdays or weekends?") and the payment option they chose.'
  }
};

// Picks at most 2 things to coach: the metrics furthest from goal, from different Core 4
// pillars when possible. If everything is at goal, returns one stretch item.
const gap = (m, v, goal) => (m.lower ? (v ? goal / v : 2) : v / goal);
export function pickFocus(k, goals, pace = 1, max = 2) {
  const cands = METRICS.filter(m => COACHING[m.key] && k[m.key] !== null && k[m.key] !== undefined && goals[m.key])
    .map(m => {
      const goal = m.monthly ? goals[m.key] * pace : goals[m.key];
      return { key: m.key, label: m.label, value: k[m.key], goal, lower: !!m.lower, ratio: gap(m, k[m.key], goal),
        perWeek: m.monthly ? Math.ceil(goals[m.key] / 4.33) : null };
    })
    .sort((a, b) => a.ratio - b.ratio);
  const below = cands.filter(x => x.ratio < 1);
  const out = [], used = new Set();
  for (const x of below) { if (out.length >= max) break; const p = COACHING[x.key].pillar; if (used.has(p)) continue; out.push(x); used.add(p); }
  for (const x of below) { if (out.length >= max) break; if (!out.includes(x)) out.push(x); }
  if (!out.length && cands.length) out.push({ ...cands[0], stretch: true });
  return out.map(x => ({ ...x, target: weeklyTarget(x) }));
}
// Next-week target: close half the gap to goal. Monthly counts get a this-week number.
export function weeklyTarget(x) {
  if (x.perWeek) return x.perWeek;
  let t;
  if (x.lower) t = x.value <= x.goal ? x.value * 0.95 : x.value - (x.value - x.goal) / 2;
  else t = x.ratio >= 1 ? x.value * 1.05 : x.value + (x.goal - x.value) / 2;
  return Math.round(t * 10) / 10;
}

// ---------------------------------------------------------------- store (team) coaching
// Store focus candidates. Results (Net Sales, SPG, Traffic) are left out; the team works the drivers.
export const TEAM_FOCUS = ['closeRate', 'sph', 'avgTicket', 'effMargin', 'financePct', 'appsToTraffic', 'beddingPct', 'beddingSph',
  'protectionPct', 'protectionSph', 'protectionAttach', 'deliveryPct', 'cancelPct'];
export function pickStoreFocus(t, goals, max = 2) {
  const cands = TEAM_FOCUS.map(key => {
    const m = STORE_METRICS.find(x => x.key === key);
    const v = t.k?.[key], goal = t.budget?.[key] ?? goals[key];
    if (v === null || v === undefined || goal === null || goal === undefined || !COACHING[key]) return null;
    return { key, label: m.label, value: v, goal, lower: !!m.lower, ratio: m.lower ? (v ? goal / v : 2) : v / goal, perWeek: null };
  }).filter(Boolean).sort((a, b) => a.ratio - b.ratio);
  const below = cands.filter(x => x.ratio < 1);
  const out = [], used = new Set();
  for (const x of below) { if (out.length >= max) break; const p = COACHING[x.key].pillar; if (used.has(p)) continue; out.push(x); used.add(p); }
  for (const x of below) { if (out.length >= max) break; if (!out.includes(x)) out.push(x); }
  if (!out.length && cands.length) out.push({ ...cands[0], stretch: true });
  return out.map(x => ({ ...x, target: weeklyTarget(x) }));
}

// ---------------------------------------------------------------- team roster (Paylocity export)
// Sheet "Sales Team": Region, Quartile, Location, Role, Name, Email. OPEN rows are empty seats.
export const TITLES = { 'assistant selling manager': 'ASM', 'sales lead': 'Sales Lead', 'rsa': 'RSA' };
export function parseTeamRoster(rawRows) {
  const rows = rawRows.map(r => { const o = {}; for (const [k, v] of Object.entries(r)) o[normalizeHeader(k)] = typeof v === 'string' ? v.trim() : v; return o; });
  const missing = ['location', 'role', 'name'].filter(c => !rows.some(r => c in r));
  if (missing.length) return { missing, people: [] };
  const people = [], open = [], badStores = new Set();
  for (const r of rows) {
    const name = String(r.name || '').trim(); if (!name) continue;
    const store = canonicalStore(r.location);
    if (!isKnownStore(store)) { badStores.add(r.location); continue; }
    const title = TITLES[String(r.role || '').toLowerCase()] || 'RSA';
    if (/^open$/i.test(name)) { open.push({ store, title }); continue; }
    people.push({ cid: cidOf(name), name, store, title, email: String(r.email || '').trim().toLowerCase() || null });
  }
  return { missing: [], people, open, badStores: [...badStores] };
}

// Links names in the RSA report to people on the roster. Exact name first, then saved aliases,
// then a suggestion when the last name matches and the first names share a start
// (Danny / Daniel, Nathan / Nathaniel, "Michael Mike Harding", "Daniel Martinez Jr").
const nameParts = s => String(s).toLowerCase().replace(/\b(jr|sr|ii|iii)\b/g, '').replace(/[^a-z\s-]/g, '').trim().split(/\s+/);
// Returns { cid, how } or null. how: 'name' (nickname / suffix), 'email' (first initial + last name
// matches their work email, catches name changes), 'possible' (same last name only: confirm by hand).
export function suggestMatch(reportName, candidates) {
  const [f, ...rest] = nameParts(reportName); const l = rest[rest.length - 1];
  if (!f || !l) return null;
  const one = arr => (arr.length === 1 ? arr[0] : null);
  const byName = one(candidates.filter(c => {
    const [cf, ...cr] = nameParts(c.name); const cl = cr[cr.length - 1];
    if (cl !== l) return false;
    return cf.slice(0, 3) === f.slice(0, 3) || (cf.startsWith(f.slice(0, 2)) && f.startsWith(cf.slice(0, 2))) || rest.includes(cf) || cr.includes(f);
  }));
  if (byName) return { cid: byName.cid, how: 'name' };
  const handle = (f[0] + l).replace(/[^a-z]/g, '');
  const byEmail = one(candidates.filter(c => c.email && c.email.split('@')[0].replace(/\d+$/, '') === handle));
  if (byEmail) return { cid: byEmail.cid, how: 'email' };
  const byLast = one(candidates.filter(c => { const cr = nameParts(c.name); return cr[cr.length - 1] === l; }));
  if (byLast) return { cid: byLast.cid, how: 'possible' };
  return null;
}
export function resolveReportNames(reportPeople, directory) {
  const byCid = new Map(directory.map(d => [d.cid, d]));
  const byAlias = new Map();
  directory.forEach(d => (d.aliases || []).forEach(a => byAlias.set(a, d)));
  const matched = [], unmatched = [];
  for (const p of reportPeople) {
    const d = byCid.get(p.cid) || byAlias.get(p.cid);
    if (d) matched.push({ p, d }); else unmatched.push(p);
  }
  const used = new Set(matched.map(x => x.d.cid));
  const open = directory.filter(d => !used.has(d.cid) && d.store !== '__skip');
  const suggestions = {};
  for (const p of unmatched) { const s = suggestMatch(p.name, open); if (s) suggestions[p.cid] = s; }
  return { matched, unmatched, suggestions, openRoster: open };
}
