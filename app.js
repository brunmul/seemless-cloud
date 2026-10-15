// Seemless cloud : photos, musique et livres sur Google Drive, façon Apple Photos.
// Tout tourne dans le navigateur : OAuth Google puis API Drive v3.

// Accès complet à Drive : nécessaire pour créer des albums (dossiers),
// déplacer des photos et partager par lien.
const SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FOLDER_FIELDS = "id, name, parents, shared";

const state = {
  token: null,
  tokenClient: null,
  rootId: null,
  lib: { folders: [], photos: [], tracks: [], books: [] }, // données brutes Drive (mises en cache)
  folders: new Map(),       // id -> { id, name, parent, shared }
  photos: [],               // photos visibles (filtrées par les réglages), triées récentes d'abord
  photoAlbums: [],          // [{ id, name, path, photos, latest }]
  photosByFolder: new Map(),// toutes les photos par dossier (pochettes, onglet Drive)
  musicAlbums: [],          // [{ id, name, path, tracks }]
  tracks: [],
  view: { name: "library" },
  history: [],
  libraryMode: "months",
  query: "",
  queue: [], queueIndex: -1, shuffle: false,
  lightboxList: [], lightboxIndex: 0,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, one, many) => `${n.toLocaleString("fr-FR")} ${n > 1 ? many : one}`;

// ---------- Réglages (gardés dans ce navigateur) ----------

const settings = Object.assign(
  { sources: [], hideSmall: true },
  (() => { try { return JSON.parse(localStorage.getItem("mcm-settings")) || {}; } catch { return {}; } })(),
);
// Une source sans identifiant (bug d'une version précédente) est inutilisable.
settings.sources = (settings.sources || []).filter((s) => s && s.id);
function saveSettings() {
  try { localStorage.setItem("mcm-settings", JSON.stringify(settings)); } catch {}
}

// ---------- Service worker (streaming authentifié) ----------

async function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register("sw.js");
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) =>
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  }
}

// URL locale servie par sw.js : le fichier original, avec Range pour l'audio.
// Invité sans compte : lecture directe du fichier partagé avec la clé d'API.
const driveUrl = (id) => state.token ? `drive/${id}?t=${encodeURIComponent(state.token)}`
  : `${API}/files/${id}?alt=media&key=${window.APP_CONFIG?.API_KEY}`;

// ---------- Authentification ----------

function initAuth() {
  const clientId = window.APP_CONFIG?.GOOGLE_CLIENT_ID;
  if (!clientId || clientId.startsWith("COLLE")) {
    $(".welcome p").textContent = "Configure d'abord ton ID client Google dans config.js (voir README.md).";
    $("#signin").disabled = true;
    return;
  }
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId, scope: SCOPE, callback: onToken,
  });
  $("#signin").onclick = () => state.tokenClient.requestAccessToken();
}

let tokenWaiters = [];
function onToken(resp) {
  if (resp.error) { alert("Connexion refusée : " + resp.error); return; }
  const firstLogin = !state.token;
  state.token = resp.access_token;
  // Le jeton dure ~1 h : on le renouvelle silencieusement un peu avant.
  setTimeout(() => state.tokenClient.requestAccessToken({ prompt: "" }), (resp.expires_in - 120) * 1000);
  tokenWaiters.forEach((w) => w()); tokenWaiters = [];
  if (firstLogin) onSignedIn();
}

function refreshToken() {
  return new Promise((resolve) => {
    tokenWaiters.push(resolve);
    state.tokenClient.requestAccessToken({ prompt: "" });
  });
}

function signOut() {
  if (state.token) google.accounts.oauth2.revoke(state.token);
  location.reload();
}

// ---------- API Drive ----------

