# הקמת השרת מאפס

השרת מריץ **שני** דברים: אסטריסק, ואפליקציית ה‑IVR מהריפו הזה.
ראו `docs/architecture.md` להסבר למה הם על אותה מכונה.

בסיס מומלץ: Ubuntu 24.04 LTS או Debian 12, 2 vCPU / 2GB RAM,
**IP ציבורי קבוע**. ה‑IP נכנס להגדרות טוויליו, אז הוא לא יכול להשתנות.

> כל הפקודות והפלטים במסמך אומתו על Ubuntu 24.04 עם Asterisk 20.6.

---

## 1. חומת אש — לפני ההתקנה

זה הצעד הראשון, לא האחרון. שרת SIP חשוף נסרק תוך שעות מרגע העלייה, ואם
מישהו מצליח לחייג דרכו — החשבון שסופג את החיוב הוא שלכם.

```bash
sudo apt update && sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp                       # SSH — הגבילו ל-IP שלכם אם אפשר

# SIP — רק מטוויליו. אמתו את הרשימה מול התיעוד העדכני של טוויליו.
for net in 54.172.60.0/30 54.244.51.0/30 54.171.127.192/30 35.156.191.128/30 \
           54.169.127.128/30 54.65.63.192/30 54.252.254.64/30 177.71.206.192/30; do
  sudo ufw allow from "$net" to any port 5060 proto udp
done

# RTP — טווח כתובות המדיה של טוויליו רחב יותר מטווח הסיגנלינג.
sudo ufw allow from 168.86.128.0/18 to any port 10000:20000 proto udp

sudo ufw enable
sudo ufw status numbered
```

> אם ה‑VM אצל ספק ענן, צריך לפתוח את אותם פורטים גם ב‑Security Group שלו.
> חומת אש מקומית לבדה לא תספיק.

---

## 2. התקנת אסטריסק

### מה מגיע מהמאגר

בדקו לפני ההתקנה איזו גרסה תקבלו:

```bash
apt-cache policy asterisk
```

ב‑Ubuntu 24.04 התשובה היא `1:20.6.0` — כלומר **Asterisk 20, שהיא גרסת
LTS**. זה בדיוק מה שרוצים לייצור: תיקוני אבטחה לאורך שנים, בלי לרדוף אחרי
גרסאות. אין שום סיבה לבנות מהמקור.

> ב‑Ubuntu החבילה נמצאת ב‑`universe`. אם `apt-cache policy` מחזיר ריק:
> `sudo add-apt-repository universe && sudo apt update`

### ההתקנה עצמה

```bash
sudo apt install -y asterisk
```

זה מושך גם את `asterisk-modules` (שם נמצאים `res_ari` ו‑`res_pjsip`),
את `asterisk-config`, יוצר את המשתמש `asterisk`, ומתקין יחידת systemd
שכבר מופעלת אוטומטית.

```bash
sudo systemctl status asterisk
sudo asterisk -rx 'core show version'
```

### ודאו שהמודולים שאנחנו צריכים קיימים

```bash
sudo asterisk -rx 'module show like res_ari'      # מנוע ה-ARI
sudo asterisk -rx 'module show like res_pjsip'    # מחסנית ה-SIP
```

בשלב הזה חלקם יופיעו כ‑`Not Running` — זה תקין, `ari.conf` המקורי מגיע
מושבת. שלב 4 מפעיל אותם.

---

## 3. התקנת Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # צריך 20 ומעלה
```

---

## 4. פריסת הקונפיג

הקונפיג חי בריפו, לא בשרת. ככה אפשר לדעת מה השתנה ומתי.

```bash
sudo mkdir -p /opt/ivr && sudo chown "$USER" /opt/ivr
git clone https://github.com/27180781/IVR.git /opt/ivr
cd /opt/ivr

cp asterisk/asterisk.env.example asterisk/asterisk.env
openssl rand -hex 24        # לייצור ARI_PASSWORD
# ערכו: PUBLIC_IP, ARI_PASSWORD

