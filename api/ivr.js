// api/ivr.js
//
// שירות הטלפוניה (IVR) של FamilyCent — מתחבר ל"ימות המשיח" דרך מודול ה-API שלהם.
// גרסה ללא תלויות חיצוניות: מדבר עם Supabase ישירות דרך REST (fetch מובנה ב-Node 18+).
//
// הפונקציה "חסרת מצב" (stateless): ימות אוסף את כל ההקשות בשלוחות "שאלה" רגילות,
// וקורא ל-API פעם אחת בלבד, בסוף, עם כל הנתונים כפרמטרים.

const SUPABASE_URL = 'https://unkrcsdymaggkruzeorc.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---------------------------------------------------------------------
// עזרים
// ---------------------------------------------------------------------

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// משאיר רק ספרות ולוקח את 9 הספרות האחרונות, כדי שהשוואת טלפונים תעבוד
// גם עם הבדלי פורמט (אפס מוביל, 972 וכו')
function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').slice(-9);
}

// שם הפרמטר שבו ימות שולח את מספר המתקשר משתנה; בודקים כמה אפשרויות.
function extractCallerPhone(params) {
  const candidates = ['ApiPhone', 'Phone', 'phone', 'ApiDID', 'CallerID', 'ApiCallerID'];
  for (const key of candidates) {
    if (params[key]) return params[key];
  }
  return '';
}

function isExpense(actionType) {
  return typeof actionType === 'string' && actionType.includes('הוצאה');
}

// ---------------------------------------------------------------------
// Handler ראשי
// ---------------------------------------------------------------------

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  try {
    const params = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };

    // מצב דיבאג: .../api/ivr?debug=1 מחזיר את כל הפרמטרים שהתקבלו
    if (String(params.debug || '').split(/[?&]/)[0] === '1') {
      return res.status(200).send(JSON.stringify(params, null, 2));
    }

    // ימות שולח בקשה נוספת בניתוק השיחה (hangup=yes) עם כל הנתונים שנאספו.
    // מתעלמים ממנה כדי לא לבצע פעולה (כמו דיווח הוצאה) פעם שנייה.
    if (String(params.hangup || '').toLowerCase() === 'yes') {
      return res.status(200).send('ok');
    }

    // ימות עלול לצרף את הפרמטרים שלו לכתובת באופן שמלכלך את הערך (למשל "menu?ApiCallId=...").
    // לכן לוקחים רק את החלק שלפני ? או & , ואם יש כמה ערכים - את הראשון.
    const rawAction = Array.isArray(params.action) ? params.action[0] : params.action;
    const action = String(rawAction || 'menu').split(/[?&]/)[0].trim().toLowerCase();

    if (action === 'menu') {
      // ברכה אישית: אם אפשר לזהות את המתקשר לפי הטלפון - פונים אליו בשם.
      // כל כשל בזיהוי לא מפיל את התפריט, אלא רק מחזיר ברכה כללית.
      let name = '';
      try {
        const phone = normalizePhone(extractCallerPhone(params));
        if (phone && SERVICE_KEY) {
          const rows = await sb('profiles?select=family_name,phone&phone=not.is.null');
          const p = (rows || []).find(r => normalizePhone(r.phone) === phone);
          if (p && p.family_name) {
            // מנרמלים לצורה "משפחת <שם>": אם כבר כתוב "משפחת"/"משפחה" - משאירים, אחרת מוסיפים
            const clean = String(p.family_name)
              .replace(/[.&=]/g, ' ')
              .replace(/^\s*משפח(ת|ה)\s+/, '')
              .trim();
            name = clean ? 'משפחת ' + clean : '';
          }
        }
      } catch (e) {
        console.error('ברכה אישית נכשלה:', e.message);
      }
      const hello = name ? `שלום ${name}` : 'שלום';
      return res.status(200).send(
        hello + ', ברוכים הבאים למרכז המשפחה. ' +
        'להאזנה ליתרה החודשית הקישו 1. ' +
        'לדיווח הוצאה או הכנסה חדשה הקישו 2. ' +
        'לשמיעת התנועות האחרונות הקישו 3.'
      );
    }

    if (!SERVICE_KEY) {
      console.error('חסר משתנה סביבה SUPABASE_SERVICE_ROLE_KEY');
      return res.status(200).send('אירעה תקלה בהגדרות השרת. אנא פנו לתמיכה.');
    }

    const callerPhone = normalizePhone(extractCallerPhone(params));
    if (!callerPhone) {
      return res.status(200).send('לא זוהה מספר הטלפון של המתקשר. אנא פנו לתמיכה.');
    }

    const profile = await findProfileByPhone(callerPhone);
    if (!profile) {
      return res.status(200).send(
        'מספר הטלפון שממנו התקשרתם אינו רשום במערכת. ' +
        'יש להזין את המספר הזה בהגדרות הפרופיל באתר, ולהתקשר שוב מאותו מספר.'
      );
    }

    const currency = (profile.currency && profile.currency !== '₪') ? profile.currency : 'שקלים';
    const userId = profile.id;

    if (action === 'balance') return res.status(200).send(await getBalanceMessage(userId, currency));
    if (action === 'recent') return res.status(200).send(await getRecentMessage(userId));
    if (action === 'report') return res.status(200).send(await reportTransaction(userId, params));

    console.log('פעולה לא מוכרת:', JSON.stringify(params));
    return res.status(200).send('פעולה לא מוכרת.');
  } catch (err) {
    console.error(err);
    return res.status(200).send('אירעה שגיאה בעיבוד הבקשה. נסו שוב מאוחר יותר.');
  }
};

