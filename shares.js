// Rubrique « Partages » : les dossiers partagés par lien, leur activité
// (commentaires et pastilles des invités) et leurs options.

const SHARE_FIELDS = "id, name, modifiedTime, parents";
const MEDIA_Q = "trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')";

const shares = {
  list: null,          // [{ folder, items, subs, comments, error }] ; null tant que pas chargé
  loading: null,
  at: 0,
};

// Dossiers lisibles par « tous ceux qui ont le lien », du plus récent au plus ancien.
async function loadShares(fresh) {
  if (shares.loading) return shares.loading;
  if (shares.list && !fresh && Date.now() - shares.at < 60_000) return shares.list;
  shares.loading = (async () => {
    const q = `mimeType = '${FOLDER_MIME}' and 'me' in owners and trashed = false and (visibility = 'anyoneWithLink' or visibility = 'anyoneCanFind')`;
    const all = await listAll(q, SHARE_FIELDS, null, "modifiedTime desc");
    // Les sous-dossiers d'un dossier partagé le sont aussi : on ne garde que le haut.
    const ids = new Set(all.map((f) => f.id));
    const folders = all.filter((f) => !(f.parents || []).some((p) => ids.has(p)));
    const old = new Map((shares.list || []).map((s) => [s.folder.id, s]));
    const list = folders.map((folder) => old.has(folder.id) ? { ...old.get(folder.id), folder }
      : { folder, items: [], subs: [], comments: [], error: null, loaded: false });
    shares.list = list;
    shares.at = Date.now();
    shares.filling = fillShares(list);
    return list;
  })();
  try { return await shares.loading; } finally { shares.loading = null; }
}

// Contenu et réactions de chaque dossier, plusieurs à la fois ; chaque carte
// se met à jour dès que son dossier est prêt.
async function fillShares(list) {
  await pool(list, 6, async (s) => {
    if (!s.loaded) await fillShare(s);
    s.loaded = true;
    shareReady(s);
  });
}

async function fillShare(s) {
  try {
    const kids = await listAll(`'${s.folder.id}' in parents and trashed = false and (mimeType = '${FOLDER_MIME}' or mimeType contains 'image/' or mimeType contains 'video/')`,
      "id, name, mimeType, thumbnailLink, createdTime", null, "createdTime desc");
    s.subs = kids.filter((f) => f.mimeType === FOLDER_MIME);
    s.items = kids.filter((f) => f.mimeType !== FOLDER_MIME);
    // Pas de photo à la racine : la couverture vient des sous-dossiers.
    if (!s.items.length && s.subs.length) {
      const inSubs = s.subs.slice(0, 10).map((f) => `'${f.id}' in parents`).join(" or ");
      s.cover = (await api("/files", { q: `(${inSubs}) and ${MEDIA_Q}`, pageSize: 4, orderBy: "createdTime desc",
        fields: "files(id, mimeType, thumbnailLink, createdTime)" })).files;
    }
  } catch (e) { console.error(e); }
  if (!boxUrl()) return;
  try {
    const key = await ownerKey(s.folder.id);
    s.comments = (await box("list", { folder: s.folder.id, key })).comments;
  } catch (e) { s.error = e.message; }
}

function shareReady(s) {
  updateSharesBadge();
  if (state.view.name !== "shares") return;
  const card = document.querySelector(`.sh-card[data-id="${s.folder.id}"]`);
  if (!card) return;
  card.insertAdjacentHTML("afterend", shareCard(s));
  card.remove();
  bindCard(document.querySelector(`.sh-card[data-id="${s.folder.id}"]`));
}

// ---------- Statistiques d'un dossier ----------

const lastActivity = (s) => s.comments.reduce((m, c) => (c.at > m ? c.at : m), "");
// Jamais ouvert : seules les réactions des 3 derniers jours comptent comme nouvelles.
const seenAt = (id) => settings.sharesSeen?.[id] || new Date(Date.now() - 3 * 86400e3).toISOString();
const newCount = (s) => s.comments.filter((c) => !c.me && c.at > seenAt(s.folder.id)).length;

function markSeen(id) {
  settings.sharesSeen ||= {};
  settings.sharesSeen[id] = new Date().toISOString();
  saveSettings();
  const s = shares.list?.find((x) => x.folder.id === id);
  if (s) updateSharesBadge();
}

