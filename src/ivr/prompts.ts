/**
 * The prompt catalogue.
 *
 * `file` is the path Asterisk resolves RELATIVE to the language directory:
 * playing "ivr/welcome" on a channel whose language is `he` loads
 *   /usr/share/asterisk/sounds/he/ivr/welcome.<ext>
 *
 * `text` is the Hebrew script for the recording. It is the single source of
 * truth for what has to be recorded - `npm run prompts:list` prints it as a
 * recording sheet. Keep the two in sync; a prompt with no matching file is
 * silence on a live call.
 */
export const PROMPTS = {
  welcome: {
    file: 'ivr/welcome',
    text: 'שלום, הגעתם למענה הקולי האוטומטי.',
  },
  mainMenu: {
    file: 'ivr/main-menu',
    text: 'לבירור סטטוס הזמנה, הקישו 1. לשעות הפעילות, הקישו 2. לשמיעת התפריט שוב, הקישו 9.',
  },
  askReference: {
    file: 'ivr/ask-reference',
    text: 'אנא הקישו את מספר ההזמנה בן שש הספרות, ולאחריו סולמית.',
  },
  invalidChoice: {
    file: 'ivr/invalid-choice',
    text: 'בחירה לא חוקית.',
  },
  noInput: {
    file: 'ivr/no-input',
    text: 'לא התקבלה בחירה.',
  },
  invalidReference: {
    file: 'ivr/invalid-reference',
    text: 'מספר ההזמנה שהקשתם אינו תקין.',
  },
  notFound: {
    file: 'ivr/not-found',
    text: 'לא נמצאה הזמנה עם המספר שהקשתם.',
  },
  lookupError: {
    file: 'ivr/lookup-error',
    text: 'אירעה תקלה בשליפת המידע. אנא נסו שוב מאוחר יותר.',
  },
  orderNumberIs: {
    file: 'ivr/order-number-is',
    text: 'מספר ההזמנה',
  },
  statusIs: {
    file: 'ivr/status-is',
    text: 'סטטוס ההזמנה',
  },
  statusNew: {
    file: 'ivr/status-new',
    text: 'התקבלה',
  },
  statusProcessing: {
    file: 'ivr/status-processing',
    text: 'בטיפול',
  },
  statusShipped: {
    file: 'ivr/status-shipped',
    text: 'נשלחה',
  },
  statusDelivered: {
    file: 'ivr/status-delivered',
    text: 'נמסרה',
  },
  statusCancelled: {
    file: 'ivr/status-cancelled',
    text: 'בוטלה',
  },
  officeHours: {
    file: 'ivr/office-hours',
    text: 'שעות הפעילות שלנו הן בימים ראשון עד חמישי, בין תשע בבוקר לחמש אחר הצהריים.',
  },
  anythingElse: {
    file: 'ivr/anything-else',
    text: 'לחזרה לתפריט הראשי, הקישו 1. לסיום השיחה, הקישו 2.',
  },
  tooManyRetries: {
    file: 'ivr/too-many-retries',
    text: 'לא הצלחנו לקלוט את בחירתכם. השיחה מסתיימת כעת.',
  },
  goodbye: {
    file: 'ivr/goodbye',
    text: 'תודה שפניתם אלינו. להתראות.',
  },
  /** Played by the dialplan when the application itself is unreachable. */
  systemUnavailable: {
    file: 'ivr/system-unavailable',
    text: 'המערכת אינה זמינה כרגע. אנא נסו שוב מאוחר יותר.',
  },
} as const satisfies Record<string, { file: string; text: string }>;

export type PromptKey = keyof typeof PROMPTS;
