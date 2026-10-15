// Revue d'un dossier partagé : mode invité et vue « Revue » du propriétaire.
// L'invité ouvre l'app avec un lien #invite=<id du dossier> et ne voit que ce
// dossier : photos, vidéos, commentaires et pastilles de couleur.
//
// L'invité n'a pas besoin de compte Google : le dossier est partagé « tous ceux
// qui ont le lien », lu avec la clé d'API de l'app, et les commentaires vont
// dans la boîte à commentaires (boite-commentaires.gs, un script Google de
// Bruno), protégée par la clé secrète du lien #invite=<dossier>&k=<clé>.
// Une pastille est un commentaire au texte fixe (« 🔴 Pastille rouge ») :
// chacun pose la sienne, tout le monde les voit.

const TAGS = [
  { key: "rouge", label: "Pastille rouge", emoji: "🔴", color: "#ff453a" },
  { key: "orange", label: "Pastille orange", emoji: "🟠", color: "#ff9f0a" },
  { key: "jaune", label: "Pastille jaune", emoji: "🟡", color: "#ffd60a" },
  { key: "verte", label: "Pastille verte", emoji: "🟢", color: "#30d158" },
  { key: "bleue", label: "Pastille bleue", emoji: "🔵", color: "#0a84ff" },
  { key: "violette", label: "Pastille violette", emoji: "🟣", color: "#bf5af2" },
  { key: "grise", label: "Pastille grise", emoji: "⚪", color: "#8e8e93" },
];
const tagText = (t) => `${t.emoji} ${t.label}`;
const tagOf = (comment) => TAGS.find((t) => comment.content?.trim() === tagText(t));

const REVIEW_FIELDS = "id, name, mimeType, thumbnailLink, createdTime, imageMediaMetadata(time, width, height), videoMediaMetadata(durationMillis)";

const review = {
  folders: new Map(),   // id -> { meta, subs, items } : dossiers déjà chargés
  root: null,           // dossier partagé dont on lit la boîte à commentaires
  key: null,
  ready: false, error: null,
  comments: new Map(),  // fileId -> [commentaires]
  filter: null,         // clé de pastille, "none" ou null (tout)
  list: [], index: 0,   // visionneuse
  replyTo: null,
};

// ---------- Mode invité ----------

