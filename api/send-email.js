// פונקציית שרת (Vercel Serverless Function) - שולחת מייל דרך Resend.
// משתני סביבה נדרשים ב-Vercel: RESEND_API_KEY, ADMIN_EMAIL, SUPABASE_URL, SUPABASE_ANON_KEY, SITE_URL
// אופציונלי: RESEND_FROM (כתובת שולח מדומיין מאומת)

const MAX_ATTACHMENT_B64 = 4 * 1024 * 1024; // ~3MB קובץ
const MAX_HTML = 200000;

function esc(s) {
  return String(s || '').slice(0, 200)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// מאמת את המשתמש מול Supabase לפי הטוקן שנשלח מהדפדפן
async function getUserFromToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

// טוקן ההתחברות של המשתמש (לשאילתות שמכבדות את מדיניות ה-RLS שלו)
function getToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}
async function userRest(req, path) {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${getToken(req)}` }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// הגבלת קצב פשוטה בזיכרון (עוזרת מול ספאם; בסביבת שרת-ללא-מצב היא "מאמץ סביר" ולא ערובה מוחלטת)
const rlHits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (rlHits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { rlHits.set(key, arr); return true; }
  arr.push(now); rlHits.set(key, arr);
  if (rlHits.size > 5000) rlHits.clear();
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY לא מוגדר בהגדרות הפרויקט ב-Vercel' });

  const { subject, text, html, attachment, notifyAdmin, pendingUser, adminRequest } = req.body || {};
  const from = process.env.RESEND_FROM || 'FamilyCent <onboarding@resend.dev>';
  let payload;

  const user = await getUserFromToken(req);

  if (user && user.email && adminRequest) {
    // משתמש מחובר שלח בקשת איפוס/שחזור: ההתראה נשלחת למנהל, והתוכן נקבע בשרת (הכתובת נלקחת מהטוקן)
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) return res.status(500).json({ error: 'ADMIN_EMAIL לא מוגדר' });
    const label = adminRequest === 'reset' ? 'איפוס נתונים' : adminRequest === 'restore' ? 'שחזור נתונים' : null;
    if (!label) return res.status(400).json({ error: 'סוג בקשה לא תקין' });
    // מונע שימוש לרעה כשרשור הודעות למנהל: חייבת להיות בקשה פתוחה אמיתית של המשתמש שנוצרה ב-10 הדקות האחרונות
    if (!UUID_RE.test(String(user.id))) return res.status(400).json({ error: 'משתמש לא תקין' });
    if (rateLimited('adm:' + user.id, 3, 10 * 60 * 1000)) return res.status(429).json({ error: 'יותר מדי בקשות. נסו שוב בעוד כמה דקות.' });
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const open = await userRest(req, `data_requests?user_id=eq.${user.id}&type=eq.${adminRequest}&status=eq.pending&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`);
    if (!Array.isArray(open) || open.length === 0) return res.status(403).json({ error: 'לא נמצאה בקשה פתוחה' });
    payload = {
      from, to: [adminEmail],
      subject: `FamilyCent - בקשה ל${label}`,
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7">המשתמש <b>${esc(user.email)}</b> שלח בקשה ל<b>${label}</b>.<br><br><a href="${process.env.SITE_URL || ''}/#admin">מעבר לפאנל המנהל לטיפול בבקשה</a></div>`
    };
  } else if (user && user.email && !notifyAdmin) {
    // משתמש מחובר: המייל נשלח תמיד לכתובת שלו בלבד, בלי קשר לשדה "to" שהלקוח שלח
    // משתמש שעדיין לא אושר על ידי המנהל לא יכול לשלוח מיילים
    const prof = await userRest(req, `profiles?id=eq.${user.id}&select=is_approved`);
    if (Array.isArray(prof) && prof[0] && prof[0].is_approved === false) return res.status(403).json({ error: 'החשבון ממתין לאישור מנהל' });
    if (rateLimited('mail:' + user.id, 10, 60 * 1000)) return res.status(429).json({ error: 'יותר מדי מיילים. נסו שוב בעוד דקה.' });
    if (!subject || (!text && !html)) return res.status(400).json({ error: 'חסרים פרטים (subject / text או html)' });
    if (html && String(html).length > MAX_HTML) return res.status(413).json({ error: 'התוכן גדול מדי' });
    payload = { from, to: [user.email], subject: String(subject).slice(0, 200) };
    if (html) payload.html = html;
    if (text) payload.text = String(text).slice(0, MAX_HTML);
    if (attachment && attachment.filename && attachment.content) {
      if (String(attachment.content).length > MAX_ATTACHMENT_B64) return res.status(413).json({ error: 'הקובץ גדול מדי' });
      payload.attachments = [{ filename: String(attachment.filename).slice(0, 100), content: attachment.content }];
    }
  } else if (notifyAdmin && pendingUser) {
    // הרשמה חדשה (עדיין בלי התחברות): היעד והתוכן נקבעים בשרת בלבד
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) return res.status(500).json({ error: 'ADMIN_EMAIL לא מוגדר בהגדרות הפרויקט ב-Vercel' });
    // הגבלת קצב כללית להתראות הרשמה (מונע הצפת מיילים על ידי גורם אנונימי)
    if (rateLimited('signup:all', 10, 60 * 1000)) return res.status(200).json({ success: true });
    const claimedEmail = String((pendingUser && pendingUser.email) || '').toLowerCase().trim().slice(0, 200);
    if (!claimedEmail || rateLimited('signup:' + claimedEmail, 1, 10 * 60 * 1000)) return res.status(200).json({ success: true });
    // אימות מול המסד: ההתראה נשלחת רק אם באמת קיים משתמש ממתין שנרשם ב-30 הדקות האחרונות, והפרטים נלקחים מהמסד ולא מהלקוח
    let family = esc(pendingUser.familyName);
    let email = esc(claimedEmail);
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey && process.env.SUPABASE_URL) {
      try {
        const since30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const pr = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(claimedEmail)}&is_approved=eq.false&created_at=gte.${encodeURIComponent(since30)}&select=email,family_name&limit=1`, {
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
        });
        const rows = pr.ok ? await pr.json() : null;
        if (Array.isArray(rows)) {
          if (rows.length === 0) return res.status(200).json({ success: true }); // אין משתמש ממתין כזה: מתעלמים בשקט
          family = esc(rows[0].family_name || pendingUser.familyName);
          email = esc(rows[0].email);
        }
      } catch (e) { /* אם הבדיקה נכשלה טכנית, ממשיכים כרגיל */ }
    }
    const siteUrl = process.env.SITE_URL || '';
    payload = {
      from,
      to: [adminEmail],
      subject: 'FamilyCent - משתמש חדש ממתין לאישור',
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7">משתמש חדש נרשם ומחכה לאישור:<br>משפחה: ${family}<br>אימייל: ${email}<br><br><a href="${siteUrl}/#admin">מעבר לפאנל המנהל</a></div>`
    };
  } else {
    return res.status(401).json({ error: 'נדרשת התחברות' });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ error: 'שליחת המייל נכשלה' });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'שליחת המייל נכשלה' });
  }
};
