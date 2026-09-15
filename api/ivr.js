// api/ivr.js
// FamilyCent <-> Yemot HaMashiach
//
// שלב 1:
// - קבלת פנייה מימות המשיח
// - זיהוי מספר המתקשר
// - חיפוש המשתמש ב-Supabase
// - החזרת טקסט פשוט לימות המשיח
//
// חשוב:
// במודול API החדש של ימות המשיח תשובת השרת חייבת להיות טקסט פשוט.
// לכן הפונקציה מחזירה טקסט בלבד ולא JSON ולא id_list_message.
//
// משתני סביבה נדרשים ב-Vercel:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
//
// אופציונלי:
// IVR_API_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const IVR_API_SECRET =
  process.env.IVR_API_SECRET || "";

/* =========================================================
   פונקציות עזר
   ========================================================= */

function clean(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (Array.isArray(value)) {
    value = value[0];
  }

  return String(value).trim();
}

/**
 * נרמול מספר ישראלי.
 *
 * לדוגמה:
 * +972501234567 -> 0501234567
 * 972501234567  -> 0501234567
 */
function normalizePhone(raw) {
  let value = clean(raw);

  value = value.replace(/[^\d+]/g, "");

  if (!value) {
    return "";
  }

  if (value.startsWith("+972")) {
    value = "0" + value.slice(4);
  } else if (value.startsWith("972")) {
    value = "0" + value.slice(3);
  }

  return value;
}

/**
 * איסוף פרמטרים מ-GET וגם מ-POST.
 */
function getRequestParams(req) {
  const result = {};

  // GET
  if (req.query && typeof req.query === "object") {
    for (const [key, value] of Object.entries(req.query)) {
      result[key] = Array.isArray(value)
        ? value[0]
        : value;
    }
  }

  // POST
  if (req.body && typeof req.body === "object") {
    for (const [key, value] of Object.entries(req.body)) {
      result[key] = Array.isArray(value)
        ? value[0]
        : value;
    }
  }

  return result;
}

/**
 * חיפוש פרמטר לפי כמה שמות אפשריים.
 */
function getParam(params, names) {
  for (const name of names) {
    if (
      params[name] !== undefined &&
      clean(params[name]) !== ""
    ) {
      return clean(params[name]);
    }
  }

  return "";
}

/**
 * מספר המתקשר.
 *
 * ימות המשיח שולחים כברירת מחדל:
 * ApiPhone
 */
function getCallerPhone(params) {
  return normalizePhone(
    getParam(params, [
      "ApiPhone",
      "api_phone",
      "callerIdNum",
      "CallerIdNum",
      "phone",
      "phone_number",
    ])
  );
}

/**
 * הבחירה שהמתקשר הקיש.
 *
 * נשאיר תמיכה במספר שמות אפשריים,
 * כדי שנוכל להתאים את זה בהמשך למבנה המדויק
 * של שאלות ה-API.
 */
function getChoice(params) {
  return getParam(params, [
    "ApiDigits",
    "api_digits",
    "Digits",
    "digits",
    "choice",
    "menu",
    "action",
  ]);
}

/**
 * מחזיר טקסט פשוט בלבד.
 *
 * חשוב מאוד:
 * אין כאן JSON.
 * אין id_list_message.
 * אין go_to_folder.
 * ימות המשיח יקבלו את הטקסט וישמיעו אותו
 * כאשר "הקראת תשובת השרת" מסומנת.
 */
function plainText(message) {
  return String(message || "")
    .replace(/\r?\n/g, " ")
    .trim();
}

/* =========================================================
   Supabase
   ========================================================= */

async function supabaseRest(
  path,
  options = {}
) {
  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

        "Content-Type":
          "application/json",

        ...(options.headers || {}),
      },
    }
  );

  const text = await response.text();

  let data = null;

  try {
    data = text
      ? JSON.parse(text)
      : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const detail =
      typeof data === "string"
        ? data
        : JSON.stringify(data || {});

    throw new Error(
      `Supabase ${response.status}: ${detail.slice(
        0,
        500
      )}`
    );
  }

  return data;
}

