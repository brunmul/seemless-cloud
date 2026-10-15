# Seemless cloud

Un "Google Photos + Spotify" perso qui lit directement ton Google Drive.

- **Photos** : toutes les images de ton Drive, triées par date de prise de vue (EXIF), groupées par mois, avec visionneuse plein écran (flèches ← →, Échap).
- **Musique** : tous les fichiers audio (MP3, M4A, FLAC, OGG…). Un dossier Drive = un album, et une image `cover.jpg` / `folder.jpg` dans le dossier sert de pochette. Lecture en streaming avec avance rapide, file d'attente, aléatoire, touches multimédia et contrôles sur l'écran verrouillé.
- **Recherche** sur les noms de fichiers, d'albums et de photos.

Aucun serveur : la page parle directement à l'API Google Drive avec ton compte, en **lecture seule**.

## Pourquoi Drive et pas Google Photos ?

Depuis mars 2025, Google a fermé l'accès de l'API Google Photos à la bibliothèque complète : une app tierce ne voit plus que les photos qu'elle a elle-même ajoutées, ou celles que tu choisis une par une dans un sélecteur. Pour parcourir *toute* ta bibliothèque, il faut que les photos soient dans Drive. Pour y copier ta bibliothèque Google Photos : [Google Takeout](https://takeout.google.com) → "Google Photos" → destination "Ajouter à Drive".

## Configuration (une seule fois, ~10 min)

1. Va sur [console.cloud.google.com](https://console.cloud.google.com) et crée un projet (par ex. "mon-cloud-media").
2. **API et services → Bibliothèque** : active **Google Drive API**.
3. **API et services → Écran de consentement OAuth** (ou "Google Auth Platform") :
   - Type d'utilisateur : **Externe**.
   - Renseigne le nom de l'app et ton e-mail.
   - Dans **Accès aux données**, ajoute le champ d'application `https://www.googleapis.com/auth/drive.readonly`.
   - Dans **Audience → Utilisateurs test**, ajoute ton adresse Gmail. (En mode "Test", l'app n'a pas besoin d'être validée par Google.)
4. **Identifiants → Créer des identifiants → ID client OAuth** :
   - Type : **Application Web**.
   - Origines JavaScript autorisées : `http://localhost:8080`
5. Copie l'ID client (qui finit par `.apps.googleusercontent.com`) dans `config.js`.

## Lancer l'app

Dans ce dossier :

```bash
python3 -m http.server 8080
# ou : npx serve -l 8080
```

Puis ouvre <http://localhost:8080> et clique sur **Se connecter avec Google**. Google affichera un avertissement "application non validée" : c'est normal, c'est ta propre app ; clique sur *Continuer*.

> Il faut passer par `http://localhost` (pas en ouvrant `index.html` directement) car le streaming audio passe par un service worker, qui exige une vraie adresse web.

## Comment ça marche

| Fichier | Rôle |
|---|---|
| `index.html` | La page : onglets Photos / Musique, visionneuse, lecteur. |
| `app.js` | Connexion Google (Google Identity Services), listing Drive (`files.list` paginé), rendu galerie et albums, file de lecture. |
| `sw.js` | Service worker qui ajoute le jeton Google aux requêtes vers les fichiers, ce que `<audio>` et `<img>` ne savent pas faire seuls. Il transmet l'en-tête `Range`, donc l'audio est streamé et on peut sauter dans un morceau. |
| `config.js` | Ton ID client OAuth. |
| `styles.css` | Thème sombre, responsive mobile. |

Les miniatures de photos viennent de Google (`thumbnailLink`), ce qui reste rapide même avec des milliers de photos et fonctionne aussi pour le HEIC de l'iPhone.

## Limites actuelles et prochaines étapes possibles

- Les titres viennent des noms de fichiers ; les tags ID3 (artiste, album) ne sont pas encore lus. Prochaine étape : lire les tags avec une petite lib comme `music-metadata` et mettre le résultat en cache.
- Rien n'est mis en cache entre deux visites : le listing est refait à chaque connexion. Avec IndexedDB, l'app démarrerait instantanément.
- Pour l'utiliser depuis ton téléphone hors de chez toi, il faudra la mettre en ligne (GitHub Pages, Netlify, Vercel… gratuit) et ajouter cette adresse aux origines autorisées. On peut aussi en faire une PWA installable.
- Le format FLAC se lit dans Chrome, Firefox et Safari récents ; le WMA ne se lit nulle part.
