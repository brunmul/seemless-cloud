// Livres : bibliothèque d'ebooks (EPUB, PDF) façon Apple Books, avec liseuse.
// Inspiré de Calibre-Web : une bibliothèque Calibre copiée sur Drive
// (Auteur/Titre (id)/Titre - Auteur.epub + cover.jpg) est reconnue telle quelle,
// et la lecture des EPUB passe par epub.js, comme dans Calibre-Web.

const BOOK_MIMES = ["application/epub+zip", "application/pdf"];
// Chaque bibliothèque a plusieurs adresses : si un site ne répond pas, on
// essaie le suivant. sw.js en garde une copie pour lire hors connexion.
const EPUBJS = [
  ["https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
   "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js",
   "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"],
  ["https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js",
   "https://unpkg.com/epubjs@0.3.93/dist/epub.min.js"],
];

const readerPrefs = Object.assign(
  { size: 110, theme: "original", font: "original" },
  (() => { try { return JSON.parse(localStorage.getItem("mcm-reader")) || {}; } catch { return {}; } })(),
);
const saveReaderPrefs = () => { try { localStorage.setItem("mcm-reader", JSON.stringify(readerPrefs)); } catch {} };

// Où en est-on dans chaque livre : { id: { cfi, pct, at } }
const reading = (() => { try { return JSON.parse(localStorage.getItem("mcm-reading")) || {}; } catch { return {}; } })();
const saveReading = () => { try { localStorage.setItem("mcm-reading", JSON.stringify(reading)); } catch {} };

// Couvertures extraites des EPUB déjà ouverts (petites images gardées en local).
const extractedCovers = new Map();
cacheGet("covers").then((m) => { if (m) for (const [k, v] of Object.entries(m)) extractedCovers.set(k, v); });
const saveCovers = () => cacheSet("covers", Object.fromEntries(extractedCovers));

// ---------- Titre et auteur ----------

function parseBook(f) {
  const ext = f.mimeType === "application/pdf" ? "PDF" : "EPUB";
  let base = f.name.replace(/\.(epub|pdf)$/i, "").replace(/_/g, " ").trim();
  let title = base, author = "";
  const parent = state.folders.get(f.parents?.[0]);
  const grand = parent && state.folders.get(parent.parent);
  const k = base.lastIndexOf(" - ");
  if (k > 0) {
    const a = base.slice(0, k).trim(), b = base.slice(k + 3).trim();
    // Calibre : « Titre - Auteur » dans « Auteur/Titre (12)/ ».
    const folderTitle = parent?.name.replace(/\s*\(\d+\)$/, "");
    if (folderTitle && folderTitle === a) [title, author] = [a, b];
    else if (grand && grand.name === a) [title, author] = [b, a];
    else if (grand && grand.name === b) [title, author] = [a, b];
    else [title, author] = [b, a]; // le plus courant : « Auteur - Titre »
  } else if (parent && /\(\d+\)$/.test(parent.name) && grand) {
    author = grand.name;
  }
  return { title, author, ext };
}

function bookCover(b) {
  return extractedCovers.get(b.id) || null;
}

// Couverture dessinée quand le livre n'en a pas (style Apple Books).
function drawnCover(b) {
  let h = 0;
  for (const ch of b.title + b.author) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `<div class="drawn-cover" style="--h:${hue}">
    <span class="dc-title">${esc(b.title)}</span><span class="dc-author">${esc(b.author)}</span></div>`;
}

function coverBox(b) {
  const img = bookCover(b);
  if (img) return `<img src="${img}" alt="">`;
  if (b.coverPhoto) return `<img data-thumb="${b.coverPhoto.id}" alt="">`;
  if (b.thumbnailLink) return `<img src="${esc(thumb(b, 600))}" referrerpolicy="no-referrer" alt="" onerror="this.replaceWith(document.createRange().createContextualFragment(this.dataset.fallback))" data-fallback="${esc(drawnCover(b))}">`;
  return drawnCover(b);
}

// ---------- Vues ----------

