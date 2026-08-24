// פונקציית שרת (Vercel Serverless Function) - שולחת מייל דרך Resend, עם מפתח סודי שנשמר ב-Environment Variables של הפרויקט ב-Vercel.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY לא מוגדר בהגדרות הפרויקט ב-Vercel' });
  }

  const { to, subject, text } = req.body || {};
  if (!to || !subject || !text) {
    return res.status(400).json({ error: 'חסרים פרטים (to / subject / text)' });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'FamilyCent <onboarding@resend.dev>',
        to: [to],
        subject,
        text
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ error: data.message || 'שליחת המייל נכשלה' });
    }
    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'שליחת המייל נכשלה' });
  }
}
