import { firebaseConfig, OWNER_EMAIL } from './config.js';
import {
  METRICS, STORE_METRICS, COACHING, pickFocus, weeklyTarget, DEFAULT_GOALS, STORES, DISTRICTS, OUTLETS, canonicalStore,
  minSphFor, rollingSph, minStatus, monthsBack, isOutlet, goalsFor, paceFactor, status, fmt, fmtGoal, slug, cidOf,
  parseRsa, parseDailyReport, rangeFromFileName, addRanks, daysBetween, TEAM_FOCUS, pickStoreFocus,
  parseTeamRoster, resolveReportNames, periodOf, WEEK_PACE, mondayOf, addDaysIso
} from './core.js';

const DEMO = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PASTE');
const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const ROLES = [
  ['admin', 'Admin'], ['exec', 'Executive (view all)'], ['director', 'Director'],
  ['leader', 'Store leader'], ['consultant', 'Consultant']
];
const roleLabel = r => (ROLES.find(x => x[0] === r) || [r, r])[1];
const SKIP = '__skip';   // directory value for "not a consultant"

// ---------------------------------------------------------------- helpers
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const monthLabel = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }); };
const dateLabel = d => { if (!d) return ''; const [y, m, dd] = d.split('-'); return `${m}/${dd}/${y}`; };
const titleName = n => /^[A-Z\s.'-]+$/.test(n) ? n.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (a, b, c) => b + c.toUpperCase()) : n;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.className = 'toast', 3800);
}
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function csvEscape(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function parseCsvText(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter(r => r.some(c => c.trim() !== ''));
  if (!clean.length) return [];
  const head = clean[0].map(h => h.trim());
  return clean.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
async function readSpreadsheet(file) {
  if (/\.csv$/i.test(file.name)) return parseCsvText(await file.text());
  const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}


// ---------------------------------------------------------------- Firebase backend
async function firebaseBackend() {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js')
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const email = () => (auth.currentUser?.email || '').toLowerCase();
  const list = async (coll, ...wheres) => (await F.getDocs(F.query(F.collection(db, coll), ...wheres.map(([a, b]) => F.where(a, '==', b))))).docs.map(d => ({ id: d.id, ...d.data() }));
  const batchWrite = async (ops, onProgress) => {
    let done = 0;
    for (const part of chunk(ops, 400)) {
      const b = F.writeBatch(db);
      part.forEach(([kind, coll, id, data]) => kind === 'set' ? b.set(F.doc(db, coll, id), data) : b.delete(F.doc(db, coll, id)));
      await b.commit(); done += part.length; onProgress?.(done, ops.length);
    }
  };
  const be = {
    demo: false,
    onAuth: cb => A.onAuthStateChanged(auth, u => cb(u ? { email: u.email.toLowerCase(), verified: u.emailVerified } : null)),
    signIn: (e, p) => A.signInWithEmailAndPassword(auth, e, p),
    async register(e, p) { const c = await A.createUserWithEmailAndPassword(auth, e, p); await A.sendEmailVerification(c.user); },
    resendVerify: () => A.sendEmailVerification(auth.currentUser),
    async refresh() { await A.reload(auth.currentUser); await auth.currentUser.getIdToken(true); return auth.currentUser.emailVerified; },
    reset: e => A.sendPasswordResetEmail(auth, e),
    signOut: () => A.signOut(auth),

    async profile() {
      const e = email();
      const snap = await F.getDoc(F.doc(db, 'users', e));
      if (snap.exists()) return snap.data();
      if (e === OWNER_EMAIL.toLowerCase()) {
        const p = { email: e, name: 'Frank Pina', role: 'admin', stores: ['*'], canUpload: true };
        await F.setDoc(F.doc(db, 'users', e), p);
        return p;
      }
      return null;
    },
    async meta() { const s = await F.getDoc(F.doc(db, 'config', 'meta')); return s.exists() ? s.data() : { months: [], asOf: {} }; },
    async goals() { const s = await F.getDoc(F.doc(db, 'config', 'goals')); return s.exists() ? s.data() : DEFAULT_GOALS; },
    saveGoals: g => F.setDoc(F.doc(db, 'config', 'goals'), g),

    cardsForStore: (month, store) => list('scorecards', ['month', month], ['store', store]),
    cardsForCid: (month, cid) => list('scorecards', ['month', month], ['cid', cid]),
    async storeTotal(month, store) { const s = await F.getDoc(F.doc(db, 'storeTotals', `${month}_${slug(store)}`)); return s.exists() ? s.data() : null; },

    // RSA report: one card per consultant for the month. Replaces the month.
    async publishRsa(p, onProgress) {
      const now = new Date().toISOString();
      const ops = [], keep = new Set();
      for (const x of p.people) {
        const id = `${p.month}_${x.cid}`; keep.add(id);
        ops.push(['set', 'scorecards', id, { month: p.month, cid: x.cid, name: x.name, reportName: x.reportName || x.name, title: x.title || 'RSA', store: x.store, k: x.k, hours: x.hours, rank: x.rank || null, from: p.from, asOf: p.to, uploadedAt: now }]);
      }
      (await list('scorecards', ['month', p.month])).forEach(d => { if (!keep.has(d.id)) ops.push(['del', 'scorecards', d.id]); });
      await batchWrite(ops, onProgress);
      const meta = await be.meta();
      await F.setDoc(F.doc(db, 'config', 'meta'), { ...meta, months: [...new Set([...(meta.months || []), p.month])].sort().reverse(),
        asOf: { ...(meta.asOf || {}), [p.month]: p.to }, lastRsa: { by: email(), at: now, file: p.file, people: p.people.length } });
    },
    async publishDaily(d) {
      const now = new Date().toISOString();
      const ops = d.stores.map(s => ['set', 'storeTotals', `${d.month}_${slug(s.store)}`, { month: d.month, store: s.store, k: s.k, budget: s.budget, vsBudget: s.vsBudget, vsLy: s.vsLy, asOf: d.date, uploadedAt: now }]);
      d.stores.filter(s => s.week).forEach(s => ops.push(['set', 'storeWeekly', `${d.weekStart}_${slug(s.store)}`, { week: d.weekStart, store: s.store, ...s.week, period: 'week', from: d.weekStart, asOf: d.date, uploadedAt: now }]));
      await batchWrite(ops);
      const meta = await be.meta();
      await F.setDoc(F.doc(db, 'config', 'meta'), { ...meta, months: [...new Set([...(meta.months || []), d.month])].sort().reverse(),
        storeAsOf: { ...(meta.storeAsOf || {}), [d.month]: d.date },
        storeWeeks: d.weekStart ? [...new Set([...(meta.storeWeeks || []), d.weekStart])].sort().reverse() : (meta.storeWeeks || []),
        storeWeekAsOf: d.weekStart ? { ...(meta.storeWeekAsOf || {}), [d.weekStart]: d.date } : (meta.storeWeekAsOf || {}),
        lastDaily: { by: email(), at: now, file: d.file, stores: d.stores.length } });
    },
    // RSA report for one week (coaching numbers). Replaces that week.
    async publishWeekly(p, onProgress) {
      const now = new Date().toISOString();
      const ops = [], keep = new Set();
      for (const x of p.people) {
        const id = `${p.from}_${x.cid}`; keep.add(id);
        ops.push(['set', 'weekly', id, { week: p.from, cid: x.cid, name: x.name, reportName: x.reportName || x.name, title: x.title || 'RSA', store: x.store, k: x.k, hours: x.hours, rank: x.rank || null, period: 'week', from: p.from, asOf: p.to, uploadedAt: now }]);
      }
      (await list('weekly', ['week', p.from])).forEach(d => { if (!keep.has(d.id)) ops.push(['del', 'weekly', d.id]); });
      await batchWrite(ops, onProgress);
      const meta = await be.meta();
      await F.setDoc(F.doc(db, 'config', 'meta'), { ...meta, weeks: [...new Set([...(meta.weeks || []), p.from])].sort().reverse(),
        weekTo: { ...(meta.weekTo || {}), [p.from]: p.to }, lastWeekly: { by: email(), at: now, file: p.file, people: p.people.length } });
    },
    weeklyForStore: (week, store) => list('weekly', ['week', week], ['store', store]),
    weeklyForCid: cid => list('weekly', ['cid', cid]),
    async storeWeek(week, store) { const s = await F.getDoc(F.doc(db, 'storeWeekly', `${week}_${slug(store)}`)); return s.exists() ? s.data() : null; },
    // Director roll-up
    cardsForMonth: month => list('scorecards', ['month', month]),
    async coachingSince(iso) { return (await F.getDocs(F.query(F.collection(db, 'coaching'), F.where('createdAt', '>=', iso)))).docs.map(d => ({ id: d.id, ...d.data() })); },

    async saveMeta(patch) { const meta = await be.meta(); await F.setDoc(F.doc(db, 'config', 'meta'), { ...meta, ...patch }); },
    // Consultant directory: RSA name -> store.
    directory: () => list('consultants'),
    saveDirectory: rows => batchWrite(rows.map(r => ['set', 'consultants', r.cid, r])),
    deleteDirectory: cid => F.deleteDoc(F.doc(db, 'consultants', cid)),

    coachingForStore: store => list('coaching', ['store', store]),
    coachingForCid: cid => list('coaching', ['cid', cid]),
    async coachingByCoach(e, stores) {
      // Store-by-store for leaders so each query matches the access rules exactly.
      if (stores && !stores.includes('*')) return (await Promise.all(stores.map(st => list('coaching', ['coach', e], ['store', st])))).flat();
      return list('coaching', ['coach', e]);
    },
    teamCoaching: store => list('coaching', ['store', store], ['type', 'team']),
    saveCoaching: d => F.addDoc(F.collection(db, 'coaching'), { ...d, coach: email() }),
    deleteCoaching: id => F.deleteDoc(F.doc(db, 'coaching', id)),

    users: async () => (await F.getDocs(F.collection(db, 'users'))).docs.map(d => d.data()),
    saveUser: u => F.setDoc(F.doc(db, 'users', u.email), u),
    deleteUser: e => F.deleteDoc(F.doc(db, 'users', e)),
    saveUsers: list2 => batchWrite(list2.map(u => ['set', 'users', u.email, u]))
  };
  return be;
}

// ---------------------------------------------------------------- Demo backend (in memory, made-up people)
function demoBackend() {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const demoStores = ['Tallahassee', 'Thomasville', 'Harahan', 'Outlet Pensacola'];
  const first = ['Maria', 'Devon', 'Alyssa', 'Marcus', 'Priya', 'Tyler', 'Jasmine', 'Chris', 'Nina', 'Omar', 'Keisha', 'Luis'];
  const last = ['Alvarez', 'Brooks', 'Chen', 'Dawson', 'Ellis', 'Foster', 'Grant', 'Hayes', 'Ibarra', 'Jordan', 'Kim', 'Lopez'];
  const people = [];
  demoStores.forEach((store, si) => {
    for (let i = 0; i < 6; i++) {
      const skill = i === 5 && si < 2 ? 0.55 : i === 4 && si === 0 ? 0.68 : 0.8 + rnd() * 0.7;
      const n = si * 6 + i;   // unique first/last pair for all 24
      people.push({ name: `${first[n % 12]} ${last[(n * 7 + Math.floor(n / 12)) % 12]}`, store, skill: skill * (store.startsWith('Outlet') ? 0.55 : 1) });
    }
  });
  people.push({ name: 'Jordan Reyes', store: null, skill: 1 });   // new hire nobody has assigned yet
  const rsaRow = (p, days) => {
    const hours = days * 5.6 * (0.85 + rnd() * 0.3);
    const sph = 400 * p.skill * (0.9 + rnd() * 0.2);
    const pc = (a, b) => (a + rnd() * (b - a)).toFixed(2) + '%';
    return { 'Sales Associate': p.name, 'Net Sales': (sph * hours).toFixed(2), 'Cancellation %': pc(1, 9), 'Discount %': pc(4, 17),
      'Credit Apps #': Math.round(days / 30 * 18 * p.skill * (0.6 + rnd() * 0.6)), 'Eff. Margin': pc(53, 59), 'SPH': sph.toFixed(2),
      'Avg Ticket w. Del.': (1700 + rnd() * 1000).toFixed(2), 'Fin. % of Sales': pc(45, 78), 'Bed. % of Sales': pc(9, 28),
      'Prot. % of Sales': pc(4, 11), 'Del. % of Sales': pc(5, 10) };
  };
  const storeRows = date => demoStores.flatMap(st => {
    const SUMS = ['Net Sales (Stores)', 'Traffic', 'Cancellations', 'Gross Sales'];
    const m = (metric, mtd, bud = '') => {
      const wtd = SUMS.includes(metric) ? Number(mtd) * (0.22 + rnd() * 0.06) : Number(mtd) * (0.88 + rnd() * 0.24);
      return { report_date: date, segment: st.startsWith('Outlet') ? st.replace('Outlet ', '') + ' Outlet' : st, metric, mtd_ty: String(mtd), mtd_ly: '', mtd_budget: String(bud),
        wtd_ty: wtd.toFixed(2), wtd_ly: '', wtd_budget: bud === '' ? '' : String((Number(bud) + (rnd() * 10 - 5)).toFixed(1)) };
    };
    const ns = 250000 + rnd() * 300000;
    return [m('Net Sales (Stores)', ns.toFixed(2), (-20 + rnd() * 30).toFixed(1)), m('Sales per Guest w. Cancellations', (420 + rnd() * 200).toFixed(2), (-15 + rnd() * 25).toFixed(1)),
      m('Close Rate', (22 + rnd() * 10).toFixed(1), Math.round(-500 + rnd() * 700)), m('Traffic', Math.round(900 + rnd() * 700), (-10 + rnd() * 15).toFixed(1)),
      m('Sales per Hour', (330 + rnd() * 150).toFixed(2)), m('Avg Ticket w. Del.', (1900 + rnd() * 600).toFixed(2)), m('Eff. Margin', (54 + rnd() * 4).toFixed(2)),
      m('Finance % of Sales', (52 + rnd() * 20).toFixed(2)), m('Finance Apps to Traffic', (7 + rnd() * 8).toFixed(2)), m('Bedding % of Sales', (12 + rnd() * 10).toFixed(2)),
      m('Bedding SPH', (40 + rnd() * 35).toFixed(2)), m('Protection % of Sales', (6 + rnd() * 4).toFixed(2)), m('Protection SPH', (22 + rnd() * 20).toFixed(2)),
      m('Protection Attachment', (45 + rnd() * 25).toFixed(2)), m('Delivery % of sales', (6 + rnd() * 3).toFixed(2)),
      m('Cancellations', (-ns * (0.04 + rnd() * 0.06)).toFixed(2)), m('Gross Sales', (ns * 1.08).toFixed(2))];
  });
  const augRows = people.filter(p => p.store).map(p => rsaRow(p, 31));
  // last full week (Mon to Sun). One person only worked a day, to show the 20-hour fallback.
  const weekRows = people.filter(p => p.store).map((p, i) => rsaRow(p, i === 3 ? 1 : 6));
  people[8].reportName = people[8].name.replace(/^(\w{3})\w+/, '$1');   // a nickname in the report, e.g. "Jas" for Jasmine
  const sepRows = people.map(p => ({ ...rsaRow(p, 28), 'Sales Associate': p.reportName || p.name }));
  sepRows.push({ 'Sales Associate': 'HOUSE SALES', 'Net Sales': '900', 'Cancellation %': '0%', 'Discount %': '0%', 'Credit Apps #': '0', 'Eff. Margin': '50%', 'SPH': '0', 'Avg Ticket w. Del.': '0', 'Fin. % of Sales': '0%', 'Bed. % of Sales': '0%', 'Prot. % of Sales': '0%', 'Del. % of Sales': '0%' });

  const cards = {}, totals = {}, dir = {}, weekly = {}, storeWeekly = {};
  let meta = { months: [], asOf: {} };
  let goals = structuredClone(DEFAULT_GOALS);
  goals.markets = [{ name: 'Demo Market Leader', email: 'director@demo', stores: ['Tallahassee', 'Thomasville', 'Albany'] }, { name: 'Second Market', email: 'nobody@demo', stores: ['Macon', 'Dothan'] }];
  const TITLE = i => (i % 6 === 0 ? 'ASM' : i % 6 === 1 ? 'Sales Lead' : 'RSA');
  people.filter(p => p.store).forEach((p, i) => { const cid = cidOf(p.name); dir[cid] = { cid, name: p.name, store: p.store, title: TITLE(i), email: p.name.toLowerCase().replace(/[^a-z]/g, '') + '@demo', aliases: [] }; });
  const users = {
    'fpina@1915south.com': { email: 'fpina@1915south.com', name: 'Frank Pina', role: 'admin', stores: ['*'], canUpload: true },
    'director@demo': { email: 'director@demo', name: 'Demo Director', role: 'director', stores: ['Tallahassee', 'Thomasville'], canUpload: false },
    'exec@demo': { email: 'exec@demo', name: 'Demo Exec', role: 'exec', stores: ['*'] },
    'leader@demo': { email: 'leader@demo', name: 'Demo Store Leader', role: 'leader', stores: ['Harahan'] },
    'asm@demo': { email: 'asm@demo', name: people[0].name + ' (ASM, sells and coaches)', role: 'leader', title: 'ASM', stores: ['Tallahassee'], cid: cidOf(people[0].name) },
    'consultant@demo': { email: 'consultant@demo', name: people[2].name, role: 'consultant', stores: ['Tallahassee'], cid: cidOf(people[2].name) },
    'low@demo': { email: 'low@demo', name: people[5].name + ' (below minimum)', role: 'consultant', stores: ['Tallahassee'], cid: cidOf(people[5].name) }
  };
  let current = 'fpina@1915south.com';
  const coaching = [];
  const clone = x => structuredClone(x);
  const be = {
    demo: true,
    sampleFiles: () => [['rsa_report_2026-09-01_to_2026-09-28.csv', sepRows], ['rsa_report_2026-09-21_to_2026-09-27.csv', weekRows], ['daily-report-2026-09-28.csv', storeRows('2026-09-28')]],
    onAuth: cb => cb({ email: current, verified: true }),
    switchUser: e => { current = e; },
    demoUsers: () => Object.values(users),
    signOut: async () => toast('Demo mode: nothing to sign out of'),
    profile: async () => users[current],
    meta: async () => clone(meta),
    goals: async () => clone(goals),
    saveGoals: async g => { goals = clone(g); },
    cardsForStore: async (m, s) => Object.values(cards).filter(c => c.month === m && c.store === s).map(clone),
    cardsForCid: async (m, cid) => Object.values(cards).filter(c => c.month === m && c.cid === cid).map(clone),
    storeTotal: async (m, s) => clone(totals[`${m}_${slug(s)}`] || null),
    async publishRsa(p) {
      const keep = new Set();
      p.people.forEach(x => { const id = `${p.month}_${x.cid}`; keep.add(id); cards[id] = { id, month: p.month, cid: x.cid, name: x.name, reportName: x.reportName || x.name, title: x.title || 'RSA', store: x.store, k: x.k, hours: x.hours, rank: x.rank || null, from: p.from, asOf: p.to }; });
      Object.keys(cards).forEach(id => { if (cards[id].month === p.month && !keep.has(id)) delete cards[id]; });
      if (!meta.months.includes(p.month)) meta.months.push(p.month); meta.months.sort().reverse();
      meta.asOf[p.month] = p.to; meta.lastRsa = { by: current, at: new Date().toISOString(), file: p.file, people: p.people.length };
    },
    async publishWeekly(p) {
      const keep = new Set();
      p.people.forEach(x => { const id = `${p.from}_${x.cid}`; keep.add(id); weekly[id] = { id, week: p.from, cid: x.cid, name: x.name, reportName: x.reportName || x.name, title: x.title || 'RSA', store: x.store, k: x.k, hours: x.hours, rank: x.rank || null, period: 'week', from: p.from, asOf: p.to }; });
      Object.keys(weekly).forEach(id => { if (weekly[id].week === p.from && !keep.has(id)) delete weekly[id]; });
      meta.weeks = [...new Set([...(meta.weeks || []), p.from])].sort().reverse(); meta.weekTo = { ...(meta.weekTo || {}), [p.from]: p.to };
      meta.lastWeekly = { by: current, at: new Date().toISOString(), file: p.file, people: p.people.length };
    },
    weeklyForStore: async (w, st) => Object.values(weekly).filter(c => c.week === w && c.store === st).map(clone),
    weeklyForCid: async cid => Object.values(weekly).filter(c => c.cid === cid).map(clone),
    storeWeek: async (w, st) => clone(storeWeekly[`${w}_${slug(st)}`] || null),
    cardsForMonth: async m => Object.values(cards).filter(c => c.month === m).map(clone),
    coachingSince: async iso => coaching.filter(x => (x.createdAt || '') >= iso).map(clone),
    async publishDaily(d) {
      d.stores.forEach(s => { totals[`${d.month}_${slug(s.store)}`] = { month: d.month, store: s.store, k: s.k, budget: s.budget, vsBudget: s.vsBudget, vsLy: s.vsLy, asOf: d.date }; });
      d.stores.filter(s => s.week).forEach(s => { storeWeekly[`${d.weekStart}_${slug(s.store)}`] = { week: d.weekStart, store: s.store, ...s.week, period: 'week', from: d.weekStart, asOf: d.date }; });
      if (d.weekStart) { meta.storeWeeks = [...new Set([...(meta.storeWeeks || []), d.weekStart])].sort().reverse(); meta.storeWeekAsOf = { ...(meta.storeWeekAsOf || {}), [d.weekStart]: d.date }; }
      if (!meta.months.includes(d.month)) meta.months.push(d.month); meta.months.sort().reverse();
      meta.storeAsOf = { ...(meta.storeAsOf || {}), [d.month]: d.date }; meta.lastDaily = { by: current, at: new Date().toISOString(), file: d.file, stores: d.stores.length };
    },
    saveMeta: async patch => { meta = { ...meta, ...patch }; },
    sampleRoster: () => [...people.filter(p => p.store).map((p, i) => ({ Region: 'West', Quartile: '1', Location: p.store === 'Outlet Pensacola' ? 'Pensacola Outlet' : p.store,
      Role: i % 6 === 0 ? 'Assistant Selling Manager' : i % 6 === 1 ? 'Sales Lead' : 'RSA', Name: p.name, Email: p.name.toLowerCase().replace(/[^a-z]/g, '') + '@demo' })),
      { Region: 'West', Quartile: '1', Location: 'Harahan', Role: 'Sales Lead', Name: 'OPEN', Email: '' }],
    directory: async () => Object.values(dir).map(clone),
    saveDirectory: async rows => rows.forEach(r => { dir[r.cid] = clone(r); }),
    deleteDirectory: async cid => { delete dir[cid]; },
    coachingForStore: async st => coaching.filter(x => x.store === st).map(clone),
    coachingForCid: async cid => coaching.filter(x => x.cid === cid).map(clone),
    coachingByCoach: async e => coaching.filter(x => x.coach === e).map(clone),
    teamCoaching: async st => coaching.filter(x => x.store === st && x.type === 'team').map(clone),
    saveCoaching: async d => { coaching.push({ ...clone(d), id: 'c' + Date.now(), coach: current }); },
    deleteCoaching: async id => { const i = coaching.findIndex(x => x.id === id); if (i >= 0) coaching.splice(i, 1); },
    users: async () => Object.values(users),
    saveUser: async u => { users[u.email] = u; },
    deleteUser: async e => { delete users[e]; },
    saveUsers: async l => l.forEach(u => users[u.email] = u)
  };
  // Load August and September the same way a real upload would.
  const load = (rows, from, to, weekly = false) => {
    const r = parseRsa(rows);
    const res = resolveReportNames(r.people, Object.values(dir));
    const ppl = res.matched.map(({ p, d }) => ({ ...p, cid: d.cid, name: d.name, reportName: p.name, store: d.store, title: d.title })).filter(x => x.store !== SKIP);
    addRanks(ppl);
    (weekly ? be.publishWeekly : be.publishRsa)({ month: from.slice(0, 7), from, to, people: ppl, file: 'demo' });
  };
  load(augRows, '2026-08-01', '2026-08-31');
  load(sepRows, '2026-09-01', '2026-09-28');
  load(weekRows, '2026-09-21', '2026-09-27', true);
  const dd = parseDailyReport(storeRows('2026-09-27')); dd.month = '2026-09'; be.publishDaily({ ...dd, file: 'demo' });
  // one past 1:1 so the follow-up view has something to show
  const tp = Object.values(cards).find(c => c.month === '2026-09' && c.cid === users['consultant@demo'].cid);
  const f = pickFocus(tp.k, DEFAULT_GOALS.standard, 0.72).map(x => x.perWeek ? { ...x, value: Math.max(0, x.value - 2) } : { ...x, value: Math.round(x.value * (x.lower ? 1.08 : 0.93) * 10) / 10 });
  coaching.push({ id: 'seed1', store: tp.store, cid: tp.cid, name: tp.name, coach: 'director@demo', coachName: 'Demo Director',
    date: '2026-09-22', createdAt: '2026-09-22T15:00:00Z', focus: f,
    commitment: f.map(x => COACHING[x.key].doThis).join(' '), support: 'I will shadow two of your guests on Saturday.', notes: '' });
  return be;
}

// ---------------------------------------------------------------- state
const S = { view: 'mtd', sessions: [], coach: null, rolls: {}, be: null, user: null, meta: null, goals: null, month: null, store: null, tab: 'cards', selected: null, pending: null };

const isAdmin = () => S.user?.role === 'admin';
const seesAll = () => ['admin', 'exec'].includes(S.user?.role) || (S.user?.stores || []).includes('*');
const canUpload = () => isAdmin() || !!S.user?.canUpload;
const canCoach = store => isAdmin() || (['director', 'leader'].includes(S.user?.role) && ((S.user.stores || []).includes('*') || (S.user.stores || []).includes(store)));
const ALL_STORE_NAMES = STORES.map(s => s.name);
const myStores = () => {
  if (seesAll()) return ALL_STORE_NAMES;
  const mine = (S.user?.stores || []).filter(s => s !== '*');
  return ALL_STORE_NAMES.filter(s => mine.includes(s));
};
// Store dropdown grouped by district, in STORIS store-number order.
function storeOptions(list, selected, extra = '') {
  const groups = {};
  list.forEach(n => { const st = STORES.find(x => x.name === n); if (st) (groups[st.district] ||= []).push(st); });
  return extra + Object.entries(groups).map(([k, arr]) => `<optgroup label="${esc(DISTRICTS[k] || 'Other')}">${arr.map(st =>
    `<option value="${esc(st.name)}" ${st.name === selected ? 'selected' : ''}>${esc(st.name)} (${st.id})</option>`).join('')}</optgroup>`).join('');
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    S.be = DEMO ? demoBackend() : await firebaseBackend();
  } catch (e) {
    $('#app').innerHTML = `<div class="panel narrow"><h2>Could not load</h2><p>${esc(e.message)}</p></div>`; return;
  }
  if (DEMO) {
    $('#demoBar').hidden = false;
    $('#demoRole').innerHTML = S.be.demoUsers().map(u => `<option value="${esc(u.email)}">${esc(roleLabel(u.role))}: ${esc(u.name)}</option>`).join('');
  }
  S.be.onAuth(async u => {
    if (!u) return renderSignIn();
    if (!u.verified) return renderVerify(u.email);
    // A sign-in token issued before the email was verified is refused by the rules. Refresh it once and retry.
    let err = null;
    try { S.user = await S.be.profile(); } catch (e) {
      try { await S.be.refresh(); S.user = await S.be.profile(); } catch (e2) { S.user = null; err = e2; }
    }
    if (!S.user && err) return renderLoadError(u.email, err);
    if (!S.user) return renderNotRostered(u.email);
    await loadShared();
    renderShell();
  });
}

// A bar across the top to go back to the Field Leader App visit this was opened from.
function backBar() {
  let url = null; try { url = sessionStorage.getItem('fl_back'); } catch (e) {}
  let bar = document.getElementById('flback');
  if (!url) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'flback'; bar.style.cssText = 'position:sticky;top:0;z-index:50;background:#003B4A;color:#fff;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:14px'; document.body.prepend(bar); }
  bar.innerHTML = `<a href="${url.replace(/"/g, '&quot;')}" id="flbackgo" style="color:#fff;font-weight:700;text-decoration:none">&larr; Back to the visit</a><button type="button" id="flbackx" style="background:none;border:0;color:#DBECF1;font-size:13px;cursor:pointer">Hide</button>`;
  document.getElementById('flbackgo').onclick = () => { try { sessionStorage.removeItem('fl_back'); } catch (e) {} };
  document.getElementById('flbackx').onclick = () => { try { sessionStorage.removeItem('fl_back'); } catch (e) {} bar.remove(); };
}
async function loadShared() {
  [S.meta, S.goals] = await Promise.all([S.be.meta(), S.be.goals()]);
  S.goals = { ...DEFAULT_GOALS, ...S.goals, standard: { ...DEFAULT_GOALS.standard, ...(S.goals?.standard || {}) } };
  if (!S.goals.outletStores?.length) S.goals.outletStores = OUTLETS;
  if (!S.month || !S.meta.months.includes(S.month)) S.month = S.meta.months[0] || null;
  if (!S.viewSet && (S.meta.weeks || []).length) { S.view = S.meta.weeks[0]; S.viewSet = true; }
  const stores = myStores();
  if (!S.store || !stores.includes(S.store)) S.store = stores[0] || null;
  // Opened from the Field Leader App: ?store=Harahan&c=<consultant id> goes straight to that consultant's card.
  try {
    const q = new URLSearchParams(location.search), st = q.get('store'), c = q.get('c');
    if (st && stores.includes(st)) { S.store = st; S.tab = 'cards'; if (c) { S.selected = c; S.jump = true; } }
    // Remember where to go back to (only the Field Leader App).
    const back = q.get('back');
    if (back && back.startsWith('https://fpina-1915south.github.io/field-leader-app/')) sessionStorage.setItem('fl_back', back);
    if (st || c || back) history.replaceState(null, '', location.pathname);
  } catch (e) {}
  backBar();
}
// ---------------------------------------------------------------- auth screens
function renderSignIn(msg = '') {
  $('#who').innerHTML = '';
  $('#app').innerHTML = `
  <form class="panel narrow" id="signin">
    <h2>Sign in</h2>
    <p class="muted">Use your work email. First time here? Enter your email, choose a password, and tap Create account. You will get a verification email.</p>
    <label>Email<input type="email" id="em" autocomplete="username" required></label>
    <label>Password<input type="password" id="pw" autocomplete="current-password" minlength="8" required></label>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
    <div class="row">
      <button class="btn primary" type="submit">Sign in</button>
      <button class="btn" type="button" id="reg">Create account</button>
      <button class="link" type="button" id="forgot">Forgot password</button>
    </div>
  </form>`;
  const em = () => $('#em').value.trim().toLowerCase(), pw = () => $('#pw').value;
  $('#signin').onsubmit = async e => { e.preventDefault(); try { await S.be.signIn(em(), pw()); } catch (x) { renderSignIn(friendly(x)); } };
  $('#reg').onclick = async () => {
    if (!em() || pw().length < 8) return renderSignIn('Enter your email and a password of at least 8 characters.');
    try { await S.be.register(em(), pw()); } catch (x) { renderSignIn(friendly(x)); }
  };
  $('#forgot').onclick = async () => {
    if (!em()) return renderSignIn('Type your email first, then tap Forgot password.');
    try { await S.be.reset(em()); toast('Password reset email sent.'); } catch (x) { renderSignIn(friendly(x)); }
  };
}
function friendly(x) {
  const c = x?.code || '';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'Email or password is not right. New here? Tap Create account.';
  if (c.includes('email-already-in-use')) return 'That email already has an account. Sign in, or tap Forgot password.';
  if (c.includes('weak-password')) return 'Password needs at least 8 characters.';
  if (c.includes('too-many-requests')) return 'Too many tries. Wait a few minutes and try again.';
  return x?.message || 'Something went wrong.';
}
function renderVerify(email) {
  $('#who').innerHTML = signOutBtn();
  $('#app').innerHTML = `
  <div class="panel narrow">
    <h2>Check your email</h2>
    <p>We sent a verification link to <b>${esc(email)}</b>. Open it, then come back and tap Continue. Check junk mail if you do not see it.</p>
    <div class="row"><button class="btn primary" id="cont">Continue</button><button class="btn" id="again">Send it again</button></div>
  </div>`;
  wireSignOut();
  $('#cont').onclick = async () => { if (await S.be.refresh()) location.reload(); else toast('Not verified yet. Open the link in the email first.', true); };
  $('#again').onclick = async () => { try { await S.be.resendVerify(); toast('Sent.'); } catch (x) { toast(friendly(x), true); } };
}
function renderLoadError(email, e) {
  $('#who').innerHTML = signOutBtn();
  $('#app').innerHTML = `<div class="panel narrow"><h2>Could not open your account</h2><p><b>${esc(email)}</b> is signed in, but the app could not load your access (${esc(e.code || e.message)}). Tap Sign out, sign back in, and try again. If it keeps happening, send this screen to Frank Pina.</p></div>`;
  wireSignOut();
}
function renderNotRostered(email) {
  $('#who').innerHTML = signOutBtn();
  $('#app').innerHTML = `
  <div class="panel narrow">
    <h2>You are signed in, but not on the roster yet</h2>
    <p><b>${esc(email)}</b> has not been given access. Ask your director or Frank Pina to add this email, then refresh.</p>
  </div>`;
  wireSignOut();
}
const signOutBtn = () => `<button class="link light" id="so">Sign out</button>`;
function wireSignOut() { const b = $('#so'); if (b) b.onclick = () => S.be.signOut(); }