// opts : { method, body } pour les écritures (POST/PATCH/DELETE).
// Sans connexion (invité), lecture des fichiers partagés par lien avec la clé d'API.
async function api(path, params = {}, opts = {}, retry = true) {
  const url = new URL(API + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  else url.searchParams.set("key", window.APP_CONFIG?.API_KEY || "");
  if (opts.body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: opts.method || "GET", headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && retry && state.token) { await refreshToken(); return api(path, params, opts, false); }
  if (!res.ok) throw new Error(`Drive ${res.status} : ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// onPage reçoit chaque page de résultats dès qu'elle arrive (affichage progressif).
async function listAll(q, fields, onPage, orderBy) {
  const out = [];
  let pageToken;
  do {
    const data = await api("/files", {
      q, pageSize: 1000, spaces: "drive",
      fields: `nextPageToken, files(${fields})`,
      ...(orderBy ? { orderBy } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...data.files);
    onPage?.(data.files, out.length);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

// Exécute fn sur chaque élément avec au plus `limit` requêtes simultanées.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k]).catch(() => null); }
  }));
  return results;
}

// ---------- Cache local (IndexedDB) ----------
// Au retour, l'app s'affiche tout de suite depuis le cache, puis se met à jour.

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("mon-cloud-media", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function cacheGet(key) {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const r = db.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    });
  } catch { return undefined; }
}
async function cacheSet(key, value) {
  try { (await idb()).transaction("kv", "readwrite").objectStore("kv").put(value, key); } catch {}
}
const saveLibrary = () => cacheSet("lib", state.lib);

// ---------- Chargement de la bibliothèque ----------

async function onSignedIn() {
  $("#welcome").hidden = true;
  $("#app").hidden = false;
  await setupServiceWorker();

  if (isGuest()) { state.history = []; return go({ name: "review", id: settings.guest.id }, false); }
  myName().then((n) => { $("#account-name").textContent = n; $("#account-avatar").textContent = initials(n); }).catch(() => {});
  const cached = await cacheGet("lib");
  if (cached?.rootId) state.rootId = cached.rootId;
  else state.rootId = (await api("/files/root", { fields: "id" })).id;

  // Première fois : on choisit les dossiers sources avant de charger quoi que ce soit.
  if (!settings.sources.length) return goRoot("sources");
  const hasCache = cached?.key === sourcesKey();
  if (hasCache) { state.lib = cached; buildLibrary(); }
  else render();
  // Pastille « nouveaux commentaires » de la rubrique Partages, sans bloquer.
  if (boxUrl()) setTimeout(() => loadShares().catch(() => {}), 2500);
  await refreshLibrary(hasCache);
}

let loadGeneration = 0;
async function refreshLibrary(hasCache) {
  const gen = ++loadGeneration; // un rechargement plus récent annule celui-ci
  const key = sourcesKey();
  const sync = $("#sync-status");
  sync.textContent = hasCache ? "Mise à jour…" : "Chargement…";
  const fresh = { folders: [], photos: [], tracks: [], books: [] };
  if (!hasCache) { state.lib = { ...fresh, rootId: state.rootId, key }; buildLibrary(); }
  // Sans cache : on affiche au fur et à mesure (au plus une fois par seconde).
  let last = 0;
  const progressive = () => {
    if (gen !== loadGeneration) return;
    sync.textContent = `${plural(fresh.photos.length, "photo", "photos")} · ${plural(fresh.tracks.length, "morceau", "morceaux")}…`;
    if (hasCache || Date.now() - last < 1000) return;
    last = Date.now();
    state.lib = { ...fresh, rootId: state.rootId, key };
    buildLibrary();
  };
  try {
    await crawlSources(sourceIds(), fresh, progressive, () => gen !== loadGeneration);
    if (gen !== loadGeneration) return;
    state.lib = { ...fresh, rootId: state.rootId, key };
    buildLibrary();
    saveLibrary();
    sync.textContent = `À jour · ${plural(state.lib.photos.length, "photo", "photos")}`;
  } catch (e) {
    if (gen !== loadGeneration) return;
    sync.textContent = "Erreur de synchronisation";
    console.error(e);
  }
}

// Transforme les données brutes en vues : filtres, albums, pochettes.
function buildLibrary() {
  const { folders, photos, tracks } = state.lib;
  const books = state.lib.books || [];
  state.folders = new Map(folders.map((f) => [f.id, { id: f.id, name: f.name, parent: f.parents?.[0], shared: f.shared }]));
  if (state.rootId) state.folders.set(state.rootId, { id: state.rootId, name: "Mon Drive", parent: null });
  ancestorCache.clear();

  state.photosByFolder = new Map();
  const all = photos.map((p) => ({ ...p, date: photoDate(p) })).sort((a, b) => b.date - a.date);
  for (const p of all) {
    const f = p.parents?.[0] || "_";
    if (!state.photosByFolder.has(f)) state.photosByFolder.set(f, []);
    state.photosByFolder.get(f).push(p);
  }

  // Les images rangées avec de la musique ou des livres (pochettes,
  // couvertures) ne sont pas des photos.
  const musicFolders = new Set([...tracks, ...books].map((t) => t.parents?.[0]));
  state.photos = all.filter((p) => !(settings.hideSmall && isSmall(p)) && !musicFolders.has(p.parents?.[0])
    && inSources(p, sourceIds("photos")));
  state.photoAlbums = groupAlbums(state.photos, "photos")
    .map((a) => ({ ...a, latest: a.photos[0].date }))
    .sort((a, b) => b.latest - a.latest);

  state.tracks = tracks.filter((t) => inSources(t, sourceIds("music")))
    .map((t) => ({ ...t, title: trackTitle(t.name) }));
  state.musicAlbums = groupAlbums(state.tracks, "tracks").sort((a, b) => a.name.localeCompare(b.name, "fr"));
  state.musicAlbums.forEach((a) => {
    a.tracks.sort((x, y) => x.name.localeCompare(y.name, "fr", { numeric: true }));
    a.tracks.forEach((t) => (t.album = a));
  });
  state.books = books.filter((b) => inSources(b, sourceIds("books")))
    .map((b) => {
      const imgs = state.photosByFolder.get(b.parents?.[0]) || [];
      const coverPhoto = imgs.find((p) => /^(cover|folder|front)/i.test(p.name)) || null;
      return { ...b, ...parseBook(b), coverPhoto };
    })
    .sort((a, b) => a.title.localeCompare(b.title, "fr", { numeric: true }));
  // L'écran Sources ne dépend pas de la bibliothèque : le redessiner pendant
  // un chargement ferait disparaître les boutons sous le curseur.
  if (state.view.name !== "sources") render();
}

function groupAlbums(items, key) {
  const map = new Map();
  for (const it of items) {
    const id = it.parents?.[0] || "_";
    if (!map.has(id)) {
      const f = state.folders.get(id);
      const name = id === "_" ? "Partagés avec moi" : id === state.rootId ? "Non classées" : f?.name || "Sans nom";
      map.set(id, { id, name, path: folderPath(id), [key]: [] });
    }
    map.get(id)[key].push(it);
  }
  return [...map.values()];
}

const isSmall = (p) => {
  const m = p.imageMediaMetadata;
  return m?.width && m?.height && Math.max(m.width, m.height) < 400;
};

const ancestorCache = new Map();
function ancestors(id) {
  if (ancestorCache.has(id)) return ancestorCache.get(id);
  const out = [];
  let cur = id, guard = 0;
  while (cur && guard++ < 50) { out.push(cur); cur = state.folders.get(cur)?.parent; }
  ancestorCache.set(id, out);
  return out;
}
function inSources(item, sources) {
  const chain = ancestors(item.parents?.[0]);
  return sources.some((s) => chain.includes(s));
}
// Chemin lisible du dossier parent, ex. "Vacances › 2019" (sans "Mon Drive").
function folderPath(id) {
  return ancestors(id).slice(1).reverse()
    .filter((x) => x !== state.rootId).map((x) => state.folders.get(x)?.name).filter(Boolean).join(" › ");
}

function photoDate(p) {
  // imageMediaMetadata.time ressemble à "2019:07:14 12:30:00" (EXIF)
  const t = p.imageMediaMetadata?.time;
  if (t) {
    const d = new Date(t.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").replace(" ", "T"));
    if (!isNaN(d)) return d;
  }
  return new Date(p.createdTime);
}

function trackTitle(name) {
  return name.replace(/\.[^.]+$/, "").replace(/^\d{1,3}[\s._-]+/, "");
}

// Pochette d'un album musical : une image du même dossier, de préférence cover/folder/front.
function findCover(folderId) {
  const imgs = state.photosByFolder.get(folderId) || [];
  return imgs.find((p) => /^(cover|folder|front|album)/i.test(p.name)) || imgs[0] || null;
}

// ---------- Miniatures ----------

const thumb = (p, size) => p?.thumbnailLink?.replace(/=s\d+$/, `=s${size}`);

// La clé d'API de l'invité est limitée au site : ses requêtes doivent dire d'où elles viennent.
function withReferrer(img, url) {
  if (url.startsWith(API)) img.referrerPolicy = "strict-origin-when-cross-origin";
  return url;
}

// Avec repli : les liens thumbnailLink expirent au bout de quelques heures (cache),
// on passe alors par l'URL de miniature Drive, puis par l'original.
function setThumb(img, p, size) {
  const sources = [thumb(p, size), `https://drive.google.com/thumbnail?id=${p.id}&sz=w${size}`, driveUrl(p.id)].filter(Boolean);
  let k = 0;
  img.referrerPolicy = "no-referrer";
  img.onload = () => img.classList.add("ld");
  img.onerror = () => { if (++k < sources.length) img.src = withReferrer(img, sources[k]); };
  img.src = sources[0];
}

function coverHtml(p, size, fallback) {
  return p ? `<img data-thumb="${p.id}" alt="" loading="lazy">` : fallback;
}
// Active les <img data-thumb> insérés via innerHTML.
function hydrateThumbs(root, size) {
  root.querySelectorAll("img[data-thumb]").forEach((img) => {
    const p = photoById(img.dataset.thumb);
    if (p) setThumb(img, p, size);
    img.removeAttribute("data-thumb");
  });
}
const photoById = (id) => state.lib.photos.find((p) => p.id === id);

// ---------- Navigation ----------

// Les changements de vue passent par un fondu très court (View Transitions).
function transition(update) {
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(update);
  else update();
}
function go(view, push = true) {
  transition(() => {
    if (push) state.history.push(state.view);
    state.view = view;
    $("#content").scrollTop = 0;
    if (state.selecting) setSelecting(false);
    render();
  });
}
function goRoot(name) { state.history = []; go({ name }, false); }
function back() { if (state.history.length) transition(() => { state.view = state.history.pop(); render(); }); }

// Rubrique de la barre latérale à laquelle appartient chaque vue.
const SECTION = {
  library: "library", albums: "albums", album: "albums",
  shares: "shares", "share-activity": "shares", review: "shares",
  "music-albums": "music-albums", "music-album": "music-albums", songs: "music-albums",
  books: "books", "books-authors": "books", "books-author": "books",
};

// opts : tabs [{ label, on, onClick }] (au centre), primary { label, onClick }
// (bouton bleu), actions [{ label, onClick }], zoom, select, kicker (invité).
function setHeader(title, subtitle = "", opts = {}) {
  $("#view-title").textContent = title;
  $("#view-subtitle").textContent = subtitle;
  $("#view-kicker").hidden = !opts.kicker;
  $("#view-kicker").innerHTML = opts.kicker || "";
  $(".toolbar").classList.toggle("hero", !!opts.kicker);
  $("#btn-back").hidden = !state.history.length;
  const seg = $("#segmented");
  seg.hidden = !opts.tabs;
  seg.innerHTML = "";
  for (const t of opts.tabs || []) {
    const b = document.createElement("button");
    b.textContent = t.label;
    b.className = t.on ? "on" : "";
    if (t.key) b.dataset.mode = t.key;
    b.onclick = t.onClick;
    seg.appendChild(b);
  }
  $("#zoom-wrap").hidden = !opts.zoom;
  $("#btn-select").hidden = !opts.select;
  $("#view-actions").innerHTML = "";
  for (const a of [...(opts.actions || []), ...(opts.primary ? [{ ...opts.primary, primary: true }] : [])]) {
    const b = document.createElement("button");
    b.className = a.primary ? "btn-primary tb-primary" : "tb-btn";
    b.innerHTML = a.primary ? `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${a.icon || '<path d="M8 3v10M3 8h10"/>'}</svg><span>${esc(a.label)}</span>` : esc(a.label);
    if (a.primary) b.setAttribute("aria-label", a.label);
    b.onclick = a.onClick;
    $("#view-actions").appendChild(b);
  }
  const section = SECTION[state.history[0]?.name || state.view.name];
  document.querySelectorAll(".side-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === section));
}

// Onglets d'une rubrique : seulement à son premier niveau.
function sectionTabs(list) {
  if (state.history.length) return undefined;
  return list.map(([name, label]) => ({ label, key: name, on: state.view.name === name, onClick: () => state.view.name !== name && goRoot(name) }));
}

// ---------- Petit menu (compte, options d'une carte) ----------

let menuAnchor = null;
function openMenu(anchor, items, { up } = {}) {
  const m = $("#menu");
  if (!m.hidden && menuAnchor === anchor) return closeMenu();
  menuAnchor = anchor;
  m.innerHTML = "";
  for (const it of items) {
    if (it === "-") { m.insertAdjacentHTML("beforeend", "<hr>"); continue; }
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.textContent = it.label;
    if (it.danger) b.className = "danger";
    b.onclick = (e) => { e.stopPropagation(); closeMenu(); it.onClick(); };
    m.appendChild(b);
  }
  m.hidden = false;
  const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - w - 8, up ? r.left : r.right - w));
  const top = up || r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  Object.assign(m.style, { left: left + "px", top: top + "px" });
  setTimeout(() => document.addEventListener("pointerdown", outsideMenu), 0);
}
function outsideMenu(e) { if (!e.target.closest("#menu") && !menuAnchor?.contains(e.target)) closeMenu(); }
function closeMenu() {
  $("#menu").hidden = true;
  menuAnchor = null;
  document.removeEventListener("pointerdown", outsideMenu);
}

function openAccountMenu() {
  openMenu($("#account"), [
    { label: "Réglages…", onClick: openSettings },
    { label: "Dossiers suivis", onClick: () => goRoot("sources") },
    { label: "Parcourir Google Drive", onClick: () => goRoot("drive") },
    "-",
    { label: "Se déconnecter", onClick: signOut },
  ], { up: true });
}

function render() {
  const v = state.view;
  const views = {
    library: renderLibrary, albums: renderAlbums, album: renderAlbum, shared: renderShares,
    shares: renderShares, "share-activity": renderShareActivity,
    "music-albums": renderMusicAlbums, "music-album": renderMusicAlbum, songs: renderSongs, drive: renderDrive, sources: renderSources,
    books: renderBooks, "books-authors": renderAuthors, "books-author": renderAuthor,
    review: renderReview,
  };
  if (isGuest() && v.name !== "review") { state.view = { name: "review", id: settings.guest.id }; return renderReview(state.view); }
  if (!settings.sources.length && v.name !== "sources" && v.name !== "review") { state.view = { name: "sources" }; return renderSources(); }
  (views[v.name] || renderLibrary)(v);
}

const matches = (s) => !state.query || s.toLowerCase().includes(state.query);
const empty = (msg) => `<div class="empty">${msg}</div>`;

// ---------- Grille de photos (rendu par tranches) ----------
// Seules les premières vignettes sont dans la page ; la suite arrive en défilant.

let gridObserver;
function photoGrid(container, list, { byMonth } = {}) {
  gridObserver?.disconnect();
  container.innerHTML = list.length ? "" : empty("Aucune photo.");
  let rendered = 0, lastKey = null, grid = null;
  if (!byMonth) { grid = document.createElement("div"); grid.className = "grid flush"; container.appendChild(grid); }
  const sentinel = document.createElement("div");
  sentinel.className = "sentinel";

  const append = (n) => {
    const end = Math.min(list.length, rendered + n);
    for (let i = rendered; i < end; i++) {
      const p = list[i];
      if (byMonth) {
        const key = p.date.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
        if (key !== lastKey) {
          const sec = document.createElement("section");
          sec.className = "month";
          sec.dataset.year = p.date.getFullYear();
          sec.innerHTML = `<div class="month-head"><b>${esc(key[0].toUpperCase() + key.slice(1))}</b></div><div class="grid"></div>`;
          container.insertBefore(sec, sentinel.parentNode ? sentinel : null);
          grid = sec.querySelector(".grid");
          lastKey = key;
        }
      }
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = p.name;
      setThumb(img, p, 400);
      bindPhoto(img, p, list, i);
      grid.appendChild(img);
    }
    rendered = end;
    container.appendChild(sentinel);
  };
  append(400);
  gridObserver = new IntersectionObserver((e) => {
    if (e[0].isIntersecting && rendered < list.length) append(400);
  }, { rootMargin: "2000px" });
  gridObserver.observe(sentinel);
  return { revealUntil: (pred) => { while (rendered < list.length && !pred()) append(400); } };
}

// ---------- Photothèque ----------

function renderLibrary() {
  const list = state.photos.filter((p) => matches(p.name));
  const tabs = [["years", "Années"], ["months", "Mois"], ["all", "Toutes les photos"]].map(([key, label]) => ({
    label, key, on: state.libraryMode === key, onClick: () => { state.libraryMode = key; render(); } }));
  setHeader("Photos", plural(list.length, "photo", "photos"), { tabs, zoom: state.libraryMode !== "years", select: state.libraryMode !== "years" });
  const c = $("#content");
  if (!state.photos.length) { c.innerHTML = empty($("#sync-status").textContent.includes("…") ? "Chargement de tes photos…" : "Aucune photo dans tes dossiers suivis. Ajoute-en depuis le menu de ton compte, en bas à gauche."); return; }

  if (state.libraryMode === "years") {
    gridObserver?.disconnect();
    const years = new Map();
    for (const p of list) {
      const y = p.date.getFullYear();
      if (!years.has(y)) years.set(y, []);
      years.get(y).push(p);
    }
    c.innerHTML = `<div class="years">${[...years].map(([y, ps]) => `
      <button class="year-card" data-year="${y}">${coverHtml(ps[Math.floor(ps.length / 2)], 800, "")}
        <span class="label"><b>${y}</b>${plural(ps.length, "photo", "photos")}</span></button>`).join("")}</div>`;
    hydrateThumbs(c, 800);
    c.querySelectorAll(".year-card").forEach((b) => (b.onclick = () => {
      state.libraryMode = "months";
      render();
      const g = state.currentGrid;
      g.revealUntil(() => c.querySelector(`.month[data-year="${b.dataset.year}"]`));
      c.querySelector(`.month[data-year="${b.dataset.year}"]`)?.scrollIntoView();
    }));
    return;
  }
  state.currentGrid = photoGrid(c, list, { byMonth: state.libraryMode === "months" });
}

// ---------- Albums ----------

function albumCards(albums, { onOpen, kind = "photos" } = {}) {
  return `<div class="album-grid">${albums.map((a, i) => {
    const cover = kind === "photos" ? a.photos[0] : findCover(a.id);
    const count = kind === "photos" ? plural(a.photos.length, "photo", "photos") : plural(a.tracks.length, "titre", "titres");
    const shared = state.folders.get(a.id)?.shared ? ` · <span class="badge">partagé</span>` : "";
    return `<button class="album-card" data-i="${i}">
      <div class="cover">${coverHtml(cover, 500, kind === "photos" ? "🖼️" : "🎵")}</div>
      <div class="name">${esc(a.name)}</div>
      <div class="meta">${count}${shared}${a.path ? ` · ${esc(a.path)}` : ""}</div></button>`;
  }).join("")}</div>`;
}
function bindAlbumCards(c, albums, onOpen) {
  hydrateThumbs(c, 500);
  c.querySelectorAll(".album-card").forEach((b) => (b.onclick = () => onOpen(albums[+b.dataset.i])));
}

function renderAlbums() {
  const albums = state.photoAlbums.filter((a) => matches(a.name + " " + a.path));
  setHeader("Albums", plural(albums.length, "album", "albums"), {
    zoom: true, primary: { label: "Nouvel album", onClick: () => createAlbum(sourceIds("photos")[0] || state.rootId) },
  });
  const c = $("#content");
  gridObserver?.disconnect();
  c.innerHTML = albums.length ? albumCards(albums) : empty("Aucun album. Chaque dossier Drive qui contient des photos devient un album.");
  bindAlbumCards(c, albums, (a) => go({ name: "album", id: a.id }));
}

function renderAlbum({ id }) {
  // Toutes les photos du dossier (même hors des sources choisies), récentes d'abord.
  const folder = state.folders.get(id) || { id, name: "Album" };
  const title = id === state.rootId ? "Non classées" : folder.name;
  const all = (state.photosByFolder.get(id) || []).filter((p) => !(settings.hideSmall && isSmall(p)));
  const list = all.filter((p) => matches(p.name));
  const own = id !== "_" && id !== state.rootId;
  setHeader(title, [plural(list.length, "photo", "photos"), folderPath(id)].filter(Boolean).join(" · "), { zoom: true, select: true,
    actions: own ? [{ label: "Commentaires", onClick: () => go({ name: "review", id }) }] : [],
    primary: own ? { label: folder.shared ? "Partagé" : "Partager…", icon: SHARE_ICON, onClick: () => openInvite(folder) } : null });
  state.currentGrid = photoGrid($("#content"), list, { byMonth: false });
}

// ---------- Musique ----------

const MUSIC_TABS = [["music-albums", "Albums"], ["songs", "Morceaux"]];
const SHARE_ICON = '<path d="M8 10V1.5M5 4.5l3-3 3 3M4 7H3v7.5h10V7h-1"/>';

function renderMusicAlbums() {
  const albums = state.musicAlbums.filter((a) => matches(a.name + " " + a.path));
  setHeader("Musique", plural(albums.length, "album", "albums"), { zoom: true, tabs: sectionTabs(MUSIC_TABS) });
  const c = $("#content");
  gridObserver?.disconnect();
  c.innerHTML = albums.length ? albumCards(albums, { kind: "tracks" }) : empty("Aucune musique trouvée.");
  bindAlbumCards(c, albums, (a) => go({ name: "music-album", id: a.id }));
}

function trackRows(list, { showAlbum = true } = {}) {
  const playing = state.queue[state.queueIndex];
  return `<div class="tracklist ${showAlbum ? "" : "compact"}">${list.map((t, i) => `
    <div class="track ${playing?.id === t.id ? "playing" : ""}" data-i="${i}">
      <span class="t-num">${i + 1}</span><span class="t-title">${esc(t.title)}</span>
      ${showAlbum ? `<span class="t-album">${esc(t.album?.name || "")}</span>` : ""}
      <span class="t-size">${t.size ? (t.size / 1048576).toFixed(1) + " Mo" : ""}</span></div>`).join("")}</div>`;
}
function bindTracks(c, list) {
  c.querySelectorAll(".track").forEach((r) => (r.onclick = () => playQueue(list, +r.dataset.i)));
}

function renderMusicAlbum({ id }) {
  const a = state.musicAlbums.find((x) => x.id === id);
  if (!a) return go({ name: "music-albums" }, false);
  setHeader(a.name, a.path);
  const c = $("#content");
  gridObserver?.disconnect();
  c.innerHTML = `<div class="album-hero"><div class="cover">${coverHtml(findCover(a.id), 600, "🎵")}</div>
    <div><h2>${esc(a.name)}</h2><div class="muted">${plural(a.tracks.length, "titre", "titres")}</div>
    <div class="actions"><button class="btn-primary" id="a-play">▶ Lire</button><button id="a-shuffle">⤮ Aléatoire</button></div></div></div>
    ${trackRows(a.tracks, { showAlbum: false })}`;
  hydrateThumbs(c, 600);
  bindTracks(c, a.tracks);
  $("#a-play").onclick = () => { state.shuffle = false; syncShuffle(); playQueue(a.tracks, 0); };
  $("#a-shuffle").onclick = () => { state.shuffle = true; syncShuffle(); playQueue(a.tracks, Math.floor(Math.random() * a.tracks.length)); };
}

function renderSongs() {
  const list = state.musicAlbums.flatMap((a) => a.tracks).filter((t) => matches(t.title + " " + t.album.name));
  setHeader("Musique", plural(list.length, "morceau", "morceaux"), { tabs: sectionTabs(MUSIC_TABS) });
  gridObserver?.disconnect();
  const c = $("#content");
  c.innerHTML = list.length ? trackRows(list) : empty("Aucun morceau.");
  bindTracks(c, list);
}

// ---------- Lecteur ----------

function playQueue(list, startIndex) {
  state.queue = [...list];
  state.queueIndex = startIndex;
  if (state.shuffle) shuffleQueue();
  playCurrent();
}

function shuffleQueue() {
  const current = state.queue[state.queueIndex];
  const rest = state.queue.filter((_, k) => k !== state.queueIndex);
  for (let k = rest.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [rest[k], rest[j]] = [rest[j], rest[k]];
  }
  state.queue = current ? [current, ...rest] : rest;
  state.queueIndex = 0;
}

function playCurrent() {
  const t = state.queue[state.queueIndex];
  if (!t) return;
  const audio = $("#audio");
  audio.src = driveUrl(t.id);
  audio.play().catch(() => {});
  $("#player").hidden = false;
  document.body.classList.add("playing");
  $("#player-title").textContent = t.title;
  $("#player-album").textContent = t.album?.name || "";
  const cover = findCover(t.album?.id);
  const img = $("#player-cover");
  if (cover) setThumb(img, cover, 200); else img.removeAttribute("src");

  // Contrôles sur l'écran verrouillé / touches multimédia.
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, album: t.album?.name || "",
      artwork: cover?.thumbnailLink ? [{ src: thumb(cover, 512), sizes: "512x512" }] : [],
    });
  }
  document.querySelectorAll(".track").forEach((r) => r.classList.remove("playing"));
  if (["music-album", "songs"].includes(state.view.name)) render();
}