// ---------------------------------------------------------------------
// גישה לנתונים
// ---------------------------------------------------------------------

async function findProfileByPhone(callerPhone) {
  const rows = await sb('profiles?select=id,currency,phone&phone=not.is.null');
  return (rows || []).find(p => normalizePhone(p.phone) === callerPhone) || null;
}

async function getBalanceMessage(userId, currency) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const rows = await sb(
    `transactions?select=amount,action_type,occurred_at&user_id=eq.${encodeURIComponent(userId)}` +
    `&occurred_at=gte.${encodeURIComponent(monthStart)}`
  );

  let income = 0;
  let expense = 0;
  for (const t of (rows || [])) {
    const amt = parseFloat(t.amount) || 0;
    if (isExpense(t.action_type)) expense += amt; else income += amt;
  }

  const balance = income - expense;
  const balanceText = Math.round(Math.abs(balance)).toString();

  if (balance >= 0) {
    return `היתרה שלכם החודש היא ${balanceText} ${currency}, ביתרת זכות.`;
  }
  return `שימו לב, החודש אתם ביתרת חובה של ${balanceText} ${currency}.`;
}

async function getRecentMessage(userId) {
  const rows = await sb(
    `transactions?select=amount,action_type,description,occurred_at&user_id=eq.${encodeURIComponent(userId)}` +
    `&order=occurred_at.desc&limit=5`
  );

  if (!rows || rows.length === 0) {
    return 'לא נמצאו תנועות בחשבון שלכם.';
  }

  const parts = rows.map(t => {
    const kind = isExpense(t.action_type) ? 'הוצאה' : 'הכנסה';
    const amt = Math.round(parseFloat(t.amount) || 0);
    const desc = t.description ? `, ${t.description}` : '';
    return `${kind} של ${amt}${desc}`;
  });

  return `הנה חמש התנועות האחרונות שלכם: ${parts.join('. ')}.`;
}

async function reportTransaction(userId, params) {
  // type: '1' = הוצאה, '2' = הכנסה (מוקש בשלוחת ה"שאלה" בימות)
  const rawAmount = parseFloat(params.amount);
  const typeDigit = String(params.type || '1');

  if (!rawAmount || rawAmount <= 0) {
    return 'הסכום שהוקש אינו תקין. אנא נסו לדווח שוב.';
  }

  const actionType = typeDigit === '2' ? 'הכנסה 📈' : 'הוצאה 📉';

  await sb('transactions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      action_type: actionType,
      amount: rawAmount,
      description: 'דווח טלפונית',
      category: '💰 כללי'
    })
  });

  const kindHeb = typeDigit === '2' ? 'הכנסה' : 'הוצאה';
  return `נרשמה ${kindHeb} על סך ${Math.round(rawAmount)} בהצלחה. תודה שהתקשרתם למרכז המשפחה.`;
}
