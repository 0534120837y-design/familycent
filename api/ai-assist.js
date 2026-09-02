// פונקציית שרת (Vercel Serverless Function) - מריצה בקשות AI עם מפתח סודי שנשמר בהגדרות הפרויקט ב-Vercel (Environment Variables), ולא בקוד שרץ בדפדפן.
// עודכן להשתמש ב-Google Gemini (יש לו רמה חינמית נדיבה) במקום OpenAI (שדורש כרטיס אשראי ותשלום).
// כדי לקבל מפתח חינם: היכנסו ל-https://aistudio.google.com/apikey , צרו מפתח, והוסיפו אותו ב-Vercel כמשתנה סביבה בשם GEMINI_API_KEY.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY לא מוגדר בהגדרות הפרויקט ב-Vercel. אפשר לקבל מפתח חינמי בכתובת https://aistudio.google.com/apikey' });
  }

  const { mode, description, categories, imageBase64, question, financialSummary } = req.body || {};
  const MODEL = 'gemini-2.0-flash';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  async function callGemini(parts, generationConfig) {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: generationConfig || {}
      })
    });
    const data = await response.json();
    if (!response.ok) {
      const detail = (data.error && data.error.message) ? data.error.message : JSON.stringify(data).slice(0, 300);
      const err = new Error(detail);
      err.raw = data;
      throw err;
    }
    const text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '';
    return text.trim();
  }

  try {
    if (mode === 'suggest_category') {
      if (!description || !Array.isArray(categories)) {
        return res.status(400).json({ error: 'חסרים פרטים (description / categories)' });
      }
      const prompt = `You categorize personal finance transactions. Respond with ONLY the exact category string from the provided list, nothing else, no explanation.\nDescription: "${description}"\nAvailable categories: ${categories.join(' | ')}\nWhich category fits best? Respond with only the exact category text from the list.`;
      let suggestion = '';
      try {
        suggestion = await callGemini([{ text: prompt }], { maxOutputTokens: 20, temperature: 0 });
      } catch (e) {
        console.error('Gemini suggest_category error:', e.message);
        return res.status(500).json({ error: e.message || 'שגיאה מ-Gemini' });
      }
      return res.status(200).json({ suggestion });
    }

    if (mode === 'advisor') {
      if (!financialSummary) {
        return res.status(400).json({ error: 'חסר financialSummary' });
      }
      const systemPrompt = 'אתה יועץ פיננסי אישי ידידותי לאפליקציית ניהול תקציב משפחתי בשם FamilyCent. תענה תמיד בעברית, בטון חם ותומך אך ישיר. קיבלת סיכום נתונים פיננסיים של המשתמש (הכנסות, הוצאות לפי קטגוריה, תקציבים, יעדי חיסכון, והשוואה לחודשים קודמים). תן ניתוח קצר וממוקד: איפה ההוצאות גדלו, איפה אפשר לחסוך, אילו תקציבים עומדים לחרוג, כמה אפשר להפריש לחיסכון החודש, והשוואה לחודשים קודמים. אם המשתמש שאל שאלה ספציפית - התמקד בה. תשובה בפורמט טקסט פשוט (לא markdown), עד כ-200 מילים, עם שורות קצרות וברורות.';
      const userPrompt = `נתוני התקציב שלי:\n${financialSummary}\n\n${question ? `השאלה שלי: ${question}` : 'מה כדאי לי לעשות החודש? תן לי ניתוח כללי.'}`;
      let advice = '';
      try {
        advice = await callGemini([{ text: systemPrompt + '\n\n' + userPrompt }], { maxOutputTokens: 500, temperature: 0.4 });
      } catch (e) {
        console.error('Gemini advisor error:', e.message);
        return res.status(500).json({ error: 'לא התקבלה תשובה מה-AI: ' + e.message });
      }
      if (!advice) {
        return res.status(500).json({ error: 'לא התקבלה תשובה מה-AI' });
      }
      return res.status(200).json({ advice });
    }

    if (mode === 'parse_receipt') {
      if (!imageBase64) {
        return res.status(400).json({ error: 'חסרה תמונה (imageBase64)' });
      }
      const prompt = 'You extract purchase details from receipt/invoice images for a personal finance app. Respond ONLY with valid JSON, no markdown, no explanation, in this exact shape: {"amount": number, "description": string, "date": "YYYY-MM-DD" or null}. Use the total amount paid. Description should be the merchant/store name, short. If a field cannot be determined, use null for it (except amount, do your best estimate).\n\nExtract the total amount, merchant name, and date from this receipt.';
      let raw = '{}';
      try {
        raw = await callGemini([
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }
        ], { maxOutputTokens: 300 });
      } catch (e) {
        console.error('Gemini parse_receipt error:', e.message);
        return res.status(500).json({ error: e.message || 'שגיאה מ-Gemini' });
      }
      const cleaned = (raw || '{}').replace(/```json/g, '').replace(/```/g, '').trim();
      let parsed;
      try { parsed = JSON.parse(cleaned); } catch (e) { parsed = {}; }
      return res.status(200).json(parsed);
    }

    return res.status(400).json({ error: 'mode לא מוכר' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'בקשת ה-AI נכשלה' });
  }
}