// Le lien d'invitation est mémorisé : l'app installée rouvre le même dossier.
(function readInvite() {
  const m = location.hash.match(/invite=([\w-]+)&k=([\w-]+)/);
  if (m) {
    settings.guest = { id: m[1], key: m[2], name: settings.guest?.name };
    saveSettings();
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (settings.guest) document.documentElement.classList.add("guest");
})();

const isGuest = () => !!settings.guest;

// L'invité arrive directement sur le dossier, sans connexion.
function startGuest() {
  $("#welcome").hidden = true;
  $("#app").hidden = false;
  state.history = [];
  go({ name: "review", id: settings.guest.id }, false);
}

function leaveGuest() {
  if (!confirm("Fermer ce dossier partagé ? Il faudra rouvrir le lien d'invitation pour le revoir.")) return;
  delete settings.guest;
  saveSettings();
  location.reload();
}

// Adresse publique de l'app, pour les liens d'invitation.
function publicUrl() {
  const conf = window.APP_CONFIG?.PUBLIC_URL;
  if (conf) return conf.replace(/\/?$/, "/");
  if (!/^(localhost|127\.)/.test(location.hostname)) return location.origin + location.pathname;
  return null;
}

// ---------- Chargement ----------

async function loadReviewFolder(id, fresh) {
  if (review.folders.has(id) && !fresh) return review.folders.get(id);
  const meta = await api(`/files/${id}`, { fields: "id, name, owners(displayName, me), capabilities(canComment)" });
  const q = `'${id}' in parents and trashed = false and (mimeType = '${FOLDER_MIME}' or mimeType contains 'image/' or mimeType contains 'video/')`;
  const files = await listAll(q, REVIEW_FIELDS, null, "name");
  const subs = files.filter((f) => f.mimeType === FOLDER_MIME);
  const items = files.filter((f) => f.mimeType !== FOLDER_MIME)
    .map((f) => ({ ...f, date: photoDate(f), video: f.mimeType.startsWith("video/") }))
    .sort((a, b) => a.date - b.date);
  const entry = { meta, subs, items };
  review.folders.set(id, entry);
  return entry;
}

// ---------- Boîte à commentaires ----------

const boxUrl = () => window.APP_CONFIG?.REVIEW_URL;

function myId() {
  if (!settings.me) { settings.me = crypto.randomUUID(); saveSettings(); }
  return settings.me;
}

async function box(action, data = {}) {
  if (!boxUrl()) throw new Error("la boîte à commentaires n'est pas encore installée");
  // Corps en texte brut : pas de requête préalable CORS vers Google Apps Script.
  const res = await fetch(boxUrl(), { method: "POST",
    body: JSON.stringify({ action, folder: review.root, key: review.key, by: myId(), ...data }) });
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  return out;
}

// Clé d'un dossier pour le propriétaire : le script vérifie son jeton Google.
async function ownerKey(folder) {
  settings.reviewKeys ||= {};
  if (!settings.reviewKeys[folder]) {
    settings.reviewKeys[folder] = (await box("key", { folder, token: state.token })).key;
    saveSettings();
  }
  return settings.reviewKeys[folder];
}

// Prénom affiché sous les commentaires : demandé une fois à l'invité.
async function myName() {
  if (!isGuest()) {
    state.myName ||= (await api("/about", { fields: "user(displayName)" })).user.displayName;
    return state.myName;
  }
  if (!settings.guest.name) {
    const name = await askName();
    if (!name) throw new Error("cancel");
    settings.guest.name = name;
    saveSettings();
  }
  return settings.guest.name;
}

function askName() {
  return new Promise((resolve) => {
    const input = $("#name-input");
    input.value = "";
    $("#name-ask").hidden = false;
    input.focus();
    const done = (v) => { $("#name-ask").hidden = true; resolve(v); };
    $("#name-form").onsubmit = (e) => { e.preventDefault(); const v = input.value.trim().slice(0, 40); if (v) done(v); };
    $("#name-cancel").onclick = () => done(null);
  });
}

// Format de la boîte -> format affiché (celui des commentaires Drive).
const asComment = (c) => ({ id: c.id, content: c.text, createdTime: c.at, author: { displayName: c.name, me: c.me }, replies: [] });

function setComments(list) {
  review.comments = new Map();
  const top = new Map();
  for (const c of list.filter((x) => !x.parent)) {
    const one = asComment(c);
    top.set(c.id, one);
    if (!review.comments.has(c.file)) review.comments.set(c.file, []);
    review.comments.get(c.file).push(one);
  }
  for (const r of list.filter((x) => x.parent)) top.get(r.parent)?.replies.push(asComment(r));
}

// Ouvre la boîte du dossier partagé ; l'affichage n'attend pas.
function openBox(root) {
  if (review.root === root) return;
  Object.assign(review, { root, key: null, ready: false, error: null, comments: new Map() });
  (async () => {
    try {
      const key = isGuest() ? settings.guest.key : await ownerKey(root);
      if (review.root !== root) return;
      review.key = key;
      const { comments } = await box("list");
      if (review.root !== root) return;
      setComments(comments);
    } catch (e) { console.error(e); review.error = e.message; }
    review.ready = true;
    document.querySelectorAll(".rv-tile").forEach((t) => refreshTile(t.dataset.id));
    if (!$("#rv").hidden) drawSide();
  })();
}

const commentsOf = (id) => review.comments.get(id) || [];
const tagsOf = (id) => commentsOf(id).map((c) => ({ c, tag: tagOf(c) })).filter((x) => x.tag);
const notesOf = (id) => commentsOf(id).filter((c) => !tagOf(c));
const myTag = (id) => tagsOf(id).find((x) => x.c.author?.me);

// ---------- Vue « Revue » ----------

async function renderReview({ id, root }) {
  const c = $("#content");
  gridObserver?.disconnect();
  openBox(root || id);
  const cached = review.folders.get(id);
  if (!cached) {
    setHeader("Chargement…", "");
    c.innerHTML = `<div class="empty">Ouverture du dossier…</div>`;
  }
  let entry;
  try { entry = await loadReviewFolder(id); }
  catch (e) {
    console.error(e);
    setHeader("Dossier introuvable", "");
    c.innerHTML = isGuest() ? `<div class="empty">Ce dossier n'est plus partagé, ou il n'existe plus.<br>Demande un nouveau lien d'invitation.</div>`
      : `<div class="empty">Ce dossier n'existe plus.</div>`;
    return;
  }
  if (state.view.id !== id) return;
  drawReview(id, entry);
}

function drawReview(id, entry) {
  const { meta, subs, items } = entry;
  const photos = items.filter((f) => !f.video).length, videos = items.length - photos;
  const owner = meta.owners?.[0];
  const sub = [photos && plural(photos, "photo", "photos"), videos && plural(videos, "vidéo", "vidéos"),
    owner && !owner.me ? `partagé par ${owner.displayName}` : ""].filter(Boolean).join(" · ");
  const actions = [];
  if (isGuest() && !state.history.length) actions.push({ label: "Quitter", onClick: leaveGuest });
  else if (!isGuest() && id === review.root) actions.push({ label: "Inviter…", onClick: () => openInvite({ id, name: meta.name }) });
  setHeader(meta.name, sub, { zoom: true, actions });

  const c = $("#content");
  const visible = items.filter((f) => matches(f.name) && passesFilter(f.id));
  c.innerHTML = `<div class="rv-filters" id="rv-filters"></div>
    ${subs.length ? `<div class="folder-grid">${subs.filter((f) => matches(f.name)).map((f) => `
      <div class="folder-card"><button class="folder-open" data-id="${f.id}"><span class="fi">📁</span>
      <span class="fn">${esc(f.name)}<small>&nbsp;</small></span></button></div>`).join("")}</div>` : ""}
    <div class="grid flush rv-grid" id="rv-grid"></div>
    ${!items.length && !subs.length ? empty("Ce dossier est vide.") : ""}
    ${items.length && !visible.length ? empty("Aucun fichier avec cette pastille.") : ""}`;
  c.querySelectorAll(".folder-open").forEach((b) => (b.onclick = () => go({ name: "review", id: b.dataset.id, root: review.root })));

  const grid = $("#rv-grid");
  const frag = document.createDocumentFragment();
  visible.forEach((f, i) => {
    const tile = document.createElement("button");
    tile.className = "rv-tile";
    tile.dataset.id = f.id;
    tile.innerHTML = `<img alt="" loading="lazy"><span class="rv-dots"></span>
      ${f.video ? `<span class="rv-badge">▶ ${duration(f)}</span>` : ""}<span class="rv-count"></span>`;
    setThumb(tile.querySelector("img"), f, 400);
    tile.onclick = () => { review.list = visible; openViewer(i, tile.querySelector("img")); };
    frag.appendChild(tile);
  });
  grid.appendChild(frag);
  visible.forEach((f) => refreshTile(f.id));
  drawFilters(items);
}

function duration(f) {
  const s = Math.round((+f.videoMediaMetadata?.durationMillis || 0) / 1000);
  return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "";
}

function passesFilter(id) {
  if (!review.filter) return true;
  const tags = tagsOf(id);
  return review.filter === "none" ? !tags.length : tags.some((x) => x.tag.key === review.filter);
}

function drawFilters(items) {
  const box = $("#rv-filters");
  if (!box) return;
  const counts = new Map();
  let none = 0;
  for (const f of items) {
    const keys = new Set(tagsOf(f.id).map((x) => x.tag.key));
    if (!keys.size) none++;
    keys.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
  }
  const chip = (key, html) => `<button class="rv-chip ${review.filter === key ? "on" : ""}" data-key="${key ?? ""}">${html}</button>`;
  box.innerHTML = !counts.size && !review.filter ? "" : chip(null, "Tout") +
    TAGS.filter((t) => counts.has(t.key) || review.filter === t.key)
      .map((t) => chip(t.key, `<i style="background:${t.color}"></i>${counts.get(t.key) || 0}`)).join("") +
    chip("none", `Sans pastille · ${none}`);
  box.querySelectorAll(".rv-chip").forEach((b) => (b.onclick = () => {
    review.filter = b.dataset.key || null;
    render();
  }));
}

// Pastilles et nombre de commentaires sur une vignette.
function refreshTile(id) {
  const tile = document.querySelector(`.rv-tile[data-id="${id}"]`);
  if (tile) {
    tile.querySelector(".rv-dots").innerHTML = [...new Map(tagsOf(id).map((x) => [x.tag.key, x.tag])).values()]
      .map((t) => `<i style="background:${t.color}"></i>`).join("");
    const n = notesOf(id).length;
    tile.querySelector(".rv-count").textContent = n ? `💬 ${n}` : "";
  }
  const v = state.view;
  if (v.name === "review") { const e = review.folders.get(v.id); if (e) drawFilters(e.items); }
}

// ---------- Visionneuse avec commentaires ----------

// Transition « morphing » : l'élément de départ devient l'élément d'arrivée
// (API View Transitions de Chrome ; sans elle, on affiche directement).
function morph(fromEl, update, toEl) {
  if (!document.startViewTransition || !fromEl) { update(); return; }
  fromEl.style.viewTransitionName = "hero";
  const t = document.startViewTransition(() => {
    fromEl.style.viewTransitionName = "";
    update();
    const target = toEl?.();
    if (target) target.style.viewTransitionName = "hero";
  });
  t.finished.finally(() => { const target = toEl?.(); if (target) target.style.viewTransitionName = ""; });
}

function openViewer(i, fromEl) {
  const first = $("#rv").hidden;
  const show = () => { $("#rv").hidden = false; showItem(i); };
  if (first) morph(fromEl, show, () => $("#rv-media").firstElementChild);
  else show();
}

function closeViewer() {
  const f = review.list[review.index];
  const tile = f && document.querySelector(`.rv-tile[data-id="${f.id}"] img`);
  const media = $("#rv-media").firstElementChild;
  if (media?.tagName === "VIDEO") media.pause();
  morph(media, () => { $("#rv").hidden = true; $("#rv-media").innerHTML = ""; }, () => tile);
}

function showItem(i) {
  const n = review.list.length;
  review.index = (i + n) % n;
  review.replyTo = null;
  const f = review.list[review.index];
  const box = $("#rv-media");
  if (f.video) {
    box.innerHTML = `<video controls autoplay playsinline preload="metadata"></video>`;
    const v = box.firstElementChild;
    if (f.thumbnailLink) v.poster = thumb(f, 1200);
    v.src = driveUrl(f.id);
  } else {
    box.innerHTML = `<img alt="">`;
    const img = box.firstElementChild;
    setThumb(img, f, 400);
    loadBig(f).then((src) => {
      if (src && review.list[review.index] === f) { img.onerror = null; img.src = src; }
      for (const d of [1, -1]) { const g = review.list[(review.index + d + n) % n]; if (!g.video) loadBig(g); }
    });
  }
  $("#rv-title").innerHTML = `<b>${esc(f.name)}</b><br>${esc(f.date.toLocaleDateString("fr-FR", { dateStyle: "long" }))} · ${review.index + 1} / ${n}`;
  drawSide();
}

function drawSide() {
  const f = review.list[review.index];
  if (!f) return;
  const mine = myTag(f.id)?.tag.key;
  $("#rv-tags").innerHTML = TAGS.map((t, k) =>
    `<button class="rv-swatch ${mine === t.key ? "on" : ""}" data-key="${t.key}" title="${t.label} (${k + 1})" style="--c:${t.color}"></button>`).join("") +
    `<button class="rv-swatch none ${mine ? "" : "on"}" data-key="" title="Aucune pastille (0)"></button>`;
  $("#rv-tags").querySelectorAll(".rv-swatch").forEach((b) => (b.onclick = () => setTag(f, b.dataset.key || null)));

  const others = tagsOf(f.id).filter((x) => !x.c.author?.me);
  $("#rv-tagged").innerHTML = others.map((x) =>
    `<span><i style="background:${x.tag.color}"></i>${esc(x.c.author?.displayName || "Quelqu'un")}</span>`).join("");

  const notes = notesOf(f.id);
  $("#rv-comments").innerHTML = !review.ready ? `<p class="muted">Chargement…</p>`
    : review.error ? `<p class="muted">Commentaires indisponibles : ${esc(review.error)}.</p>`
    : notes.length ? notes.map((c) => commentHtml(c)).join("")
    : `<p class="muted rv-empty">Pas encore de commentaire.</p>`;
  $("#rv-comments").querySelectorAll("[data-reply]").forEach((b) => (b.onclick = () => {
    review.replyTo = notes.find((c) => c.id === b.dataset.reply);
    $("#rv-input").placeholder = `Répondre à ${review.replyTo.author?.displayName || "ce commentaire"}…`;
    $("#rv-input").focus();
  }));
  $("#rv-comments").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => deleteComment(f, b.dataset.del)));
  $("#rv-input").placeholder = "Ajouter un commentaire…";
}

