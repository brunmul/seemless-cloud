// Sources : les dossiers Drive choisis par l'utilisateur. On ne charge que leur contenu
// (sous-dossiers compris), jamais tout le Drive, pour éviter les images parasites.

const ALL_FIELDS = "id, name, mimeType, parents, shared, size, thumbnailLink, createdTime, imageMediaMetadata(time, width, height)";

const sourceIds = (kind) => settings.sources.filter((s) => !kind || s[kind]).map((s) => s.id);
// Le préfixe change quand on charge de nouveaux types de fichiers (ici les livres) :
// l'ancien cache est alors rechargé une fois.
const sourcesKey = () => "v2:" + sourceIds().slice().sort().join(",");
const isSource = (id) => settings.sources.some((s) => s.id === id);

// ---------- Chargement : parcours des dossiers sources ----------

// Descend dans l'arborescence niveau par niveau. Chaque requête couvre jusqu'à
// 40 dossiers parents et ramène d'un coup leurs sous-dossiers, images et sons.
// stale() devient vrai quand l'utilisateur change ses sources : on arrête tout.
async function crawlSources(ids, fresh, onProgress, stale) {
  const metas = await pool(ids, 5, (id) => api(`/files/${id}`, { fields: FOLDER_FIELDS }));
  metas.filter(Boolean).forEach((f) => { if (f.id !== state.rootId) fresh.folders.push(f); });

  const seen = new Set(ids);
  let frontier = [...ids];
  while (frontier.length) {
    const batches = [];
    for (let k = 0; k < frontier.length; k += 40) batches.push(frontier.slice(k, k + 40));
    frontier = [];
    await pool(batches, 6, async (batch) => {
      if (stale()) return;
      const q = `(${batch.map((id) => `'${id}' in parents`).join(" or ")}) and trashed = false and ` +
        `(mimeType = '${FOLDER_MIME}' or mimeType contains 'image/' or mimeType contains 'audio/'` +
        BOOK_MIMES.map((m) => ` or mimeType = '${m}'`).join("") + ")";
      const onPage = (page) => {
        for (const f of page) {
          if (f.mimeType === FOLDER_MIME) {
            if (!seen.has(f.id)) { seen.add(f.id); fresh.folders.push(f); frontier.push(f.id); }
          } else if (f.mimeType.startsWith("image/")) fresh.photos.push(f);
          else if (BOOK_MIMES.includes(f.mimeType)) fresh.books.push(f);
          else fresh.tracks.push(f);
        }
        onProgress();
      };
      // Une nouvelle tentative si Drive répond une erreur passagère.
      try { await listAll(q, ALL_FIELDS, onPage); }
      catch { await listAll(q, ALL_FIELDS, onPage); }
    });
  }
}

// ---------- Vue « Sources » ----------

const browse = { stack: [{ id: null, name: "Google Drive" }], cache: new Map() };