// ---------------------------------------------------------------- shell
function renderShell() {
  const u = S.user;
  $('#who').innerHTML = `<span>${esc(u.name || u.email)} <small>${esc(roleLabel(u.role))}</small></span>${DEMO ? '' : signOutBtn()}`;
  wireSignOut();
  const tabs = [['cards', u.role === 'consultant' ? 'My scorecard' : 'Scorecards']];
  if (u.role !== 'consultant' && u.cid) tabs.push(['mine', 'My scorecard']);
  if (myMarkets().length) tabs.push(['market', 'Market']);
  if (['admin', 'exec', 'director'].includes(u.role)) tabs.push(['rollup', 'Coaching check']);
  if (canUpload()) tabs.push(['upload', 'Upload'], ['directory', 'Consultants']);
  if (isAdmin()) tabs.push(['roster', 'Logins'], ['goals', 'Goals']);
  if (!tabs.some(t => t[0] === S.tab)) S.tab = 'cards';
  $('#app').innerHTML = `
    <nav class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
    <div id="view"></div>`;
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; S.selected = null; renderShell(); });
  ({ cards: viewCards, mine: viewMineTab, market: viewMarket, rollup: viewRollup, upload: viewUpload, directory: viewDirectory, roster: viewRoster, goals: viewGoals })[S.tab]();
}

