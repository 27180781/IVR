# הגדרת Twilio Elastic SIP Trunking

המטרה: להביא שיחות מהמספר שלכם אל האסטריסק, וכלום מעבר לזה. טוויליו לא
תדע ולא תצטרך לדעת מה ה-IVR עושה.

> **שימו לב להבחנה.** Elastic SIP Trunking ו-Programmable Voice הם שני
> מוצרים שונים באותו חשבון. אם המספר מוגדר עם Voice Webhook — הוא ב-
> Programmable Voice, וההגדרות למטה לא יחולו עליו. השלב 4 הוא זה שמעביר
> את המספר לטראנק.

---

## 1. יצירת הטראנק

Twilio Console → **Elastic SIP Trunking** → **Trunks** → **Create new SIP Trunk**.
תנו שם (למשל `ivr-prod`).

## 2. Origination — הכיוון שמעניין אותנו

זהו הנתיב מטוויליו אל השרת שלכם: שיחות **נכנסות**.

בטראנק → **Origination** → **Add new Origination URI**:

```
sip:<PUBLIC_IP_OF_ASTERISK>:5060;transport=udp
```

- Priority: `10`, Weight: `10`
- Enabled: כן

השתמשו ב-IP ולא בשם דומיין, אלא אם יש לכם רשומת DNS יציבה.

## 3. Termination — רק אם תרצו שיחות יוצאות

בטראנק → **Termination**. הגדירו Termination SIP Domain
(`your-trunk.pstn.twilio.com`) ו-**IP Access Control List** שמכיל את ה-IP
של השרת. בלי ACL, טוויליו לא תקבל מכם שיחות יוצאות.

לשלב הנוכחי זה לא נדרש — ה-IVR רק עונה. הקונפיג ב-`pjsip.conf` מוכן לזה
מראש.

## 4. חיבור המספר לטראנק

זה הצעד שקל לפספס. Console → **Phone Numbers** → המספר שלכם →
**Voice Configuration** → **Configure with**: בחרו את הטראנק שיצרתם.

כל עוד המספר מוגדר כ-Webhook/TwiML — Origination לא ייכנס לתמונה בכלל.

## 5. אבטחה

טוויליו **לא** מאמתת את הטראנק מולכם עם סיסמה בכיוון הנכנס — הזיהוי הוא
לפי כתובת IP. לכן ההגנה שלכם היא:

1. `type=identify` ב-`pjsip.conf` — מקבל SIP רק מהרשתות של טוויליו
2. `ufw` — חוסם את הפורט לכל השאר
3. Security Group של ספק הענן

שלושתם, לא אחד מהם. שרת SIP פתוח הוא יעד להונאות חיוג בינלאומי, והחשבון
שסופג את החיוב הוא שלכם.

## 6. בדיקה

התקשרו למספר. במקביל, על השרת:

```bash
sudo asterisk -rvvv
pjsip set logger on
```

מה שאמור להיראות:

```
<--- Received SIP request (INVITE) from UDP:54.172.60.x --->
    -- Executing [+9725xxxxxxx@from-twilio:1] NoOp(...)
    -- Executing [+9725xxxxxxx@from-twilio:3] Stasis("PJSIP/twilio-00000001", "ivr-app,...")
```

### תקלות נפוצות

| מה קורה | הסיבה הכי סבירה |
|---------|------------------|
| השיחה מנותקת מיד, אין SIP בלוג | Origination URI שגוי, או המספר עדיין על Webhook |
| מגיע INVITE אבל נדחה 401/403 | ה-IP של טוויליו לא ברשימת ה-`identify` |
| השיחה נענית, אין אודיו בכלל | `external_media_address` לא מוגדר ל-IP הציבורי |
| אודיו בכיוון אחד | פורטי RTP (10000-20000/UDP) חסומים בחומת אש או ב-Security Group |
| ההודעות לא מתנגנות, השיחה שותקת | קבצי הקול חסרים, או הונחו תחת `/var/lib/asterisk/sounds` במקום `/usr/share/asterisk/sounds` |
| DTMF לא נקלט | `dtmf_mode` שונה מ-`rfc4733` |
