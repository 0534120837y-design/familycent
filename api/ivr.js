// api/ivr.js
// FamilyCent IVR endpoint for Vercel
//
// Required Vercel Environment Variables:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Optional:
//   IVR_API_SECRET
//
// Endpoint:
//   https://familycent.vercel.app/api/ivr
//
// בשלב הזה הקוד רק בודק את החיבור ומזהה מתקשר.
// הוא עדיין לא מכניס או משנה נתונים כספיים.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IVR_API_SECRET = process.env.IVR_API_SECRET || "";

function clean(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) value = value[0];
  return String(value).trim();
}

function normalizePhone(raw) {
  let value = clean(raw).replace(/[^\d+]/g, "");

  if (!value) return "";

  // המרת מספר ישראלי מפורמט בינלאומי לפורמט מקומי
  if (value.startsWith("+972")) {
    value = "0" + value.slice(4);
  } else if (value.startsWith("972")) {
    value = "0" + value.slice(3);
  }

  return value;
}

function getRequestParams(req) {
  const result = {};

  // GET
  if (req.query && typeof req.query === "object") {
    for (const [key, value] of Object.entries(req.query)) {
      result[key] = Array.isArray(value) ? value[0] : value;
    }
  }

  // POST
  if (req.body && typeof req.body === "object") {
    for (const [key, value] of Object.entries(req.body)) {
      result[key] = Array.isArray(value) ? value[0] : value;
    }
  }

  return result;
}

function redactForLogs(params) {
  const copy = { ...params };

  for (const key of Object.keys(copy)) {
    const k = key.toLowerCase();

    if (
      k.includes("password") ||
      k.includes("pass") ||
      k.includes("token") ||
      k.includes("secret") ||
      k.includes("authorization")
    ) {
      copy[key] = "***";
    }
  }

  return copy;
}

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

function buildResponse({
  message = "",
  folder = "/"
} = {}) {
  const safeMessage = String(message)
    .replace(/\r?\n/g, " ")
    .replace(/&/g, " and ")
    .trim();

  const parts = [];

  if (safeMessage) {
    parts.push(
      `id_list_message=t-${safeMessage}`
    );
  }

  if (
    folder !== null &&
    folder !== undefined
  ) {
    parts.push(
      `go_to_folder=${folder}`
    );
  }

  return parts.join("&");
}

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
        apikey:
          SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

        "Content-Type":
          "application/json",

        ...(options.headers || {})
      }
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

async function findProfileByPhone(phone) {
  if (!phone) return null;

  const encodedPhone =
    encodeURIComponent(phone);

  const data = await supabaseRest(
    `profiles?select=id,email,family_name,phone,currency&phone=eq.${encodedPhone}&limit=1`,
    {
      method: "GET"
    }
  );

  return Array.isArray(data) &&
    data.length > 0
    ? data[0]
    : null;
}

function mainMenu() {
  return [
    "לתנועות הקש 1",
    "למצב החשבון הקש 2",
    "לדוחות הקש 3",
    "לשליחת דוחות הקש 4",
    "לקטגוריות הקש 5",
    "לתקציבים ויעדים הקש 6",
    "לפעולות קבועות הקש 7",
    "לפרטים שלי הקש 8",
    "לעזרה והגדרות הקש 9",
    "ליציאה הקש 0"
  ].join(". ");
}

module.exports = async function handler(
  req,
  res
) {
  // מאפשר גם GET וגם POST
  if (
    !["GET", "POST"].includes(req.method)
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

    // אבטחה אופציונלית
    if (IVR_API_SECRET) {
      const suppliedSecret =
        getParam(params, [
          "token",
          "Token",
          "ivr_token"
        ]);

      if (
        !suppliedSecret ||
        suppliedSecret !== IVR_API_SECRET
      ) {
        return res
          .status(401)
          .send(
            buildResponse({
              message:
                "החיבור למערכת אינו מורשה",
              folder: "/"
            })
          );
      }
    }

    const callerPhone =
      getCallerPhone(params);

    const choice =
      getChoice(params);

    const callId =
      getParam(params, [
        "ApiCallId",
        "api_call_id",
        "call_id",
        "id"
      ]);

    const extension =
      getParam(params, [
        "ApiExtension",
        "api_extension",
        "extension",
        "path"
      ]);

    const did =
      getParam(params, [
        "ApiDID",
        "api_did",
        "did"
      ]);

    console.log(
      "FamilyCent IVR request:",
      {
        callerPhone,
        choice,
        callId,
        extension,
        did,
        params:
          redactForLogs(params)
      }
    );

    // אין מספר מתקשר
    if (!callerPhone) {
      return res
        .status(200)
        .send(
          buildResponse({
            message:
              "ברוכים הבאים ל-FamilyCent. המערכת לא קיבלה את מספר המתקשר. להרשמה הקש 1. לכניסה באמצעות סיסמה הקש 2.",
            folder: "/"
          })
        );
    }

    let profile;

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
          buildResponse({
            message:
              "אירעה שגיאה זמנית בחיבור למערכת. נא לנסות שוב מאוחר יותר.",
            folder: "/"
          })
        );
    }

    // משתמש מוכר
    if (profile) {
      const familyName =
        clean(profile.family_name) ||
        "משפחתכם";

      // בשלב הראשון לא משנים נתונים
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
            "9"
          ]);

        if (
          !allowedChoices.has(choice)
        ) {
          return res
            .status(200)
            .send(
              buildResponse({
                message:
                  "בחירה לא תקינה. " +
                  mainMenu(),
                folder: "/"
              })
            );
        }

        if (choice === "0") {
          return res
            .status(200)
            .send(
              buildResponse({
                message:
                  "להתראות.",
                folder: "/"
              })
            );
        }

        return res
          .status(200)
          .send(
            buildResponse({
              message:
                `שלום ${familyName}. בחרת ${choice}. התפריט המלא יחובר בשלב הבא.`,
              folder: "/"
            })
          );
      }

      return res
        .status(200)
        .send(
          buildResponse({
            message:
              `שלום ${familyName}. ברוכים הבאים ל-FamilyCent. ${mainMenu()}`,
            folder: "/"
          })
        );
    }

    // משתמש לא מוכר
    return res
      .status(200)
      .send(
        buildResponse({
          message:
            "המספר שממנו התקשרת אינו מזוהה במערכת. להרשמה למערכת הקש 1. לכניסה באמצעות סיסמה הקש 2.",
          folder: "/"
        })
      );

  } catch (error) {
    console.error(
      "FamilyCent IVR fatal error:",
      error
    );

    return res
      .status(200)
      .send(
        buildResponse({
          message:
            "אירעה שגיאה במערכת. נא לנסות שוב מאוחר יותר.",
          folder: "/"
        })
      );
  }
};
