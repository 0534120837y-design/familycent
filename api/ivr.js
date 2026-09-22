// api/ivr.js
//
// שירות הטלפוניה (IVR) של FamilyCent — מתחבר ל"ימות המשיח" דרך מודול ה-API שלהם.
//
// חשוב להבין: זו פונקציית Vercel Serverless, כלומר "חסרת מצב" (stateless) —
// כל קריאה היא עצמאית לחלוטין ולא "זוכרת" את הקריאה הקודמת. לכן כל ה"הקשות"
// (בחירת תפריט, סכום, סוג פעולה) נאספות ע"י ימות עצמו (שלוחות "שאלה" רגילות
// בפאנל הניהול), וה-API נקרא פעם אחת בלבד, בסוף, עם כל הנתונים כפרמטרים.
// ראו את מדריך ההגדרה שנשלח בצ'אט להסבר המלא על מבנה השלוחות.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://unkrcsdymaggkruzeorc.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

// ---------------------------------------------------------------------
// עזרים
// ---------------------------------------------------------------------

// משאיר רק ספרות, ולוקח את 9 הספרות האחרונות - כדי שהשוואת מספרי טלפון
// תעבוד גם אם יש הבדלים בפורמט (עם/בלי אפס מוביל, עם/בלי 972 בהתחלה וכו')
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  return digits.slice(-9);
}

// שם הפרמטר שבו ימות שולח את מספר הטלפון של המתקשר משתנה בין הגדרות/גרסאות.
// בודקים כמה שמות אפשריים כדי לא להיתקע על זה - ואפשר לוודא את השם המדויק
// דרך מצב ה-debug (ראו בהמשך).
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

  const params = { ...(req.query || {}), ...(req.body || {}) };

  // מצב דיבאג: גולשים לכתובת .../api/ivr?debug=1 בדפדפן (בלי צורך בטלפון)
  // כדי לראות בדיוק אילו פרמטרים מגיעים, ולוודא את שם שדה הטלפון האמיתי.
  if (params.debug === '1') {
    return res.status(200).send(JSON.stringify(params, null, 2));
  }

  if (!supabaseAdmin) {
    console.error('חסר משתנה סביבה SUPABASE_SERVICE_ROLE_KEY');
    return res.status(200).send('אירעה תקלה בהגדרות השרת. אנא פנו לתמיכה.');
  }

  const action = params.action || 'menu';

  // תפריט הפתיחה לא צריך זיהוי משתמש - רק מקריא את האפשרויות.
  // (שימושי בעיקר לבדיקה; בפועל ההודעה הזו יכולה להיות גם קובץ TTS/הקלטה בימות עצמו)
  if (action === 'menu') {
    return res.status(200).send(
      'שלום, ברוכים הבאים למרכז המשפחה. ' +
      'להאזנה ליתרה החודשית הקישו 1. ' +
      'לדיווח הוצאה או הכנסה חדשה הקישו 2. ' +
      'לשמיעת התנועות האחרונות הקישו 3.'
    );
  }

  const callerPhone = normalizePhone(extractCallerPhone(params));
  if (!callerPhone) {
    return res.status(200).send('לא זוהה מספר הטלפון של המתקשר. אנא פנו לתמיכה.');
  }

  let profile;
  try {
    profile = await findProfileByPhone(callerPhone);
  } catch (err) {
    console.error(err);
    return res.status(200).send('אירעה שגיאה בזיהוי החשבון. נסו שוב מאוחר יותר.');
  }

  if (!profile) {
    return res.status(200).send(
      'מספר הטלפון שממנו התקשרתם אינו רשום במערכת. ' +
      'יש להזין את המספר הזה בהגדרות הפרופיל באתר, ולהתקשר שוב מאותו מספר.'
    );
  }

  const currency = profile.currency || '₪';
  const userId = profile.id;

  try {
    if (action === 'balance') {
      return res.status(200).send(await getBalanceMessage(userId, currency));
    }
    if (action === 'recent') {
      return res.status(200).send(await getRecentMessage(userId));
    }
    if (action === 'report') {
      return res.status(200).send(await reportTransaction(userId, params));
    }
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
  // שולפים את כל הפרופילים עם טלפון מוגדר, ומשווים לאחר נירמול -
  // כי מספרי טלפון יכולים להישמר בפורמטים שונים (0501234567 / +972501234567 וכו')
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, currency, phone')
    .not('phone', 'is', null);

  if (error) throw error;

  return (data || []).find(p => normalizePhone(p.phone) === callerPhone) || null;
}

async function getBalanceMessage(userId, currency) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('amount, action_type, occurred_at')
    .eq('user_id', userId)
    .gte('occurred_at', monthStart);

  if (error) throw error;

  let income = 0;
  let expense = 0;
  for (const t of (data || [])) {
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
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('amount, action_type, description, occurred_at')
    .eq('user_id', userId)
    .order('occurred_at', { ascending: false })
    .limit(5);

  if (error) throw error;

  if (!data || data.length === 0) {
    return 'לא נמצאו תנועות בחשבון שלכם.';
  }

  const parts = data.map(t => {
    const kind = isExpense(t.action_type) ? 'הוצאה' : 'הכנסה';
    const amt = Math.round(parseFloat(t.amount) || 0);
    const desc = t.description ? `, ${t.description}` : '';
    return `${kind} של ${amt}${desc}`;
  });

  return `הנה חמש התנועות האחרונות שלכם: ${parts.join('. ')}.`;
}

async function reportTransaction(userId, params) {
  // type: '1' = הוצאה, '2' = הכנסה (מוקש בשלוחת ה"שאלה" השנייה בימות)
  const rawAmount = parseFloat(params.amount);
  const typeDigit = String(params.type || '1');

  if (!rawAmount || rawAmount <= 0) {
    return 'הסכום שהוקש אינו תקין. אנא נסו לדווח שוב.';
  }

  const actionType = typeDigit === '2' ? 'הכנסה 📈' : 'הוצאה 📉';

  const { error } = await supabaseAdmin.from('transactions').insert({
    user_id: userId,
    action_type: actionType,
    amount: rawAmount,
    description: 'דווח טלפונית',
    category: '💰 כללי'
  });

  if (error) throw error;

  const kindHeb = typeDigit === '2' ? 'הכנסה' : 'הוצאה';
  return `נרשמה ${kindHeb} על סך ${Math.round(rawAmount)} בהצלחה. תודה שהתקשרתם למרכז המשפחה.`;
}