function updateSharesBadge() {
  const n = (shares.list || []).reduce((t, s) => t + newCount(s), 0);
  const badge = $("#shares-count");
  if (!badge) return;
  badge.textContent = n > 99 ? "99+" : n;
  badge.hidden = !n;
}

function shareStats(s) {
  const tags = new Map();
  let notes = 0;
  const people = new Set();
  for (const c of s.comments) {
    if (!c.me) people.add(c.name);
    const t = TAGS.find((x) => c.text === tagText(x));
    if (t) tags.set(t.key, (tags.get(t.key) || 0) + 1);
    else notes++;
  }
  return { tags, notes, people: [...people] };
}

function ago(iso) {
  if (!iso) return "";
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return "hier";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

const initials = (name) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
function avatars(people) {
  return `<span class="sh-people">${people.slice(0, 4).map((p) =>
    `<i title="${esc(p)}" style="--h:${[...p].reduce((h, ch) => h + ch.charCodeAt(0), 0) % 360}">${esc(initials(p))}</i>`).join("")}${
    people.length > 4 ? `<i class="more">+${people.length - 4}</i>` : ""}</span>`;
}

// ---------- Vue « Dossiers partagés » ----------

async function renderShares() {
  const c = $("#content");
  gridObserver?.disconnect();
  const actions = [{ label: "+ Nouveau partage…", onClick: openSharePicker }];
  setHeader("Dossiers partagés", shares.list ? "" : "Chargement…", { actions });
  if (!shares.list) c.innerHTML = `<div class="sh-grid">${`<div class="sh-card skel"><div class="sh-cover"></div><div class="sh-body"><b></b><span></span></div></div>`.repeat(3)}</div>`;
  else drawShares();
  try { await loadShares(); }
  catch (e) { console.error(e); if (state.view.name === "shares") c.innerHTML = empty("Impossible de lire tes partages : " + esc(e.message)); return; }
  if (state.view.name === "shares") drawShares();
}

function drawShares() {
  const c = $("#content");
  const list = shares.list.filter((s) => matches(s.folder.name))
    .sort((a, b) => (lastActivity(b) || b.folder.modifiedTime).localeCompare(lastActivity(a) || a.folder.modifiedTime));
  const total = shares.list.reduce((t, s) => t + s.comments.length, 0);
  setHeader("Dossiers partagés", shares.list.length
    ? `${plural(shares.list.length, "dossier", "dossiers")} · ${plural(total, "réaction", "réactions")} des invités` : "",
    { actions: [{ label: "+ Nouveau partage…", onClick: openSharePicker }] });
  if (!list.length) {
    c.innerHTML = empty(shares.list.length ? "Aucun dossier ne correspond." :
      "Aucun dossier partagé pour l'instant.<br><br><button id=\"sh-first\" class=\"btn-primary\">Partager un dossier…</button>");
    $("#sh-first")?.addEventListener("click", openSharePicker);
    return;
  }
  c.innerHTML = `<div class="sh-grid">${list.map(shareCard).join("")}</div>`;
  c.querySelectorAll(".sh-card").forEach(bindCard);
}

const coverOf = (s) => (s.items.length ? s.items : s.cover || []).slice(0, 4);

function bindCard(card) {
  const s = shares.list.find((x) => x.folder.id === card.dataset.id);
  card.querySelectorAll("img[data-thumb]").forEach((img) => {
    const f = coverOf(s).find((x) => x.id === img.dataset.thumb);
    if (f) setThumb(img, f, 400);
  });
  card.querySelector(".sh-open").onclick = () => openShare(s);
  card.querySelector("[data-act=copy]").onclick = () => copyShareLink(s.folder);
  card.querySelector("[data-act=activity]").onclick = () => go({ name: "share-activity", id: s.folder.id });
  card.querySelector("[data-act=stop]").onclick = () => stopShare(s);
}

function shareCard(s) {
  const { tags, notes, people } = shareStats(s);
  const fresh = newCount(s);
  const photos = s.items.filter((f) => !f.mimeType.startsWith("video/")).length, videos = s.items.length - photos;
  const cover = coverOf(s);
  const last = lastActivity(s);
  return `<div class="sh-card ${s.loaded ? "" : "pending"}" data-id="${s.folder.id}">
    <button class="sh-open">
      <div class="sh-cover n${cover.length}">${cover.map((f) => `<img data-thumb="${f.id}" alt="" loading="lazy">`).join("") || "<span>📁</span>"}
        ${fresh ? `<span class="sh-new">${fresh} nouveau${fresh > 1 ? "x" : ""}</span>` : ""}</div>
      <div class="sh-body">
        <b>${esc(s.folder.name)}</b>
        <span class="muted">${[photos && plural(photos, "photo", "photos"), videos && plural(videos, "vidéo", "vidéos"),
          s.subs.length && plural(s.subs.length, "sous-dossier", "sous-dossiers")].filter(Boolean).join(" · ") || (s.loaded ? "Vide" : "&nbsp;")}</span>
        <span class="sh-stats">${TAGS.filter((t) => tags.has(t.key)).map((t) => `<span><i style="background:${t.color}"></i>${tags.get(t.key)}</span>`).join("")}
          ${notes ? `<span>💬 ${notes}</span>` : ""}${!s.loaded ? `<span class="muted">Chargement…</span>` : !tags.size && !notes ? `<span class="muted">${s.error ? `<span title="${esc(s.error)}">Commentaires indisponibles</span>` : "Pas encore de réaction"}</span>` : ""}</span>
        <span class="sh-foot">${avatars(people)}<span class="muted">${last ? ago(last) : ""}</span></span>
      </div>
    </button>
    <div class="sh-actions">
      <button data-act="copy" title="Copier le lien d'invitation">Copier le lien</button>
      <button data-act="activity" title="Voir l'activité">Activité</button>
      <span class="spacer"></span>
      <button data-act="stop" class="danger" title="Désactiver le lien">Arrêter</button>
    </div>
  </div>`;
}

function openShare(s) {
  markSeen(s.folder.id);
  go({ name: "review", id: s.folder.id });
}

async function shareLink(folder) {
  return `${publicUrl()}#invite=${folder.id}&k=${await ownerKey(folder.id)}`;
}

async function copyShareLink(folder) {
  try {
    const link = await shareLink(folder);
    await navigator.clipboard.writeText(link);
    toast("Lien d'invitation copié");
  } catch (e) { console.error(e); toast("Impossible de copier le lien"); }
}

async function stopShare(s) {
  if (!confirm(`Désactiver le lien de « ${s.folder.name} » ? Les invités n'y auront plus accès. Leurs commentaires restent.`)) return;
  try {
    const p = await linkPermission(s.folder);
    if (p) await api(`/files/${s.folder.id}/permissions/${p.id}`, {}, { method: "DELETE" });
    sharedChanged(s.folder, false);
    toast(`« ${s.folder.name} » n'est plus partagé`);
    if (state.view.name === "shares") drawShares();
  } catch (e) { console.error(e); toast("Impossible de désactiver le lien"); }
}

// Un partage créé ou arrêté ailleurs (fenêtre d'invitation) : on met à jour la liste.
function sharedChanged(folder, shared) {
  markShared(folder.id, shared);
  if (!shared && shares.list) shares.list = shares.list.filter((x) => x.folder.id !== folder.id);
  shares.at = 0;
  if (state.view.name === "shares") renderShares();
}

// Nouveau partage : on parcourt tout Mon Drive (pas seulement les sources),
// on entre dans un dossier, puis « Partager » ouvre la fenêtre d'invitation.
const sp = { stack: [], cache: new Map() };

function openSharePicker() {
  sp.stack = [];
  openFolderPicker({
    title: "Partager un dossier",
    render: renderSharePicker,
    current: () => sp.stack.at(-1),
    onPick: (f) => openInvite(f),
  });
}

function spChildren(id) {
  if (!sp.cache.has(id)) {
    const p = listAll(`'${id}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`, "id, name", null, "name");
    p.catch(() => sp.cache.delete(id));
    sp.cache.set(id, p);
  }
  return sp.cache.get(id);
}

async function renderSharePicker() {
  const at = sp.stack.at(-1);
  const list = $("#picker-list");
  $("#picker-path").textContent = ["Mon Drive", ...sp.stack.map((f) => f.name)].join(" › ");
  $("#picker-confirm").textContent = at ? `Partager « ${at.name} »` : "Ouvre un dossier";
  $("#picker-confirm").disabled = !at;
  list.innerHTML = `<p class="muted" style="padding:8px">Chargement…</p>`;
  let subs;
  try { subs = await spChildren(at ? at.id : "root"); }
  catch (e) { list.innerHTML = `<p class="muted" style="padding:8px">Impossible de lire Drive : ${esc(e.message)}</p>`; return; }
  if (sp.stack.at(-1) !== at) return; // on a changé de dossier entre-temps
  const shared = new Set((shares.list || []).map((s) => s.folder.id));
  list.innerHTML = "";
  if (at) {
    const up = document.createElement("button");
    up.className = "picker-item";
    up.textContent = "‹ Retour";
    up.onclick = () => { sp.stack.pop(); renderSharePicker(); };
    list.appendChild(up);
  }
  for (const f of subs) {
    const b = document.createElement("button");
    b.className = "picker-item";
    b.textContent = `📁 ${f.name}${shared.has(f.id) ? "  🔗" : ""}`;
    b.onclick = () => { sp.stack.push(f); renderSharePicker(); };
    list.appendChild(b);
  }
  if (!subs.length) list.insertAdjacentHTML("beforeend", `<p class="muted" style="padding:8px">${at ? "Aucun sous-dossier : tu peux partager celui-ci." : "Aucun dossier."}</p>`);
}

// ---------- Vue « Activité » ----------

async function renderShareActivity({ id }) {
  const c = $("#content");
  gridObserver?.disconnect();
  setHeader("Activité", "Chargement…");
  if (!shares.list) c.innerHTML = `<div class="empty">Chargement de l'activité…</div>`;
  try { await loadShares(); await shares.filling; }
  catch (e) { console.error(e); c.innerHTML = empty("Impossible de lire l'activité : " + esc(e.message)); return; }
  if (state.view.name !== "share-activity") return;
  const scope = id ? shares.list.filter((s) => s.folder.id === id) : shares.list;
  const events = scope.flatMap((s) => s.comments.map((cm) => ({ ...cm, s })))
    .filter((e) => matches(e.name + " " + e.text + " " + e.s.folder.name))
    .sort((a, b) => b.at.localeCompare(a.at));
  const title = id ? scope[0]?.folder.name || "Activité" : "Activité";
  const filter = state.activityFilter || "all";
  const shown = events.filter((e) => filter === "all" || (filter === "guests" ? !e.me : TAGS.some((t) => e.text === tagText(t))));
  setHeader(title, `${plural(events.filter((e) => !e.me).length, "réaction", "réactions")} des invités`, {
    actions: id ? [{ label: "Ouvrir le dossier", onClick: () => openShare(scope[0]) }] : [],
  });
  const chip = (k, label) => `<button class="rv-chip ${filter === k ? "on" : ""}" data-f="${k}">${label}</button>`;
  let day = "";
  c.innerHTML = `<div class="rv-filters">${chip("all", "Tout")}${chip("guests", "Invités seulement")}${chip("tags", "Pastilles")}</div>` +
    (shown.length ? `<div class="act-list">${shown.map((e) => {
      const d = new Date(e.at).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
      const head = d !== day ? `<div class="act-day">${esc(d)}</div>` : "";
      day = d;
      const tag = TAGS.find((t) => e.text === tagText(t));
      const isNew = !e.me && e.at > seenAt(e.s.folder.id);
      return `${head}<button class="act-row ${isNew ? "new" : ""}" data-folder="${e.s.folder.id}" data-file="${e.file}">
        <img alt="" data-file="${e.file}">
        <span class="act-text"><span><b>${esc(e.me ? "Toi" : e.name)}</b> ${tag ? `a posé une <i class="act-dot" style="background:${tag.color}"></i> ${esc(tag.label.toLowerCase())}`
          : `${e.parent ? "a répondu" : "a commenté"} : <span class="act-quote">« ${esc(e.text)} »</span>`}</span>
          <small class="muted">${esc(e.s.folder.name)} · ${new Date(e.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</small></span>
      </button>`;
    }).join("")}</div>` : empty("Pas encore d'activité."));
  c.querySelectorAll(".rv-chip").forEach((b) => (b.onclick = () => { state.activityFilter = b.dataset.f; render(); }));
  c.querySelectorAll(".act-row img").forEach((img) => {
    const s = shares.list.find((x) => x.folder.id === img.closest(".act-row").dataset.folder);
    const f = s?.items.find((x) => x.id === img.dataset.file) || { id: img.dataset.file };
    setThumb(img, f, 120);
  });
  c.querySelectorAll(".act-row").forEach((r) => (r.onclick = () => {
    markSeen(r.dataset.folder);
    go({ name: "review", id: r.dataset.folder, open: r.dataset.file });
  }));
  if (id) markSeen(id);
}
