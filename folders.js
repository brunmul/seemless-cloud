// Organisation : sélection de photos, albums (= dossiers Drive), déplacement,
// partage par lien, navigateur « Tous les dossiers » et réglages.
// Toute l'arborescence vient de la bibliothèque déjà chargée : pas d'attente.

state.selecting = false;
state.selected = new Map(); // id -> photo

// ---------- Clic sur une photo : visionneuse ou sélection ----------

function bindPhoto(img, p, list, i) {
  img.dataset.pid = p.id;
  img.classList.toggle("selected", state.selected.has(p.id));
  img.onclick = () => {
    if (state.selecting) return toggleSelect(p, img);
    state.lightboxList = list;
    openLightbox(i, img);
  };
}

function toggleSelect(p, img) {
  if (state.selected.has(p.id)) state.selected.delete(p.id);
  else state.selected.set(p.id, p);
  img.classList.toggle("selected", state.selected.has(p.id));
  updateSelectionBar();
}

function setSelecting(on) {
  state.selecting = on;
  document.body.classList.toggle("selecting", on);
  if (!on) {
    state.selected.clear();
    document.querySelectorAll("img.selected").forEach((el) => el.classList.remove("selected"));
  }
  $("#btn-select").textContent = on ? "Annuler" : "Sélectionner";
  updateSelectionBar();
}

function updateSelectionBar() {
  const n = state.selected.size;
  $("#selection-bar").hidden = !state.selecting;
  $("#selection-count").textContent = n ? plural(n, "photo sélectionnée", "photos sélectionnées") : "Clique sur des photos pour les sélectionner";
  $("#btn-move").disabled = !n;
}

// ---------- Arborescence ----------

const childFolders = (id) => [...state.folders.values()]
  .filter((f) => f.parent === id && f.id !== id)
  .sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }));

// Chemin d'un dossier depuis sa source (la source en premier).
function pathFromSource(id) {
  const chain = ancestors(id);
  const k = chain.findIndex(isSource);
  return (k >= 0 ? chain.slice(0, k + 1) : chain.slice(0, 1)).reverse();
}

// ---------- Tous les dossiers ----------

function renderSourceFolders() {
  setHeader("Google Drive", "Tes dossiers suivis", { actions: [{ label: "Dossiers suivis…", onClick: () => goRoot("sources") }] });
  gridObserver?.disconnect();
  const c = $("#content");
  c.innerHTML = `<div class="folder-grid">${settings.sources.map((s) => {
    const n = state.photosByFolder.get(s.id)?.length || 0;
    return `<div class="folder-card"><button class="folder-open" data-id="${s.id}"><span class="fi">📁</span><span class="fn">${esc(s.name)}
      <small>${n ? plural(n, "photo", "photos") : "&nbsp;"}</small></span></button></div>`;
  }).join("")}</div>`;
  c.querySelectorAll(".folder-open").forEach((b) => (b.onclick = () => go({ name: "drive", id: b.dataset.id })));
}