sudo ./scripts/deploy-asterisk.sh
```

הסקריפט מגבה את הקונפיג הקיים, מרנדר את התבניות, מתקין אותן
כ‑`root:asterisk` במצב `640`, ועושה reload ממוקד שלא מנתק שיחות פעילות.

> **ההרשאות הן לא פרט טכני.** אסטריסק רץ כמשתמש `asterisk`. אם `ari.conf`
> שייך ל‑`root:root` במצב `640` — אסטריסק פשוט לא יכול לקרוא אותו, וכל
> מודולי ה‑ARI **ידחו טעינה בשקט**. בלוג זה נראה כך:
>
> ```
> ERROR config_options.c: Unable to load config file 'ari.conf'
> ERROR loader.c: res_ari declined to load.
> ```
>
> ואז `ari show apps` יחזיר "No such command" — מה שנראה כמו אסטריסק
> שבור, אבל זו רק בעיית הרשאות. הסקריפט מטפל בזה.

---

## 5. הקלטת ההודעות

```bash
npm install
npm run prompts:list
```

מדפיס את דף ההקלטות: לכל הודעה, הנתיב המדויק והטקסט בעברית.

### הנתיב הנכון — שימו לב

אסטריסק מחפש קבצי קול תחת **`astdatadir`**, ולא תחת `/var/lib/asterisk`
כפי שכתוב בהרבה מדריכים. ב‑Debian ו‑Ubuntu:

```bash
grep astdatadir /etc/asterisk/asterisk.conf
# astdatadir => /usr/share/asterisk
```

כלומר הקבצים הולכים ל‑**`/usr/share/asterisk/sounds/he/`**. שתי התיקיות
קיימות במערכת, וזו טעות שקטה במיוחד: השיחה תתחבר, האפליקציה תדווח שהכל
תקין, והמתקשר ישמע שקט מוחלט.

```bash
ffmpeg -i raw.mp3 -ar 8000 -ac 1 -c:a pcm_s16le welcome.wav
sudo mkdir -p /usr/share/asterisk/sounds/he/ivr
sudo cp welcome.wav /usr/share/asterisk/sounds/he/ivr/
sudo chown -R asterisk:asterisk /usr/share/asterisk/sounds/he
```

### ערכת הספרות העברית

הקראת מספרים (`digits:100003`) נשענת על קבצי ספרות בעברית תחת
`/usr/share/asterisk/sounds/he/digits/`. **אין חבילת קול עברית במאגרים** —
`apt-cache search asterisk-core-sounds` מחזיר אנגלית, ספרדית, צרפתית,
איטלקית ורוסית בלבד. את `0.wav` עד `9.wav` תצטרכו להקליט בעצמכם.

בלעדיהם ההודעות הקבועות יתנגנו, אבל המערכת תשתוק במקום להקריא את מספר
ההזמנה.

---

## 6. הרצת האפליקציה

```bash
cd /opt/ivr
cp .env.example .env
# ערכו: ARI_PASSWORD — חייב להיות זהה לזה שב-asterisk/asterisk.env
npm ci
npm run build

sudo useradd --system --home /opt/ivr --shell /usr/sbin/nologin ivr || true
sudo chown -R ivr:ivr /opt/ivr
sudo chmod 600 /opt/ivr/.env

sudo cp deploy/ivr-app.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ivr-app
```

---

## 7. אימות

```bash
./scripts/verify-asterisk.sh
```

עובר על כל השרשרת ואומר איזו חוליה שבורה. הבדיקה הקריטית היא זו:

```bash
sudo asterisk -rx 'ari show apps'
# חייב להופיע: ivr-app
```

אם `ivr-app` מופיע — האפליקציה מחוברת ואסטריסק יודע להעביר אליה שיחות.
אם לא:

```bash
journalctl -u ivr-app -f
sudo asterisk -rx 'module show like res_ari.so'   # Running או Not Running?
sudo asterisk -rx 'http show status'              # 127.0.0.1:8088
```

### בדיקת שיחה בלי טוויליו

אפשר להזריק שיחה לזרימה ישירות מה‑CLI, עוד לפני שהטראנק מוגדר:

```bash
sudo asterisk -rx 'channel originate Local/+972500000000@from-twilio application Wait 40'
journalctl -u ivr-app -f
```

אמורים לראות בלוג את מסלול השיחה: `welcome` → `mainMenu` → נסיונות חוזרים
→ `tooManyRetries`. אם זה עובד, כל הצד של השרת תקין ומה שנשאר הוא טוויליו.

---

## תחזוקה שוטפת

- **טווחי ה‑IP של טוויליו משתנים.** בדקו מדי כמה חודשים ועדכנו גם
  ב‑`pjsip.conf` וגם ב‑ufw. רשימה מיושנת = שיחות שנופלות.
- **שדרוגי חבילה.** קבצי `/etc/asterisk/*.conf` הם conffiles של החבילה.
  מכיוון שהחלפנו אותם, `apt upgrade` ישאל אם לשמור את הגרסה שלכם. ענו
  "שמור" — ואז הריצו שוב את `deploy-asterisk.sh` כדי לוודא התאמה.
- **`fail2ban`** עם ה‑jail של אסטריסק, כשכבה נוספת מעל ה‑ACL.
- **גיבוי** של `/etc/asterisk/backup-*` ושל `data/calls.jsonl`.