// ---------------------------------------------------------------- scorecards
function pickers(mine = false) {
  const months = S.meta.months || [];
  const showStore = S.user.role !== 'consultant' && !mine;
  const asOf = S.meta.asOf?.[S.month], sAsOf = S.meta.storeAsOf?.[S.month];
  const weeks = weeksInMonth(S.month);
  const wkLabel = w => `${dateLabel(w).slice(0, 5)} to ${dateLabel(S.meta.weekTo?.[w] || addDaysIso(w, 6)).slice(0, 5)}`;
  return `<div class="pickers">
    <label>Month<select id="pm">${months.map(m => `<option value="${m}" ${m === S.month ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select></label>
    ${weeks.length ? `<label>Week<select id="pv">${weeks.map(w => `<option value="${w}" ${S.view === w ? 'selected' : ''}>${wkLabel(w)}</option>`).join('')}</select></label>` : ''}
    ${showStore ? `<label>Store<select id="ps">${storeOptions(myStores(), S.store)}</select></label>` : ''}
    <div class="asof">${asOf ? `Consultants through <b>${dateLabel(asOf)}</b>` : ''}${sAsOf ? `<br>Stores through <b>${dateLabel(sAsOf)}</b>` : ''}</div>
  </div>`;
}
function wirePickers() {
  const pm = $('#pm'), ps = $('#ps'), pv = $('#pv');
  const again = () => (S.tab === 'mine' ? viewMineTab() : S.tab === 'market' ? viewMarket() : viewCards());
  if (pm) pm.onchange = () => { S.month = pm.value; S.selected = null; again(); };
  if (ps) ps.onchange = () => { S.store = ps.value; S.selected = null; again(); };
  if (pv) pv.onchange = () => { S.view = pv.value; again(); };
}
// Weeks that touch the picked month (Monday or Sunday falls in it), newest first.
function weeksInMonth(m) {
  return (S.meta.weeks || []).filter(w => w.slice(0, 7) === m || (S.meta.weekTo?.[w] || addDaysIso(w, 6)).slice(0, 7) === m);
}
// The week shown next to month to date: the one picked, else the latest in that month.
function shownWeek() {
  const weeks = weeksInMonth(S.month);
  if (!weeks.includes(S.view)) S.view = weeks[0] || null;
  return S.view;
}
const daysAgo = iso => Math.floor((Date.now() - new Date(iso + (iso.length === 10 ? 'T12:00:00' : '')).getTime()) / 86400000);
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const byNewest = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '');
const metricBy = key => METRICS.find(m => m.key === key);
const prevMonth = m => monthsBack(m, 1)[1];
const paceOf = c => (c?.period === 'week' ? WEEK_PACE : paceFactor(c?.asOf));
const periodLabel = c => (c?.period === 'week' ? `Week ${dateLabel(c.from).slice(0, 5)} to ${dateLabel(c.asOf).slice(0, 5)}` : `MTD ${dateLabel(c.from)} to ${dateLabel(c.asOf)}`);
const MIN_WEEK_HOURS = 20;
// Coaching runs on the latest week when the person worked enough hours to judge it; otherwise month to date.
function coachBasis(monthCard, weekCard) {
  if (weekCard && weekCard.hours >= MIN_WEEK_HOURS) return weekCard;
  if (!monthCard) return weekCard || null;
  return { ...monthCard, fallback: weekCard ? `Only ${Math.round(weekCard.hours)} hours last week, too few to judge a week. Coaching on month to date.` : 'No weekly numbers on file yet. Coaching on month to date.' };
}
// Team sessions use the store's week that matches the consultants' latest week. A newer partial week
// only counts once it has at least 3 days in it.
async function pickStoreWeek(latestWeek, latestStoreWeek, store) {
  const same = latestWeek ? await S.be.storeWeek(latestWeek, store).catch(() => null) : null;
  if (same) return same;
  if (!latestStoreWeek) return null;
  const w = await S.be.storeWeek(latestStoreWeek, store).catch(() => null);
  return w && daysBetween(w.from, w.asOf) >= 3 ? w : null;
}
function teamBasis(total, storeWk) {
  if (storeWk?.k) return storeWk;
  return total ? { ...total, fallback: 'No week-to-date store numbers yet. Coaching on month to date.' } : null;
}

async function viewCards() {
  const v = $('#view');
  if (!S.month) {
    v.innerHTML = `<div class="panel"><h2>No data yet</h2><p>${canUpload() ? 'Go to Upload and drop in this week\'s files.' : 'Scorecards show up here once the first files are uploaded.'}</p></div>`;
    return;
  }
  const viewWeek = shownWeek();
  v.innerHTML = pickers() + `<div class="loading">Loading…</div>`;
  wirePickers();
  try {
    if (S.user.role === 'consultant') return await viewMine(v);
    if (!S.store) { v.innerHTML = pickers() + `<div class="panel"><p>No stores assigned to you yet. Ask Frank to add your stores.</p></div>`; wirePickers(); return; }
    const latestWeek = (S.meta.weeks || [])[0], latestStoreWeek = (S.meta.storeWeeks || [])[0];
    const fuP = myFollowUps();
    const [cards, total, sessions, prev, weekCards, storeWk, viewCardsWk, viewStoreWk] = await Promise.all([
      S.be.cardsForStore(S.month, S.store), S.be.storeTotal(S.month, S.store),
      S.be.coachingForStore(S.store).catch(() => []), S.be.cardsForStore(prevMonth(S.month), S.store).catch(() => []),
      latestWeek ? S.be.weeklyForStore(latestWeek, S.store).catch(() => []) : [],
      null,
      viewWeek && viewWeek !== latestWeek ? S.be.weeklyForStore(viewWeek, S.store).catch(() => []) : null,
      viewWeek ? S.be.storeWeek(viewWeek, S.store).catch(() => null) : null
    ]);
    sessions.sort(byNewest);
    S.sessions = sessions;
    const fus = await fuP;
    const lastBy = {}; sessions.filter(x => !isTeam(x)).forEach(x => { if (!lastBy[x.cid]) lastBy[x.cid] = x; });
    S.rolls = {};
    cards.forEach(c => { S.rolls[c.cid] = rollFor(c, prev.find(p => p.cid === c.cid)); });
    // Week and month side by side: one row per person on either report.
    const wkCards = viewWeek ? (viewCardsWk || weekCards) : [];
    const wkOf = cid => wkCards.find(w => w.cid === cid) || null;
    const moOf = cid => cards.find(c => c.cid === cid) || null;
    const ids = [...new Set([...cards.map(c => c.cid), ...wkCards.map(w => w.cid)])];
    const rows = ids.map(cid => ({ cid, mo: moOf(cid), wk: wkOf(cid) })).map(r => ({ ...r, any: r.mo || r.wk }));
    rows.sort((a, b) => (b.mo?.k.netSales ?? -1) - (a.mo?.k.netSales ?? -1) || (b.wk?.k.netSales ?? 0) - (a.wk?.k.netSales ?? 0));
    const hasWk = wkCards.length > 0;
    const g = goalsFor(S.goals, S.store);
    const pace = paceFactor(S.meta.asOf?.[S.month]);
    const minSph = minSphFor(S.goals, S.store);
    const below = cards.filter(c => S.rolls[c.cid]?.st === 'below'), watch = cards.filter(c => S.rolls[c.cid]?.st === 'watch');
    const selMonth = moOf(S.selected), selWeekLatest = weekCards.find(c => c.cid === S.selected), selWeekShown = wkOf(S.selected);
    const basis = S.selected ? coachBasis(selMonth, selWeekLatest) : null;
    const lastCell = cid => {
      const l = sessions.find(x => !isTeam(x) && x.cid === cid);
      if (!l) return `<td><span class="due">No 1:1 yet</span></td>`;
      const d = daysAgo(l.date);
      return `<td>${d > 7 ? `<span class="due">${d} days ago</span>` : `<span class="ok">${d === 0 ? 'Today' : d + ' days ago'}</span>`}</td>`;
    };
    const pair = (m, w, c) => {
      const mv = c ? `<span class="val ${status(m, c.k[m.key], g[m.key], pace)}">${fmt(m, c.k[m.key])}</span>` : '<span class="val none">--</span>';
      if (!hasWk) return `<td class="num">${mv}</td>`;
      const wv = w ? `<span class="val ${status(m, w.k[m.key], g[m.key], WEEK_PACE)}">${fmt(m, w.k[m.key])}</span>` : '<span class="val none">--</span>';
      return `<td class="num"><div class="stack"><div>${wv}</div><div class="mo">${mv}</div></div></td>`;
    };
    const goalCell = m => {
      if (g[m.key] == null) return '<td class="num">--</td>';
      if (!m.monthly) return `<td class="num">${fmtGoal(m, g[m.key])}</td>`;
      return hasWk ? `<td class="num"><div class="stack"><div>${fmtGoal(m, g[m.key] * WEEK_PACE)}</div><div class="mo">${fmtGoal(m, g[m.key] * pace)}</div></div></td>` : `<td class="num">${fmtGoal(m, g[m.key] * pace)}</td>`;
    };
    const wkName = viewWeek ? `week of ${dateLabel(viewWeek).slice(0, 5)}` : '';
    v.innerHTML = pickers() + followUpPanel(fus, lastBy)
      + (below.length || watch.length ? `<div class="panel minpanel">
          <h2>Minimum standard: $${minSph} rolling SPH</h2>
          ${below.length ? `<p class="minrow"><span class="flag below">Below minimum</span> ${below.map(c => `<button class="link" data-jump="${esc(c.cid)}">${esc(titleName(c.name))} ($${Math.round(S.rolls[c.cid].sph)})</button>`).join(', ')}</p>` : ''}
          ${watch.length ? `<p class="minrow"><span class="flag watch">Within 10%</span> ${watch.map(c => `<button class="link" data-jump="${esc(c.cid)}">${esc(titleName(c.name))} ($${Math.round(S.rolls[c.cid].sph)})</button>`).join(', ')}</p>` : ''}
        </div>` : '')
      + (total || viewStoreWk ? storeCard(total, viewStoreWk) : `<div class="panel"><p class="muted">No store report on file for ${esc(S.store)} in ${monthLabel(S.month)} yet.</p></div>`)
      + (rows.length ? `<div class="panel flush">
        <div class="panel-head"><h2>Consultants <span class="count">${rows.length}</span></h2><span class="muted small">${hasWk ? `Each box: <b>${wkName}</b> on top, <b>month to date</b> below. ` : ''}Tap a name to open their card and weekly 1:1. Sorted by MTD net sales.</span></div>
        <div class="scroller"><table class="grid">
          <thead><tr><th>Consultant</th><th>Last 1:1</th><th class="num">Rolling SPH</th><th class="num">Hours${hasWk ? '<br><small>Wk / MTD</small>' : ''}</th>${METRICS.map(m => `<th class="num">${esc(m.label)}${hasWk ? '<br><small>Wk / MTD</small>' : ''}</th>`).join('')}</tr>
          <tr class="goalrow"><td>Goal${pace < 1 || hasWk ? ` <small>(monthly totals ${hasWk ? 'for one week / ' : ''}paced to ${Math.round(pace * 100)}% of month)</small>` : ''}</td><td></td><td class="num">min $${minSph}</td><td class="num">${hasWk ? `${MIN_WEEK_HOURS}+ to coach` : ''}</td>${METRICS.map(goalCell).join('')}</tr></thead>
          <tbody>${rows.map(r => `<tr data-id="${esc(r.cid)}" class="${r.cid === S.selected ? 'sel' : ''}"><td class="nm">${esc(titleName(r.any.name))}${r.any.title && r.any.title !== 'RSA' ? `<small>${esc(r.any.title)}</small>` : ''}</td>${lastCell(r.cid)}${rollCell(S.rolls[r.cid])}<td class="num">${hasWk ? `<div class="stack"><div>${r.wk ? Math.round(r.wk.hours) : '--'}</div><div class="mo">${r.mo ? Math.round(r.mo.hours) : '--'}</div></div>` : (r.mo ? Math.round(r.mo.hours) : '--')}</td>${METRICS.map(m => pair(m, r.wk, r.mo)).join('')}</tr>`).join('')}</tbody>
        </table></div></div>` : `<div class="panel"><p class="muted">No consultants on file for ${esc(S.store)} in ${monthLabel(S.month)}. ${canUpload() ? 'If people are missing, check the Consultants tab to make sure they are assigned to this store.' : ''}</p></div>`)
      + (S.selected && (selMonth || selWeekShown) ? (selMonth ? minBanner(selMonth, S.rolls[S.selected], false) : '') + consultantCard(selMonth, selWeekShown) + (basis ? `<div id="coach">${coachPanel('one', basis)}</div>` : '') : '');
    wirePickers(); wireFollowUps(v, fus);
    v.querySelectorAll('[data-jump]').forEach(b => b.onclick = () => v.querySelector(`tr[data-id="${CSS.escape(b.dataset.jump)}"]`)?.click());
    v.querySelectorAll('tbody tr[data-id]').forEach(tr => tr.onclick = () => {
      S.selected = S.selected === tr.dataset.id ? null : tr.dataset.id; if (S.cstate) S.cstate.one = null;
      viewCards().then(() => { const d = $('#min-' + CSS.escape(S.selected || '')) || $('#detail-' + CSS.escape(S.selected || '')); d?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    });
    if (basis) wireCoach('one', basis);
    if (S.jump) { S.jump = false; ($('#min-' + CSS.escape(S.selected || '')) || $('#detail-' + CSS.escape(S.selected || '')))?.scrollIntoView({ block: 'start' }); }
  } catch (e) {
    v.innerHTML = pickers() + `<div class="panel"><p class="err">Could not load scorecards: ${esc(e.message)}</p></div>`; wirePickers();
  }
}

async function viewMine(v) {
  const cid = S.user.cid;
  const viewWeek = shownWeek();
  const [cards, prev, sessions, weeks] = await Promise.all([S.be.cardsForCid(S.month, cid), S.be.cardsForCid(prevMonth(S.month), cid).catch(() => []),
    S.be.coachingForCid(cid).catch(() => []), S.be.weeklyForCid(cid).catch(() => [])]);
  sessions.sort(byNewest);
  weeks.sort((a, b) => b.week.localeCompare(a.week));
  const c = cards[0];
  const wk = viewWeek ? weeks.find(w => w.week === viewWeek) || null : null;
  if (!c && !wk) { v.innerHTML = pickers(true) + `<div class="panel"><p>No sales on file for you in ${monthLabel(S.month)} yet.</p></div>`; wirePickers(); return; }
  const store = (c || wk).store;
  const [total, storeWk] = await Promise.all([S.be.storeTotal(S.month, store).catch(() => null),
    viewWeek ? S.be.storeWeek(viewWeek, store).catch(() => null) : null]);
  const basis = coachBasis(c, weeks[0]);
  v.innerHTML = pickers(true) + (c ? minBanner(c, rollFor(c, prev[0]), true) : '') + myFocus(basis, sessions.filter(x => !isTeam(x))[0])
    + consultantCard(c, wk) + (total || storeWk ? storeCard(total, storeWk) : '');
  wirePickers();
}
// Selling leaders (ASM, Sales Lead) with their own card.
async function viewMineTab() {
  const v = $('#view');
  if (!S.month) { v.innerHTML = `<div class="panel"><p>No data yet.</p></div>`; return; }
  v.innerHTML = pickers(true) + `<div class="loading">Loading…</div>`;
  try { await viewMine(v); } catch (e) { v.innerHTML = pickers(true) + `<div class="panel"><p class="err">Could not load: ${esc(e.message)}</p></div>`; }
}

// ---------------------------------------------------------------- minimum standard
function rollFor(c, prev) {
  const r = rollingSph(c, prev);
  const min = minSphFor(S.goals, c.store);
  return { ...r, min, st: minStatus(r.sph, min) };
}
function rollCell(r) {
  if (!r || r.sph === null) return `<td class="num">--</td>`;
  const cls = r.st === 'below' ? 'red' : r.st === 'watch' ? 'amber' : 'green';
  return `<td class="num"><span class="val ${cls}">$${Math.round(r.sph).toLocaleString('en-US')}</span>${r.st === 'below' ? '<small class="flagtxt">Below min</small>' : ''}</td>`;
}
function minBanner(c, r, own) {
  if (!r || r.sph === null || r.st === 'ok' || r.st === 'none') return '';
  const who = own ? 'Your' : `${esc(titleName(c.name).split(' ')[0])}'s`;
  const range = `${dateLabel(r.from)} to ${dateLabel(r.to)}, ${r.days} days`;
  const outlet = isOutlet(S.goals, c.store) ? ' for outlets' : '';
  if (r.st === 'below') return `<div class="minbanner below" id="min-${esc(c.cid)}"><b>Below minimum standard.</b> ${who} rolling sales per hour is <b>$${Math.round(r.sph)}</b>. The minimum is $${r.min}${outlet}. <span class="small">(Last month plus this month: ${range}, $${Math.round(r.sales).toLocaleString('en-US')} over ${Math.round(r.hours)} hours.)</span>${own ? ' Talk with your leader this week about a plan.' : ' Address this in the 1:1 this week.'}</div>`;
  return `<div class="minbanner watch" id="min-${esc(c.cid)}"><b>Close to minimum.</b> ${who} rolling sales per hour is <b>$${Math.round(r.sph)}</b>, within 10% of the $${r.min} minimum. <span class="small">(${range}.)</span></div>`;
}

// ---------------------------------------------------------------- cards
// A tile with this week's number and month to date side by side. Either side may be missing.
function dualTile(label, sides, foot = '', cls = '') {
  return `<div class="tile dual ${cls}"><div class="tl">${esc(label)}</div><div class="halves">${sides.map(x => `<div class="half ${x.st}"><span class="hl">${x.tag}</span><span class="hv">${x.val}</span>${x.note ? `<span class="hg">${x.note}</span>` : ''}</div>`).join('')}</div>${foot}</div>`;
}
function consultantCard(mo, wk) {
  const c = mo || wk;
  const g = goalsFor(S.goals, c.store);
  const moPace = mo ? paceFactor(mo.asOf) : 1;
  const r = mo?.rank || wk?.rank;
  const rk = (scope, key) => { const x = r?.[scope]?.[key]; return x ? `#${x[0]} of ${x[1]}` : ''; };
  const headline = r?.store?.netSales
    ? `<div class="rankline"><span class="rk"><b>${rk('store', 'netSales')}</b> in ${esc(c.store)}</span><span class="rk"><b>${rk('company', 'netSales')}</b> company-wide</span><span class="muted small">Net sales rank${mo ? ', month to date' : ', this week'}</span></div>` : '';
  const sub = [wk ? `Week ${dateLabel(wk.from).slice(0, 5)} to ${dateLabel(wk.asOf).slice(0, 5)}, ${Math.round(wk.hours)} hrs` : '', mo ? `MTD ${dateLabel(mo.from).slice(0, 5)} to ${dateLabel(mo.asOf).slice(0, 5)}, ${Math.round(mo.hours)} hrs` : ''].filter(Boolean).join(' · ');
  return `<section class="panel card" id="detail-${esc(c.cid)}">
    <div class="card-head">
      <div><p class="eyebrow">${esc(c.store)}</p><h2 class="big">${esc(titleName(c.name))}</h2></div>
      <div class="muted small">${sub}</div>
    </div>
    ${headline}
    <div class="tiles duo">${METRICS.map(m => {
      const goal = g[m.key];
      const side = (card, pace, tag) => card
        ? { tag, val: fmt(m, card.k[m.key]), st: status(m, card.k[m.key], goal, pace), note: m.monthly && goal != null ? `goal ${fmtGoal(m, goal * pace)}` : '' }
        : { tag, val: '--', st: 'none', note: '' };
      const shown = wk && mo ? [side(wk, WEEK_PACE, 'Week'), side(mo, moPace, 'MTD')] : [side(wk || mo, wk ? WEEK_PACE : moPace, wk ? 'Week' : 'MTD')];
      const foot = `<div class="tg">${goal == null ? 'No goal set' : m.monthly ? `${fmtGoal(m, goal)}/mo` : `${m.lower ? 'At or under ' : 'Goal '}${fmtGoal(m, goal)}`}</div>${mo?.rank?.store?.[m.key] ? `<div class="tr">MTD ${rk('store', m.key)} store · ${rk('company', m.key)} co.</div>` : ''}`;
      return dualTile(m.label, shown, foot);
    }).join('')}</div>
  </section>`;
}

function storeCard(mo, wk) {
  const t = mo || wk;
  const g = goalsFor(S.goals, t.store);
  const sign = x => (x > 0 ? '+' : '') + x;
  const sub = [wk ? `Week to date ${dateLabel(wk.from).slice(0, 5)} to ${dateLabel(wk.asOf).slice(0, 5)}` : '', mo ? `MTD through ${dateLabel(mo.asOf)}` : ''].filter(Boolean).join(' · ');
  return `<section class="panel card store">
    <div class="card-head">
      <div><p class="eyebrow">Store total · from the daily report</p><h2 class="big">${esc(t.store)}</h2></div>
      <div class="muted small">${sub}</div>
    </div>
    <div class="tiles duo">${STORE_METRICS.map(m => {
      const side = (x, tag) => {
        if (!x) return { tag, val: '--', st: 'none', note: '' };
        const v = x.k?.[m.key], bud = x.budget?.[m.key], vb = x.vsBudget?.[m.key], ly = x.vsLy?.[m.key];
        const goal = bud ?? g[m.key] ?? null;
        const st = m.key === 'traffic' && bud == null ? 'none' : status(m, v, goal);
        const bits = [];
        if (bud != null) bits.push(`bud ${fmtGoal(m, bud)} (${m.budget === 'bps' ? sign(vb) + ' bps' : sign(vb) + '%'})`);
        if (ly != null) bits.push(`${sign(ly)}% LY`);
        return { tag, val: fmt(m, v), st, note: bits.join(' · ') };
      };
      const shown = wk && mo ? [side(wk, 'Week'), side(mo, 'MTD')] : [side(t, wk ? 'Week' : 'MTD')];
      const hasBud = [wk, mo].some(x => x?.budget?.[m.key] != null);
      const foot = !hasBud && g[m.key] != null ? `<div class="tg">${m.lower ? 'At or under ' : 'Goal '}${fmtGoal(m, g[m.key])}</div>` : '';
      return dualTile(m.label, shown, foot, m.key === 'spg' ? 'hero' : '');
    }).join('')}</div>
  </section>`;
}
// ---------------------------------------------------------------- talk to text
// Uses the browser's built-in speech recognition (Chrome, Edge, Safari). Nothing is recorded
// or saved as audio; only the words land in the box.
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recBtn = null;
const micBtn = id => Speech ? `<button type="button" class="mic" data-mic="${id}" aria-label="Talk to text"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg><span>Talk</span></button>` : '';
function stopMic() { if (rec) { try { rec.stop(); } catch (e) {} } }
function wireMics(root) {
  root.querySelectorAll('[data-mic]').forEach(b => b.onclick = () => {
    if (rec && recBtn === b) return stopMic();
    stopMic();
    const box = $('#' + b.dataset.mic);
    const live = b.parentElement.querySelector('.live');
    rec = new Speech(); recBtn = b;
    rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.trim();
        if (e.results[i].isFinal) {
          const cur = box.value.replace(/\s+$/, '');
          const said = t.charAt(0).toUpperCase() + t.slice(1);
          box.value = (cur ? cur + (/[.!?]$/.test(cur) ? ' ' : '. ') : '') + said;
        } else interim += t + ' ';
      }
      if (live) live.textContent = interim;
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microphone is blocked. Allow it for this site in your browser settings, then tap Talk again.', true);
      else if (e.error === 'no-speech') toast('Did not hear anything. Tap Talk and try again.', true);
      else if (e.error !== 'aborted') toast('Talk to text stopped: ' + e.error, true);
    };
    rec.onend = () => { b.classList.remove('on'); b.querySelector('span').textContent = 'Talk'; if (live) live.textContent = ''; rec = null; recBtn = null; };
    try { rec.start(); b.classList.add('on'); b.querySelector('span').textContent = 'Stop'; box.focus(); }
    catch (x) { toast('Could not start talk to text.', true); rec = null; }
  });
}