function commentHtml(c) {
  const when = (d) => new Date(d).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const one = (x, cls) => `<div class="${cls}"><div class="rv-meta"><b>${esc(x.author?.displayName || "Quelqu'un")}</b> · ${when(x.createdTime)}
    ${x.author?.me && cls === "rv-comment" ? `<button class="rv-link" data-del="${x.id}">Supprimer</button>` : ""}</div>
    <div class="rv-text">${esc(x.content || "")}</div></div>`;
  return `<div class="rv-thread">${one(c, "rv-comment")}
    ${(c.replies || []).filter((r) => !r.deleted).map((r) => one(r, "rv-reply")).join("")}
    <button class="rv-link" data-reply="${c.id}">Répondre</button></div>`;
}

// Change sa propre pastille : on modifie, crée ou supprime son commentaire-pastille.
async function setTag(f, key) {
  const current = myTag(f.id);
  const tag = TAGS.find((t) => t.key === key);
  try {
    if (current && !tag) {
      await box("delete", { id: current.c.id });
      review.comments.set(f.id, commentsOf(f.id).filter((c) => c !== current.c));
    } else if (current && tag) {
      if (current.tag.key === key) return;
      await box("edit", { id: current.c.id, text: tagText(tag) });
      current.c.content = tagText(tag);
    } else if (tag) {
      const { comment } = await box("add", { file: f.id, text: tagText(tag), name: await myName() });
      review.comments.set(f.id, [...commentsOf(f.id), asComment(comment)]);
    }
  } catch (e) { if (e.message !== "cancel") { console.error(e); toast("Impossible de poser la pastille"); } return; }
  refreshTile(f.id);
  if (review.list[review.index] === f) drawSide();
}