function renderDrive({ id }) {
  if (!id) return renderSourceFolders();
  const folder = state.folders.get(id) || { id, name: "Mon Drive" };
  const subs = childFolders(id).filter((f) => matches(f.name));
  const photos = (state.photosByFolder.get(id) || []).filter((p) => matches(p.name));
  const tracks = state.lib.tracks.filter((t) => t.parents?.[0] === id)
    .map((t) => ({ ...t, title: trackTitle(t.name), album: { id, name: folder.name } }));

  const actions = [{ label: "Nouveau dossier", onClick: () => createAlbum(id) }];
  const own = id !== state.rootId;
  if (own) actions.push({ label: "Commentaires", onClick: () => go({ name: "review", id }) });
  setHeader(folder.name, "", { zoom: true, select: photos.length > 0, actions,
    primary: own ? { label: folder.shared ? "Partagé" : "Partager…", icon: SHARE_ICON, onClick: () => openInvite(folder) } : null });

  const c = $("#content");
  gridObserver?.disconnect();
  const crumbs = ["", ...pathFromSource(id)];
  c.innerHTML = `<nav class="breadcrumb">${crumbs.map((x, k) =>
    `${k ? "›" : ""}<button class="crumb" data-id="${x}">${esc(x ? state.folders.get(x)?.name || "Mon Drive" : "Dossiers suivis")}</button>`).join("")}</nav>`;
  c.querySelectorAll(".crumb").forEach((b) => (b.onclick = () => go({ name: "drive", id: b.dataset.id || undefined }, false)));

  if (subs.length) {
    const grid = document.createElement("div");
    grid.className = "folder-grid";
    for (const f of subs) {
      const n = state.photosByFolder.get(f.id)?.length || 0;
      const card = document.createElement("div");
      card.className = "folder-card";
      card.innerHTML = `<button class="folder-open"><span class="fi">📁</span><span class="fn">${esc(f.name)}
        <small>${[n ? plural(n, "photo", "photos") : "", f.shared ? "partagé" : ""].filter(Boolean).join(" · ") || "&nbsp;"}</small></span></button>
        <button class="folder-share" title="Partager par lien">🔗</button>`;
      card.querySelector(".folder-open").onclick = () => go({ name: "drive", id: f.id });
      card.querySelector(".folder-share").onclick = () => openInvite(f);
      grid.appendChild(card);
    }
    c.appendChild(grid);
  }
  if (photos.length) {
    const box = document.createElement("div");
    c.appendChild(box);
    state.currentGrid = photoGrid(box, photos);
  }
  if (tracks.length) {
    c.insertAdjacentHTML("beforeend", `<div class="section-title">${plural(tracks.length, "morceau", "morceaux")}</div>${trackRows(tracks, { showAlbum: false })}`);
    c.querySelectorAll(".track").forEach((r) => (r.onclick = () => playQueue(tracks, +r.dataset.i)));
  }
  if (!subs.length && !photos.length && !tracks.length) c.insertAdjacentHTML("beforeend", empty("Ce dossier est vide."));
}

// ---------- Créer un album (dossier) ----------

async function createFolder(parentId, name) {
  const f = await api("/files", { fields: FOLDER_FIELDS }, {
    method: "POST", body: { name, mimeType: FOLDER_MIME, parents: [parentId] },
  });
  state.lib.folders.push(f);
  return f;
}

async function createAlbum(parentId) {
  const name = prompt("Nom du nouvel album :");
  if (!name?.trim()) return;
  try {
    await createFolder(parentId || state.rootId, name.trim());
    buildLibrary();
    saveLibrary();
    toast(`« ${name.trim()} » créé`);
  } catch (e) { alert("Impossible de créer l'album : " + e.message); }
}

// ---------- Déplacer des photos ----------

let pickerAt = null;
let pickerOpts = null; // null : déplacer la sélection ; sinon { title, confirm, onPick }

function openMovePicker() {
  if (!state.selected.size) return;
  openFolderPicker(null);
}

// Choisir un dossier dans ses sources (déplacer des photos, partager un dossier…).
function openFolderPicker(opts) {
  pickerOpts = opts;
  pickerAt = null;
  $("#picker-title").textContent = opts?.title || "Déplacer vers…";
  $("#picker-new").hidden = !!opts;
  $("#picker").hidden = false;
  renderPicker();
}

function pickerConfirm() {
  if (!pickerOpts) return confirmMove();
  const f = pickerOpts.current?.() || state.folders.get(pickerAt) || { id: pickerAt, name: settings.sources.find((s) => s.id === pickerAt)?.name || "Dossier" };
  $("#picker").hidden = true;
  pickerOpts.onPick(f);
}

function renderPicker() {
  if (pickerOpts?.render) return pickerOpts.render();
  // pickerAt === null : liste des sources.
  $("#picker-path").textContent = pickerAt ? pathFromSource(pickerAt)
    .map((x) => state.folders.get(x)?.name || "Mon Drive").join(" › ") : "Tes sources";
  const list = $("#picker-list");
  list.innerHTML = "";
  if (pickerAt) {
    const parent = isSource(pickerAt) ? null : state.folders.get(pickerAt)?.parent;
    const up = document.createElement("button");
    up.className = "picker-item";
    up.textContent = "‹ Dossier parent";
    up.onclick = () => { pickerAt = parent; renderPicker(); };
    list.appendChild(up);
  }
  const subs = pickerAt ? childFolders(pickerAt)
    : settings.sources.map((s) => state.folders.get(s.id) || { id: s.id, name: s.name });
  for (const f of subs) {
    const b = document.createElement("button");
    b.className = "picker-item";
    b.textContent = "📁 " + f.name;
    b.onclick = () => { pickerAt = f.id; renderPicker(); };
    list.appendChild(b);
  }
  if (!subs.length) list.insertAdjacentHTML("beforeend", `<p class="muted" style="padding:8px">Aucun sous-dossier.</p>`);
  $("#picker-confirm").textContent = pickerOpts ? pickerOpts.confirm : `Déplacer ici (${state.selected.size})`;
  $("#picker-confirm").disabled = !pickerAt;
  $("#picker-new").disabled = !pickerAt;
}