// ---------------------------------------------------------------- weekly coaching: 1:1 and team
// mode 'one' = a consultant's weekly 1:1 (consultant card metrics)
// mode 'team' = the store's weekly team coaching (store total metrics from the daily report)
const MODES = {
  one: { box: 'coach', p: 'cf', list: METRICS, word: '1:1' },
  team: { box: 'teamcoach', p: 'tf', list: STORE_METRICS.filter(m => TEAM_FOCUS.includes(m.key)), word: 'team session' }
};
const mBy = (mode, key) => MODES[mode].list.find(m => m.key === key) || STORE_METRICS.find(m => m.key === key) || metricBy(key);
const isTeam = x => x.type === 'team';

// Goal for one metric in this mode (monthly metrics are paced; team uses the store budget when there is one).
function goalOf(mode, subj, key) {
  const g = goalsFor(S.goals, subj.store), m = mBy(mode, key);
  if (mode === 'team') return subj.budget?.[key] ?? g[key];
  return m.monthly ? g[key] * paceOf(subj) : g[key];
}
function focusItem(mode, subj, key) {
  const m = mBy(mode, key), v = subj.k?.[key], goal = goalOf(mode, subj, key);
  const g = goalsFor(S.goals, subj.store);
  const x = { key, label: m.label, value: v, goal, lower: !!m.lower, ratio: m.lower ? (v ? goal / v : 2) : v / goal, perWeek: mode === 'one' && m.monthly && subj.period !== 'week' ? Math.ceil(g[key] / 4.33) : null };
  return { ...x, target: weeklyTarget(x) };
}

// How each focus item from a past session has moved since.
function followUp(mode, session, subj) {
  const k = subj?.k;
  const sameWeek = session.basis === 'week' && subj?.period === 'week' && subj.from === session.week;
  return (session.focus || []).map(f => {
    const m = mBy(mode, f.key); const cur = k?.[f.key];
    let st = 'none', word = 'No data';
    if (daysAgo(session.date) < 1) { st = 'none'; word = 'Set today'; }
    else if (sameWeek) { st = 'none'; word = 'No new week of numbers yet'; }
    else if (cur !== null && cur !== undefined) {
      if (f.perWeek) { const gained = cur - f.value; st = gained >= f.target ? 'green' : gained > 0 ? 'amber' : 'red'; word = `${Math.round(gained)} since then (aim ${f.target})`; }
      else if (f.lower) { st = cur <= f.target ? 'green' : cur < f.value ? 'amber' : 'red'; word = st === 'green' ? 'Hit target' : st === 'amber' ? 'Coming down' : 'Not moving yet'; }
      else { st = cur >= f.target ? 'green' : cur > f.value ? 'amber' : 'red'; word = st === 'green' ? 'Hit target' : st === 'amber' ? 'Moving up' : 'Not moving yet'; }
    }
    return `<div class="fu ${st}"><div><b>${esc(m.label)}</b><div class="small muted">${f.perWeek ? `Was ${fmt(m, f.value)} MTD` : `${fmt(m, f.value)} ${f.basis === 'week' ? 'that week' : 'then'} · target ${fmt(m, f.target)}`}</div></div>
      <div class="fu-now"><span class="val ${st}">${fmt(m, cur)}</span><div class="small">${esc(word)}</div></div></div>`;
  }).join('');
}

function coachPanel(mode, subj) {
  const M = MODES[mode], team = mode === 'team';
  const sessions = (S.sessions || []).filter(x => team ? isTeam(x) : !isTeam(x) && x.cid === subj.cid);
  const last = sessions[0];
  const own = !team && S.user.cid && subj.cid === S.user.cid;
  const coachable = canCoach(subj.store) && !own;
  const key = (team ? 'team:' + subj.store : subj.cid) + (subj.period || 'mtd') + subj.asOf;
  S.cstate ||= {};
  if (!S.cstate[mode] || S.cstate[mode].id !== key) {
    let picks = team ? pickStoreFocus(subj, goalsFor(S.goals, subj.store)).map(p => p.key)
      : pickFocus(subj.k, goalsFor(S.goals, subj.store), paceOf(subj)).map(p => p.key);
    // Below the minimum standard: SPH is always focus #1.
    if (!team && S.rolls?.[subj.cid]?.st === 'below') picks = ['sph', ...picks.filter(k => k !== 'sph')].slice(0, 2);
    S.cstate[mode] = { id: key, suggested: picks, selected: [...picks] };
  }
  const st = S.cstate[mode];
  const items = st.selected.map(k => focusItem(mode, subj, k));
  const others = M.list.filter(m => COACHING[m.key] && !st.selected.includes(m.key) && subj.k?.[m.key] != null);
  const first = team ? 'the team' : titleName(subj.name).split(' ')[0];
  const who = team ? 'The team' : first;
  const n = last ? 1 : 0;
  if (own) return `<section class="panel coach"><p class="eyebrow">Weekly 1:1</p><p>This is your own card. Your 1:1 is run by your leader.</p>
    ${last ? `<div class="fus">${followUp(mode, last, subj)}</div>` : ''}</section>`;
  return `<section class="panel coach ${team ? 'team' : ''}">
    <div class="card-head"><div><p class="eyebrow">${team ? 'Weekly team coaching' : 'Weekly 1:1'}</p><h2 class="big">${team ? `Coaching the ${esc(subj.store)} team` : `Coaching ${esc(first)}`}</h2></div>
      <div class="muted small">${last ? `Last ${M.word} ${dateLabel(last.date)} with ${esc(last.coachName || last.coach)}${last.followUp ? `<br>Follow-up set for <b>${dateLabel(last.followUp)}</b>` : ''}` : `No ${M.word} on file yet`}</div></div>
    <p class="basis ${subj.fallback ? 'fb' : ''}">${subj.fallback ? esc(subj.fallback) : subj.period === 'week' ? `Coaching on <b>${team ? 'week to date' : 'last week'}</b>: ${dateLabel(subj.from).slice(0, 5)} to ${dateLabel(subj.asOf).slice(0, 5)}${team ? '' : `, ${Math.round(subj.hours)} hours`}. Month to date is for tracking.` : 'Coaching on month to date.'}</p>
    ${team ? `<p class="small muted">Use this for the weekly team meeting or huddle. Same rule: no more than 2 things. The team sees this plan on their own cards.</p>` : ''}

    ${last ? `<h3>1. Follow up on last week</h3>
      <p class="small">${team ? 'The team' : 'They'} committed to: <i>${esc(last.commitment || 'nothing recorded')}</i></p>
      <div class="fus">${followUp(mode, last, subj)}</div>
      <p class="small muted">Start here. Ask what ${team ? 'the team' : 'they'} did, what worked, and what got in the way.</p>` : ''}

    <h3>${n + 1}. This week's focus <span class="muted small">(no more than 2)</span></h3>
    <div class="focus">${items.map((x, i) => {
      const t = COACHING[x.key]; const m = mBy(mode, x.key); const sug = st.suggested.includes(x.key);
      const goalWord = team && subj.budget?.[x.key] != null ? 'budget' : 'goal';
      return `<div class="fcard">
        <div class="fhead"><span class="fnum">${i + 1}</span><div><b>${esc(x.label)}</b> <span class="pill">${esc(t.pillar)}</span>${!team && x.key === 'sph' && S.rolls?.[subj.cid]?.st === 'below' ? ' <span class="pill minp">Minimum standard</span>' : ''}${sug ? '' : ' <span class="pill alt">Leader pick</span>'}
          <div class="small muted">Now ${fmt(m, x.value)} · ${goalWord} ${fmt(m, x.goal)} · ${x.perWeek ? `this week: ${x.perWeek}` : `${subj.period === 'week' ? 'target next week' : 'target by next week'}: ${fmt(m, x.target)}`}</div></div>
          ${coachable ? `<button class="link small" data-drop="${x.key}">Remove</button>` : ''}</div>
        <p class="small">${esc(t.why)}</p>
        ${t.source ? `<p class="src">From: ${esc(t.source)}</p>` : ''}
        <div class="small"><b>${team ? 'Ask the team' : 'Ask'}</b><ul>${t.ask.map(q => `<li>${esc(q)}</li>`).join('')}</ul></div>
        <div class="small"><b>This week</b> ${esc(t.doThis)}</div>
      </div>`;
    }).join('') || `<p class="muted">Pick one or two areas below.</p>`}</div>
    ${coachable && others.length ? `<div class="swap"><span class="small muted">${st.selected.length >= 2 ? 'Remove one to pick something else:' : 'Add a focus:'}</span>
      ${others.map(m => `<button class="chip" data-add="${m.key}" ${st.selected.length >= 2 ? 'disabled' : ''}>${esc(m.label)}</button>`).join('')}</div>` : ''}

    ${coachable ? `<h3>${n + 2}. Agree on the plan</h3>
    <form id="${M.p}Form" class="cform">
      <div class="fieldhead"><label for="${M.p}_commit">What ${esc(team ? 'the team' : first)} will do this week</label>${micBtn(M.p + '_commit')}<span class="live"></span></div>
      <textarea id="${M.p}_commit" rows="3" required>${esc(items.map(x => COACHING[x.key].doThis).join(' '))}</textarea>
      <div class="fieldhead"><label for="${M.p}_support">${team ? 'How leaders will follow up' : 'How you will help'}</label>${micBtn(M.p + '_support')}<span class="live"></span></div>
      <textarea id="${M.p}_support" rows="2" placeholder="${team ? 'Example: Leaders check apps at every huddle and shadow one guest each per shift.' : 'Example: I will shadow two of your guests Saturday.'}"></textarea>
      <div class="fieldhead"><label for="${M.p}_notes">Notes <small>${team ? 'the team can see these' : esc(first) + ' can see these'}</small></label>${micBtn(M.p + '_notes')}<span class="live"></span></div>
      <textarea id="${M.p}_notes" rows="3" placeholder="Tap Talk and say what you covered."></textarea>
      ${team ? '' : `<div class="formgrid fudate"><label>Follow up on <small>when you will check back in with ${esc(first)}</small><input type="date" id="${M.p}_fu" value="${addDaysIso(todayIso(), 7)}" min="${todayIso()}" required></label>
        <label class="check"><input type="checkbox" id="${M.p}_cal" checked> Add a reminder to my calendar</label></div>`}
      ${Speech ? '' : '<p class="small muted">Talk to text is not supported in this browser. Use Chrome, Edge or Safari, or the mic on your keyboard.</p>'}
      <div class="row"><button class="btn primary" ${items.length ? '' : 'disabled'}>Save ${M.word}</button><span class="small muted">Saves the focus, the numbers as of today, and the plan. Next week this opens with the follow-up.</span></div>
    </form>` : ''}

    ${sessions.length ? `<details class="hist"><summary>Past ${team ? 'team sessions' : '1:1s'} (${sessions.length})</summary>${sessions.map(x => `
      <div class="hrow"><div><b>${dateLabel(x.date)}</b> · ${esc(x.coachName || x.coach)}<div class="small">${(x.focus || []).map(f => esc(f.label)).join(' + ')}</div>${x.followUp ? `<div class="small muted">Follow up ${dateLabel(x.followUp)}</div>` : ''}</div>
      <div class="small">${esc(x.commitment || '')}${x.support ? `<div class="muted">Leader: ${esc(x.support)}</div>` : ''}${x.notes ? `<div class="muted">Notes: ${esc(x.notes)}</div>` : ''}</div>
      ${isAdmin() || x.coach === S.user.email ? `<button class="link danger small" data-delc="${esc(x.id)}">Delete</button>` : '<span></span>'}</div>`).join('')}</details>` : ''}
  </section>`;
}