async function sendComment(e) {
  e.preventDefault();
  const input = $("#rv-input");
  const text = input.value.trim();
  const f = review.list[review.index];
  if (!text || !f) return;
  input.disabled = true;
  try {
    const name = await myName();
    const { comment } = await box("add", { file: f.id, parent: review.replyTo?.id, text, name });
    if (review.replyTo) review.replyTo.replies.push(asComment(comment));
    else review.comments.set(f.id, [...commentsOf(f.id), asComment(comment)]);
    input.value = "";
    review.replyTo = null;
  } catch (err) { if (err.message !== "cancel") { console.error(err); toast("Impossible d'envoyer le commentaire"); } }
  input.disabled = false;
  input.blur(); // les raccourcis clavier (flèches, 1 à 7) remarchent tout de suite
  refreshTile(f.id);
  drawSide();
}

async function deleteComment(f, id) {
  if (!confirm("Supprimer ce commentaire ?")) return;
  try {
    await box("delete", { id });
    review.comments.set(f.id, commentsOf(f.id).filter((c) => c.id !== id));
  } catch (e) { console.error(e); toast("Impossible de supprimer"); return; }
  refreshTile(f.id);
  drawSide();
}

// ---------- Inviter quelqu'un (propriétaire) ----------

// Le dossier devient lisible par « tous ceux qui ont le lien » (introuvable
// sans le lien) ; le lien d'invitation porte aussi la clé de la boîte.
async function linkPermission(folder) {
  const { permissions } = await api(`/files/${folder.id}/permissions`, { fields: "permissions(id, type, role)" });
  return permissions.find((p) => p.type === "anyone");
}