async function pickerNewFolder() {
  const name = prompt("Nom du nouvel album :");
  if (!name?.trim()) return;
  try {
    const f = await createFolder(pickerAt, name.trim());
    buildLibrary();
    pickerAt = f.id;
    renderPicker();
  } catch (e) { alert("Impossible de créer l'album : " + e.message); }
}

async function confirmMove() {
  const dest = pickerAt;
  const destName = state.folders.get(dest)?.name || "Mon Drive";
  const photos = [...state.selected.values()];
  $("#picker").hidden = true;
  let done = 0, failed = 0;
  toast(`Déplacement de ${plural(photos.length, "photo", "photos")}…`, true);
  await pool(photos, 5, async (p) => {
    try {
      const params = { addParents: dest, fields: "id, parents" };
      const old = (p.parents || []).filter((x) => x !== dest).join(",");
      if (old) params.removeParents = old;
      const res = await api(`/files/${p.id}`, params, { method: "PATCH", body: {} });
      const raw = state.lib.photos.find((x) => x.id === p.id);
      if (raw) raw.parents = res.parents;
      done++;
    } catch { failed++; }
    toast(`Déplacement… ${done + failed}/${photos.length}`, true);
  });
  toast(failed ? `${done} déplacée(s), ${failed} en échec` : `${plural(done, "photo déplacée", "photos déplacées")} dans « ${destName} »`);
  setSelecting(false);
  buildLibrary();
  saveLibrary();
}

// ---------- Partager par lien ----------

function markShared(id, shared) {
  const raw = state.lib?.folders.find((f) => f.id === id);
  if (!raw) return;
  raw.shared = shared;
  buildLibrary();
  saveLibrary();
}

async function shareFolder(f) {
  try {
    // "anyone" + "reader" : toute personne ayant le lien peut voir, pas modifier.
    await api(`/files/${f.id}/permissions`, { sendNotificationEmail: false }, {
      method: "POST", body: { role: "reader", type: "anyone" },
    });
    const { webViewLink } = await api(`/files/${f.id}`, { fields: "webViewLink" });
    markShared(f.id, true);
    $("#share-title").textContent = `« ${f.name} » est partagé`;
    $("#share-link").value = webViewLink;
    $("#share").hidden = false;
    $("#share-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(webViewLink); toast("Lien copié"); }
      catch { $("#share-link").select(); }
    };
    $("#share-stop").onclick = () => unshareFolder(f);
  } catch (e) { alert("Impossible de partager : " + e.message); }
}

async function unshareFolder(f) {
  try {
    const { permissions } = await api(`/files/${f.id}/permissions`, { fields: "permissions(id, type)" });
    for (const p of permissions.filter((p) => p.type === "anyone")) {
      await api(`/files/${f.id}/permissions/${p.id}`, {}, { method: "DELETE" });
    }
    $("#share").hidden = true;
    markShared(f.id, false);
    toast(`« ${f.name} » n'est plus partagé`);
  } catch (e) { alert("Impossible d'arrêter le partage : " + e.message); }
}

// ---------- Réglages : dossiers sources ----------

function openSettings() {
  $("#set-hide-small").checked = settings.hideSmall;
  $("#settings").hidden = false;
}

// ---------- Petit message temporaire ----------

let toastTimer;
function toast(msg, sticky) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

// ---------- Branchements ----------

window.addEventListener("load", () => {
  $("#btn-select").onclick = () => setSelecting(!state.selecting);
  $("#btn-move").onclick = openMovePicker;
  $("#btn-cancel-select").onclick = () => setSelecting(false);
  $("#picker-cancel").onclick = () => ($("#picker").hidden = true);
  $("#picker-new").onclick = pickerNewFolder;
  $("#picker-confirm").onclick = pickerConfirm;
  $("#share-close").onclick = () => ($("#share").hidden = true);
  $("#settings-close").onclick = () => ($("#settings").hidden = true);
  $("#settings-sources").onclick = () => { $("#settings").hidden = true; goRoot("sources"); };
  $("#set-hide-small").onchange = (e) => { settings.hideSmall = e.target.checked; saveSettings(); buildLibrary(); };
});
