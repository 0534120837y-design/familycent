// פונקציית שרת שרצה אוטומטית פעם בחודש (ב-1 לחודש, ראו vercel.json), בונה לכל משתמש דוח חודשי מעוצב
// + קובץ PDF אמיתי (וקטורי - לא צילום מסך) בעזרת דפדפן Chromium חסר-ראש (headless), ושולחת במייל.
// משתמשת ב-SUPABASE_SERVICE_ROLE_KEY (מפתח שרת סודי) כדי לקרוא נתונים של כל המשתמשים.
const chromium = require('@sparticuz/chromium-min');
const puppeteer = require('puppeteer-core');

// קובץ ה-Chromium המוכן מראש (של הספרייה @sparticuz/chromium), מתארח בדף ה-Releases הרשמי שלה ב-GitHub.
// אם בעתיד תרצו לעדכן גרסה, יש להחליף גם כאן וגם בגרסה שרשומה ב-package.json (@sparticuz/chromium-min).
const CHROMIUM_PACK_URL = 'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

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

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: chromium.headless
    });

    const profilesRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,email,family_name,currency,monthly_report_enabled`, { headers: sbHeaders });
    const allProfiles = await profilesRes.json();
    if (!Array.isArray(allProfiles)) throw new Error('לא הצלחנו לקרוא את רשימת המשתמשים מ-Supabase');
    // מכבדים את בחירת המשתמש: שולחים רק למי שלא כיבה את הדוח החודשי האוטומטי בהגדרות שלו (ברירת המחדל: מופעל)
    const profiles = allProfiles.filter(p => p.monthly_report_enabled !== false);

    const now = new Date();
    // הדוח מכסה את החודש הקודם (הקרון רץ ב-1 לחודש, אחרי שהחודש הקודם כבר הסתיים לגמרי)
    const reportMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const startOfReportMonth = new Date(reportMonthDate.getFullYear(), reportMonthDate.getMonth(), 1).toISOString();
    const endOfReportMonth = new Date(reportMonthDate.getFullYear(), reportMonthDate.getMonth() + 1, 1).toISOString();
    const monthLabel = reportMonthDate.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });

    let sentCount = 0;
    for (const profile of profiles) {
      if (!profile.email) continue;
      const currency = profile.currency || '₪';

      const txRes = await fetch(
        `${SUPABASE_URL}/rest/v1/transactions?user_id=eq.${profile.id}&occurred_at=gte.${startOfReportMonth}&occurred_at=lt.${endOfReportMonth}&select=amount,category,description,action_type,occurred_at`,
        { headers: sbHeaders }
      );
      const transactions = await txRes.json();
      if (!Array.isArray(transactions) || transactions.length === 0) continue; // אין מה לדווח למשתמש הזה החודש

      let totalIncome = 0, totalExpense = 0;
      const breakdown = {};
      transactions.forEach(t => {
        const amt = parseFloat(t.amount) || 0;
        const isExp = t.action_type && t.action_type.includes('הוצאה');
        if (isExp) {
          totalExpense += amt;
          const cat = t.category || 'כללי';
          breakdown[cat] = (breakdown[cat] || 0) + amt;
        } else {
          totalIncome += amt;
        }
      });
      const neto = totalIncome - totalExpense;

      const html = buildMonthlyReportHtml({
        familyName: profile.family_name, email: profile.email, monthLabel, currency,
        totalIncome, totalExpense, neto, breakdown
      });

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({
        format: 'A4', printBackground: true,
        margin: { top: '15mm', bottom: '15mm', left: '10mm', right: '10mm' }
      });
      await page.close();
      const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');

      const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'FamilyCent <onboarding@resend.dev>',
          to: [profile.email],
          subject: `FamilyCent - הדוח החודשי שלכם (${monthLabel})`,
          html,
          attachments: [{ filename: `דוח-חודשי-${monthLabel.replace(/\s/g, '-')}.pdf`, content: pdfBase64 }]
        })
      });
      if (sendRes.ok) sentCount++;
      else console.error('שליחת מייל נכשלה עבור', profile.email, await sendRes.text());
    }

    return res.status(200).json({ success: true, totalUsers: allProfiles.length, optedIn: profiles.length, sent: sentCount, month: monthLabel });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'monthly report cron failed: ' + err.message });
  } finally {
    if (browser) await browser.close();
  }
}

/* --- בונה מסמך HTML מלא (עם <head>/<body>) עבור הדוח - נשלח גם כגוף המייל וגם מודפס ל-PDF ע"י Chromium --- */
function buildMonthlyReportHtml({ familyName, email, monthLabel, currency, totalIncome, totalExpense, neto, breakdown }) {
  const rows = Object.keys(breakdown).map(cat => `
    <tr>
      <td style="padding:9px 12px; border-bottom:1px solid #f1f5f9; font-size:13px; color:#334155;">${cat}</td>
      <td style="padding:9px 12px; border-bottom:1px solid #f1f5f9; font-size:13px; text-align:left; font-weight:700; color:#334155;">${currency}${breakdown[cat].toLocaleString()}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
  <html dir="rtl" lang="he">
  <head><meta charset="utf-8"></head>
  <body style="margin:0; font-family: Arial, Helvetica, sans-serif; background:#f1f5f9; padding:24px; direction:rtl;">
    <div style="max-width:640px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.06);">
      <div style="background:linear-gradient(90deg,#4f46e5,#6366f1); padding:24px 28px; color:#ffffff;">
        <div style="font-size:22px; font-weight:800;">💰 FamilyCent</div>
        <div style="font-size:16px; font-weight:700; margin-top:6px;">הדוח החודשי שלכם</div>
        <div style="font-size:13px; opacity:.9; margin-top:2px;">${familyName ? familyName + ' · ' : ''}${monthLabel}</div>
      </div>
      <div style="padding:24px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          <tr>
            <td width="33%" style="background:#ecfdf5; border-radius:12px; padding:14px; text-align:center;">
              <div style="font-size:11px; color:#059669; font-weight:700;">הכנסות</div>
              <div style="font-size:18px; font-weight:800; color:#047857; white-space:nowrap;">${currency}${totalIncome.toLocaleString()}</div>
            </td>
            <td width="2%"></td>
            <td width="33%" style="background:#fff1f2; border-radius:12px; padding:14px; text-align:center;">
              <div style="font-size:11px; color:#e11d48; font-weight:700;">הוצאות</div>
              <div style="font-size:18px; font-weight:800; color:#be123c; white-space:nowrap;">${currency}${totalExpense.toLocaleString()}</div>
            </td>
            <td width="2%"></td>
            <td width="33%" style="background:#eef2ff; border-radius:12px; padding:14px; text-align:center;">
              <div style="font-size:11px; color:#4f46e5; font-weight:700;">יתרה נטו</div>
              <div style="font-size:18px; font-weight:800; color:#4338ca; white-space:nowrap;">${currency}${neto.toLocaleString()}</div>
            </td>
          </tr>
        </table>
        <div style="font-size:13px; font-weight:700; color:#475569; margin-bottom:8px;">פילוח לפי קטגוריות</div>
        <table style="width:100%; border-collapse:collapse; background:#fff; border-radius:10px; overflow:hidden;">${rows}</table>
      </div>
      <div style="background:#f8fafc; padding:14px 28px; text-align:center; color:#94a3b8; font-size:11px;">
        נשלח אוטומטית מאפליקציית FamilyCent · ${email}
      </div>
    </div>
  </body>
  </html>`;
}
