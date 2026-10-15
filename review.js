// Revue d'un dossier partagé : mode invité et vue « Revue » du propriétaire.
// L'invité ouvre l'app avec un lien #invite=<id du dossier> et ne voit que ce
// dossier : photos, vidéos, commentaires et pastilles de couleur.
//
// Un invité « Commentateur » ne peut pas modifier les fichiers, donc pas leurs
// propriétés Drive. Les pastilles sont des commentaires Drive au texte fixe
// (« 🔴 Pastille rouge ») : chacun pose les siennes, tout le monde les voit,
// y compris dans Google Drive.

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
const COMMENT_FIELDS = "id, content, createdTime, deleted, author(displayName, me), replies(id, content, createdTime, deleted, author(displayName, me))";

const review = {
  folders: new Map(),   // id -> { meta, subs, items } : dossiers déjà chargés
  comments: new Map(),  // fileId -> [commentaires]
  filter: null,         // clé de pastille, "none" ou null (tout)
  list: [], index: 0,   // visionneuse
  replyTo: null,
};

// ---------- Mode invité ----------

// Le lien d'invitation est mémorisé : l'app installée rouvre le même dossier.
(function readInvite() {
  const m = location.hash.match(/invite=([\w-]+)/);
  if (m) {
    settings.guest = { id: m[1] };
    saveSettings();
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (settings.guest) document.documentElement.classList.add("guest");
})();

const isGuest = () => !!settings.guest;

function leaveGuest() {
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
  loadComments(items);
  return entry;
}

// Commentaires de chaque fichier, quelques requêtes à la fois ; chaque
// vignette se met à jour dès que les siens arrivent.
function loadComments(items) {
  pool(items.filter((f) => !review.comments.has(f.id)), 8, async (f) => {
    const { comments } = await api(`/files/${f.id}/comments`, { fields: `comments(${COMMENT_FIELDS})`, pageSize: 100 });
    review.comments.set(f.id, comments.filter((c) => !c.deleted));
    refreshTile(f.id);
  });
}

const commentsOf = (id) => review.comments.get(id) || [];
const tagsOf = (id) => commentsOf(id).map((c) => ({ c, tag: tagOf(c) })).filter((x) => x.tag);
const notesOf = (id) => commentsOf(id).filter((c) => !tagOf(c));
const myTag = (id) => tagsOf(id).find((x) => x.c.author?.me);

// ---------- Vue « Revue » ----------

async function renderReview({ id }) {
  const c = $("#content");
  gridObserver?.disconnect();
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
    c.innerHTML = `<div class="empty">Ce dossier n'est pas partagé avec ce compte Google, ou il n'existe plus.<br><br>
      <button id="rv-signout">Changer de compte</button></div>`;
    $("#rv-signout").onclick = signOut;
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
  if (isGuest() && !state.history.length) {
    if (owner?.me) actions.push({ label: "Revenir à ma bibliothèque", onClick: leaveGuest });
    actions.push({ label: "Déconnexion", onClick: signOut });
  } else if (!isGuest()) {
    actions.push({ label: "Inviter…", onClick: () => openInvite({ id, name: meta.name }) });
  }
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
  c.querySelectorAll(".folder-open").forEach((b) => (b.onclick = () => go({ name: "review", id: b.dataset.id })));

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
  const loaded = review.comments.has(f.id);
  $("#rv-comments").innerHTML = !loaded ? `<p class="muted">Chargement…</p>`
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
  const list = commentsOf(f.id).slice();
  try {
    if (current && !tag) {
      await api(`/files/${f.id}/comments/${current.c.id}`, {}, { method: "DELETE" });
      review.comments.set(f.id, list.filter((c) => c !== current.c));
    } else if (current && tag) {
      if (current.tag.key === key) return;
      const c = await api(`/files/${f.id}/comments/${current.c.id}`, { fields: COMMENT_FIELDS }, { method: "PATCH", body: { content: tagText(tag) } });
      review.comments.set(f.id, list.map((x) => (x === current.c ? c : x)));
    } else if (tag) {
      const c = await api(`/files/${f.id}/comments`, { fields: COMMENT_FIELDS }, { method: "POST", body: { content: tagText(tag) } });
      review.comments.set(f.id, [...list, c]);
    }
  } catch (e) { console.error(e); toast("Impossible de poser la pastille"); return; }
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
    const list = commentsOf(f.id).slice();
    if (review.replyTo) {
      const r = await api(`/files/${f.id}/comments/${review.replyTo.id}/replies`,
        { fields: "id, content, createdTime, deleted, author(displayName, me)" }, { method: "POST", body: { content: text } });
      const parent = list.find((c) => c.id === review.replyTo.id);
      if (parent) parent.replies = [...(parent.replies || []), r];
    } else {
      list.push(await api(`/files/${f.id}/comments`, { fields: COMMENT_FIELDS }, { method: "POST", body: { content: text } }));
    }
    review.comments.set(f.id, list);
    input.value = "";
    review.replyTo = null;
  } catch (err) { console.error(err); toast("Impossible d'envoyer le commentaire"); }
  input.disabled = false;
  input.blur(); // les raccourcis clavier (flèches, 1 à 7) remarchent tout de suite
  refreshTile(f.id);
  drawSide();
}