/**
 * חיפוש משתמש לפי מספר הטלפון שבפרופיל.
 */
async function findProfileByPhone(phone) {
  if (!phone) {
    return null;
  }

  const encodedPhone =
    encodeURIComponent(phone);

  const data = await supabaseRest(
    `profiles?select=id,email,family_name,phone,currency&phone=eq.${encodedPhone}&limit=1`,
    {
      method: "GET",
    }
  );

  if (
    Array.isArray(data) &&
    data.length > 0
  ) {
    return data[0];
  }

  return null;
}

/* =========================================================
   תפריט FamilyCent
   ========================================================= */

function mainMenu() {
  return (
    "לתנועות הקש 1. " +
    "למצב החשבון הקש 2. " +
    "לדוחות הקש 3. " +
    "לשליחת דוחות הקש 4. " +
    "לקטגוריות הקש 5. " +
    "לתקציבים ויעדים הקש 6. " +
    "לפעולות קבועות הקש 7. " +
    "לפרטים שלי הקש 8. " +
    "לעזרה והגדרות הקש 9. " +
    "ליציאה הקש 0."
  );
}

/* =========================================================
   אבטחת לוגים
   ========================================================= */

function redactForLogs(params) {
  const copy = {
    ...params,
  };

  for (const key of Object.keys(copy)) {
    const lower =
      key.toLowerCase();

    if (
      lower.includes("password") ||
      lower.includes("pass") ||
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("authorization")
    ) {
      copy[key] = "***";
    }
  }

  return copy;
}

/* =========================================================
   Handler
   ========================================================= */