function step(delta) {
  if (!state.queue.length) return;
  state.queueIndex = (state.queueIndex + delta + state.queue.length) % state.queue.length;
  playCurrent();
}

const syncShuffle = () => $("#btn-shuffle").classList.toggle("on", state.shuffle);

function setupPlayer() {
  const audio = $("#audio");
  audio.addEventListener("ended", () => step(1));
  audio.addEventListener("play", () => ($("#btn-play").textContent = "⏸"));
  audio.addEventListener("pause", () => ($("#btn-play").textContent = "▶"));
  $("#btn-play").onclick = () => (audio.paused ? audio.play() : audio.pause());
  $("#btn-prev").onclick = () => step(-1);
  $("#btn-next").onclick = () => step(1);
  $("#btn-shuffle").onclick = () => {
    state.shuffle = !state.shuffle;
    syncShuffle();
    if (state.shuffle && state.queue.length) shuffleQueue();
  };
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
  }
}

// ---------- Visionneuse ----------

function openLightbox(i, fromEl) {
  if (fromEl && $("#lightbox").hidden) return morph(fromEl, () => openLightbox(i), () => $("#lb-img"));
  const n = state.lightboxList.length;
  state.lightboxIndex = (i + n) % n;
  const list = state.lightboxList, k = state.lightboxIndex, p = list[k];
  // Tout de suite la vignette déjà affichée dans la grille, puis la grande
  // version dès qu'elle arrive. Les photos voisines sont préchargées.
  const img = $("#lb-img");
  setThumb(img, p, 400);
  loadBig(p).then((src) => {
    if (src && state.lightboxList[state.lightboxIndex] === p) { img.onerror = null; img.src = src; }
    for (const d of [1, -1, 2]) loadBig(list[(k + d + n) % n]);
  });
  $("#lb-caption").innerHTML = `<b>${esc(p.date.toLocaleDateString("fr-FR", { dateStyle: "full" }))}</b><br>${esc(p.name)}`;
  $("#lightbox").hidden = false;
}