async function deleteComment(f, id) {
  if (!confirm("Supprimer ce commentaire ?")) return;
  try {
    await api(`/files/${f.id}/comments/${id}`, {}, { method: "DELETE" });
    review.comments.set(f.id, commentsOf(f.id).filter((c) => c.id !== id));
  } catch (e) { console.error(e); toast("Impossible de supprimer"); return; }
  refreshTile(f.id);
  drawSide();
}

// ---------- Inviter quelqu'un (propriétaire) ----------

async function openInvite(folder) {
  const url = publicUrl();
  const link = url ? `${url}#invite=${folder.id}` : "";
  $("#invite-title").textContent = `Inviter sur « ${folder.name} »`;
  $("#invite-email").value = "";
  $("#invite-link").value = link;
  $("#invite-link-row").hidden = !link;
  $("#invite-note").textContent = link ? ""
    : "L'app n'a pas encore d'adresse publique : l'invité aura accès au dossier dans Google Drive, mais pas encore à l'app.";
  $("#invite-people").innerHTML = "";
  $("#invite").hidden = false;
  $("#invite-email").focus();
  $("#invite-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast("Lien copié"); } catch { $("#invite-link").select(); }
  };
  $("#invite-send").onclick = () => sendInvite(folder, link);
  drawPeople(folder);
}

const roleName = (r) => ({ commenter: "Commentateur", reader: "Lecteur", writer: "Éditeur" }[r] || r);

async function sendInvite(folder, link) {
  const email = $("#invite-email").value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { $("#invite-email").focus(); return; }
  $("#invite-send").disabled = true;
  try {
    await api(`/files/${folder.id}/permissions`, {
      sendNotificationEmail: true,
      emailMessage: link ? `Ouvre ce lien pour voir les photos, commenter et poser des pastilles : ${link}` : "",
    }, { method: "POST", body: { type: "user", role: "commenter", emailAddress: email } });
    toast(`${email} est invité`);
    $("#invite-email").value = "";
    $("#invite-note").textContent = "Dernière étape : ajoute aussi cette adresse dans Google Cloud, Audience, Utilisateurs test. Sans ça, Google refusera sa connexion à l'app.";
    drawPeople(folder);
  } catch (e) { console.error(e); alert("Impossible d'inviter : " + e.message); }
  $("#invite-send").disabled = false;
}

async function drawPeople(folder) {
  try {
    const { permissions } = await api(`/files/${folder.id}/permissions`, { fields: "permissions(id, type, role, emailAddress, displayName)" });
    const people = permissions.filter((p) => p.type === "user" && p.role !== "owner");
    $("#invite-people").innerHTML = people.length ? `<div class="muted">Déjà invités</div>` + people.map((p) =>
      `<div class="invite-person"><span>${esc(p.displayName || p.emailAddress)}</span><span class="muted">${roleName(p.role)}</span></div>`).join("") : "";
  } catch {}
}

// ---------- Branchements ----------

window.addEventListener("load", () => {
  $("#rv-close").onclick = closeViewer;
  $("#rv-prev").onclick = () => showItem(review.index - 1);
  $("#rv-next").onclick = () => showItem(review.index + 1);
  $("#rv-form").onsubmit = sendComment;
  $("#rv-input").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendComment(e); };
  $("#invite-close").onclick = () => ($("#invite").hidden = true);
  $("#invite-email").onkeydown = (e) => { if (e.key === "Enter") $("#invite-send").click(); };
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