function bookCards(list) {
  return `<div class="book-grid">${list.map((b, i) => {
    const r = reading[b.id];
    const meta = r?.pct ? `${Math.round(r.pct * 100)} %` : b.ext === "PDF" ? "PDF" : "";
    return `<button class="book-card" data-i="${i}">
      <div class="book-cover">${coverBox(b)}</div>
      <div class="book-title">${esc(b.title)}</div>
      <div class="book-meta">${esc(b.author)}${b.author && meta ? " · " : ""}${meta}</div></button>`;
  }).join("")}</div>`;
}

function bindBookCards(c, list) {
  hydrateThumbs(c, 600);
  c.querySelectorAll(".book-card").forEach((el) => (el.onclick = () => openBook(list[+el.dataset.i])));
}

const BOOK_TABS = [["books", "Bibliothèque"], ["books-authors", "Auteurs"]];

function renderBooks() {
  const list = state.books.filter((b) => matches(b.title + " " + b.author));
  setHeader("Livres", plural(list.length, "livre", "livres"), { zoom: true, tabs: sectionTabs(BOOK_TABS) });
  gridObserver?.disconnect();
  const c = $("#content");
  if (!state.books.length) {
    c.innerHTML = empty("Aucun livre. Dans Dossiers suivis (menu de ton compte), coche « Livres » sur le dossier qui contient tes EPUB ou PDF.");
    return;
  }
  const current = list.filter((b) => reading[b.id] && reading[b.id].pct < 0.99)
    .sort((a, b) => reading[b.id].at - reading[a.id].at).slice(0, 8);
  c.innerHTML = (current.length && !state.query
    ? `<div class="section-title">Continuer la lecture</div><div class="shelf">${bookCards(current)}</div>` : "")
    + `<div class="section-title">Tous les livres</div><div class="all-books">${bookCards(list)}</div>`;
  if (current.length && !state.query) bindBookCards(c.querySelector(".shelf"), current);
  bindBookCards(c.querySelector(".all-books"), list);
}

function renderAuthors() {
  const map = new Map();
  for (const b of state.books) {
    const a = b.author || "Auteur inconnu";
    if (!map.has(a)) map.set(a, []);
    map.get(a).push(b);
  }
  const authors = [...map].filter(([a]) => matches(a)).sort((x, y) => x[0].localeCompare(y[0], "fr"));
  setHeader("Livres", plural(authors.length, "auteur", "auteurs"), { tabs: sectionTabs(BOOK_TABS) });
  gridObserver?.disconnect();
  const c = $("#content");
  c.innerHTML = authors.length ? `<div class="author-list">${authors.map(([a, bs], i) =>
    `<button class="author-row" data-i="${i}"><span class="author-avatar">${esc(a.trim()[0] || "?")}</span>
      <span class="author-name">${esc(a)}</span><span class="muted">${plural(bs.length, "livre", "livres")} ›</span></button>`).join("")}</div>`
    : empty("Aucun auteur.");
  c.querySelectorAll(".author-row").forEach((el) => (el.onclick = () => go({ name: "books-author", author: authors[+el.dataset.i][0] })));
}

function renderAuthor({ author }) {
  const list = state.books.filter((b) => (b.author || "Auteur inconnu") === author && matches(b.title));
  setHeader(author, plural(list.length, "livre", "livres"), { zoom: true });
  gridObserver?.disconnect();
  const c = $("#content");
  c.innerHTML = bookCards(list);
  bindBookCards(c, list);
}

// ---------- Liseuse ----------

const rd = { book: null, rendition: null, item: null, blobUrl: null, toc: [] };

const THEMES = {
  original: { bg: "#ffffff", fg: "#1d1d1f" },
  sepia: { bg: "#f8f1e3", fg: "#5b4636" },
  gris: { bg: "#4a4a4d", fg: "#e8e8ea" },
  nuit: { bg: "#121212", fg: "#d6d6d6" },
};
const FONTS = {
  original: null,
  serif: "Georgia, 'New York', 'Times New Roman', serif",
  sans: "-apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif",
  palatino: "Palatino, 'Palatino Linotype', 'Book Antiqua', serif",
};

let libsPromise;
function loadEpubLibs() {
  if (window.ePub) return Promise.resolve();
  const load = (src) => new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => { s.remove(); ko(); };
    document.head.appendChild(s);
  });
  const loadFirst = async (urls) => {
    for (const u of urls) { try { return await load(u); } catch {} }
    throw new Error("Impossible de charger la liseuse (connexion ?)");
  };
  libsPromise ||= EPUBJS.reduce((p, urls) => p.then(() => loadFirst(urls)), Promise.resolve());
  libsPromise.catch(() => (libsPromise = null));
  return libsPromise;
}

