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

  async function sendPlainEmail(to, subject, text) {
    if (!RESEND_KEY) { console.error('RESEND_API_KEY חסר - לא ניתן לשלוח מייל'); return; }
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'FamilyCent <onboarding@resend.dev>',
          to: [to], subject, text
        })
      });
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
        const txRes = await fetch(
          `${SUPABASE_URL}/rest/v1/transactions?user_id=eq.${p.id}&select=amount,action_type,occurred_at&order=occurred_at.desc`,
          { headers: sbHeaders }
        );
        const txs = await txRes.json();
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
      if (!userId) return res.status(400).json({ error: 'חסר userId' });
      const repRes = await fetch(`${SUPABASE_URL}/rest/v1/reports?user_id=eq.${userId}&select=*&order=created_at.desc`, { headers: sbHeaders });
      const reports = await repRes.json();
      return res.status(200).json({ reports });
    }

    if (mode === 'toggleAdmin') {
      // רק בעל האפליקציה (ADMIN_EMAIL) רשאי למנות/לבטל מנהלים אחרים - לא מנהל משני
      if (!isOwner) return res.status(403).json({ error: 'רק בעל האפליקציה יכול למנות או לבטל מנהלים' });
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });

      const { targetUserId, makeAdmin } = req.body || {};
      if (!targetUserId) return res.status(400).json({ error: 'חסר targetUserId' });

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
        return res.status(500).json({ error: 'עדכון הרשאות נכשל: ' + errText });
      }
      return res.status(200).json({ success: true });
    }

    if (mode === 'approveUser') {
      // כל מנהל (בעלים או משני) יכול לאשר משתמש חדש - זו פעולה עם סיכון נמוך יחסית
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });
      const { targetUserId } = req.body || {};
      if (!targetUserId) return res.status(400).json({ error: 'חסר targetUserId' });

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
        return res.status(500).json({ error: 'אישור המשתמש נכשל: ' + errText });
      }

      if (target && target.email) {
        await sendPlainEmail(
          target.email,
          'FamilyCent - ההרשמה שלכם אושרה! 🎉',
          `שלום${target.family_name ? ' ' + target.family_name : ''},\n\nההרשמה שלכם ל-FamilyCent אושרה! אתם יכולים להתחבר עכשיו ולהתחיל להשתמש באפליקציה.\n\nבברכה,\nצוות FamilyCent`
        );
      }
      return res.status(200).json({ success: true });
    }

    if (mode === 'rejectUser') {
      // כל מנהל (בעלים או משני) יכול לדחות בקשת הרשמה ממתינה
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });
      const { targetUserId, reason } = req.body || {};
      if (!targetUserId) return res.status(400).json({ error: 'חסר targetUserId' });

      const targetRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${targetUserId}&select=email,family_name`, { headers: sbHeaders });
      const targetRows = await targetRes.json();
      const target = Array.isArray(targetRows) && targetRows[0];
      const targetEmail = (target && target.email || '').toLowerCase().trim();
      if (targetEmail === ADMIN_EMAIL) {
        return res.status(400).json({ error: 'אי אפשר לדחות את חשבון בעל האפליקציה עצמו' });
      }

      if (target && target.email) {
        const reasonLine = reason ? `\n\nסיבה: ${reason}` : '';
        await sendPlainEmail(
          target.email,
          'FamilyCent - עדכון לגבי בקשת ההרשמה שלכם',
          `שלום${target.family_name ? ' ' + target.family_name : ''},\n\nלצערנו בקשת ההרשמה שלכם ל-FamilyCent לא אושרה.${reasonLine}\n\nבברכה,\nצוות FamilyCent`
        );
      }

      // מוחקים את החשבון (הוא ממילא עדיין לא היה בשימוש בפועל, כי הוא לא היה מאושר)
      const deleteRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${targetUserId}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      if (!deleteRes.ok) {
        const errText = await deleteRes.text();
        return res.status(500).json({ error: 'דחיית המשתמש נכשלה: ' + errText });
      }
      return res.status(200).json({ success: true });
    }

    if (mode === 'deleteUser') {
      // מחיקת משתמש היא פעולה בלתי הפיכה - מותרת רק לבעל האפליקציה
      if (!isOwner) return res.status(403).json({ error: 'רק בעל האפליקציה יכול למחוק משתמשים' });
      if (req.method !== 'POST') return res.status(405).json({ error: 'יש להשתמש ב-POST' });

      const { targetUserId } = req.body || {};
      if (!targetUserId) return res.status(400).json({ error: 'חסר targetUserId' });

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
        return res.status(500).json({ error: 'מחיקת המשתמש נכשלה: ' + errText });
      }
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'mode לא מוכר' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'admin-data נכשל: ' + err.message });
  }
}
