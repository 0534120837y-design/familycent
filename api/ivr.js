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
      // רק ברכה: את אפשרויות התפריט (1/2/3) משמיעה שלוחת התפריט בימות עצמו
      return res.status(200).send(hello + ', ברוכים הבאים למרכז המשפחה.');
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
    if (action === 'add_income') return res.status(200).send(await reportTransaction(userId, params, 'income'));
    if (action === 'add_expense') return res.status(200).send(await reportTransaction(userId, params, 'expense'));
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
  const r = n => Math.round(Math.abs(n)).toString();

  const balancePart = balance >= 0
    ? `היתרה ${r(balance)} ${currency}`
    : `אתם ביתרת חובה של ${r(balance)} ${currency}`;

  return `החודש ההכנסות שלכם הן ${r(income)} ${currency}. ההוצאות ${r(expense)} ${currency}. ${balancePart}.`;
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

// קטגוריות קבועות לשלב 1 (תואמות לברירות המחדל באתר). ספרה -> שם הקטגוריה
const EXPENSE_CATEGORIES = {
  '1': { name: '🛒 סופרמרקט', spoken: 'מזון' },
  '2': { name: '🚗 תחבורה', spoken: 'תחבורה' },
  '3': { name: '🏠 מדור וחשבונות', spoken: 'דיור וחשבונות' },
  '4': { name: '💰 כללי', spoken: 'כללי' }
};

async function reportTransaction(userId, params, forcedKind) {
  // forcedKind: 'income' / 'expense' (מהכתובת של השלוחה).
  // בלי forcedKind (תאימות לאחור): params.type '2' = הכנסה, אחרת הוצאה.
  const isIncome = forcedKind
    ? forcedKind === 'income'
    : String(params.type || '1') === '2';

  const rawAmount = parseFloat(params.amount);
  if (!rawAmount || rawAmount <= 0) {
    return 'הסכום שהוקש אינו תקין. אנא נסו שוב.';
  }

  const actionType = isIncome ? 'הכנסה 📈' : 'הוצאה 📉';

  // קטגוריה נשאלת רק בהוצאה; בהכנסה וכשלא הוקשה קטגוריה תקינה - "כללי"
  const cat = (!isIncome && EXPENSE_CATEGORIES[String(params.category || '').trim()]) || EXPENSE_CATEGORIES['4'];

  await sb('transactions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      action_type: actionType,
      amount: rawAmount,
      description: 'דווח טלפונית',
      category: cat.name
    })
  });

  const kindHeb = isIncome ? 'הכנסה' : 'הוצאה';
  const catPart = isIncome ? '' : ` בקטגוריית ${cat.spoken}`;
  return `נרשמה ${kindHeb} בסך ${Math.round(rawAmount)} שקלים${catPart}.`;
}