// Grande miniature générée par Google (marche aussi pour le HEIC), sinon
// l'original. Mémorise le chargement pour ne jamais télécharger deux fois.
const bigCache = new Map();
function loadBig(p) {
  if (!bigCache.has(p.id)) {
    if (bigCache.size > 80) bigCache.delete(bigCache.keys().next().value);
    const size = Math.min(2000, Math.ceil(Math.max(screen.width, screen.height) * (devicePixelRatio || 1)));
    const urls = [thumb(p, size), `https://drive.google.com/thumbnail?id=${p.id}&sz=w${size}`, driveUrl(p.id)].filter(Boolean);
    bigCache.set(p.id, new Promise((resolve) => {
      const im = new Image();
      let k = 0;
      im.referrerPolicy = "no-referrer";
      im.onload = () => resolve(im.src);
      im.onerror = () => (++k < urls.length ? (im.src = withReferrer(im, urls[k])) : resolve(null));
      im.src = urls[0];
    }));
  }
  return bigCache.get(p.id);
}

function closeLightbox() {
  const p = state.lightboxList[state.lightboxIndex];
  const tile = p && document.querySelector(`#content img[data-pid="${p.id}"]`);
  morph($("#lb-img"), () => ($("#lightbox").hidden = true), () => tile);
}

