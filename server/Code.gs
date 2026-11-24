/**
 * שרת הנתונים של מערכת המשימות – ג. בן עטר בע"מ
 * הנתונים נשמרים בקובץ JSON בתיקיית Google Drive של המשרד, עם גיבוי יומי אוטומטי (30 יום אחורה).
 * רק מי שיודע את קוד הגישה יכול לקרוא או לשנות.
 * קוד הגישה לא כתוב כאן: הקוד הראשון שמוזן באפליקציה אחרי ההתקנה נשמר בהגדרות הסקריפט והופך לקוד של המשרד.
 * להחלפת הקוד: בעורך Apps Script ← הגדרות הפרויקט ← מאפייני סקריפט ← מחק את accessKey, והזן קוד חדש באפליקציה.
 */
const DATA_FOLDER = 'מערכת משימות - נתונים';   // התיקייה ב-Google Drive שבה נשמרים הנתונים והגיבויים
const BACKUP_DAYS = 30;

function doGet() {
  return ContentService.createTextOutput('שרת מערכת המשימות פעיל.');
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return out_({ ok: false, code: 'invalid_argument' }); }
  if (!req || !checkKey_(req)) return out_({ ok: false, code: 'unauthenticated' });
  try {
    switch (req.op) {
      case 'ping': dataFile_(); return out_({ ok: true });
      case 'list': {
        const db = read_();
        if (req.rev != null && req.rev === db.rev) return out_({ ok: true, unchanged: true, rev: db.rev });
        const docs = Object.keys(db.docs).map(p => ({ path: p, data: db.docs[p].data }));
        return out_({ ok: true, rev: db.rev, docs: docs });
      }
      case 'import': {
        // טעינה ראשונה מקובץ גיבוי – רק כשהשרת עדיין ריק, כדי שלא יידרסו נתונים קיימים
        const lock = LockService.getScriptLock();
        if (!lock.tryLock(20000)) return out_({ ok: false, code: 'unavailable' });
        try {
          const db = read_();
          if (Object.keys(db.docs).some(p => p.indexOf('topics/') === 0)) return out_({ ok: false, code: 'already_exists' });
          (req.docs || []).forEach(d => { if (validPath_(d.path)) db.docs[d.path] = { data: d.data, updatedAt: new Date().toISOString() }; });
          db.rev = (db.rev || 0) + 1;
          write_(db);
          return out_({ ok: true, rev: db.rev });
        } finally { lock.releaseLock(); }
      }
      case 'set':
      case 'delete': {
        if (!validPath_(req.path)) return out_({ ok: false, code: 'invalid_argument' });
        const lock = LockService.getScriptLock();
        if (!lock.tryLock(20000)) return out_({ ok: false, code: 'unavailable' });
        try {
          const db = read_();
          backupOncePerDay_(db);
          if (req.op === 'set') db.docs[req.path] = { data: req.data, updatedAt: new Date().toISOString() };
          else delete db.docs[req.path];
          db.rev = (db.rev || 0) + 1;
          write_(db);
          return out_({ ok: true, rev: db.rev });
        } finally { lock.releaseLock(); }
      }
      default: return out_({ ok: false, code: 'invalid_argument' });
    }
  } catch (err) {
    return out_({ ok: false, code: 'unavailable', message: String(err) });
  }
}

function checkKey_(req) {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('accessKey');
  if (saved) return req.key === saved;
  // עדיין אין קוד: הכניסה הראשונה קובעת אותו (לפחות 8 תווים)
  if (req.op === 'ping' && typeof req.key === 'string' && req.key.trim().length >= 8) {
    props.setProperty('accessKey', req.key);
    return true;
  }
  return false;
}

function validPath_(p) { return typeof p === 'string' && /^(topics|settings)\/[A-Za-z0-9_-]{1,40}$/.test(p); }

// קובץ הנתונים נוצר אוטומטית בפעם הראשונה
function dataFile_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('dataFileId');
  if (id) return DriveApp.getFileById(id);
  const it = DriveApp.getFoldersByName(DATA_FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(DATA_FOLDER);
  const f = folder.createFile('נתוני משימות.json', JSON.stringify({ rev: 0, docs: {} }), 'application/json');
  props.setProperty('dataFileId', f.getId());
  return f;
}

function read_() {
  const text = dataFile_().getBlob().getDataAsString('UTF-8');
  const db = text ? JSON.parse(text) : {};
  db.docs = db.docs || {};
  db.rev = db.rev || 0;
  return db;
}
function write_(db) {
  dataFile_().setContent(JSON.stringify(db));
}

// לפני השינוי הראשון בכל יום – שומר עותק של הנתונים בתיקיית "גיבויים", ומוחק גיבויים בני יותר מ-30 יום
function backupOncePerDay_(db) {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
  if (props.getProperty('lastBackup') === today) return;
  const file = dataFile_();
  const parent = file.getParents().hasNext() ? file.getParents().next() : DriveApp.getRootFolder();
  const it = parent.getFoldersByName('גיבויים');
  const folder = it.hasNext() ? it.next() : parent.createFolder('גיבויים');
  folder.createFile('משימות-גיבוי-' + today + '.json', JSON.stringify(db), 'application/json');
  const cutoff = Date.now() - BACKUP_DAYS * 86400000;
  const files = folder.getFiles();
  while (files.hasNext()) { const f = files.next(); if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true); }
  props.setProperty('lastBackup', today);
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// להרצה ידנית מהעורך: בודק שהשרת קורא את הקובץ ומדפיס כמה משימות יש
function checkData() {
  const db = read_();
  let n = 0;
  Object.keys(db.docs).forEach(p => { if (p.indexOf('topics/') === 0) n += (db.docs[p].data.tasks || []).length; });
  Logger.log('תחומים: ' + Object.keys(db.docs).filter(p => p.indexOf('topics/') === 0).length + ', משימות: ' + n);
}
