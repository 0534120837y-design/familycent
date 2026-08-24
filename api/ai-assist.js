// פונקציית שרת (Vercel Serverless Function) - מריצה בקשות AI עם מפתח סודי שנשמר בהגדרות הפרויקט ב-Vercel (Environment Variables), ולא בקוד שרץ בדפדפן.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'AI_API_KEY לא מוגדר בהגדרות הפרויקט ב-Vercel' });
  }

  const { mode, description, categories, imageBase64 } = req.body || {};

  try {
    if (mode === 'suggest_category') {
      if (!description || !Array.isArray(categories)) {
        return res.status(400).json({ error: 'חסרים פרטים (description / categories)' });
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You categorize personal finance transactions. Respond with ONLY the exact category string from the provided list, nothing else.' },
            { role: 'user', content: `Description: "${description}"\nAvailable categories: ${categories.join(' | ')}\nWhich category fits best? Respond with only the exact category text from the list.` }
          ],
          max_tokens: 20,
          temperature: 0
        })
      });
      const data = await response.json();
      const suggestion = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ? data.choices[0].message.content.trim() : '';
      return res.status(200).json({ suggestion });
    }

    if (mode === 'parse_receipt') {
      if (!imageBase64) {
        return res.status(400).json({ error: 'חסרה תמונה (imageBase64)' });
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You extract purchase details from receipt/invoice images for a personal finance app. Respond ONLY with valid JSON, no markdown, no explanation, in this exact shape: {"amount": number, "description": string, "date": "YYYY-MM-DD" or null}. Use the total amount paid. Description should be the merchant/store name, short. If a field cannot be determined, use null for it (except amount, do your best estimate).'
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Extract the total amount, merchant name, and date from this receipt.' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
              ]
            }
          ],
          max_tokens: 300
        })
      });
      const data = await response.json();
      const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ? data.choices[0].message.content : '{}';
      const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
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
