# IVR

מערכת מענה קולי מבוססת Asterisk, שמקבלת שיחות מקו Twilio דרך
Elastic SIP Trunking. כל לוגיקת השיחה חיה בריפו הזה כאפליקציית
TypeScript שמדברת עם אסטריסק דרך ARI.

```
מתקשר ──PSTN──► Twilio SIP Trunk ──SIP/RTP──► Asterisk ──ARI──► האפליקציה ──HTTPS──► המערכת העסקית
```

אסטריסק מטפל בטלפוניה ובאודיו בלבד. הוא לא מקבל אף החלטה — ה-dialplan
כולו הוא שורה אחת שמעבירה את השיחה לאפליקציה.

**האפליקציה רצה על אותו שרת של אסטריסק**, ומתחברת אליו על `127.0.0.1`.
ההסבר המלא ב-[`docs/architecture.md`](docs/architecture.md).

## תיעוד

| מסמך | תוכן |
|------|------|
| [`docs/architecture.md`](docs/architecture.md) | איך זה עובד, ולמה כל רכיב נמצא שם |
| [`docs/deployment.md`](docs/deployment.md) | פריסה על דרופלט, ופריסות אוטומטיות מגיטהאב |
| [`docs/server-setup.md`](docs/server-setup.md) | הקמת השרת ידנית, צעד־צעד |
| [`docs/twilio-setup.md`](docs/twilio-setup.md) | הגדרת הטראנק והמספר |

## פריסה בפקודה אחת

```bash
ssh root@<droplet-ip>
apt update && apt install -y git
git clone https://github.com/27180781/IVR.git /opt/ivr
cd /opt/ivr && ./scripts/bootstrap-server.sh
```

פריסות שוטפות: `sudo ./scripts/deploy.sh`, או אוטומטית בכל מיזוג ל־`main`
דרך `.github/workflows/deploy.yml`. הפרטים ב־[`docs/deployment.md`](docs/deployment.md).

## הזרימה הנוכחית

```
ברוכים הבאים
      │
      ▼
  תפריט ראשי ─── 1 ──► הקשת מספר הזמנה (6 ספרות + #)
      │                        │
      │                        ▼
      │                  שליפה מהמערכת
      │                   │    │    │
      │              נמצא │    │    │ תקלה
      │                   │    │ לא נמצא
      │                   ▼    ▼    ▼
      ├─── 2 ──► שעות פעילות ──► "משהו נוסף?" ──► סיום
      │
      └─── 9 ──► חזרה על התפריט
```

הכל ב-DTMF. אין זיהוי דיבור בשלב הזה — זו בחירה, לא חוסר: DTMF עובד
בכל מכשיר, בכל רעש רקע, ובלי עלות לדקה.

## פיתוח מקומי

```bash
npm install
cp .env.example .env
npm run dev
```

בלי אסטריסק זמין האפליקציה תעלה ותנסה להתחבר שוב ושוב — זו ההתנהגות
הנכונה, ואפשר לפתח כך את הזרימה. `DATA_SOURCE=mock` מספק הזמנות לדוגמה
במספרים `100001`–`100005`.

```bash
npm run typecheck     # בדיקת טיפוסים
npm run prompts:list  # דף ההקלטות: מה להקליט ואיך לקרוא לקבצים
npm run build         # קומפילציה ל-dist/
```

## מבנה הפרויקט

```
src/
  index.ts              נקודת הכניסה: מחבר הכל ומטפל בשיחה נכנסת
  config.ts             קריאת env ואימות סכימה - נכשל בעלייה, לא בשיחה
  ari/
    client.ts           החזקת החיבור לאסטריסק והתאוששות מניתוקים
    channel.ts          עטיפה על ערוץ בודד: ניגון, איסוף ספרות, ניתוק
  ivr/
    flow.ts             טיפוסי מכונת המצבים + ולידציה של המעברים
    engine.ts           המנוע שמריץ אותה
    prompts.ts          קטלוג ההודעות: מפתח -> קובץ + טקסט עברי
    flows/main.ts       הזרימה עצמה
  services/
    data.ts             DataSource: mock / HTTP
    speech.ts           SpeechProvider: קבצים מוקלטים היום, TTS מחר
  store/calls.ts        לוג שיחות ב-JSONL

asterisk/               קונפיג האסטריסק כקוד (נפרס בסקריפט)
scripts/                פריסה ואימות
deploy/                 יחידת systemd
```

## איפה נוגעים כדי לשנות משהו

| רוצים | הקובץ |
|-------|--------|
| לשנות את התפריט או להוסיף סעיף | `src/ivr/flows/main.ts` |
| לשנות נוסח הודעה | `src/ivr/prompts.ts` + הקלטה מחדש |
| להתחבר למערכת אמיתית | `.env`: `DATA_SOURCE=http` + `DATA_HTTP_URL` |
| להוסיף סוג צעד חדש (המתנה, העברה) | `src/ivr/flow.ts` + `src/ivr/engine.ts` |
| לגעת בטלפוניה עצמה | `asterisk/` ואז `scripts/deploy-asterisk.sh` |

## מצב

שלב 1. הבסיס עובד מקצה לקצה; מה שנשאר בכוונה בחוץ (TTS עברי, זיהוי דיבור,
מסד נתונים, ניתוב לנציגים, זמינות גבוהה) מפורט בסוף
[`docs/architecture.md`](docs/architecture.md).