async function openInvite(folder) {
  $("#invite-title").textContent = `Inviter sur « ${folder.name} »`;
  $("#invite-link-row").hidden = true;
  $("#invite-send").hidden = $("#invite-stop").hidden = true;
  $("#invite-note").textContent = "";
  $("#invite").hidden = false;
  $("#invite-send").onclick = () => createLink(folder);
  $("#invite-stop").onclick = () => stopLink(folder);
  $("#invite-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#invite-link").value); toast("Lien copié"); } catch { $("#invite-link").select(); }
  };
  if (!publicUrl() || !boxUrl()) {
    $("#invite-note").textContent = !publicUrl() ? "L'app n'a pas encore d'adresse publique (PUBLIC_URL dans config.js)."
      : "Installe d'abord la boîte à commentaires (REVIEW_URL dans config.js, voir README).";
    return;
  }
  try { (await linkPermission(folder)) ? await showLink(folder) : ($("#invite-send").hidden = false); }
  catch (e) { console.error(e); $("#invite-note").textContent = "Impossible de lire le partage : " + e.message; }
}

async function showLink(folder) {
  const key = await ownerKey(folder.id);
  $("#invite-link").value = `${publicUrl()}#invite=${folder.id}&k=${key}`;
  $("#invite-link-row").hidden = false;
  $("#invite-send").hidden = true;
  $("#invite-stop").hidden = false;
  $("#invite-note").textContent = "Envoie ce lien à qui tu veux, par message ou par e-mail. Pas besoin de compte Google.";
}