function setupLightbox() {
  const lb = $("#lightbox");
  $(".lb-close").onclick = closeLightbox;
  $(".lb-prev").onclick = () => openLightbox(state.lightboxIndex - 1);
  $(".lb-next").onclick = () => openLightbox(state.lightboxIndex + 1);
  document.addEventListener("keydown", (e) => {
    if (lb.hidden) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") openLightbox(state.lightboxIndex - 1);
    if (e.key === "ArrowRight") openLightbox(state.lightboxIndex + 1);
  });
}

// ---------- Interface ----------

function setupUI() {
  document.querySelectorAll(".side-item[data-view]").forEach((b) => (b.onclick = () => goRoot(b.dataset.view)));
  $("#account").onclick = openAccountMenu;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#menu").hidden) closeMenu(); });
  addEventListener("resize", closeMenu);
  $("#btn-back").onclick = back;
  const zoom = $("#zoom");
  const applyZoom = () => document.documentElement.style.setProperty("--tile", zoom.value + "px");
  try { zoom.value = localStorage.getItem("mcm-zoom") || zoom.value; } catch {}
  applyZoom();
  zoom.oninput = () => { applyZoom(); try { localStorage.setItem("mcm-zoom", zoom.value); } catch {} };
  let pending = 0, frame = 0;
  $("#content").addEventListener("wheel", (e) => {
    if (!e.ctrlKey || $("#zoom-wrap").hidden) return;
    e.preventDefault();
    pending += e.deltaY;
    frame ||= requestAnimationFrame(() => {
      const v = Math.min(+zoom.max, Math.max(+zoom.min, zoom.value * Math.exp(-Math.max(-40, Math.min(40, pending)) * 0.006)));
      zoom.value = v; pending = 0; frame = 0;
      zoom.oninput();
    });
  }, { passive: false });
  let timer;
  $("#search").oninput = (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = e.target.value.trim().toLowerCase(); render(); }, 200);
  };
  setupLightbox();
  setupPlayer();
}

window.addEventListener("load", () => {
  setupServiceWorker(); // dès l'ouverture : l'app reste utilisable serveur éteint
  setupUI();
  if (isGuest()) startGuest();
  else initAuth();
});
