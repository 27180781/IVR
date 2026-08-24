# הקמת השרת מאפס

השרת מריץ **שני** דברים: אסטריסק, ואפליקציית ה-IVR מהריפו הזה.
ראו `docs/architecture.md` להסבר למה הם על אותה מכונה.

בסיס מומלץ: Debian 12 או Ubuntu 22.04/24.04, 2 vCPU / 2GB RAM, **IP ציבורי
קבוע**. ה-IP הזה נכנס להגדרות טוויליו, אז הוא לא יכול להשתנות.

---

## 1. חומת אש

זה הצעד הראשון, לא האחרון. שרת SIP חשוף נסרק תוך שעות מרגע העלייה.

```bash
sudo apt update && sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp                       # SSH - הגבילו ל-IP שלכם אם אפשר

# SIP - רק מטוויליו. אמתו את הרשימה מול התיעוד העדכני של טוויליו.
for net in 54.172.60.0/30 54.244.51.0/30 54.171.127.192/30 35.156.191.128/30 \
           54.169.127.128/30 54.65.63.192/30 54.252.254.64/30 177.71.206.192/30; do
  sudo ufw allow from "$net" to any port 5060 proto udp
done

# RTP - טווח כתובות המדיה של טוויליו רחב יותר מטווח הסיגנלינג.
sudo ufw allow from 168.86.128.0/18 to any port 10000:20000 proto udp

sudo ufw enable
sudo ufw status numbered
```

> אם ה-VM אצל ספק ענן, צריך לפתוח את אותם פורטים גם ב-Security Group שלו.
> חומת אש מקומית לבדה לא תספיק.

---

## 2. התקנת אסטריסק

```bash
sudo apt install -y asterisk
asterisk -rx 'core show version'
```

חבילת הדיסטרו מספיקה לחלוטין לשלב הזה. אם תרצו גרסת LTS ספציפית, בנו
מהמקור לפי התיעוד הרשמי — אבל אל תעשו את זה רק בשביל "לקבל את החדש".

מודולים נדרשים (בדרך כלל מותקנים כברירת מחדל):

```bash
sudo asterisk -rx 'module show like res_ari'
sudo asterisk -rx 'module show like res_pjsip'
```

---

## 3. התקנת Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # צריך 20 ומעלה
```

---

## 4. פריסת הקונפיג של אסטריסק

הקונפיג חי בריפו, לא בשרת. ככה אפשר לדעת מה השתנה ומתי.

```bash
sudo mkdir -p /opt/ivr && sudo chown "$USER" /opt/ivr
git clone https://github.com/27180781/ivr.git /opt/ivr
cd /opt/ivr

cp asterisk/asterisk.env.example asterisk/asterisk.env
# ערכו: PUBLIC_IP, ARI_PASSWORD (מחרוזת ארוכה ואקראית)
openssl rand -hex 24        # לייצור הסיסמה

sudo ./scripts/deploy-asterisk.sh
```

הסקריפט מגבה את הקונפיג הקיים, מרנדר את התבניות ועושה reload ממוקד
שלא מנתק שיחות פעילות.

---

## 5. הקלטת ההודעות

```bash
npm install
npm run prompts:list
```

מדפיס את דף ההקלטות: לכל הודעה, השם שהקובץ צריך לקבל והטקסט בעברית.
הקבצים נשמרים תחת `/var/lib/asterisk/sounds/he/ivr/`.

פורמט: WAV, PCM 16-bit, **8000 Hz, mono**. המרה מכל מקור:

```bash
ffmpeg -i raw.mp3 -ar 8000 -ac 1 -c:a pcm_s16le welcome.wav
sudo mkdir -p /var/lib/asterisk/sounds/he/ivr
sudo cp welcome.wav /var/lib/asterisk/sounds/he/ivr/
sudo chown -R asterisk:asterisk /var/lib/asterisk/sounds/he
```

בנוסף צריך את **ערכת הצלילים העברית של אסטריסק** (`he/digits/*`) כדי
שהקראת מספרים תעבוד. היא לא מגיעה עם ההתקנה הסטנדרטית ויש להשיג או להקליט
אותה בנפרד — ספרות 0-9 הן המינימום ההכרחי לזרימה הנוכחית.

---

## 6. הרצת האפליקציה

```bash
cd /opt/ivr
cp .env.example .env
# ערכו: ARI_PASSWORD - חייב להיות זהה לזה שב-asterisk/asterisk.env
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

הבדיקה הקריטית היא זו:

```bash
sudo asterisk -rx 'ari show apps'
# חייב להופיע: ivr-app
```

אם `ivr-app` מופיע — האפליקציה מחוברת ואסטריסק יודע להעביר אליה שיחות.
אם לא:

```bash
journalctl -u ivr-app -f          # מה האפליקציה אומרת
sudo asterisk -rx 'ari show status'
sudo asterisk -rx 'http show status'   # צריך להאזין על 127.0.0.1:8088
```

לצפייה בשיחה חיה:

```bash
sudo asterisk -rvvv
# בתוך ה-CLI:
pjsip set logger on      # לראות SIP נכנס
core set verbose 5
```

---

## תחזוקה שוטפת

- **טווחי ה-IP של טוויליו משתנים.** בדקו אותם מול התיעוד מדי כמה חודשים
  ועדכנו גם ב-`pjsip.conf` וגם ב-ufw. רשימה מיושנת = שיחות שנופלות.
- **`fail2ban`** עם ה-jail של אסטריסק, כשכבה נוספת מעל ה-ACL.
- **גיבוי** של `/etc/asterisk/backup-*` ושל `data/calls.jsonl`.
