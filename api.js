/* חיבור הדשבורד לשרת הנתונים ב-Google (Apps Script).
   מספק לדף את אותו ממשק שהיה לו בתוך Claude: window.claude.use('db').
   הנתונים עצמם לא נמצאים באתר הזה – רק בחשבון Google של המשרד, מאחורי קוד גישה. */
(function () {
  const KEY_STORE = 'taskDashboard.accessKey';
  const CACHE_STORE = 'taskDashboard.cache';
  const POLL_MS = 20000;
  const API = (window.APP_CONFIG && window.APP_CONFIG.apiUrl) || '';

  let accessKey = localStorage.getItem(KEY_STORE) || '';
  let docs = new Map();     // path -> data
  let rev = null;
  let loaded = false;
  const listeners = new Set();
  let pollTimer = null;

  function apiError(code, message) { const e = new Error(message || code); e.code = code; return e; }

  async function call(op, body) {
    if (!API) throw apiError('unavailable', 'no api url');
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // בלי preflight
        body: JSON.stringify(Object.assign({ op, key: accessKey }, body || {})),
        redirect: 'follow'
      });
    } catch (e) { throw apiError('unavailable', 'network'); }
    let out;
    try { out = await res.json(); } catch (e) { throw apiError('unavailable', 'bad response'); }
    if (!out.ok) {
      if (out.code === 'unauthenticated') { showLogin('קוד הגישה שגוי או שהוחלף. הזן את הקוד מחדש.'); }
      throw apiError(out.code || 'unavailable', out.message);
    }
    return out;
  }

  function saveCache() {
    try { localStorage.setItem(CACHE_STORE, JSON.stringify({ rev, docs: [...docs] })); } catch (e) { /* מלא */ }
  }
  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_STORE));
      if (c && Array.isArray(c.docs)) { docs = new Map(c.docs); return true; }
    } catch (e) { /* אין */ }
    return false;
  }

  function snapshotFor(collection, fromCache) {
    const prefix = collection + '/';
    const list = [...docs].filter(([p]) => p.startsWith(prefix) && p.indexOf('/', prefix.length) === -1)
      .map(([p, d]) => ({ id: p.slice(prefix.length), data: () => d }));
    return { docs: list, metadata: { fromCache } };
  }
  function emit(fromCache) {
    listeners.forEach(l => { try { l.cb(snapshotFor(l.collection, fromCache)); } catch (e) { console.error(e); } });
  }

  async function refresh() {
    const out = await call('list', { rev });
    if (!out.unchanged) {
      docs = new Map(out.docs.map(d => [d.path, d.data]));
      rev = out.rev; saveCache();
      loaded = true; emit(false);
      if (![...docs.keys()].some(p => p.startsWith('topics/'))) showRestore();
    } else if (!loaded) { loaded = true; emit(false); }
    setOffline(false);
  }
  async function poll() {
    clearTimeout(pollTimer);
    if (document.visibilityState === 'visible' && accessKey) {
      try { await refresh(); }
      catch (e) {
        if (e.code === 'unavailable') setOffline(true);
        else listeners.forEach(l => l.err && l.err(e));
      }
    }
    pollTimer = setTimeout(poll, POLL_MS);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  window.addEventListener('online', () => poll());

  function setOffline(on) {
    let el = document.getElementById('offlineBar');
    if (!el) {
      el = document.createElement('div'); el.id = 'offlineBar';
      el.textContent = 'אין חיבור לשרת – מוצגים הנתונים האחרונים שנשמרו במכשיר. שינויים חדשים יישמרו רק כשהחיבור יחזור.';
      document.body.prepend(el);
    }
    el.hidden = !on;
  }

  function docRef(path) {
    return {
      async get() {
        if (!loaded) { try { await refresh(); } catch (e) { if (!docs.size) throw e; } }
        const d = docs.get(path);
        return { exists: d !== undefined, data: () => d };
      },
      async set(data) {
        const clean = JSON.parse(JSON.stringify(data));
        const out = await call('set', { path, data: clean });
        docs.set(path, clean); rev = out.rev; saveCache();
        return true;
      },
      async delete() {
        const out = await call('delete', { path });
        docs.delete(path); rev = out.rev; saveCache();
        return true;
      },
      async acquire() { return { acquired: true, release() {} }; }
    };
  }

  const db = {
    doc: docRef,
    collection(name) {
      return {
        onSnapshot(cb, err) {
          const l = { collection: name, cb, err };
          listeners.add(l);
          // אם הנתונים כבר הגיעו מהשרת – מוסרים אותם מיד כמאושרים; אחרת מציגים את מה שנשמר במכשיר עד שיגיעו
          if (loaded) setTimeout(() => cb(snapshotFor(name, false)), 0);
          else if (docs.size) setTimeout(() => cb(snapshotFor(name, true)), 0);
          if (!pollTimer) poll();
          return () => listeners.delete(l);
        }
      };
    }
  };

  /* ===== טעינה ראשונה מקובץ גיבוי (רק כשהשרת ריק) ===== */
  function showRestore() {
    if (document.getElementById('restoreScreen')) return;
    const box = document.createElement('div');
    box.id = 'restoreScreen';
    box.innerHTML = `<form><img src="icon-192.png" alt=""><h2>טעינת המשימות הקיימות</h2>
      <p class="muted" style="margin:0;line-height:1.6">השרת עדיין ריק. בחר את קובץ הגיבוי ("גיבוי משימות - ….json") שהורדת מהדשבורד הקודם.</p>
      <label class="btn primary" style="justify-content:center;padding:10px">בחירת קובץ גיבוי<input type="file" accept=".json,application/json" hidden></label>
      <div class="msg"></div></form>`;
    document.body.appendChild(box);
    const msg = box.querySelector('.msg');
    box.querySelector('input').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      msg.textContent = 'טוען...';
      try {
        const b = JSON.parse(await f.text());
        if (!b || !Array.isArray(b.topics) || !b.topics.length) throw new Error('bad');
        const list = b.topics.map(tp => ({ path: 'topics/' + tp.id, data: { name: tp.name, tasks: tp.tasks || [], updatedAt: new Date().toISOString() } }));
        list.push({ path: 'settings/main', data: { responseDays: b.responseDays || 14, stages: b.stages || null } });
        const n = b.topics.reduce((a, tp) => a + (tp.tasks || []).length, 0);
        await call('import', { docs: list });
        rev = null; await refresh();
        box.remove();
        alert(`נטענו ${b.topics.length} תחומים ו-${n} משימות.`);
        location.reload();
      } catch (err) {
        msg.textContent = err.code === 'already_exists' ? 'כבר יש נתונים בשרת – הטעינה בוטלה.' : 'הקובץ לא תקין או שאין חיבור. נסה שוב.';
      }
    });
  }

  /* ===== מסך כניסה עם קוד גישה ===== */
  let loginResolve = null;
  function showLogin(msg) {
    accessKey = ''; localStorage.removeItem(KEY_STORE);
    const box = document.getElementById('loginScreen');
    document.getElementById('loginMsg').textContent = msg || '';
    box.hidden = false;
    setTimeout(() => document.getElementById('loginKey').focus(), 50);
  }
  function waitForKey() {
    return new Promise(resolve => {
      loginResolve = resolve;
      showLogin('');
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const k = document.getElementById('loginKey').value.trim();
      if (!k) return;
      const btn = form.querySelector('button'); btn.disabled = true;
      document.getElementById('loginMsg').textContent = 'בודק...';
      accessKey = k;
      try {
        await call('ping');
        localStorage.setItem(KEY_STORE, k);
        document.getElementById('loginScreen').hidden = true;
        if (loginResolve) { loginResolve(); loginResolve = null; }
        else poll();
      } catch (err) {
        document.getElementById('loginMsg').textContent =
          err.code === 'unauthenticated' ? 'קוד שגוי. נסה שוב.' : 'אין חיבור לשרת. בדוק אינטרנט ונסה שוב.';
        accessKey = '';
      } finally { btn.disabled = false; }
    });
    const out = document.getElementById('btnLogout');
    if (out) out.addEventListener('click', () => {
      if (!confirm('לצאת מהמכשיר הזה? תצטרך להזין שוב את קוד הגישה.')) return;
      localStorage.removeItem(CACHE_STORE); showLogin('');
    });
  });

  loadCache();
  window.claude = {
    async use(cap) {
      if (cap === 'db') { if (!accessKey) await waitForKey(); return db; }
      if (cap === 'user') return { can: async () => true };
      throw apiError('not_available');
    }
  };

  /* ===== אפליקציה: עבודה גם בלי אינטרנט ===== */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