module.exports = async function handler(
  req,
  res
) {
  /**
   * אנחנו מאפשרים גם GET וגם POST.
   */
  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    res.setHeader(
      "Allow",
      "GET, POST"
    );

    return res
      .status(405)
      .send("Method not allowed");
  }

  try {
    const params =
      getRequestParams(req);

    /* -----------------------------------------------------
       בדיקת Secret אופציונלית
       ----------------------------------------------------- */

    if (IVR_API_SECRET) {
      const suppliedSecret =
        getParam(params, [
          "token",
          "Token",
          "ivr_token",
        ]);

      if (
        !suppliedSecret ||
        suppliedSecret !== IVR_API_SECRET
      ) {
        return res
          .status(401)
          .send(
            plainText(
              "החיבור למערכת אינו מורשה"
            )
          );
      }
    }

    /* -----------------------------------------------------
       פרטי השיחה
       ----------------------------------------------------- */

    const callerPhone =
      getCallerPhone(params);

    const choice =
      getChoice(params);

    const callId =
      getParam(params, [
        "ApiCallId",
        "api_call_id",
        "call_id",
        "id",
      ]);

    const extension =
      getParam(params, [
        "ApiExtension",
        "api_extension",
        "extension",
      ]);

    const did =
      getParam(params, [
        "ApiDID",
        "api_did",
        "did",
      ]);

    /**
     * לא להדפיס סיסמאות או טוקנים.
     */
    console.log(
      "FamilyCent IVR request:",
      {
        callerPhone,
        choice,
        callId,
        extension,
        did,
        params:
          redactForLogs(params),
      }
    );

    /* -----------------------------------------------------
       אין מספר מתקשר
       ----------------------------------------------------- */

    if (!callerPhone) {
      return res
        .status(200)
        .send(
          plainText(
            "ברוכים הבאים ל-FamilyCent. " +
            "המערכת לא קיבלה את מספר המתקשר. " +
            "להרשמה למערכת הקש 1. " +
            "לכניסה באמצעות סיסמה הקש 2."
          )
        );
    }

    /* -----------------------------------------------------
       חיפוש המשתמש ב-Supabase
       ----------------------------------------------------- */

    let profile = null;

    try {
      profile =
        await findProfileByPhone(
          callerPhone
        );
    } catch (error) {
      console.error(
        "FamilyCent profile lookup failed:",
        error.message
      );

      return res
        .status(200)
        .send(
          plainText(
            "אירעה שגיאה זמנית בחיבור למערכת. " +
            "נא לנסות שוב מאוחר יותר."
          )
        );
    }

    /* =====================================================
       משתמש מוכר
       ===================================================== */

    if (profile) {
      const familyName =
        clean(profile.family_name) ||
        "משפחתכם";

      /* ---------------------------------------------------
         אם הוקשה בחירה
         --------------------------------------------------- */

      if (choice) {
        const allowedChoices =
          new Set([
            "0",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
          ]);

        /**
         * בדיקה בסיסית שהבחירה תקינה.
         */
        if (
          !allowedChoices.has(
            choice
          )
        ) {
          return res
            .status(200)
            .send(
              plainText(
                "בחירה לא תקינה. " +
                mainMenu()
              )
            );
        }

        /* -----------------------------------------------
           0 = יציאה
           ----------------------------------------------- */

        if (choice === "0") {
          return res
            .status(200)
            .send(
              plainText(
                "להתראות."
              )
            );
        }

        /* -----------------------------------------------
           שלב ראשון:
           רק בדיקת החיבור והבחירה.
           ----------------------------------------------- */

        if (choice === "1") {
          return res
            .status(200)
            .send(
              plainText(
                `שלום ${familyName}. ` +
                "נכנסת לתפריט התנועות. " +
                "המערכת מוכנה לשלב הבא."
              )
            );
        }

        if (choice === "2") {
          return res
            .status(200)
            .send(
              plainText(
                `שלום ${familyName}. ` +
                "בחרת מצב חשבון. " +
                "המערכת מוכנה לשלב הבא."
              )
            );
        }

        if (choice === "3") {
          return res
            .status(200)
            .send(
              plainText(
                `שלום ${familyName}. ` +
                "בחרת דוחות. " +
                "המערכת מוכנה לשלב הבא."
              )
            );
        }

        if (choice === "4") {
          return res
            .status(200)
            .send(
              plainText(
                `שלום ${familyName}. ` +
                "בחרת שליחת דוחות. " +
                "המערכת מוכנה לשלב הבא."
              )
            );
        }

        if (choice === "5") {
          return res
            .status(200)
            .send(
              plainText(
                `שלום ${familyName}. ` +
                "בחרת קטגוריות. " +
                "המערכת מוכנה לשלב הבא."
              )
            );
        }

        if (choice === "6") {
          return res
            .status(200)
            .send(
              plainText(
                `שלום ${familyName}. ` +
                "בחרת תקציבים ויעדים. " +
                "המערכת מוכנה לשלב הבא."
              )
            );
        }

        if (choice === "7") {
          return res
            .status(200)
            .send(
              plainText(
                `שלום ${familyName}. ` +
                "בחרת פעולות קבועות. " +
                "המערכת מוכנה לשלב הבא."
              )
            );
        }

        if (choice === "8") {
          return res
            .status(200)
            .send(
              plainText(
                `שלום ${familyName}. ` +
                "בחרת פרטים אישיים. " +
                "המערכת מוכנה לשלב הבא."
              )
            );
        }

        if (choice === "9") {
          return res
            .status(200)
            .send(
              plainText(
                `שלום ${familyName}. ` +
                "בחרת עזרה והגדרות. " +
                "המערכת מוכנה לשלב הבא."
              )
            );
        }
      }

      /* ---------------------------------------------------
         משתמש מוכר ללא בחירה
         --------------------------------------------------- */

      return res
        .status(200)
        .send(
          plainText(
            `שלום ${familyName}. ` +
            "ברוכים הבאים ל-FamilyCent. " +
            mainMenu()
          )
        );
    }

    /* =====================================================
       מספר לא מוכר
       ===================================================== */

    return res
      .status(200)
      .send(
        plainText(
          "המספר שממנו התקשרת אינו מזוהה במערכת. " +
          "להרשמה למערכת הקש 1. " +
          "לכניסה למערכת באמצעות סיסמה הקש 2."
        )
      );

  } catch (error) {
    console.error(
      "FamilyCent IVR fatal error:",
      error
    );

    return res
      .status(200)
      .send(
        plainText(
          "אירעה שגיאה במערכת. " +
          "נא לנסות שוב מאוחר יותר."
        )
      );
  }
};