async function browseChildren(id) {
  if (id === null) return [{ id: state.rootId || "root", name: "Mon Drive", virtual: true }, { id: "shared", name: "Partagés avec moi", virtual: true }];
  if (browse.cache.has(id)) return browse.cache.get(id);
  const q = id === "shared"
    ? `sharedWithMe and mimeType = '${FOLDER_MIME}' and trashed = false`
    : `'${id}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const list = await listAll(q, "id, name", null, "name");
  browse.cache.set(id, list);
  return list;
}

// Une modification des sources arrête le chargement en cours : il ne
// correspond plus à ce que l'utilisateur a choisi.
function sourcesChanged() {
  saveSettings();
  if (state.lib.key !== sourcesKey()) {
    loadGeneration++;
    $("#sync-status").textContent = settings.sources.length ? "Dossiers modifiés : clique sur Charger" : "";
  }
  if (!settings.sources.length) {
    state.lib = { folders: [], photos: [], tracks: [], books: [], rootId: state.rootId };
    buildLibrary();
    saveLibrary();
  }
  renderSources();
}

function addSource(f) {
  if (isSource(f.id)) return;
  if (f.id === state.rootId && !confirm("Ajouter tout ton Drive ? Tout son contenu sera chargé, ce qui peut être long et afficher des images sans rapport.")) return;
  if (!f.id) return;
  settings.sources.push({ id: f.id, name: f.name, photos: true, music: true, books: true });
  sourcesChanged();
}

function removeSource(i) {
  settings.sources.splice(i, 1);
  sourcesChanged();
}

async function renderSources() {
  const loaded = state.lib.key === sourcesKey() && settings.sources.length;
  setHeader("Dossiers suivis", "Les dossiers Drive affichés dans Photos, Musique et Livres");
  gridObserver?.disconnect();
  const c = $("#content");

  const rows = settings.sources.map((s, i) => `
    <div class="source-row" data-i="${i}">
      <span class="sn">📁 ${esc(s.name)}</span>
      <label class="chip"><input type="checkbox" data-kind="photos" ${s.photos ? "checked" : ""}> Photos</label>
      <label class="chip"><input type="checkbox" data-kind="music" ${s.music ? "checked" : ""}> Musique</label>
      <label class="chip"><input type="checkbox" data-kind="books" ${s.books ? "checked" : ""}> Livres</label>
      <button class="source-remove" title="Retirer cette source">✕</button>
    </div>`).join("");

  c.innerHTML = `<div class="sources">
    <div class="section-title">Tes sources</div>
    ${rows || `<p class="muted">Aucune source pour l'instant. Ajoute un ou plusieurs dossiers ci-dessous : seul leur contenu sera chargé.</p>`}
    <div class="sources-go">
      <button id="src-load" class="btn-primary" ${settings.sources.length ? "" : "disabled"}>
        ${loaded ? "Recharger" : "Charger ces dossiers"}</button>
      <span class="muted">${loaded ? "Ta bibliothèque vient de ces dossiers." : settings.sources.length ? "Les changements s'appliquent quand tu charges." : ""}</span>
    </div>
    <div class="section-title">Ajouter un dossier</div>
    <nav class="breadcrumb" id="src-crumbs"></nav>
    <div id="src-browser" class="src-browser"><p class="muted" style="padding:10px">Chargement…</p></div>
  </div>`;

  c.querySelectorAll(".source-row").forEach((row) => {
    const i = +row.dataset.i, s = settings.sources[i];
    row.querySelectorAll("input").forEach((cb) => (cb.onchange = () => {
      s[cb.dataset.kind] = cb.checked;
      saveSettings();
      buildLibrary();
    }));
    row.querySelector(".source-remove").onclick = () => removeSource(i);
  });
  $("#src-load").onclick = () => { refreshLibrary(false); goRoot("library"); };

  const crumbs = $("#src-crumbs");
  crumbs.innerHTML = browse.stack.map((f, k) =>
    `${k ? "›" : ""}<button class="crumb" data-k="${k}">${esc(f.name)}</button>`).join("");
  crumbs.querySelectorAll(".crumb").forEach((b) => (b.onclick = () => {
    browse.stack = browse.stack.slice(0, +b.dataset.k + 1);
    renderSources();
  }));

  const here = browse.stack[browse.stack.length - 1];
  let list;
  try { list = await browseChildren(here.id); }
  catch (e) { $("#src-browser").innerHTML = `<p class="muted" style="padding:10px">Impossible de lire ce dossier.</p>`; return; }
  if (state.view.name !== "sources" || browse.stack[browse.stack.length - 1] !== here) return;

  const box = $("#src-browser");
  box.innerHTML = "";
  const addable = (f) => !f.virtual;
  if (here.id && here.id !== "shared") {
    box.insertAdjacentHTML("beforeend", `<div class="browse-row here"><span class="sn">Tout « ${esc(here.name)} »</span>
      <button class="browse-add">${isSource(here.id) ? "✓ Ajouté" : "+ Ajouter"}</button></div>`);
    box.lastElementChild.querySelector(".browse-add").onclick = () => addSource(here);
  }
  for (const f of list) {
    const row = document.createElement("div");
    row.className = "browse-row";
    row.innerHTML = `<button class="browse-open">📁 ${esc(f.name)} <span class="muted">›</span></button>
      ${addable(f) ? `<button class="browse-add">${isSource(f.id) ? "✓ Ajouté" : "+ Ajouter"}</button>` : ""}`;
    row.querySelector(".browse-open").onclick = () => { browse.stack.push(f); renderSources(); };
    row.querySelector(".browse-add")?.addEventListener("click", () => addSource(f));
    box.appendChild(row);
  }
  if (!list.length) box.insertAdjacentHTML("beforeend", `<p class="muted" style="padding:10px">Aucun sous-dossier.</p>`);
}