async function createLink(folder) {
  $("#invite-send").disabled = true;
  try {
    await api(`/files/${folder.id}/permissions`, {}, { method: "POST", body: { type: "anyone", role: "reader", allowFileDiscovery: false } });
    await showLink(folder);
    $("#invite-copy").click();
  } catch (e) { console.error(e); $("#invite-note").textContent = "Impossible de créer le lien : " + e.message; }
  $("#invite-send").disabled = false;
}

async function stopLink(folder) {
  if (!confirm("Désactiver le lien ? Les personnes qui l'ont n'auront plus accès au dossier. Leurs commentaires restent.")) return;
  try {
    const p = await linkPermission(folder);
    if (p) await api(`/files/${folder.id}/permissions/${p.id}`, {}, { method: "DELETE" });
    $("#invite-link-row").hidden = $("#invite-stop").hidden = true;
    $("#invite-send").hidden = false;
    $("#invite-note").textContent = "Lien désactivé.";
  } catch (e) { console.error(e); $("#invite-note").textContent = "Impossible de désactiver le lien : " + e.message; }
}

// ---------- Branchements ----------

window.addEventListener("load", () => {
  $("#rv-close").onclick = closeViewer;
  $("#rv-prev").onclick = () => showItem(review.index - 1);
  $("#rv-next").onclick = () => showItem(review.index + 1);
  $("#rv-form").onsubmit = sendComment;
  $("#rv-input").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendComment(e); };
  $("#invite-close").onclick = () => ($("#invite").hidden = true);
  document.addEventListener("keydown", (e) => {
    if ($("#rv").hidden) return;
    const typing = e.target.closest?.("textarea, input");
    if (e.key === "Escape") {
      if (typing?.value) typing.blur(); // un texte en cours : on le garde
      else closeViewer();
      return;
    }
    if (typing) return;
    const f = review.list[review.index];
    if (e.key === "ArrowLeft") showItem(review.index - 1);
    else if (e.key === "ArrowRight") showItem(review.index + 1);
    else if (/^[0-7]$/.test(e.key) && f) setTag(f, e.key === "0" ? null : TAGS[+e.key - 1].key);
  });
});
