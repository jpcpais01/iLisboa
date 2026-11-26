// Home-screen app behaviour: service worker, status-bar colour that follows day/night,
// an install hint (Android prompt or iOS "Adicionar ao ecrã principal"), and an honest offline screen.
const root = document.documentElement;
const standalone = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
root.classList.toggle('standalone', standalone);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// browser chrome / Android status bar follows the scene: warm cream by day, navy after dusk
const theme = document.querySelector('meta[name="theme-color"]');
const syncTheme = () => theme.setAttribute('content', document.body.classList.contains('night') ? '#1c2230' : '#efe7da');
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// iOS ignores maximum-scale: stop pinch-zoom of the page itself (the map handles its own pinch)
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

// offline: the shell opens, but the city streams from the network — say so instead of spinning forever
const loading = document.getElementById('loading');
const note = loading.querySelector('span');
const offline = () => { if (!loading.classList.contains('done')) { loading.classList.add('offline'); note.textContent = 'Sem ligação. O iLisboa precisa de internet para carregar a cidade.'; } };
if (!navigator.onLine) offline();
addEventListener('offline', offline);
// a failed first fetch (index.json) while still loading means no network, whatever navigator.onLine says
const failed = (m) => /fetch|network|load failed/i.test(String(m)) && offline();
addEventListener('error', (e) => failed(e.message));
addEventListener('unhandledrejection', (e) => failed(e.reason?.message || e.reason));
addEventListener('online', () => { if (loading.classList.contains('offline')) location.reload(); });
if (loading.classList.contains('offline') === false) setInterval(() => { if (loading.classList.contains('offline')) fetch('/manifest.webmanifest', { cache: 'no-store' }).then(() => location.reload(), () => {}); }, 5000);

// install hint: once, after the city is up, only on phones/tablets in the browser
const KEY = 'ilisboa.install.dismissed';
const seen = () => { try { return localStorage.getItem(KEY); } catch { return '1'; } };
const remember = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch {} };
const ios = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const touch = matchMedia('(pointer: coarse)').matches;
let deferred = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; });
addEventListener('appinstalled', () => { remember(); document.querySelector('.install')?.remove(); });

const SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
function hint() {
  if (standalone || !touch || seen() || (!ios && !deferred)) return;
  const el = document.createElement('div');
  el.className = 'install'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Instalar iLisboa');
  el.innerHTML = `<img src="/icons/icon-96.png" alt="" width="40" height="40"><div><b>Instalar iLisboa</b><small>${
    ios ? `Toca em ${SHARE} e depois em <em>Adicionar ao ecrã principal</em>.` : 'Abre como uma app, em ecrã inteiro.'}</small></div>${
    ios ? '' : '<button class="go" type="button">Instalar</button>'}<button class="x" type="button" aria-label="Fechar">×</button>`;
  const close = () => { remember(); el.classList.remove('in'); setTimeout(() => el.remove(), 400); };
  el.querySelector('.x').onclick = close;
  el.querySelector('.go')?.addEventListener('click', async () => { deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; close(); });
  document.body.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  setTimeout(() => el.isConnected && el.classList.remove('in'), 20000);   // fades out without being "dismissed", comes back next visit
}
new MutationObserver((_, o) => { if (loading.classList.contains('done')) { o.disconnect(); setTimeout(hint, 3500); } }).observe(loading, { attributes: true });
