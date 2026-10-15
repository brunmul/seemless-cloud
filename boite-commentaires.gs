// Seemless cloud : boîte à commentaires des dossiers partagés.
//
// À coller dans un projet Google Apps Script (script.google.com), puis
// Déployer > Nouveau déploiement > Application Web, « Exécuter en tant que : moi »,
// « Qui a accès : tout le monde ». L'URL obtenue va dans config.js (REVIEW_URL).
//
// Les invités n'ont pas de compte Google : ce script enregistre leurs
// commentaires et leurs pastilles dans un fichier JSON par dossier partagé,
// dans ton Drive. Chaque dossier a sa clé secrète (dans le lien d'invitation) ;
// seul le propriétaire du script peut obtenir une clé, avec son jeton Google.

function doGet() {
  return out({ ok: true });
}

function doPost(e) {
  try {
    return out(route(JSON.parse(e.postData.contents)));
  } catch (err) {
    return out({ error: String(err && err.message || err) });
  }
}

function out(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function props() {
  return PropertiesService.getScriptProperties();
}

function keyFor(folder) {
  let secret = props().getProperty("secret");
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props().setProperty("secret", secret);
  }
  const sig = Utilities.computeHmacSha256Signature(folder, secret);
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, "").slice(0, 24);
}

// Le jeton Google envoyé doit appartenir au propriétaire de ce script.
function isOwner(token) {
  const res = UrlFetchApp.fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
    headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return false;
  return JSON.parse(res.getContentText()).user.emailAddress === Session.getEffectiveUser().getEmail();
}

function route(p) {
  const folder = String(p.folder || "");
  if (!/^[\w-]+$/.test(folder)) throw new Error("Dossier invalide");
  if (p.action === "key") {
    if (!isOwner(String(p.token || ""))) throw new Error("Refusé");
    return { key: keyFor(folder) };
  }
  if (p.key !== keyFor(folder)) throw new Error("Lien d'invitation invalide");
  const by = String(p.by || "");
  if (!by) throw new Error("Auteur manquant");
  const show = (c) => ({ id: c.id, file: c.file, parent: c.parent, name: c.name, text: c.text, at: c.at, me: c.by === by });

  if (p.action === "list") return { comments: read(folder).map(show) };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    let list = read(folder);
    let result = {};
    if (p.action === "add") {
      const text = String(p.text || "").trim().slice(0, 4000);
      if (!text || !p.file) throw new Error("Commentaire vide");
      const c = {
        id: Utilities.getUuid(), file: String(p.file), parent: p.parent ? String(p.parent) : null,
        by: by, name: String(p.name || "Invité").slice(0, 60), text: text, at: new Date().toISOString(),
      };
      list.push(c);
      result = { comment: show(c) };
    } else if (p.action === "edit" || p.action === "delete") {
      const c = list.find((x) => x.id === p.id);
      if (!c || c.by !== by) throw new Error("Commentaire introuvable");
      if (p.action === "edit") {
        c.text = String(p.text || "").trim().slice(0, 4000);
        result = { comment: show(c) };
      } else {
        list = list.filter((x) => x.id !== c.id && x.parent !== c.id);
      }
    } else {
      throw new Error("Action inconnue");
    }
    write(folder, list);
    return result;
  } finally {
    lock.releaseLock();
  }
}

// ---------- Stockage : un fichier JSON par dossier, dans ton Drive ----------

function storeFile(folder, create) {
  const id = props().getProperty("file:" + folder);
  if (id) {
    try { return DriveApp.getFileById(id); } catch (e) {}
  }
  if (!create) return null;
  const file = DriveApp.createFile("Seemless cloud - commentaires " + folder + ".json", "[]", "application/json");
  props().setProperty("file:" + folder, file.getId());
  return file;
}

function read(folder) {
  const file = storeFile(folder, false);
  return file ? JSON.parse(file.getBlob().getDataAsString() || "[]") : [];
}

function write(folder, list) {
  storeFile(folder, true).setContent(JSON.stringify(list));
}
