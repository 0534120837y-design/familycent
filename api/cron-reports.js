// פונקציית שרת שרצה אוטומטית פעם ביום (מוגדר ב-vercel.json), בודקת חריגות תקציב ותשלומים קבועים קרובים לכל המשתמשים, ושולחת מייל דיגסט למי שרלוונטי.
// משתמשת ב-SUPABASE_SERVICE_ROLE_KEY (מפתח שרת סודי, לא ה-anon key הציבורי) כדי לקרוא נתונים של כל המשתמשים.
module.exports = async function handler(req, res) {
  // אבטחה: מוודאים שהקריאה מגיעה מ-Vercel Cron ולא מגורם חיצוני
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY || !RESEND_KEY) {
    return res.status(500).json({ error: 'חסרים משתני סביבה (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY)' });
  }

  const sbHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  try {
    const profilesRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,email,family_name,currency`, { headers: sbHeaders });
    const profiles = await profilesRes.json();

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    let sentCount = 0;

    for (const profile of profiles) {
      if (!profile.email) continue;
      const currency = profile.currency || '₪';

      const budgetsRes = await fetch(`${SUPABASE_URL}/rest/v1/budgets?user_id=eq.${profile.id}&select=*`, { headers: sbHeaders });
      const budgets = await budgetsRes.json();

      const recurringRes = await fetch(`${SUPABASE_URL}/rest/v1/recurring?user_id=eq.${profile.id}&select=*`, { headers: sbHeaders });
      const recurring = await recurringRes.json();

      let lines = [];

      if (budgets.length > 0) {
        const txRes = await fetch(`${SUPABASE_URL}/rest/v1/transactions?user_id=eq.${profile.id}&occurred_at=gte.${startOfMonth}&select=amount,category,action_type`, { headers: sbHeaders });
        const transactions = await txRes.json();

        let spent = {};
        transactions.forEach(t => {
          if (t.action_type && t.action_type.includes('הוצאה')) {
            spent[t.category] = (spent[t.category] || 0) + parseFloat(t.amount);
          }
        });

        budgets.forEach(b => {
          const s = spent[b.category] || 0;
          if (s > b.limit_amount) {
            lines.push(`⚠️ חריגה בקטגוריה "${b.category}": ${currency}${s.toLocaleString()} מתוך תקציב ${currency}${b.limit_amount.toLocaleString()}`);
          }
        });
      }

      recurring.forEach(r => {
        const daysUntil = r.day_of_month - now.getDate();
        const alreadyGenerated = r.last_gen_month === now.getMonth() && r.last_gen_year === now.getFullYear();
        if (daysUntil >= 0 && daysUntil <= 5 && !alreadyGenerated) {
          lines.push(`🔔 פעולה קבועה קרובה: "${r.description}" (${currency}${r.amount}) בעוד ${daysUntil} ימים`);
        }
      });

      if (lines.length === 0) continue;

      const emailText = `שלום ${profile.family_name || ''},\n\nהנה עדכון התקציב היומי שלכם ב-FamilyCent:\n\n${lines.join('\n')}\n\nלצפייה מלאה, היכנסו לאתר.`;

      const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'FamilyCent <onboarding@resend.dev>',
          to: [profile.email],
          subject: 'FamilyCent - עדכון תקציב ותזכורות',
          text: emailText
        })
      });
      if (sendRes.ok) sentCount++;
    }

    return res.status(200).json({ success: true, checked: profiles.length, sent: sentCount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'cron job failed' });
  }
}