async function fetchBook(b) {
  const res = await fetch(driveUrl(b.id));
  if (!res.ok) throw new Error(`Drive ${res.status}`);
  return res;
}

async function openBook(b) {
  closeReader();
  rd.item = b;
  const box = $("#reader");
  box.hidden = false;
  box.dataset.kind = b.ext.toLowerCase();
  document.body.classList.add("reading");
  $("#rd-title").textContent = b.title;
  $("#rd-progress").textContent = "";
  const view = $("#rd-view");
  view.innerHTML = `<div class="rd-loading">Ouverture de « ${esc(b.title)} »…</div>`;
  applyReaderTheme();
  try {
    if (b.ext === "PDF") {
      const blob = await (await fetchBook(b)).blob();
      if (rd.item !== b) return;
      rd.blobUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      view.innerHTML = `<iframe class="rd-pdf" src="${rd.blobUrl}"></iframe>`;
      markRead(b, reading[b.id]?.cfi, Math.max(reading[b.id]?.pct || 0, 0.01));
      return;
    }
    const [buf] = await Promise.all([fetchBook(b).then((r) => r.arrayBuffer()), loadEpubLibs()]);
    if (rd.item !== b) return;
    view.innerHTML = "";
    rd.book = ePub(buf);
    rd.rendition = rd.book.renderTo(view, { width: "100%", height: "100%", flow: "paginated", spread: "auto", allowScriptedContent: false });
    for (const [name, t] of Object.entries(THEMES)) {
      rd.rendition.themes.register(name, { body: { background: `${t.bg} !important`, color: `${t.fg} !important` }, "a, a:link": { color: "inherit !important" } });
    }
    applyReaderPrefs();
    rd.rendition.on("relocated", onRelocated);
    rd.rendition.on("keyup", onReaderKey);
    await rd.rendition.display(reading[b.id]?.cfi || undefined);
    rd.book.loaded.navigation.then((nav) => { rd.toc = flattenToc(nav.toc); });
    extractCover(b);
    prepareLocations(b);
  } catch (e) {
    console.error(e);
    if (rd.item === b) view.innerHTML = `<div class="rd-loading">Impossible d'ouvrir ce livre.<br><small>${esc(e.message)}</small></div>`;
  }
}

function flattenToc(items, depth = 0) {
  return items.flatMap((it) => [{ label: it.label.trim(), href: it.href, depth }, ...flattenToc(it.subitems || [], depth + 1)]);
}

// Les « positions » permettent d'afficher un pourcentage ; on les calcule une
// fois par livre en arrière-plan, puis on les garde.
async function prepareLocations(b) {
  const book = rd.book;
  const saved = await cacheGet("loc:" + b.id);
  if (rd.book !== book) return;
  if (saved) book.locations.load(saved);
  else {
    await book.locations.generate(1600);
    if (rd.book !== book) return;
    cacheSet("loc:" + b.id, book.locations.save());
  }
  const loc = rd.rendition.currentLocation();
  if (loc?.start) onRelocated(loc);
}

async function extractCover(b) {
  if (extractedCovers.has(b.id) || b.coverPhoto || b.thumbnailLink) return;
  try {
    const url = await rd.book.coverUrl();
    if (!url) return;
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = 300, h = Math.round(w * img.naturalHeight / img.naturalWidth);
    const cv = Object.assign(document.createElement("canvas"), { width: w, height: h });
    cv.getContext("2d").drawImage(img, 0, 0, w, h);
    extractedCovers.set(b.id, cv.toDataURL("image/jpeg", 0.8));
    saveCovers();
  } catch {}
}

function onRelocated(loc) {
  const b = rd.item;
  if (!b || !loc?.start) return;
  const book = rd.book;
  const pct = book.locations.length() ? book.locations.percentageFromCfi(loc.start.cfi) : reading[b.id]?.pct || 0;
  markRead(b, loc.start.cfi, pct);
  const chapter = rd.toc.find((t) => t.href.split("#")[0].endsWith(loc.start.href))?.label;
  $("#rd-progress").textContent = [book.locations.length() ? `${Math.round(pct * 100)} %` : "", chapter].filter(Boolean).join(" · ");
}