function wireCoach(mode, subj) {
  const M = MODES[mode], team = mode === 'team';
  const box = $('#' + M.box); if (!box) return;
  wireMics(box);
  const st = () => S.cstate[mode];
  const rerender = () => {
    stopMic();
    const keep = ['_support', '_notes'].map(s => [M.p + s, $('#' + M.p + s)?.value || '']);
    box.innerHTML = coachPanel(mode, subj); wireCoach(mode, subj);
    keep.forEach(([id, v]) => { const el = $('#' + id); if (el && v) el.value = v; });
  };
  box.querySelectorAll('[data-drop]').forEach(b => b.onclick = () => { st().selected = st().selected.filter(k => k !== b.dataset.drop); rerender(); });
  box.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    if (st().selected.length >= 2) return toast('Keep it to 2. Remove one first.', true);
    st().selected.push(b.dataset.add); rerender();
  });
  box.querySelectorAll('[data-delc]').forEach(b => b.onclick = async () => {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Tap again to delete'; return; }
    await S.be.deleteCoaching(b.dataset.delc); toast('Deleted.'); viewCards();
  });
  const f = $('#' + M.p + 'Form');
  if (f) f.onsubmit = async e => {
    e.preventDefault(); stopMic();
    const basis = subj.period === 'week' ? 'week' : 'mtd';
    const focus = st().selected.map(k => { const x = focusItem(mode, subj, k); return { key: k, label: x.label, value: x.value, goal: Math.round(x.goal * 10) / 10, target: x.target, perWeek: x.perWeek, lower: x.lower, basis }; });
    const base = { basis, week: basis === 'week' ? subj.from : null, store: subj.store, coachName: S.user.name || S.user.email, date: todayIso(), createdAt: new Date().toISOString(), focus,
      commitment: $('#' + M.p + '_commit').value.trim(), support: $('#' + M.p + '_support').value.trim(), notes: $('#' + M.p + '_notes').value.trim() };
    try {
      const fu = !team ? $('#' + M.p + '_fu')?.value || null : null;
      const rec = team ? { ...base, type: 'team' } : { ...base, type: 'one', cid: subj.cid, name: subj.name, followUp: fu };
      await S.be.saveCoaching(rec);
      if (!team && fu && $('#' + M.p + '_cal')?.checked) saveIcs(rec);
      toast(team ? 'Team session saved.' : `1:1 with ${titleName(subj.name).split(' ')[0]} saved.`);
      S.cstate[mode] = null; viewCards();
    } catch (x) { toast('Could not save: ' + x.message, true); }
  };
}

// Consultant's own view: their latest 1:1 plan, and the store's team plan.
function myFocus(c, session) {
  if (!session || !c) return '';
  return `<section class="panel coach mine">
    <div class="card-head"><div><p class="eyebrow">My focus this week</p><h2 class="big">${(session.focus || []).map(f => esc(f.label)).join(' + ')}</h2></div>
    <div class="muted small">From your 1:1 on ${dateLabel(session.date)} with ${esc(session.coachName || session.coach)}${session.followUp ? `<br>Next check-in: <b>${dateLabel(session.followUp)}</b>` : ''}</div></div>
    <div class="fus">${followUp('one', session, c)}</div>
    <p><b>My plan:</b> ${esc(session.commitment || '')}</p>
    ${session.support ? `<p class="small"><b>My leader will:</b> ${esc(session.support)}</p>` : ''}
    ${session.notes ? `<p class="small muted">${esc(session.notes)}</p>` : ''}
  </section>`;
}
function teamFocus(total, session) {
  if (!session) return '';
  return `<section class="panel coach team mine">
    <div class="card-head"><div><p class="eyebrow">Team focus this week</p><h2 class="big">${(session.focus || []).map(f => esc(f.label)).join(' + ')}</h2></div>
    <div class="muted small">${esc(session.store)} team, ${dateLabel(session.date)} with ${esc(session.coachName || session.coach)}</div></div>
    ${total ? `<div class="fus">${followUp('team', session, total)}</div>` : ''}
    <p><b>Team plan:</b> ${esc(session.commitment || '')}</p>
    ${session.support ? `<p class="small"><b>Leaders will:</b> ${esc(session.support)}</p>` : ''}
    ${session.notes ? `<p class="small muted">${esc(session.notes)}</p>` : ''}
  </section>`;
}

