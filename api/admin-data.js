// פונקציית שרת מאובטחת לפאנל המנהל.
// גישת צפייה: מותרת לבעל האפליקציה (לפי משתנה הסביבה ADMIN_EMAIL) וגם לכל משתמש שסומן כ-is_admin=true בפרופיל שלו.
// מינוי/ביטול מנהלים אחרים: מותר אך ורק לבעל האפליקציה (ADMIN_EMAIL) - כדי שמנהל משני לא יוכל למנות מנהלים נוספים בעצמו.
module.exports = async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();

  if (!SUPABASE_URL || !SERVICE_KEY || !ADMIN_EMAIL) {
    return res.status(500).json({ error: 'חסרים משתני סביבה (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ADMIN_EMAIL)' });
  }

  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!accessToken) return res.status(401).json({ error: 'לא מחוברים' });

  const sbHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const SITE_URL = process.env.SITE_URL || 'https://familycent.vercel.app';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const esc = (s) => String(s || '').slice(0, 300).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function wrapAdminEmailHtml(title, subtitle, innerHtml) {
    return `
    <div dir="rtl" style="font-family: Arial, Helvetica, sans-serif; background:#f1f5f9; padding:24px; direction:rtl;">
      <div style="max-width:640px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.06);">
        <div style="background:linear-gradient(90deg,#4f46e5,#6366f1); padding:24px 28px; color:#ffffff;">
          <div style="font-size:22px; font-weight:800;">💰 FamilyCent</div>
          <div style="font-size:16px; font-weight:700; margin-top:6px;">${title}</div>
          ${subtitle ? `<div style="font-size:13px; opacity:.9; margin-top:2px;">${subtitle}</div>` : ''}
        </div>
        <div style="padding:24px 28px;">${innerHtml}</div>
        <div style="background:#f8fafc; padding:14px 28px; text-align:center; color:#94a3b8; font-size:11px;">
          נשלח אוטומטית מאפליקציית FamilyCent
        </div>
      </div>
    </div>`;
  }

  async function sendPlainEmail(to, subject, text, html) {
    if (!RESEND_KEY) { console.error('RESEND_API_KEY חסר - לא ניתן לשלוח מייל'); return; }
    try {
      const payload = { from: process.env.RESEND_FROM || 'FamilyCent <onboarding@resend.dev>', to: [to], subject, text };
      if (html) payload.html = html;
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify(payload)
      });
      if (!r.ok) console.error('Resend החזיר שגיאה בשליחת מייל ל-' + to + ':', await r.text());
    } catch (err) {
      console.error('שליחת מייל נכשלה:', err);
    }
  }

  try {
    // מאמתים מול Supabase Auth מי בעל טוקן ההתחברות הזה
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'טוקן התחברות לא תקין' });
    const userData = await userRes.json();
    const callerEmail = (userData.email || '').toLowerCase().trim();
    const isOwner = callerEmail === ADMIN_EMAIL;

    let callerIsAdmin = isOwner;
    if (!isOwner) {
      const callerProfileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userData.id}&select=is_admin`, { headers: sbHeaders });
      const callerProfileRows = await callerProfileRes.json();
      callerIsAdmin = Array.isArray(callerProfileRows) && callerProfileRows[0] && callerProfileRows[0].is_admin === true;
    }

    if (!callerIsAdmin) {
      return res.status(403).json({ error: 'אין לך הרשאות גישה לפאנל המנהל' });
    }

    const mode = req.query.mode || 'overview';

    if (mode === 'overview') {
      const profilesRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,email,family_name,phone,currency,created_at,is_admin,is_approved`, { headers: sbHeaders });
      const profiles = await profilesRes.json();
      if (!Array.isArray(profiles)) throw new Error('לא הצלחנו לקרוא את רשימת המשתמשים');

      const results = await Promise.all(profiles.map(async (p) => {
        // קוראים את כל התנועות בדפים של 1000 (ברירת המחדל של Supabase מגבילה ל-1000 בבקשה אחת)
        const txs = [];
        for (let from = 0; from < 100000; from += 1000) {
          const txRes = await fetch(
            `${SUPABASE_URL}/rest/v1/transactions?user_id=eq.${p.id}&select=amount,action_type,occurred_at&order=occurred_at.desc,id.asc`,
            { headers: { ...sbHeaders, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } }
          );
          const page = await txRes.json();
          if (!Array.isArray(page)) break;
          txs.push(...page);
          if (page.length < 1000) break;
        }
        let totalIncome = 0, totalExpense = 0;
        (Array.isArray(txs) ? txs : []).forEach(t => {
          const amt = parseFloat(t.amount) || 0;
          if (t.action_type && t.action_type.includes('הוצאה')) totalExpense += amt; else totalIncome += amt;
        });
        return {
          id: p.id, email: p.email, familyName: p.family_name, phone: p.phone,
          currency: p.currency || '₪', createdAt: p.created_at,
          isAdmin: p.is_admin === true, isOwner: (p.email || '').toLowerCase().trim() === ADMIN_EMAIL,
          isApproved: p.is_approved !== false,
          transactionCount: Array.isArray(txs) ? txs.length : 0,
          totalIncome, totalExpense,
          lastActivity: (Array.isArray(txs) && txs[0]) ? txs[0].occurred_at : null
        };
      }));

      return res.status(200).json({ users: results, callerIsOwner: isOwner });
    }

    if (mode === 'reports') {
      const userId = req.query.userId;
      if (!userId || !UUID_RE.test(String(userId))) return res.status(400).json({ error: 'userId לא תקין' });
      const repRes = await fetch(`${SUPABASE_URL}/rest/v1/reports?user_id=eq.${userId}&select=*&order=created_at.desc`, { headers: sbHeaders });
      const reports = await repRes.json();
      return res.status(200).json({ reports });
    }

    if (mode === 'toggleAdmin') {
      // רק בעל האפליקציה (ADMIN_EMAIL) רשאי למנות/לבטל מנהלים אחרים - לא מנהל משני
      if (!isOwner) return res.status(403).json({ error: 'רק בעל האפליקציה יכול למנות או לבטל מנהלים' });
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });

      const { targetUserId, makeAdmin } = req.body || {};
      if (!targetUserId || !UUID_RE.test(String(targetUserId))) return res.status(400).json({ error: 'targetUserId לא תקין' });

      const targetRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${targetUserId}&select=email`, { headers: sbHeaders });
      const targetRows = await targetRes.json();
      const targetEmail = (Array.isArray(targetRows) && targetRows[0] && targetRows[0].email || '').toLowerCase().trim();
      if (targetEmail === ADMIN_EMAIL) {
        return res.status(400).json({ error: 'אי אפשר לשנות את סטטוס המנהל של בעל האפליקציה עצמו' });
      }

      const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${targetUserId}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({ is_admin: !!makeAdmin })
      });
      if (!updateRes.ok) {
        const errText = await updateRes.text();
        return res.status(500).json({ error: 'עדכון הרשאות נכשל' });
      }
      return res.status(200).json({ success: true });
    }

    if (mode === 'approveUser') {
      // כל מנהל (בעלים או משני) יכול לאשר משתמש חדש - זו פעולה עם סיכון נמוך יחסית
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });
      const { targetUserId } = req.body || {};
      if (!targetUserId || !UUID_RE.test(String(targetUserId))) return res.status(400).json({ error: 'targetUserId לא תקין' });

      const targetRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${targetUserId}&select=email,family_name`, { headers: sbHeaders });
      const targetRows = await targetRes.json();
      const target = Array.isArray(targetRows) && targetRows[0];

      const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${targetUserId}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({ is_approved: true })
      });
      if (!updateRes.ok) {
        const errText = await updateRes.text();
        return res.status(500).json({ error: 'אישור המשתמש נכשל' });
      }

      if (target && target.email) {
        const approveInner = `
          <p style="font-size:14px; color:#334155; line-height:1.7;">שלום${target.family_name ? ' ' + esc(target.family_name) : ''},</p>
          <p style="font-size:14px; color:#334155; line-height:1.7;">ההרשמה שלכם ל-FamilyCent <b style="color:#059669;">אושרה</b>! אתם יכולים להתחבר עכשיו ולהתחיל להשתמש באפליקציה.</p>
          <div style="text-align:center; margin-top:24px;">
            <a href="${SITE_URL}" style="display:inline-block; background:#059669; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:12px 28px; border-radius:10px;">כניסה לאפליקציה 🎉</a>
          </div>`;
        await sendPlainEmail(
          target.email,
          'FamilyCent - ההרשמה שלכם אושרה! 🎉',
          `שלום${target.family_name ? ' ' + target.family_name : ''},\n\nההרשמה שלכם ל-FamilyCent אושרה! אתם יכולים להתחבר עכשיו ולהתחיל להשתמש באפליקציה.\n\nכניסה: ${SITE_URL}\n\nבברכה,\nצוות FamilyCent`,
          wrapAdminEmailHtml('ההרשמה שלכם אושרה! 🎉', null, approveInner)
        );
      }
      return res.status(200).json({ success: true });
    }

    if (mode === 'rejectUser') {
      // כל מנהל (בעלים או משני) יכול לדחות בקשת הרשמה ממתינה
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });
      const { targetUserId, reason } = req.body || {};
      if (!targetUserId || !UUID_RE.test(String(targetUserId))) return res.status(400).json({ error: 'targetUserId לא תקין' });

      const targetRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${targetUserId}&select=email,family_name,is_approved,is_admin`, { headers: sbHeaders });
      const targetRows = await targetRes.json();
      const target = Array.isArray(targetRows) && targetRows[0];
      if (!target) return res.status(404).json({ error: 'המשתמש לא נמצא' });
      const targetEmail = (target.email || '').toLowerCase().trim();
      if (targetEmail === ADMIN_EMAIL) {
        return res.status(400).json({ error: 'אי אפשר לדחות את חשבון בעל האפליקציה עצמו' });
      }
      // דחייה מוחקת את החשבון, לכן מותרת רק על בקשת הרשמה שעדיין ממתינה (לא על משתמש מאושר או מנהל)
      if (target.is_approved !== false || target.is_admin === true) {
        return res.status(400).json({ error: 'אפשר לדחות רק בקשת הרשמה שעדיין ממתינה לאישור' });
      }

      if (target && target.email) {
        const reasonLine = reason ? `\n\nסיבה: ${reason}` : '';
        const reasonHtml = reason ? `<div style="background:#fff1f2; border-radius:10px; padding:12px 14px; font-size:13px; color:#be123c; margin-top:10px;"><b>סיבה:</b> ${esc(reason)}</div>` : '';
        const rejectInner = `
          <p style="font-size:14px; color:#334155; line-height:1.7;">שלום${target.family_name ? ' ' + esc(target.family_name) : ''},</p>
          <p style="font-size:14px; color:#334155; line-height:1.7;">לצערנו בקשת ההרשמה שלכם ל-FamilyCent <b style="color:#e11d48;">לא אושרה</b>.</p>
          ${reasonHtml}`;
        await sendPlainEmail(
          target.email,
          'FamilyCent - עדכון לגבי בקשת ההרשמה שלכם',
          `שלום${target.family_name ? ' ' + target.family_name : ''},\n\nלצערנו בקשת ההרשמה שלכם ל-FamilyCent לא אושרה.${reasonLine}\n\nבברכה,\nצוות FamilyCent`,
          wrapAdminEmailHtml('עדכון לגבי בקשת ההרשמה', null, rejectInner)
        );
      }

      // מוחקים את החשבון (הוא ממילא עדיין לא היה בשימוש בפועל, כי הוא לא היה מאושר)
      const deleteRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${targetUserId}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      if (!deleteRes.ok) {
        const errText = await deleteRes.text();
        return res.status(500).json({ error: 'דחיית המשתמש נכשלה' });
      }
      return res.status(200).json({ success: true });
    }

    if (mode === 'deleteUser') {
      // מחיקת משתמש היא פעולה בלתי הפיכה - מותרת רק לבעל האפליקציה
      if (!isOwner) return res.status(403).json({ error: 'רק בעל האפליקציה יכול למחוק משתמשים' });
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });

      const { targetUserId } = req.body || {};
      if (!targetUserId || !UUID_RE.test(String(targetUserId))) return res.status(400).json({ error: 'targetUserId לא תקין' });

      const targetRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${targetUserId}&select=email`, { headers: sbHeaders });
      const targetRows = await targetRes.json();
      const targetEmail = (Array.isArray(targetRows) && targetRows[0] && targetRows[0].email || '').toLowerCase().trim();
      if (targetEmail === ADMIN_EMAIL) {
        return res.status(400).json({ error: 'אי אפשר למחוק את חשבון בעל האפליקציה עצמו' });
      }

      // מוחקים מ-Supabase Auth - זה מוחק בשרשור (cascade) גם את הפרופיל וכל הנתונים המשויכים אליו (תנועות, דוחות, תקציבים וכו')
      const deleteRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${targetUserId}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      if (!deleteRes.ok) {
        const errText = await deleteRes.text();
        return res.status(500).json({ error: 'מחיקת המשתמש נכשלה' });
      }
      return res.status(200).json({ success: true });
    }

    const BACKUP_TABLES = ['credit_cards', 'categories', 'budgets', 'goals', 'recurring', 'reports', 'transactions'];

    async function getAllRows(path) {
      const rows = [];
      for (let from = 0; from < 200000; from += 1000) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { ...sbHeaders, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
        const page = await r.json();
        if (!Array.isArray(page)) throw new Error('קריאה מהמסד נכשלה');
        rows.push(...page);
        if (page.length < 1000) break;
      }
      return rows;
    }

    if (mode === 'backups') {
      const userId = req.query.userId;
      if (!userId || !UUID_RE.test(String(userId))) return res.status(400).json({ error: 'userId לא תקין' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/backups?user_id=eq.${userId}&select=id,created_at,reason,data&order=created_at.desc&limit=10`, { headers: sbHeaders });
      const rows = await r.json();
      if (!Array.isArray(rows)) return res.status(500).json({ error: 'לא ניתן לקרוא גיבויים. ודאו שטבלת הגיבויים נוצרה.' });
      const backups = rows.map(b => {
        const counts = {};
        BACKUP_TABLES.forEach(tb => { counts[tb] = Array.isArray(b.data && b.data[tb]) ? b.data[tb].length : 0; });
        return { id: b.id, created_at: b.created_at, reason: b.reason, counts };
      });
      return res.status(200).json({ backups });
    }

    async function markRequest(id, status) {
      await fetch(`${SUPABASE_URL}/rest/v1/data_requests?id=eq.${id}`, {
        method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ status, handled_at: new Date().toISOString() })
      });
    }

    if (mode === 'pending') {
      // קריאה קלה לחלון ההתראות של המנהל: משתמשים שממתינים לאישור + בקשות איפוס/שחזור פתוחות
      const [uRes, rRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/profiles?is_approved=eq.false&select=id,email,family_name,created_at&order=created_at.asc`, { headers: sbHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/data_requests?status=eq.pending&select=id,user_id,type,note,created_at&order=created_at.asc`, { headers: sbHeaders })
      ]);
      const users = await uRes.json();
      const reqRows = await rRes.json();
      const reqs = Array.isArray(reqRows) ? reqRows : [];
      const ids = [...new Set(reqs.map(x => x.user_id))].filter(id => UUID_RE.test(String(id)));
      const profMap = {};
      if (ids.length) {
        const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=in.(${ids.join(',')})&select=id,email,family_name`, { headers: sbHeaders });
        const pRows = await pr.json();
        if (Array.isArray(pRows)) pRows.forEach(p => { profMap[p.id] = p; });
      }
      return res.status(200).json({
        users: Array.isArray(users) ? users.map(u => ({ id: u.id, email: u.email, familyName: u.family_name, createdAt: u.created_at })) : [],
        requests: reqs.map(x => ({ id: x.id, type: x.type, note: x.note, createdAt: x.created_at, email: (profMap[x.user_id] || {}).email || '', familyName: (profMap[x.user_id] || {}).family_name || '' }))
      });
    }

    if (mode === 'requests') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/data_requests?status=eq.pending&select=id,user_id,type,keep_reports,note,created_at&order=created_at.asc`, { headers: sbHeaders });
      const rows = await r.json();
      if (!Array.isArray(rows)) return res.status(500).json({ error: 'לא ניתן לקרוא בקשות. ודאו שטבלת הבקשות נוצרה.' });
      const ids = [...new Set(rows.map(x => x.user_id))].filter(id => UUID_RE.test(String(id)));
      let profMap = {};
      if (ids.length) {
        const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=in.(${ids.join(',')})&select=id,email,family_name`, { headers: sbHeaders });
        const pRows = await pr.json();
        if (Array.isArray(pRows)) pRows.forEach(p => { profMap[p.id] = p; });
      }
      return res.status(200).json({ requests: rows.map(x => ({ ...x, email: (profMap[x.user_id] || {}).email || '', familyName: (profMap[x.user_id] || {}).family_name || '' })) });
    }

    if (mode === 'rejectRequest') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });
      const { requestId } = req.body || {};
      if (!requestId || !UUID_RE.test(String(requestId))) return res.status(400).json({ error: 'requestId לא תקין' });
      await markRequest(requestId, 'rejected');
      return res.status(200).json({ success: true });
    }

    if (mode === 'approveReset') {
      // איפוס מתבצע רק על בסיס בקשה פתוחה של המשתמש עצמו, ואחרי גיבוי אוטומטי
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });
      const { requestId } = req.body || {};
      if (!requestId || !UUID_RE.test(String(requestId))) return res.status(400).json({ error: 'requestId לא תקין' });
      const rr = await fetch(`${SUPABASE_URL}/rest/v1/data_requests?id=eq.${requestId}&status=eq.pending&type=eq.reset&select=user_id,keep_reports`, { headers: sbHeaders });
      const rrRows = await rr.json();
      const reqRow = Array.isArray(rrRows) && rrRows[0];
      if (!reqRow) return res.status(404).json({ error: 'בקשת האיפוס לא נמצאה או שכבר טופלה' });
      const uid = reqRow.user_id;
      if (!UUID_RE.test(String(uid))) return res.status(400).json({ error: 'משתמש לא תקין' });

      const snap = {};
      for (const tb of BACKUP_TABLES) snap[tb] = await getAllRows(`${tb}?user_id=eq.${uid}&select=*`);
      const sv = await fetch(`${SUPABASE_URL}/rest/v1/backups`, {
        method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: uid, reason: 'reset', data: snap })
      });
      if (!sv.ok) return res.status(500).json({ error: 'לא ניתן ליצור גיבוי, ולכן האיפוס בוטל.' });

      const toDelete = ['transactions', 'recurring', 'budgets', 'goals', 'categories', 'credit_cards'];
      if (reqRow.keep_reports === false) toDelete.push('reports');
      for (const tb of toDelete) {
        const d = await fetch(`${SUPABASE_URL}/rest/v1/${tb}?user_id=eq.${uid}`, { method: 'DELETE', headers: sbHeaders });
        if (!d.ok) { console.error('reset delete failed', tb, await d.text()); return res.status(500).json({ error: 'האיפוס נכשל באמצע. הגיבוי נשמר ואפשר לשחזר ממנו.' }); }
      }
      await markRequest(requestId, 'done');
      return res.status(200).json({ success: true });
    }

    if (mode === 'restoreUser') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });
      const { targetUserId, backupId, requestId } = req.body || {};
      if (!targetUserId || !UUID_RE.test(String(targetUserId))) return res.status(400).json({ error: 'targetUserId לא תקין' });
      if (!backupId || !UUID_RE.test(String(backupId))) return res.status(400).json({ error: 'backupId לא תקין' });

      // הגיבוי חייב להיות שייך לאותו משתמש בדיוק
      const bRes = await fetch(`${SUPABASE_URL}/rest/v1/backups?id=eq.${backupId}&user_id=eq.${targetUserId}&select=data`, { headers: sbHeaders });
      const bRows = await bRes.json();
      if (!Array.isArray(bRows) || !bRows[0] || !bRows[0].data) return res.status(404).json({ error: 'הגיבוי לא נמצא' });
      const data = bRows[0].data;

      // 1. גיבוי של המצב הנוכחי, כדי שאפשר יהיה לחזור אחורה
      const current = {};
      for (const tb of BACKUP_TABLES) current[tb] = await getAllRows(`${tb}?user_id=eq.${targetUserId}&select=*`);
      const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/backups`, {
        method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: targetUserId, reason: 'pre-restore', data: current })
      });
      if (!saveRes.ok) return res.status(500).json({ error: 'לא ניתן לשמור גיבוי של המצב הנוכחי, ולכן השחזור בוטל.' });

      // 2. מחיקת הנתונים הנוכחיים
      for (const tb of ['transactions', 'recurring', 'reports', 'budgets', 'goals', 'categories', 'credit_cards']) {
        const d = await fetch(`${SUPABASE_URL}/rest/v1/${tb}?user_id=eq.${targetUserId}`, { method: 'DELETE', headers: sbHeaders });
        if (!d.ok) { console.error('restore delete failed', tb, await d.text()); return res.status(500).json({ error: 'השחזור נכשל באמצע המחיקה. המצב הקודם נשמר בגיבוי.' }); }
      }

      // 3. הכנסת נתוני הגיבוי (מזהים חדשים; כרטיסי האשראי ממופים מחדש)
      const cardIdMap = {};
      const prepare = (row) => { const c = { ...row }; delete c.id; c.user_id = targetUserId; return c; };
      for (const tb of BACKUP_TABLES) {
        const src = Array.isArray(data[tb]) ? data[tb] : [];
        for (let i = 0; i < src.length; i += 500) {
          const chunk = src.slice(i, i + 500);
          const rows = chunk.map(r => {
            const c = prepare(r);
            if (tb !== 'credit_cards' && 'card_id' in c) c.card_id = c.card_id ? (cardIdMap[c.card_id] || null) : null;
            return c;
          });
          const ins = await fetch(`${SUPABASE_URL}/rest/v1/${tb}`, {
            method: 'POST', headers: { ...sbHeaders, Prefer: tb === 'credit_cards' ? 'return=representation' : 'return=minimal' },
            body: JSON.stringify(rows)
          });
          if (!ins.ok) { console.error('restore insert failed', tb, await ins.text()); return res.status(500).json({ error: 'השחזור נכשל בטבלה ' + tb + '. המצב הקודם נשמר בגיבוי ואפשר לשחזר ממנו.' }); }
          if (tb === 'credit_cards') {
            const created = await ins.json();
            chunk.forEach((old, k) => { if (old.id && created[k]) cardIdMap[old.id] = created[k].id; });
          }
        }
      }
      if (requestId && UUID_RE.test(String(requestId))) {
        // מסמן כמטופלת רק בקשת שחזור פתוחה של אותו משתמש
        await fetch(`${SUPABASE_URL}/rest/v1/data_requests?id=eq.${requestId}&user_id=eq.${targetUserId}&type=eq.restore&status=eq.pending`, {
          method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'done', handled_at: new Date().toISOString() })
        });
      }
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'mode לא מוכר' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'הפעולה נכשלה. נסו שוב.' });
  }
}