function markRead(b, cfi, pct) {
  reading[b.id] = { cfi, pct, at: Date.now() };
  saveReading();
}

function applyReaderPrefs() {
  const r = rd.rendition;
  if (!r) return;
  r.themes.select(readerPrefs.theme);
  r.themes.fontSize(readerPrefs.size + "%");
  if (FONTS[readerPrefs.font]) r.themes.override("font-family", FONTS[readerPrefs.font], true);
  else r.themes.override("font-family", "inherit");
}

function applyReaderTheme() {
  const t = THEMES[readerPrefs.theme] || THEMES.original;
  const box = $("#reader");
  box.style.setProperty("--rd-bg", t.bg);
  box.style.setProperty("--rd-fg", t.fg);
  box.dataset.theme = readerPrefs.theme;
  document.querySelectorAll("#rd-themes button").forEach((el) => el.classList.toggle("on", el.dataset.theme === readerPrefs.theme));
  document.querySelectorAll("#rd-fonts button").forEach((el) => el.classList.toggle("on", el.dataset.font === readerPrefs.font));
}

function onReaderKey(e) {
  if (e.key === "ArrowRight" || e.key === " ") rd.rendition?.next();
  if (e.key === "ArrowLeft") rd.rendition?.prev();
  if (e.key === "Escape") closeReader();
}

function closeReader() {
  rd.book?.destroy();
  if (rd.blobUrl) URL.revokeObjectURL(rd.blobUrl);
  Object.assign(rd, { book: null, rendition: null, item: null, blobUrl: null, toc: [] });
  $("#reader").hidden = true;
  $("#rd-view").innerHTML = "";
  document.querySelectorAll(".rd-panel").forEach((p) => (p.hidden = true));
  document.body.classList.remove("reading");
  if (state.view.name.startsWith("books")) render(); // pourcentages à jour
}

function togglePanel(id) {
  document.querySelectorAll(".rd-panel").forEach((p) => (p.hidden = p.id === id ? !p.hidden : true));
  if (id === "rd-toc-panel" && !$("#rd-toc-panel").hidden) {
    $("#rd-toc-panel").innerHTML = rd.toc.length ? rd.toc.map((t, i) =>
      `<button class="toc-item" data-i="${i}" style="padding-left:${14 + t.depth * 16}px">${esc(t.label)}</button>`).join("")
      : `<p class="muted" style="padding:12px">Pas de table des matières.</p>`;
    $("#rd-toc-panel").querySelectorAll(".toc-item").forEach((el) => (el.onclick = () => {
      rd.rendition?.display(rd.toc[+el.dataset.i].href);
      $("#rd-toc-panel").hidden = true;
    }));
  }
}

window.addEventListener("load", () => {
  $("#rd-close").onclick = closeReader;
  $("#rd-prev").onclick = () => rd.rendition?.prev();
  $("#rd-next").onclick = () => rd.rendition?.next();
  $("#rd-toc").onclick = () => togglePanel("rd-toc-panel");
  $("#rd-aa").onclick = () => togglePanel("rd-aa-panel");
  $("#rd-smaller").onclick = () => { readerPrefs.size = Math.max(70, readerPrefs.size - 10); saveReaderPrefs(); applyReaderPrefs(); };
  $("#rd-bigger").onclick = () => { readerPrefs.size = Math.min(220, readerPrefs.size + 10); saveReaderPrefs(); applyReaderPrefs(); };
  document.querySelectorAll("#rd-themes button").forEach((el) => (el.onclick = () => {
    readerPrefs.theme = el.dataset.theme; saveReaderPrefs(); applyReaderTheme(); applyReaderPrefs();
  }));
  document.querySelectorAll("#rd-fonts button").forEach((el) => (el.onclick = () => {
    readerPrefs.font = el.dataset.font; saveReaderPrefs(); applyReaderTheme(); applyReaderPrefs();
  }));
  document.addEventListener("keydown", (e) => { if (!$("#reader").hidden && !e.target.closest?.("input")) onReaderKey(e); });
  applyReaderTheme();
});