// ---------------------------------------------------------------- follow-ups (the coach's own reminders)
const icsText = t => String(t || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
function saveIcs(x) {
  const d = x.followUp.replace(/-/g, ''), end = addDaysIso(x.followUp, 1).replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const first = titleName(x.name || '').split(' ')[0];
  const body = [`Follow up with ${titleName(x.name || '')} (${x.store}) on your 1:1 from ${dateLabel(x.date)}.`,
    `Focus: ${(x.focus || []).map(f => f.label).join(' + ')}`, x.commitment ? `They committed to: ${x.commitment}` : '', x.support ? `You said you would: ${x.support}` : '',
    `Open the scorecard: ${location.origin + location.pathname}`].filter(Boolean).join('\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//1915 South//Consultant Scorecard//EN', 'BEGIN:VEVENT',
    `UID:${stamp}-${(x.cid || 'x')}@consultant-scorecard`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${icsText(`1:1 follow-up: ${titleName(x.name || '')} (${x.store})`)}`, `DESCRIPTION:${icsText(body)}`,
    'BEGIN:VALARM', 'TRIGGER:PT9H', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`Follow up with ${first}`)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  download(`follow-up-${(x.name || 'consultant').toLowerCase().replace(/[^a-z]+/g, '-')}-${x.followUp}.ics`, ics, 'text/calendar');
}
// The coach's open follow-ups: their latest 1:1 with each person, if it has a follow-up date and nobody has
// run a newer 1:1 with that person since.
async function myFollowUps() {
  if (!S.user || !(isAdmin() || ['director', 'leader'].includes(S.user.role))) return [];
  const mine = (await S.be.coachingByCoach(S.user.email, S.user.stores || []).catch(() => [])).filter(x => !isTeam(x) && x.followUp);
  const latest = {};
  mine.forEach(x => { if (!latest[x.cid] || (x.createdAt || '') > (latest[x.cid].createdAt || '')) latest[x.cid] = x; });
  return Object.values(latest).sort((a, b) => a.followUp.localeCompare(b.followUp));
}
function followUpPanel(list, sessionsByCid = null) {
  const today = todayIso(), soon = addDaysIso(today, 7);
  // Drop any whose person already had a newer 1:1 (by anyone) in the sessions we have loaded.
  const open = list.filter(x => !(sessionsByCid?.[x.cid] && (sessionsByCid[x.cid].createdAt || '') > (x.createdAt || '')));
  const due = open.filter(x => x.followUp <= today), next = open.filter(x => x.followUp > today && x.followUp <= soon);
  if (!due.length && !next.length) return '';
  const row = x => {
    const late = daysBetween(x.followUp, today);
    const when = x.followUp === today ? '<span class="due">Today</span>' : x.followUp < today ? `<span class="due">${late} day${late === 1 ? '' : 's'} late</span>` : `<span class="muted">${dateLabel(x.followUp).slice(0, 5)}</span>`;
    return `<div class="furow"><div><b>${esc(titleName(x.name || ''))}</b> <span class="muted small">${esc(x.store)}</span><div class="small muted">${(x.focus || []).map(f => esc(f.label)).join(' + ')} · 1:1 on ${dateLabel(x.date).slice(0, 5)}</div></div>
      <div class="furight">${when}<button class="btn tiny" data-fuopen="${esc(x.cid)}" data-fust="${esc(x.store)}">Open</button><button class="link small" data-fucal="${esc(x.id)}">Calendar</button></div></div>`;
  };
  return `<section class="panel fupanel"><h2>Your follow-ups</h2>
    ${due.length ? `<p class="small"><b>Due now (${due.length})</b></p>${due.map(row).join('')}` : ''}
    ${next.length ? `<p class="small" style="margin-top:10px"><b>Coming up this week (${next.length})</b></p>${next.map(row).join('')}` : ''}</section>`;
}
function wireFollowUps(root, list) {
  root.querySelectorAll('[data-fuopen]').forEach(b => b.onclick = () => { S.store = b.dataset.fust; S.tab = 'cards'; S.selected = b.dataset.fuopen; S.jump = true; renderShell(); });
  root.querySelectorAll('[data-fucal]').forEach(b => b.onclick = () => { const x = list.find(y => y.id === b.dataset.fucal); if (x) saveIcs(x); });
}

// ---------------------------------------------------------------- coaching check (directors, exec, admin)
async function viewRollup() {
  const v = $('#view');
  if (!S.month) { v.innerHTML = `<div class="panel"><p>No data yet.</p></div>`; return; }
  v.innerHTML = `<div class="loading">Loading coaching check…</div>`;
  try {
    const allStores = myStores();
    const markets = myMarkets();
    if (S.rMarket && !markets.some(m => m.name === S.rMarket)) S.rMarket = '';
    const mk = markets.find(m => m.name === S.rMarket);
    const stores = mk ? allStores.filter(st => mk.stores.includes(st)) : allStores;
    const since = new Date(Date.now() - 120 * 86400000).toISOString();
    const all = seesAll() && !mk;
    const [cards, prev, coaching] = await Promise.all([
      all ? S.be.cardsForMonth(S.month) : Promise.all(stores.map(st => S.be.cardsForStore(S.month, st))).then(a => a.flat()),
      all ? S.be.cardsForMonth(prevMonth(S.month)).catch(() => []) : Promise.all(stores.map(st => S.be.cardsForStore(prevMonth(S.month), st).catch(() => []))).then(a => a.flat()),
      all ? S.be.coachingSince(since) : Promise.all(stores.map(st => S.be.coachingForStore(st))).then(a => a.flat())
    ]);
    const prevBy = Object.fromEntries(prev.map(c => [c.cid, c]));
    const ones = coaching.filter(x => !isTeam(x));
    const lastOf = cid => ones.filter(x => x.cid === cid).sort(byNewest)[0];
    const inScope = cards.filter(c => stores.includes(c.store));
    // People: who needs a 1:1, never coached first, then longest since the last one.
    const people = inScope.map(c => { const l = lastOf(c.cid); const r = rollFor(c, prevBy[c.cid]);
      return { c, l, days: l ? daysAgo(l.date) : null, roll: r, fu: l?.followUp || null }; });
    const rows = stores.map(st => {
      const ps = people.filter(p => p.c.store === st);
      const covered = ps.filter(p => p.days !== null && p.days <= 7).length;
      return { st, n: ps.length, covered, pct: ps.length ? covered / ps.length : null, overdue: ps.length - covered,
        never: ps.filter(p => p.days === null).length, below: ps.filter(p => p.roll.st === 'below').length,
        market: (S.goals?.markets || []).find(m => m.stores?.includes(st))?.name || '' };
    }).filter(r => r.n);
    const tot = rows.reduce((a, r) => ({ n: a.n + r.n, covered: a.covered + r.covered, below: a.below + r.below }), { n: 0, covered: 0, below: 0 });
    const pctCls = p => (p === null ? 'none' : p >= 0.9 ? 'green' : p >= 0.6 ? 'amber' : 'red');
    const sorted = (list, vals, k) => [...list].sort((a, b) => { const x = vals[k.key](a), y = vals[k.key](b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * k.dir; });
    const th = (key, label, set, cur, num = true) => `<th class="${num ? 'num ' : ''}sortable" data-${set}="${key}">${label}${cur.key === key ? (cur.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
    const sk = S.rSort || { key: 'pct', dir: 1 };
    const sv = { st: r => r.st, market: r => r.market, n: r => r.n, pct: r => r.pct, overdue: r => r.overdue, never: r => r.never, below: r => r.below };
    const pk = S.rpSort || { key: 'days', dir: -1 };
    // Never coached sorts as the longest wait.
    const pvv = { name: p => titleName(p.c.name), store: p => p.c.store, days: p => (p.days === null ? 9999 : p.days), coach: p => p.l?.coachName || '', roll: p => p.roll.sph, net: p => p.c.k.netSales, fu: p => p.fu };
    const lastCell = p => p.days === null ? '<span class="due">Never</span>' : p.days > 7 ? `<span class="due">${p.days} days ago</span>` : `<span class="ok">${p.days === 0 ? 'Today' : p.days + ' days ago'}</span>`;
    const fuCell = p => !p.fu ? '<span class="muted">--</span>' : p.fu <= todayIso() ? `<span class="due">${dateLabel(p.fu).slice(0, 5)}</span>` : dateLabel(p.fu).slice(0, 5);
    const needOnly = S.rpNeed !== false;
    const plist = sorted(needOnly ? people.filter(p => p.days === null || p.days > 7) : people, pvv, pk);
    v.innerHTML = `
    <div class="panel">
      <div class="card-head"><div><h2>Coaching check</h2><p class="muted small" style="margin:0">A 1:1 counts if it was saved in the last 7 days. Tap any column to sort; tap again to flip low to high.</p></div>
      ${markets.length ? `<label style="margin:0">Market<select id="rmk"><option value="">${seesAll() ? 'All stores' : 'All my stores'}</option>${markets.map(m => `<option ${m.name === S.rMarket ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>` : ''}</div>
      <div class="tiles rolltiles">
        <div class="tile ${pctCls(tot.n ? tot.covered / tot.n : null)}"><div class="tl">1:1s this week</div><div class="tv">${tot.n ? Math.round(tot.covered / tot.n * 100) : 0}%</div><div class="tg">${tot.covered} of ${tot.n} consultants</div></div>
        <div class="tile ${tot.n - tot.covered ? 'amber' : 'green'}"><div class="tl">Need a 1:1</div><div class="tv">${tot.n - tot.covered}</div><div class="tg">${people.filter(p => p.days === null).length} have never had one</div></div>
        <div class="tile ${tot.below ? 'red' : 'green'}"><div class="tl">Below minimum</div><div class="tv">${tot.below}</div><div class="tg">consultants under the rolling SPH minimum</div></div>
      </div>
    </div>
    <div class="panel flush">
      <div class="panel-head"><h2>Stores <span class="count">${rows.length}</span></h2><span class="muted small">Lowest coverage first. Tap a store to open it.</span></div>
      <div class="scroller"><table class="grid">
      <thead><tr>${th('st', 'Store', 'rs', sk, false)}${markets.length ? th('market', 'Market', 'rs', sk, false) : ''}${th('n', 'Consultants', 'rs', sk)}${th('pct', '1:1 in last 7 days', 'rs', sk)}${th('overdue', 'Overdue', 'rs', sk)}${th('never', 'Never had a 1:1', 'rs', sk)}${th('below', 'Below minimum', 'rs', sk)}</tr></thead>
      <tbody>${sorted(rows, sv, sk).map(r => `<tr data-store="${esc(r.st)}"><td class="nm">${esc(r.st)}</td>${markets.length ? `<td class="small">${esc(r.market)}</td>` : ''}<td class="num">${r.n}</td>
        <td class="num"><span class="val ${pctCls(r.pct)}">${r.pct === null ? '--' : Math.round(r.pct * 100) + '%'}</span><small class="muted"> ${r.covered}/${r.n}</small></td>
        <td class="num">${r.overdue ? `<span class="due">${r.overdue}</span>` : '0'}</td><td class="num">${r.never}</td>
        <td class="num">${r.below ? `<span class="val red">${r.below}</span>` : '0'}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">No consultants on file yet.</td></tr>`}</tbody>
      </table></div>
    </div>
    <div class="panel flush">
      <div class="panel-head"><h2>Who needs a 1:1 <span class="count">${plist.length}</span></h2>
        <span class="muted small"><label class="check inline"><input type="checkbox" id="rneed" ${needOnly ? 'checked' : ''}> Only people without a 1:1 in the last 7 days</label> Tap a name to open their card.</span></div>
      <div class="scroller tall"><table class="grid">
      <thead><tr>${th('name', 'Consultant', 'rp', pk, false)}${th('store', 'Store', 'rp', pk, false)}${th('days', 'Last 1:1', 'rp', pk, false)}${th('coach', 'Coached by', 'rp', pk, false)}${th('fu', 'Follow-up', 'rp', pk, false)}${th('roll', 'Rolling SPH', 'rp', pk)}${th('net', 'Net sales MTD', 'rp', pk)}</tr></thead>
      <tbody>${plist.map(p => `<tr data-id="${esc(p.c.cid)}" data-st="${esc(p.c.store)}"><td class="nm">${esc(titleName(p.c.name))}${p.c.title && p.c.title !== 'RSA' ? `<small>${esc(p.c.title)}</small>` : ''}</td><td>${esc(p.c.store)}</td>
        <td>${lastCell(p)}</td><td class="small">${esc(p.l?.coachName || '')}</td><td>${fuCell(p)}</td>${rollCell(p.roll)}<td class="num">${fmt(metricBy('netSales'), p.c.k.netSales)}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">Everyone has had a 1:1 in the last 7 days.</td></tr>`}</tbody>
      </table></div>
    </div>`;
    const rk = $('#rmk'); if (rk) rk.onchange = () => { S.rMarket = rk.value; viewRollup(); };
    $('#rneed').onchange = e => { S.rpNeed = e.target.checked; viewRollup(); };
    v.querySelectorAll('[data-rs]').forEach(h => h.onclick = () => { const k = h.dataset.rs; S.rSort = { key: k, dir: sk.key === k ? -sk.dir : (['st', 'market', 'pct'].includes(k) ? 1 : -1) }; viewRollup(); });
    v.querySelectorAll('[data-rp]').forEach(h => h.onclick = () => { const k = h.dataset.rp; S.rpSort = { key: k, dir: pk.key === k ? -pk.dir : (['name', 'store', 'coach', 'fu', 'roll', 'net'].includes(k) ? 1 : -1) }; viewRollup(); });
    v.querySelectorAll('tr[data-store]').forEach(tr => tr.onclick = () => { S.store = tr.dataset.store; S.tab = 'cards'; S.selected = null; renderShell(); });
    v.querySelectorAll('tbody tr[data-id]').forEach(tr => tr.onclick = () => { S.store = tr.dataset.st; S.tab = 'cards'; S.selected = tr.dataset.id; S.jump = true; renderShell(); });
  } catch (e) { v.innerHTML = `<div class="panel"><p class="err">Could not load the coaching check: ${esc(e.message)}</p></div>`; }
}

// ---------------------------------------------------------------- upload (weekly: RSA report + daily report)
function viewUpload() {
  const m = S.meta;
  const last = (x, what) => x ? `<li>${what}: <b>${esc(x.file)}</b>, ${new Date(x.at).toLocaleString('en-US')} by ${esc(x.by)}</li>` : '';
  $('#view').innerHTML = `
  <div class="panel">
    <h2>Upload this week's files</h2>
    <p>Drop them together (or one at a time). The app reads the dates in each file name.</p>
    <ol class="small">
      <li><b>RSA report, month to date</b> (the 1st through the latest day), for example <code>rsa_report_2026-09-01_to_2026-09-28.csv</code>. Builds the month-to-date cards for tracking.</li>
      <li><b>RSA report, last week</b> (Monday to Sunday), for example <code>rsa_report_2026-09-21_to_2026-09-27.csv</code>. Builds the weekly numbers that 1:1s run on.</li>
      <li><b>Daily report for Sunday</b> (the last day of that week), for example <code>daily-report-2026-09-27.csv</code>. Store totals, month to date and the full week.</li>
    </ol>
    <p class="small muted">Best routine: every Monday, upload all three through Sunday. Then month to date, the week, and the store week all line up.</p>
    ${m.lastRsa || m.lastDaily || m.lastWeekly ? `<ul class="muted small">${last(m.lastRsa, 'Last month-to-date RSA report')}${last(m.lastWeekly, 'Last weekly RSA report')}${last(m.lastDaily, 'Last daily report')}</ul>` : ''}
    <label class="drop" id="drop"><input type="file" id="file" accept=".csv,.xlsx,.xls" multiple><span><b>Choose files</b> or drag them here</span></label>
    ${DEMO ? `<p class="small">Demo: <button class="link" id="sample">load this week's sample files</button> to see the preview.</p>` : ''}
    <div id="preview"></div>
  </div>`;
  const handle = async files => {
    S.pending = S.pending || {};
    for (const file of files) {
      try {
        const rows = await readSpreadsheet(file);
        addPending(file.name, rows);
      } catch (e) { toast(`Could not read ${file.name}: ${e.message}`, true); }
    }
    await renderPending();
  };
  $('#file').onchange = e => handle([...e.target.files]);
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); handle([...e.dataTransfer.files]); };
  const sb = $('#sample');
  if (sb) sb.onclick = async () => { S.pending = {}; S.be.sampleFiles().forEach(([n, rows]) => addPending(n, rows)); await renderPending(); };
  if (S.pending) renderPending();
}

function addPending(name, rows) {
  const heads = new Set(Object.keys(rows[0] || {}).map(h => h.trim().toLowerCase()));
  if (heads.has('sales associate')) {
    const parsed = parseRsa(rows);
    const range = rangeFromFileName(name) || {};
    // A month-to-date file builds the tracking cards; a one-week file builds the coaching numbers.
    const key = periodOf(range.from, range.to) === 'week' ? 'rsaWeek' : 'rsa';
    S.pending[key] = { file: name, parsed, from: range.from || '', to: range.to || '', assign: {} };
  } else if (heads.has('segment') && heads.has('metric')) {
    S.pending.daily = { file: name, parsed: parseDailyReport(rows) };
  } else {
    toast(`${name} does not look like the RSA report or the daily report.`, true);
  }
}
const RSA_KEYS = ['rsa', 'rsaWeek'];
const rsaReady = (R, dirLen) => R && !R.parsed.missing.length && R.from && R.to && dirLen > 0 && periodOf(R.from, R.to) !== 'other';

function rsaSection(key, R, dir) {
  const r = R.parsed, pf = key;
  if (r.missing.length) return `<div class="warnbox"><b>${esc(R.file)} is missing columns:</b> ${r.missing.map(c => `<code>${c}</code>`).join(' ')}</div>`;
  const res = resolveReportNames(r.people, dir);
  R.res = res;
  res.unmatched.forEach(x => { if (!(x.cid in R.assign)) { const sg = res.suggestions[x.cid]; R.assign[x.cid] = sg ? 'link:' + sg.cid : ''; } });
  const skipped = res.matched.filter(m => m.d.store === SKIP).length;
  const period = periodOf(R.from, R.to);
  const openOpts = (sel, sg) => {
    const byStore = {};
    res.openRoster.forEach(d => (byStore[d.store] ||= []).push(d));
    return (sg && sg.how === 'possible' ? `<option value="link:${esc(sg.cid)}" ${sel === 'link:' + sg.cid ? 'selected' : ''}>Possible match: ${esc(dir.find(d => d.cid === sg.cid).name)} (${esc(dir.find(d => d.cid === sg.cid).store)})</option>` : '')
      + ALL_STORE_NAMES.filter(n => byStore[n]).map(n => `<optgroup label="Same person as, at ${esc(n)}">${byStore[n].map(d => `<option value="link:${esc(d.cid)}" ${sel === 'link:' + d.cid ? 'selected' : ''}>${esc(d.name)}${d.title && d.title !== 'RSA' ? ' (' + d.title + ')' : ''}</option>`).join('')}</optgroup>`).join('');
  };
  return `<section class="pend"><h3>RSA report, ${period === 'week' ? '<span class="pill">one week: coaching numbers</span>' : period === 'month' ? '<span class="pill">month to date: tracking</span>' : 'dates to check'} <span class="muted small">${esc(R.file)}</span></h3>
    <div class="formgrid"><label>From<input type="date" data-rfrom="${pf}" value="${R.from}"></label><label>Through<input type="date" data-rto="${pf}" value="${R.to}"></label></div>
    ${!R.from || !R.to ? `<div class="warnbox">The dates were not in the file name. Enter them above.</div>` : ''}
    ${R.from && R.to && period === 'other' ? `<div class="warnbox"><b>These dates are not month to date or a single week.</b> Use the 1st of the month through the latest day, or one Monday to Sunday week.</div>` : ''}
    ${!dir.length ? `<div class="warnbox err"><b>Load the team roster first.</b> Without it the app can't tell which store anyone works at, so nobody would show up. Go to the Consultants tab, load the Store Sales Team Contacts file, then come back.</div>` : ''}
    <p class="small"><b>${r.people.length}</b> selling consultants. <b>${res.matched.length - skipped}</b> matched to the team roster${skipped ? `, ${skipped} marked not a consultant` : ''}. ${res.unmatched.length ? `<b class="err">${res.unmatched.length} not matched</b> (below).` : 'Everyone is matched.'}</p>
    <p class="muted small">Left out: ${r.skipped.map(esc).join(', ') || 'none'}, plus ${r.nonSellers.length} people with no sales hours (leaders, returns only).</p>
    ${res.unmatched.length && dir.length ? `<div class="assign">
      <p class="small"><b>Names in the report that are not on the roster.</b> Usually a nickname, a name change, or someone new. Pick who they are on the roster, or give them a store. Suggestions are filled in; check them.</p>
      ${res.unmatched.some(x => !res.suggestions[x.cid]) ? `<p class="small"><button class="btn tiny" data-skipall="${pf}">Leave off everyone with no match</button> <span class="muted">Sets every row without a suggestion to "Leave off, don't ask again". You can bring anyone back on the Consultants tab.</span></p>` : ''}
      <div class="scroller"><table class="mini"><thead><tr><th>Name in report</th><th class="num">Net Sales</th><th class="num">SPH</th><th>Who is this?</th></tr></thead><tbody>
      ${res.unmatched.sort((a, b) => b.k.netSales - a.k.netSales).map(x => { const sel = R.assign[x.cid]; const sg = res.suggestions[x.cid]; return `<tr><td>${esc(x.name)}${sg ? `<small class="sugg ${sg.how === 'possible' ? 'weak' : ''}">${sg.how === 'possible' ? 'Possible match (same last name): check it' : `Suggested by ${sg.how === 'email' ? 'work email' : 'name'}`}</small>` : ''}</td><td class="num">${fmt(METRICS[0], x.k.netSales)}</td><td class="num">${fmt(METRICS[1], x.k.sph)}</td>
        <td><select data-assign="${pf}|${esc(x.cid)}"><option value="">Leave out for now</option><option value="${SKIP}" ${sel === SKIP ? 'selected' : ''}>Leave off, don't ask again</option>${openOpts(sel, sg)}
        ${ALL_STORE_NAMES.map(n => `<option value="store:${esc(n)}" ${sel === 'store:' + n ? 'selected' : ''}>New person at ${esc(n)}</option>`).join('')}</select></td></tr>`; }).join('')}
      </tbody></table></div></div>` : ''}
  </section>`;
}

async function renderPending() {
  const p = $('#preview'); if (!p) return;
  const P = S.pending || {};
  const dir = await S.be.directory();
  const dmap = Object.fromEntries(dir.map(d => [d.cid, d]));
  let html = '';
  // Answers given for the month file carry over to the week file (same people).
  if (P.rsa && P.rsaWeek) P.rsaWeek.assign = { ...P.rsaWeek.assign, ...P.rsa.assign };
  RSA_KEYS.forEach(k => { if (P[k]) html += rsaSection(k, P[k], dir); });
  if (P.daily) {
    const d = P.daily.parsed;
    if (d.missing.length) html += `<div class="warnbox"><b>${esc(P.daily.file)} is missing columns:</b> ${d.missing.map(c => `<code>${c}</code>`).join(' ')}</div>`;
    else {
      const missingStores = ALL_STORE_NAMES.filter(n => !d.stores.some(s => s.store === n));
      html += `<section class="pend"><h3>Daily report <span class="muted small">${esc(P.daily.file)}</span></h3>
        <p class="small">Month to date and week to date through <b>${dateLabel(d.date)}</b>. <b>${d.stores.length} of 41</b> stores found.${missingStores.length ? ` Missing: ${missingStores.map(esc).join(', ')}.` : ''}</p>
        ${d.unknown.length ? `<div class="warnbox"><b>Not matched to a store:</b> ${d.unknown.map(esc).join(', ')}. Tell Claude so it can be added.</div>` : ''}
        <p class="muted small">Region, Online and Total rows are skipped.</p>
      </section>`;
    }
  }
  const anyRsa = RSA_KEYS.some(k => P[k]);
  const blocked = RSA_KEYS.some(k => P[k] && !rsaReady(P[k], dir.length));
  const ready = !blocked && (anyRsa || (P.daily && !P.daily.parsed.missing.length));
  html += (anyRsa || P.daily) ? `<div class="row"><button class="btn primary" id="pub" ${ready ? '' : 'disabled'}>Publish</button><button class="btn" id="clr">Clear</button><span id="prog" class="muted small">${blocked ? 'Fix the item above to publish.' : ''}</span></div>` : '';
  p.innerHTML = html;
  p.querySelectorAll('[data-assign]').forEach(s => s.onchange = () => { const [k, cid] = s.dataset.assign.split('|'); P[k].assign[cid] = s.value; });
  p.querySelectorAll('[data-skipall]').forEach(b => b.onclick = () => { const R = P[b.dataset.skipall]; R.res.unmatched.forEach(x => { if (!R.res.suggestions[x.cid]) R.assign[x.cid] = SKIP; }); renderPending(); });
  p.querySelectorAll('[data-rfrom]').forEach(i => i.onchange = () => { P[i.dataset.rfrom].from = i.value; moveIfWeek(P, i.dataset.rfrom); renderPending(); });
  p.querySelectorAll('[data-rto]').forEach(i => i.onchange = () => { P[i.dataset.rto].to = i.value; moveIfWeek(P, i.dataset.rto); renderPending(); });
  const clr = $('#clr'); if (clr) clr.onclick = () => { S.pending = null; viewUpload(); };
  const pub = $('#pub'); if (pub) pub.onclick = () => publishPending(dmap);
}
// If dates typed by hand change a file from month to week (or back), move it to the right slot.
function moveIfWeek(P, key) {
  const R = P[key]; const want = periodOf(R.from, R.to) === 'week' ? 'rsaWeek' : 'rsa';
  if (want !== key && !P[want]) { P[want] = R; delete P[key]; }
}

async function resolvePeople(R, dmap) {
  const res = R.res;
  const resolved = new Map(res.matched.map(m => [m.p.cid, m.d]));
  const saves = [];
  for (const x of res.unmatched) {
    const v = R.assign[x.cid] || '';
    if (!v) continue;
    if (v === SKIP) { const d = { cid: x.cid, name: x.name, store: SKIP }; saves.push(d); resolved.set(x.cid, d); dmap[x.cid] = d; }
    else if (v.startsWith('store:')) { const d = { cid: x.cid, name: x.name, store: v.slice(6), title: 'RSA', aliases: [] }; saves.push(d); resolved.set(x.cid, d); dmap[x.cid] = d; }
    else if (v.startsWith('link:')) {
      const d = dmap[v.slice(5)]; if (!d) continue;
      d.aliases = [...new Set([...(d.aliases || []), x.cid])]; saves.push(d); resolved.set(x.cid, d);
    }
  }
  if (saves.length) await S.be.saveDirectory(saves);
  const seen = new Set();
  const people = R.parsed.people.map(x => {
    const d = resolved.get(x.cid);
    if (!d || d.store === SKIP || seen.has(d.cid)) return null;
    seen.add(d.cid);
    return { ...x, cid: d.cid, name: d.name, reportName: x.name, store: d.store, title: d.title || 'RSA' };
  }).filter(Boolean);
  addRanks(people);
  return people;
}

async function publishPending(dmap) {
  const P = S.pending, b = $('#pub'); b.disabled = true;
  try {
    const msg = [];
    if (P.rsa && !P.rsa.parsed.missing.length) {
      const people = await resolvePeople(P.rsa, dmap);
      await S.be.publishRsa({ month: P.rsa.from.slice(0, 7), from: P.rsa.from, to: P.rsa.to, people, file: P.rsa.file }, (d, t) => $('#prog').textContent = `Saving ${d} of ${t}…`);
      msg.push(`${people.length} month-to-date cards`);
      S.month = P.rsa.from.slice(0, 7);
    }
    if (P.rsaWeek && !P.rsaWeek.parsed.missing.length) {
      // Re-run matching so links just made for the month file apply here too.
      P.rsaWeek.res = resolveReportNames(P.rsaWeek.parsed.people, Object.values(dmap));
      const people = await resolvePeople(P.rsaWeek, dmap);
      await S.be.publishWeekly({ from: P.rsaWeek.from, to: P.rsaWeek.to, people, file: P.rsaWeek.file }, (d, t) => $('#prog').textContent = `Saving ${d} of ${t}…`);
      msg.push(`${people.length} weekly cards`);
      S.view = P.rsaWeek.from; S.viewSet = true;
    }
    if (P.daily && !P.daily.parsed.missing.length) {
      await S.be.publishDaily({ ...P.daily.parsed, file: P.daily.file });
      msg.push(`${P.daily.parsed.stores.length} store totals`);
    }
    toast(`Published ${msg.join(', ')}.`);
    S.pending = null; await loadShared(); S.tab = 'cards'; renderShell();
  } catch (e) { b.disabled = false; toast('Publish failed: ' + e.message, true); }
}

// ---------------------------------------------------------------- consultants: team roster and store list
async function viewDirectory() {
  const v = $('#view');
  v.innerHTML = `<div class="loading">Loading consultants…</div>`;
  const dir = (await S.be.directory()).sort((a, b) => (a.store || '').localeCompare(b.store || '') || a.name.localeCompare(b.name));
  const f = S.dirFilter || '';
  const shown = dir.filter(d => !f || d.store === f);
  const counts = {}; dir.forEach(d => counts[d.store] = (counts[d.store] || 0) + 1);
  const active = dir.filter(d => d.store !== SKIP);
  const lr = S.meta.lastRoster;
  v.innerHTML = `
  <div class="panel">
    <h2>Team roster</h2>
    <p>Load the Store Sales Team Contacts file (the Paylocity export with Location, Role, Name and Email). It sets each person's store and title, and can set up their logins. Reload it whenever people join, leave or transfer.</p>
    ${lr ? `<p class="muted small">Last loaded: ${esc(lr.file)}, ${new Date(lr.at).toLocaleString('en-US')} (${lr.people} people)</p>` : ''}
    <label class="drop" id="rdrop"><input type="file" id="rfile" accept=".xlsx,.xls,.csv"><span><b>Choose the roster file</b> or drag it here</span></label>
    ${DEMO ? `<p class="small">Demo: <button class="link" id="rsample">load a sample roster</button></p>` : ''}
    <div id="rprev"></div>
  </div>
  <div class="panel flush">
    <div class="panel-head"><h2>${active.length} on the team</h2>
      <label class="inline">Show <select id="dfil"><option value="">All stores</option>${storeOptions(ALL_STORE_NAMES.filter(n => counts[n]), f)}<option value="${SKIP}" ${f === SKIP ? 'selected' : ''}>Left off (${counts[SKIP] || 0})</option></select></label></div>
    <div class="scroller"><table class="grid"><thead><tr><th>Name</th><th>Title</th><th>Store</th><th>Also appears in the report as</th><th></th></tr></thead>
    <tbody>${shown.map(d => `<tr><td class="nm">${esc(d.name)}${d.email ? `<small>${esc(d.email)}</small>` : ''}</td><td>${esc(d.title || '')}</td>
      <td><select data-dstore="${esc(d.cid)}">${storeOptions(ALL_STORE_NAMES, d.store, `<option value="${SKIP}" ${d.store === SKIP ? 'selected' : ''}>Not a consultant</option>`)}</select></td>
      <td class="small">${(d.aliases || []).map(a => `<span class="alias">${esc(a.replace(/-/g, ' '))} <button class="link small" data-unalias="${esc(d.cid)}|${esc(a)}" aria-label="Unlink">x</button></span>`).join(' ')}</td>
      <td class="acts"><button class="link danger" data-ddel="${esc(d.cid)}">Remove</button></td></tr>`).join('') || `<tr><td colspan="5" class="muted">Nobody yet. Load the team roster above.</td></tr>`}</tbody></table></div>
  </div>`;
  $('#dfil').onchange = e => { S.dirFilter = e.target.value; viewDirectory(); };
  v.querySelectorAll('[data-dstore]').forEach(s => s.onchange = async () => {
    const d = dir.find(x => x.cid === s.dataset.dstore);
    await S.be.saveDirectory([{ ...d, store: s.value }]);
    toast(`${d.name} moved to ${s.value === SKIP ? 'not a consultant' : s.value}. Takes effect on the next upload.`);
  });
  v.querySelectorAll('[data-unalias]').forEach(b => b.onclick = async () => {
    const [cid, a] = b.dataset.unalias.split('|'); const d = dir.find(x => x.cid === cid);
    await S.be.saveDirectory([{ ...d, aliases: (d.aliases || []).filter(x => x !== a) }]); toast('Unlinked.'); viewDirectory();
  });
  v.querySelectorAll('[data-ddel]').forEach(b => b.onclick = async () => {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Tap again'; return; }
    await S.be.deleteDirectory(b.dataset.ddel); toast('Removed.'); viewDirectory();
  });
  const handle = async (name, rows) => rosterPreview(name, parseTeamRoster(rows), dir);
  $('#rfile').onchange = async e => { const file = e.target.files[0]; if (file) handle(file.name, await readSpreadsheet(file)); };
  const rd = $('#rdrop');
  rd.ondragover = e => { e.preventDefault(); rd.classList.add('over'); };
  rd.ondragleave = () => rd.classList.remove('over');
  rd.ondrop = async e => { e.preventDefault(); rd.classList.remove('over'); const file = e.dataTransfer.files[0]; if (file) handle(file.name, await readSpreadsheet(file)); };
  const rs = $('#rsample'); if (rs) rs.onclick = () => handle('Store_Sales_Team_Contacts_sample.xlsx', S.be.sampleRoster());
}

async function rosterPreview(file, t, dir) {
  const p = $('#rprev');
  if (t.missing.length) { p.innerHTML = `<div class="warnbox"><b>This does not look like the team roster.</b> Missing columns: ${t.missing.join(', ')}. Use the "Sales Team" sheet.</div>`; return; }
  const users = await S.be.users();
  const uByEmail = Object.fromEntries(users.map(u => [u.email, u]));
  const inRoster = new Set(t.people.map(x => x.cid));
  const gone = dir.filter(d => d.store !== SKIP && d.title && !inRoster.has(d.cid));
  const byTitle = t.people.reduce((a, x) => (a[x.title] = (a[x.title] || 0) + 1, a), {});
  const noEmail = t.people.filter(x => !x.email);
  const protectedRoles = ['admin', 'exec', 'director'];
  const loginPlan = t.people.filter(x => x.email && !protectedRoles.includes(uByEmail[x.email]?.role));
  const newLogins = loginPlan.filter(x => !uByEmail[x.email]).length;
  p.innerHTML = `
    <p class="small"><b>${t.people.length}</b> people: ${Object.entries(byTitle).map(([k, n]) => `${n} ${k === 'ASM' ? 'Assistant Selling Managers' : k === 'Sales Lead' ? 'Sales Leads' : 'RSAs'}`).join(', ')}. ${t.open.length} open leader seats (skipped).</p>
    <p class="small">Assistant Selling Managers and Sales Leads get a login that shows <b>their own scorecard</b> and lets them <b>coach the rest of their store</b>, one on one and as a team. RSAs get a login that shows only their own card and their store.</p>
    ${t.badStores.length ? `<div class="warnbox"><b>Locations not on the store list:</b> ${t.badStores.map(esc).join(', ')}. Those rows were skipped.</div>` : ''}
    ${gone.length ? `<div class="warnbox"><b>${gone.length} people in the app are not on this roster</b> (left, transferred out of sales, or renamed): ${gone.slice(0, 15).map(d => esc(d.name)).join(', ')}${gone.length > 15 ? '…' : ''}. <label class="check"><input type="checkbox" id="rgone"> Remove them and their logins</label></div>` : ''}
    <label class="check"><input type="checkbox" id="rlog" checked> Set up logins by work email (${newLogins} new, ${loginPlan.length - newLogins} updated${noEmail.length ? `, ${noEmail.length} have no email and are skipped` : ''}). Admin, exec and director logins are never changed.</label>
    <div class="row"><button class="btn primary" id="rgo">Load roster</button><span class="muted small" id="rprog"></span></div>`;
  $('#rgo').onclick = async () => {
    $('#rgo').disabled = true;
    try {
      const old = Object.fromEntries(dir.map(d => [d.cid, d]));
      await S.be.saveDirectory(t.people.map(x => ({ cid: x.cid, name: x.name, store: x.store, title: x.title, email: x.email, aliases: old[x.cid]?.aliases || [] })));
      if ($('#rlog').checked) {
        await S.be.saveUsers(loginPlan.map(x => ({
          email: x.email, name: x.name, title: x.title, cid: x.cid, stores: [x.store],
          role: x.title === 'RSA' ? 'consultant' : 'leader', canUpload: !!uByEmail[x.email]?.canUpload
        })));
      }
      if ($('#rgone')?.checked) {
        for (const d of gone) { await S.be.deleteDirectory(d.cid); const u = users.find(u => u.cid === d.cid && !protectedRoles.includes(u.role)); if (u) await S.be.deleteUser(u.email); }
      }
      await S.be.saveMeta({ lastRoster: { file, at: new Date().toISOString(), people: t.people.length } });
      toast(`Roster loaded: ${t.people.length} people.`); await loadShared(); viewDirectory();
    } catch (e) { $('#rgo').disabled = false; toast('Could not load: ' + e.message, true); }
  };
}

// ---------------------------------------------------------------- logins (admin)
async function viewRoster() {
  const v = $('#view');
  v.innerHTML = `<div class="loading">Loading…</div>`;
  const [users, dir] = await Promise.all([S.be.users(), S.be.directory()]);
  users.sort((a, b) => (a.role + a.name).localeCompare(b.role + b.name));
  const people = dir.filter(d => d.store !== SKIP).sort((a, b) => a.name.localeCompare(b.name));
  const dname = cid => dir.find(d => d.cid === cid)?.name || cid || '';
  const counts = ROLES.map(([r, l]) => `${l}: ${users.filter(u => u.role === r).length}`).join(' · ');
  v.innerHTML = `
  <div class="panel">
    <h2>Add or edit a login</h2>
    <form id="uf" class="formgrid">
      <label>Email<input id="u_em" type="email" required></label>
      <label>Name<input id="u_nm" required></label>
      <label>Role<select id="u_rl">${ROLES.map(([r, l]) => `<option value="${r}">${l}</option>`).join('')}</select></label>
      <label>Stores <small>directors and leaders; comma separated, or * for all</small><input id="u_st" list="storelist" placeholder="Tallahassee, Thomasville"></label>
      <label>Their own scorecard <small>consultants, ASMs and Sales Leads: pick their name</small><input id="u_cn" list="conslist" placeholder="Start typing a name"></label>
      <label class="check"><input type="checkbox" id="u_up"> Can upload files</label>
      <div class="row"><button class="btn primary">Save login</button><button type="button" class="btn" id="u_clear">Clear</button></div>
    </form>
    <datalist id="storelist">${ALL_STORE_NAMES.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
    <datalist id="conslist">${people.map(d => `<option value="${esc(d.name)}">${esc(d.store)}</option>`).join('')}</datalist>
  </div>
  <div class="panel">
    <h2>Bulk load</h2>
    <p>CSV columns <code>email, name, role, stores, consultant, canUpload</code>. Roles: admin, exec, director, leader, consultant. For consultants, <code>consultant</code> is their name exactly as in the RSA report and <code>stores</code> can be blank. Separate multiple stores with a semicolon.</p>
    <div class="row">
      <label class="btn">Upload logins CSV<input type="file" id="rcsv" accept=".csv" hidden></label>
      <button class="btn" id="rtpl">Download consultants without a login</button>
      <button class="btn" id="rexp">Export logins</button>
    </div>
  </div>
  <div class="panel flush">
    <div class="panel-head"><h2>Logins <span class="count">${users.length}</span></h2><span class="muted small">${counts}</span></div>
    <div class="scroller"><table class="grid roster"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Title</th><th>Stores</th><th>Own card</th><th>Upload</th><th></th></tr></thead>
    <tbody>${users.map(u => `<tr><td class="nm">${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(roleLabel(u.role))}</td><td>${esc(u.title || '')}</td><td>${esc((u.stores || []).join(', '))}</td><td>${esc(u.cid ? dname(u.cid) : '')}</td><td>${u.canUpload ? 'Yes' : ''}</td>
      <td class="acts"><button class="link" data-edit="${esc(u.email)}">Edit</button>${u.email === OWNER_EMAIL ? '' : `<button class="link danger" data-del="${esc(u.email)}">Remove</button>`}</td></tr>`).join('')}</tbody></table></div>
  </div>`;
  const fill = u => { $('#u_em').value = u?.email || ''; $('#u_nm').value = u?.name || ''; $('#u_rl').value = u?.role || 'consultant'; $('#u_st').value = (u?.stores || []).join(', '); $('#u_cn').value = u?.cid ? dname(u.cid) : ''; $('#u_up').checked = !!u?.canUpload; };
  fill(null);
  $('#u_clear').onclick = () => fill(null);
  v.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { fill(users.find(u => u.email === b.dataset.edit)); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  v.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Tap again to remove'; return; }
    await S.be.deleteUser(b.dataset.del); toast('Removed.'); viewRoster();
  });
  $('#uf').onsubmit = async e => {
    e.preventDefault();
    const u = cleanUser({ email: $('#u_em').value, name: $('#u_nm').value, role: $('#u_rl').value, stores: $('#u_st').value, consultant: $('#u_cn').value, canUpload: $('#u_up').checked }, dir);
    if (u.error) return toast(u.error, true);
    await S.be.saveUser(u); toast(`Saved ${u.name}.`); viewRoster();
  };
  $('#rcsv').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const rows = parseCsvText(await f.text());
    const good = [], bad = [];
    rows.forEach((r, i) => {
      const o = {}; Object.entries(r).forEach(([k, val]) => o[k.trim().toLowerCase()] = val);
      if (!String(o.email || '').trim()) return;
      const u = cleanUser({ email: o.email, name: o.name, role: o.role, stores: (o.stores || '').replace(/;/g, ','), consultant: o.consultant, canUpload: /^(y|yes|true|1)$/i.test(o.canupload || '') }, dir);
      u.error ? bad.push(`Row ${i + 2}: ${u.error}`) : good.push(u);
    });
    if (bad.length) toast(`${bad.length} rows skipped. First: ${bad[0]}`, true);
    if (good.length) { await S.be.saveUsers(good); toast(`Loaded ${good.length} logins.`); viewRoster(); }
  };
  $('#rtpl').onclick = () => {
    const have = new Set(users.map(u => u.cid).filter(Boolean));
    download('consultant-logins-to-add.csv', ['email,name,role,stores,consultant,canUpload',
      ...people.filter(d => !have.has(d.cid)).map(d => ['', titleName(d.name), 'consultant', '', d.name, ''].map(csvEscape).join(','))].join('\n'));
  };
  $('#rexp').onclick = () => download('logins.csv', ['email,name,role,stores,consultant,canUpload', ...users.map(u => [u.email, u.name, u.role, (u.stores || []).join(';'), u.cid ? dname(u.cid) : '', u.canUpload ? 'yes' : ''].map(csvEscape).join(','))].join('\n'));
}
function cleanUser({ email, name, role, stores, consultant, canUpload }, dir) {
  email = String(email || '').trim().toLowerCase();
  role = String(role || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return { error: `Bad email "${email}"` };
  if (!ROLES.some(r => r[0] === role)) return { error: `Unknown role "${role}" for ${email}` };
  const st = String(stores || '').split(',').map(s => s.trim()).filter(Boolean).map(s => s === '*' ? s : canonicalStore(s));
  if (['director', 'leader'].includes(role) && !st.length) return { error: `${email} needs at least one store` };
  const u = { email, name: String(name || email).trim(), role, stores: ['admin', 'exec'].includes(role) ? ['*'] : st, canUpload: !!canUpload };
  if (role === 'consultant' || (role === 'leader' && consultant)) {
    const cid = cidOf(String(consultant || '').trim());
    const d = dir.find(x => x.cid === cid || (x.aliases || []).includes(cid));
    if (!consultant || !d) return { error: `${email}: "${consultant || ''}" is not on the Consultants list` };
    u.cid = d.cid; u.title = d.title || (role === 'leader' ? 'Sales Lead' : 'RSA');
    if (role === 'consultant' || !u.stores.length) u.stores = [d.store];
  }
  return u;
}

// ---------------------------------------------------------------- markets (market leaders)
// Markets live in config/goals: [{ name, email, stores: [...] }]. A market leader sees their own market;
// admin, exec and directors can pick any market.
function myMarkets() {
  const all = (S.goals?.markets || []).filter(m => m.stores?.length);
  if (!S.user) return [];
  if (['admin', 'exec', 'director'].includes(S.user.role)) return all;
  return all.filter(m => (m.email || '').toLowerCase() === S.user.email);
}
function marketEditor(list) {
  return `<div class="scroller"><table class="grid mkt"><thead><tr><th>Market leader</th><th>Email</th><th>Stores <small>(hold Ctrl or Cmd to pick several)</small></th><th></th></tr></thead><tbody>${list.map((m, i) => `<tr data-mk="${i}">
    <td><input name="mk_name" value="${esc(m.name || '')}" placeholder="Name"></td>
    <td><input name="mk_email" value="${esc(m.email || '')}" placeholder="name@1915south.com"></td>
    <td><select name="mk_stores" multiple size="6">${STORES.map(st => `<option value="${esc(st.name)}" ${(m.stores || []).includes(st.name) ? 'selected' : ''}>${esc(st.name)}</option>`).join('')}</select><small class="muted"> ${(m.stores || []).length} stores</small></td>
    <td><button type="button" class="link danger" data-mkdel="${i}">Remove</button></td></tr>`).join('')}</tbody></table></div>`;
}
function readMarkets() {
  return [...document.querySelectorAll('#mkts tr[data-mk]')].map(tr => ({
    name: tr.querySelector('[name=mk_name]').value.trim(),
    email: tr.querySelector('[name=mk_email]').value.trim().toLowerCase(),
    stores: [...tr.querySelector('[name=mk_stores]').selectedOptions].map(o => o.value)
  })).filter(m => m.name || m.stores.length);
}
document.addEventListener('click', e => {
  const b = e.target.closest?.('[data-mkdel]'); if (!b) return;
  const cur = readMarkets(); cur.splice(Number(b.dataset.mkdel), 1); $('#mkts').innerHTML = marketEditor(cur);
});

async function viewMarket() {
  const v = $('#view');
  const markets = myMarkets();
  if (!S.month || !markets.length) { v.innerHTML = `<div class="panel"><p>No market set up yet.</p></div>`; return; }
  if (!markets.some(m => m.name === S.market)) S.market = (markets.find(m => (m.email || '').toLowerCase() === S.user.email) || markets[0]).name;
  const mk = markets.find(m => m.name === S.market);
  const viewWeek = shownWeek();
  const head = () => `<div class="pickers mpick">${markets.length > 1 ? `<label>Market<select id="pmk">${markets.map(m => `<option ${m.name === S.market ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>` : `<div><p class="eyebrow">Market</p><h2 class="big">${esc(mk.name)}</h2></div>`}</div>` + pickers(true);
  const wire = () => { wirePickers(); const pk = $('#pmk'); if (pk) pk.onchange = () => { S.market = pk.value; viewMarket(); }; };
  v.innerHTML = head() + `<div class="loading">Loading ${esc(mk.name)}…</div>`; wire();
  try {
    const stores = mk.stores;
    const each = (fn) => Promise.all(stores.map(st => fn(st).catch(() => null)));
    const [cards, prev, wkCards, totals, wkTotals, coaching] = await Promise.all([
      each(st => S.be.cardsForStore(S.month, st)), each(st => S.be.cardsForStore(prevMonth(S.month), st)),
      viewWeek ? each(st => S.be.weeklyForStore(viewWeek, st)) : [], each(st => S.be.storeTotal(S.month, st)),
      viewWeek ? each(st => S.be.storeWeek(viewWeek, st)) : [], each(st => S.be.coachingForStore(st))
    ]);
    const flat = a => (a || []).flat().filter(Boolean);
    const mo = flat(cards), pv = flat(prev), wk = flat(wkCards), co = flat(coaching).filter(x => !isTeam(x));
    const prevBy = Object.fromEntries(pv.map(c => [c.cid, c]));
    const hasWk = wk.length > 0;
    const pace = paceFactor(S.meta.asOf?.[S.month]);
    const pct = x => (x === null || x === undefined ? '--' : (x > 0 ? '+' : '') + x + '%');
    // ---- stores
    const srows = stores.map((st, i) => {
      const t = totals[i], w = wkTotals[i] || null;
      const people = mo.filter(c => c.store === st);
      const covered = people.filter(p => { const l = co.filter(x => x.cid === p.cid).sort(byNewest)[0]; return l && daysAgo(l.date) <= 7; }).length;
      const below = people.filter(p => rollFor(p, prevBy[p.cid]).st === 'below').length;
      return { st, t, w, n: people.length, covered, cov: people.length ? covered / people.length : null, below };
    });
    const sk = S.mSort || { key: 'netSalesVb', dir: -1 };
    const sval = { store: r => r.st, netSales: r => r.t?.k?.netSales, netSalesVb: r => r.t?.vsBudget?.netSales, spg: r => r.t?.k?.spg, closeRate: r => r.t?.k?.closeRate, sph: r => r.t?.k?.sph,
      wkNet: r => r.w?.k?.netSales, wkSpg: r => r.w?.k?.spg, n: r => r.n, cov: r => r.cov, below: r => r.below };
    const sorted = (rows, vals, k) => [...rows].sort((a, b) => { const x = vals[k.key](a), y = vals[k.key](b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * k.dir; });
    const th = (key, label, set, cur, num = true) => `<th class="${num ? 'num ' : ''}sortable" data-${set}="${key}">${label}${cur.key === key ? (cur.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
    const SM = Object.fromEntries(STORE_METRICS.map(m => [m.key, m]));
    const stCell = (t, key) => { const m = SM[key]; if (!t?.k) return '<span class="val none">--</span>'; const bud = t.budget?.[key]; const g = goalsFor(S.goals, t.store); return `<span class="val ${status(m, t.k[key], bud ?? g[key] ?? null)}">${fmt(m, t.k[key])}</span>`; };
    const covCls = p => (p === null ? 'none' : p >= 0.9 ? 'green' : p >= 0.6 ? 'amber' : 'red');
    const tot = srows.reduce((a, r) => ({ ns: a.ns + (r.t?.k?.netSales || 0), bud: a.bud + (r.t?.budget?.netSales || 0), n: a.n + r.n, covered: a.covered + r.covered, below: a.below + r.below }), { ns: 0, bud: 0, n: 0, covered: 0, below: 0 });
    // ---- consultants
    const ids = [...new Set([...mo.map(c => c.cid), ...wk.map(c => c.cid)])];
    const people = ids.map(cid => { const m = mo.find(c => c.cid === cid) || null, w = wk.find(c => c.cid === cid) || null; return { cid, m, w, any: m || w, roll: m ? rollFor(m, prevBy[cid]) : null }; });
    const ck = S.mcSort || { key: 'netSales', dir: -1 };
    const basisOf = r => (S.mcBasis === 'week' ? r.w : r.m);
    const cvals = { name: r => titleName(r.any.name), store: r => r.any.store, roll: r => r.roll?.sph, hours: r => basisOf(r)?.hours, ...Object.fromEntries(METRICS.map(m => [m.key, r => basisOf(r)?.k?.[m.key]])) };
    const cell = (m, c, wkly) => { if (!c) return '<span class="val none">--</span>'; const g = goalsFor(S.goals, c.store); return `<span class="val ${status(m, c.k[m.key], g[m.key], wkly ? WEEK_PACE : pace)}">${fmt(m, c.k[m.key])}</span>`; };
    const pair = (m, r) => hasWk ? `<td class="num"><div class="stack"><div>${cell(m, r.w, true)}</div><div class="mo">${cell(m, r.m, false)}</div></div></td>` : `<td class="num">${cell(m, r.m, false)}</td>`;
    v.innerHTML = head() + `
      <div class="panel">
        <div class="tiles rolltiles">
          <div class="tile ${tot.bud ? (tot.ns >= tot.bud ? 'green' : tot.ns >= tot.bud * 0.8 ? 'amber' : 'red') : 'none'}"><div class="tl">Net sales MTD</div><div class="tv">$${Math.round(tot.ns).toLocaleString('en-US')}</div><div class="tg">${tot.bud ? `Budget $${Math.round(tot.bud).toLocaleString('en-US')} (${pct(Math.round((tot.ns / tot.bud - 1) * 1000) / 10)})` : ''}</div></div>
          <div class="tile ${covCls(tot.n ? tot.covered / tot.n : null)}"><div class="tl">1:1s this week</div><div class="tv">${tot.n ? Math.round(tot.covered / tot.n * 100) : 0}%</div><div class="tg">${tot.covered} of ${tot.n} consultants</div></div>
          <div class="tile ${tot.below ? 'red' : 'green'}"><div class="tl">Below minimum</div><div class="tv">${tot.below}</div><div class="tg">consultants under the rolling SPH minimum</div></div>
        </div>
      </div>
      <div class="panel flush">
        <div class="panel-head"><h2>Stores <span class="count">${stores.length}</span></h2><span class="muted small">Tap a column to sort. Tap a store to open it.</span></div>
        <div class="scroller"><table class="grid">
          <thead><tr>${th('store', 'Store', 'ss', sk, false)}${th('netSales', 'Net sales MTD', 'ss', sk)}${th('netSalesVb', 'vs budget', 'ss', sk)}${th('spg', 'SPG w/ canc.', 'ss', sk)}${th('closeRate', 'Close rate', 'ss', sk)}${th('sph', 'SPH', 'ss', sk)}${viewWeek ? th('wkNet', 'Week net sales', 'ss', sk) + th('wkSpg', 'Week SPG', 'ss', sk) : ''}${th('n', 'Consultants', 'ss', sk)}${th('cov', '1:1s this week', 'ss', sk)}${th('below', 'Below min', 'ss', sk)}</tr></thead>
          <tbody>${sorted(srows, sval, sk).map(r => `<tr data-store="${esc(r.st)}"><td class="nm">${esc(r.st)}</td>
            <td class="num">${stCell(r.t, 'netSales')}</td><td class="num">${pct(r.t?.vsBudget?.netSales)}</td><td class="num">${stCell(r.t, 'spg')}</td><td class="num">${stCell(r.t, 'closeRate')}</td><td class="num">${stCell(r.t, 'sph')}</td>
            ${viewWeek ? `<td class="num">${stCell(r.w, 'netSales')}</td><td class="num">${stCell(r.w, 'spg')}</td>` : ''}
            <td class="num">${r.n}</td><td class="num"><span class="val ${covCls(r.cov)}">${r.cov === null ? '--' : Math.round(r.cov * 100) + '%'}</span><small class="muted"> ${r.covered}/${r.n}</small></td>
            <td class="num">${r.below ? `<span class="val red">${r.below}</span>` : '0'}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="panel flush">
        <div class="panel-head"><h2>Consultants in ${esc(mk.name)} <span class="count">${people.length}</span></h2>
          <span class="muted small">${hasWk ? `Week on top, month to date below. Sort on <button class="chip ${S.mcBasis !== 'week' ? 'on' : ''}" data-basis="mtd">MTD</button> <button class="chip ${S.mcBasis === 'week' ? 'on' : ''}" data-basis="week">Week</button> ` : ''}Tap a column to sort, a name to open their card.</span></div>
        <div class="scroller"><table class="grid">
          <thead><tr>${th('name', 'Consultant', 'cs', ck, false)}${th('store', 'Store', 'cs', ck, false)}${th('roll', 'Rolling SPH', 'cs', ck)}${th('hours', 'Hours', 'cs', ck)}${METRICS.map(m => th(m.key, esc(m.label), 'cs', ck)).join('')}</tr></thead>
          <tbody>${sorted(people, cvals, ck).map(r => `<tr data-id="${esc(r.cid)}" data-st="${esc(r.any.store)}"><td class="nm">${esc(titleName(r.any.name))}${r.any.title && r.any.title !== 'RSA' ? `<small>${esc(r.any.title)}</small>` : ''}</td><td>${esc(r.any.store)}</td>${rollCell(r.roll)}
            <td class="num">${hasWk ? `<div class="stack"><div>${r.w ? Math.round(r.w.hours) : '--'}</div><div class="mo">${r.m ? Math.round(r.m.hours) : '--'}</div></div>` : (r.m ? Math.round(r.m.hours) : '--')}</td>${METRICS.map(m => pair(m, r)).join('')}</tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    wire();
    v.querySelectorAll('[data-ss]').forEach(h => h.onclick = () => { const k = h.dataset.ss; S.mSort = { key: k, dir: sk.key === k ? -sk.dir : (k === 'store' ? 1 : -1) }; viewMarket(); });
    v.querySelectorAll('[data-cs]').forEach(h => h.onclick = () => { const k = h.dataset.cs; const lowFirst = ['name', 'store'].includes(k) || metricBy(k)?.lower; S.mcSort = { key: k, dir: ck.key === k ? -ck.dir : (lowFirst ? 1 : -1) }; viewMarket(); });
    v.querySelectorAll('[data-basis]').forEach(b => b.onclick = () => { S.mcBasis = b.dataset.basis; viewMarket(); });
    v.querySelectorAll('tr[data-store]').forEach(tr => tr.onclick = () => { S.store = tr.dataset.store; S.tab = 'cards'; S.selected = null; renderShell(); });
    v.querySelectorAll('tbody tr[data-id]').forEach(tr => tr.onclick = () => { S.store = tr.dataset.st; S.tab = 'cards'; S.selected = tr.dataset.id; S.jump = true; renderShell(); });
  } catch (e) { v.innerHTML = head() + `<div class="panel"><p class="err">Could not load the market: ${esc(e.message)}</p></div>`; wire(); }
}

// ---------------------------------------------------------------- goals (admin)
function viewGoals() {
  const g = S.goals;
  const outlet = g.outlet || {};
  const set = new Set(g.outletStores || []);
  const rows = [...METRICS, ...STORE_METRICS.filter(m => ['appsToTraffic', 'protectionAttach'].includes(m.key))];
  $('#view').innerHTML = `
  <form class="panel" id="gf">
    <h2>Goals</h2>
    <p class="muted small">Green at or better than goal, amber within 20 percent, red beyond that. Cancellation % and Discount % are better when lower. Net Sales and Credit Apps are monthly, so they are compared to the share of the month that has passed. Store Net Sales, SPG, Close Rate and Traffic use each store's budget from the daily report.</p>
    <div class="scroller"><table class="grid goals"><thead><tr><th>Metric</th><th>Where</th><th class="num">Standard</th><th class="num">Outlet</th></tr></thead>
    <tbody>${rows.map(m => `<tr><td class="nm">${esc(m.label)}</td><td class="small">${METRICS.includes(m) ? 'Consultant' + (STORE_METRICS.some(s => s.key === m.key) ? ' and store' : '') + (m.derived ? ` (${esc(m.derived)})` : '') : 'Store only'}</td>
      <td class="num"><input type="number" step="any" name="s_${m.key}" value="${g.standard[m.key] ?? ''}"></td>
      <td class="num"><input type="number" step="any" name="o_${m.key}" value="${outlet[m.key] ?? ''}" placeholder="same"></td></tr>`).join('')}</tbody></table></div>
    <h3>Minimum standard</h3>
    <p class="muted small">Rolling sales per hour is last month plus this month to date. Consultants below it are flagged on their card, in the store list, and in the 1:1. Within 10 percent above it shows as a warning.</p>
    <div class="formgrid">
      <label>Standard stores ($ SPH)<input type="number" name="minSph" value="${g.minSph ?? 250}"></label>
      <label>Outlets ($ SPH)<input type="number" name="outletMinSph" value="${g.outletMinSph ?? 150}"></label>
    </div>
    <h3>Outlet stores</h3>
    <p class="muted small">Checked stores use the Outlet column and the outlet minimum. Blank outlet cells fall back to standard.</p>
    <div class="checks">${STORES.map(st => `<label class="check"><input type="checkbox" name="os" value="${esc(st.name)}" ${set.has(st.name) ? 'checked' : ''}> ${esc(st.name)}</label>`).join('')}</div>
    <h3>Markets</h3>
    <p class="muted small">Each market leader's stores. This drives the Market tab: a market leader sees their market there, and directors, exec and admin can pick any market. It does not change who can see which stores (that is on the Logins tab).</p>
    <div id="mkts">${marketEditor(g.markets || [])}</div>
    <div class="row"><button type="button" class="btn tiny" id="mkadd">Add a market</button></div>
    <div class="row"><button class="btn primary">Save goals and markets</button></div>
  </form>`;
  $('#mkadd').onclick = () => { const cur = readMarkets(); cur.push({ name: '', email: '', stores: [] }); $('#mkts').innerHTML = marketEditor(cur); };
  $('#gf').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const standard = {}, o = {};
    rows.forEach(m => {
      const s = fd.get('s_' + m.key), ov = fd.get('o_' + m.key);
      standard[m.key] = s === '' ? null : Number(s);
      if (ov !== '' && ov !== null) o[m.key] = Number(ov);
    });
    const goals = { standard, outlet: Object.keys(o).length ? o : null, outletStores: fd.getAll('os'), markets: readMarkets(),
      minSph: Number(fd.get('minSph')) || 250, outletMinSph: Number(fd.get('outletMinSph')) || 150 };
    await S.be.saveGoals(goals); await loadShared(); toast('Goals saved.');
  };
}

// ---------------------------------------------------------------- demo role switcher
if (DEMO) {
  window.addEventListener('DOMContentLoaded', () => {
    const sel = $('#demoRole');
    sel.onchange = async () => { S.be.switchUser(sel.value); S.user = await S.be.profile(); S.tab = 'cards'; S.selected = null; await loadShared(); renderShell(); };
  });
}
window.addEventListener('DOMContentLoaded', boot);
