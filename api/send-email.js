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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY לא מוגדר בהגדרות הפרויקט ב-Vercel' });

  const { subject, text, html, attachment, notifyAdmin, pendingUser } = req.body || {};
  const from = process.env.RESEND_FROM || 'FamilyCent <onboarding@resend.dev>';
  let payload;

  const user = await getUserFromToken(req);

  if (user && user.email && !notifyAdmin) {
    // משתמש מחובר: המייל נשלח תמיד לכתובת שלו בלבד, בלי קשר לשדה "to" שהלקוח שלח
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
    const family = esc(pendingUser.familyName);
    const email = esc(pendingUser.email);
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
