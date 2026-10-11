// פונקציית שרת שרצה אוטומטית ב-1 בכל חודש (Vercel Cron):
// 1. סוגרת דוח לחודש שהסתיים לכל משתמש מאושר ושומרת אותו בארכיון הדוחות.
// 2. ב-1 בינואר סוגרת גם דוח שנתי.
// 3. שולחת מייל סיכום למי שלא כיבה את האפשרות בפרופיל.
// משתני סביבה נדרשים: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, CRON_SECRET (אופציונלי: RESEND_FROM, SITE_URL)

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const TZ = 'Asia/Jerusalem';

const esc = (s) => String(s == null ? '' : s).slice(0, 200)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('he-IL');

// חודש ושנה לפי שעון ישראל
function israelParts(date) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t) => parseInt(p.find(x => x.type === t).value, 10);
  return { y: get('year'), m: get('month') - 1 };
}

module.exports = async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const CRON_SECRET = process.env.CRON_SECRET;
  const SITE_URL = process.env.SITE_URL || 'https://familycent.vercel.app';

  if (!SUPABASE_URL || !SERVICE_KEY || !CRON_SECRET) {
    return res.status(500).json({ error: 'חסרים משתני סביבה (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET)' });
  }
  if ((req.headers.authorization || '') !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  // החודש שהסתיים (לפי שעון ישראל). אפשר לבקש חודש אחר לבדיקה: ?month=9&year=2026 (month מ-1 עד 12)
  const nowIl = israelParts(new Date());
  let tMonth = nowIl.m - 1, tYear = nowIl.y;
  if (tMonth < 0) { tMonth = 11; tYear--; }
  if (req.query && req.query.month && req.query.year) {
    tMonth = parseInt(req.query.month, 10) - 1; tYear = parseInt(req.query.year, 10);
    if (!(tMonth >= 0 && tMonth <= 11) || !(tYear > 2000 && tYear < 2200)) return res.status(400).json({ error: 'month/year לא תקינים' });
  }

  async function getAll(path) {
    const rows = [];
    for (let from = 0; from < 200000; from += 1000) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { ...H, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
      const page = await r.json();
      if (!Array.isArray(page)) throw new Error('קריאה מ-Supabase נכשלה');
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return rows;
  }

  function summarize(txs) {
    let income = 0, expense = 0; const breakdown = {};
    txs.forEach(t => {
      const amt = parseFloat(t.amount) || 0;
      if (t.action_type && t.action_type.includes('הוצאה')) {
        expense += amt; const c = t.category || 'כללי'; breakdown[c] = (breakdown[c] || 0) + amt;
      } else income += amt;
    });
    return { income, expense, breakdown };
  }

  const snapshot = (txs) => txs.map(t => ({
    id: t.id, actionType: t.action_type, amount: t.amount, description: t.description,
    category: t.category, notes: t.notes, timestamp: t.occurred_at, cardId: t.card_id || null
  }));

  async function saveReport(userId, type, month, year, name, txs) {
    const ex = await fetch(`${SUPABASE_URL}/rest/v1/reports?user_id=eq.${userId}&report_type=eq.${type}&target_month=eq.${month}&target_year=eq.${year}&select=id`, { headers: H });
    const exRows = await ex.json();
    if (Array.isArray(exRows) && exRows.length > 0) return false;
    const s = summarize(txs);
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/reports`, {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: userId, report_name: name, report_type: type, target_month: month, target_year: year,
        total_income: s.income, total_expense: s.expense, neto: s.income - s.expense,
        breakdown: s.breakdown, transactions_snapshot: snapshot(txs)
      })
    });
    if (!ins.ok) throw new Error('שמירת דוח נכשלה: ' + (await ins.text()));
    return true;
  }

  async function sendMail(to, subject, html) {
    if (!RESEND_KEY) return false;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: process.env.RESEND_FROM || 'FamilyCent <onboarding@resend.dev>', to: [to], subject, html })
    });
    if (!r.ok) console.error('Resend error for', to, await r.text());
    return r.ok;
  }

  function buildHtml(profile, s, monthName, year) {
    const cur = esc(profile.currency || '₪');
    const balance = s.income - s.expense;
    const top = Object.entries(s.breakdown).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const rows = top.map(([c, v]) => `<tr><td style="padding:6px 0;color:#334155">${esc(c)}</td><td style="padding:6px 0;text-align:left;font-weight:700">${fmt(v)} ${cur}</td></tr>`).join('');
    return `<div dir="rtl" style="font-family:Arial,sans-serif;background:#f1f5f9;padding:24px">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
        <div style="background:#4f46e5;color:#fff;padding:22px 26px"><div style="font-size:20px;font-weight:800">FamilyCent</div>
          <div style="font-size:15px;margin-top:4px">סיכום חודש ${monthName} ${year}</div></div>
        <div style="padding:22px 26px;font-size:14px;color:#334155;line-height:1.7">
          <p>שלום ${esc(profile.family_name || '')},<br>הנה הסיכום הכספי של החודש שהסתיים:</p>
          <table style="width:100%;border-collapse:collapse;margin:10px 0">
            <tr><td style="padding:6px 0">סך הכנסות</td><td style="text-align:left;font-weight:700;color:#059669">${fmt(s.income)} ${cur}</td></tr>
            <tr><td style="padding:6px 0">סך הוצאות</td><td style="text-align:left;font-weight:700;color:#e11d48">${fmt(s.expense)} ${cur}</td></tr>
            <tr style="border-top:1px solid #e2e8f0"><td style="padding:8px 0;font-weight:700">יתרה</td><td style="text-align:left;font-weight:800;color:${balance >= 0 ? '#059669' : '#e11d48'}">${fmt(balance)} ${cur}</td></tr>
          </table>
          ${rows ? `<div style="font-weight:700;margin-top:14px">ההוצאות הגדולות לפי קטגוריה</div><table style="width:100%;border-collapse:collapse">${rows}</table>` : ''}
          <div style="text-align:center;margin-top:22px"><a href="${esc(SITE_URL)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:700;padding:11px 26px;border-radius:10px;display:inline-block">לדוח המלא באתר</a></div>
        </div>
        <div style="background:#f8fafc;padding:12px;text-align:center;color:#94a3b8;font-size:11px">נשלח אוטומטית מ-FamilyCent. אפשר לכבות את המייל בהגדרות הפרופיל.</div>
      </div></div>`;
  }

  try {
    const profiles = await getAll('profiles?select=id,email,family_name,currency,monthly_report_enabled,is_approved');
    const result = { month: tMonth + 1, year: tYear, users: 0, reportsCreated: 0, yearReports: 0, emailsSent: 0, emailsFailed: 0, errors: [] };

    for (const p of profiles) {
      if (p.is_approved === false) continue;
      try {
        // כל התנועות באזור החודש (עם שוליים), ואז מסננים לפי חודש בשעון ישראל
        const lo = new Date(Date.UTC(tYear, tMonth, 1) - 36 * 3600 * 1000).toISOString();
        const hi = new Date(Date.UTC(tYear, tMonth + 1, 1) + 36 * 3600 * 1000).toISOString();
        const near = await getAll(`transactions?user_id=eq.${p.id}&occurred_at=gte.${lo}&occurred_at=lt.${hi}&select=*&order=occurred_at.asc,id.asc`);
        const txs = near.filter(t => { const d = israelParts(new Date(t.occurred_at)); return d.m === tMonth && d.y === tYear; });
        if (txs.length === 0) continue;
        result.users++;

        const name = `דוח סגור חודש ${MONTHS[tMonth]} ${tYear}`;
        if (await saveReport(p.id, 'month', tMonth, tYear, name, txs)) result.reportsCreated++;

        if (tMonth === 11) {
          const yLo = new Date(Date.UTC(tYear, 0, 1) - 36 * 3600 * 1000).toISOString();
          const yHi = new Date(Date.UTC(tYear + 1, 0, 1) + 36 * 3600 * 1000).toISOString();
          const yNear = await getAll(`transactions?user_id=eq.${p.id}&occurred_at=gte.${yLo}&occurred_at=lt.${yHi}&select=*&order=occurred_at.asc,id.asc`);
          const yTxs = yNear.filter(t => israelParts(new Date(t.occurred_at)).y === tYear);
          if (yTxs.length && await saveReport(p.id, 'year', 0, tYear, `דוח סיכום שנתי כולל ${tYear}`, yTxs)) result.yearReports++;
        }

        if (p.monthly_report_enabled !== false && p.email) {
          const ok = await sendMail(p.email, `FamilyCent - סיכום חודש ${MONTHS[tMonth]} ${tYear}`, buildHtml(p, summarize(txs), MONTHS[tMonth], tYear));
          if (ok) result.emailsSent++; else result.emailsFailed++;
          await sleep(650); // מגבלת קצב של Resend
        }
      } catch (e) {
        console.error('monthly-report user error', p.id, e.message);
        result.errors.push(String(p.id).slice(0, 8) + ': ' + e.message.slice(0, 120));
      }
    }
    return res.status(200).json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'הרצת הדוח החודשי נכשלה: ' + e.message });
  }
};
