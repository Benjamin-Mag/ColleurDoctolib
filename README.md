# ColleurDoctolib — extension Chrome/Edge

Copie les infos d'un patient depuis Salesforce, puis les colle dans le formulaire de prise de rendez-vous Doctolib ou Acuitis — évite de ressaisir nom, coordonnées et date de naissance à la main.

## Utilisation

1. Sur une fiche patient Salesforce (Piste ou Opportunité), cliquer l'icône de l'extension → un panneau flottant apparaît avec le bouton **"📋 Copier les infos patient"**. Le bandeau **est** le bouton : cliquer dessus copie les infos dans le presse-papier ; le glisser déplace le panneau.
2. Aller sur Doctolib (réservation en ligne ou front-desk) ou sur Acuitis, cliquer l'icône de l'extension → panneau avec le bouton **"📨 Coller..."** qui remplit le formulaire.

La croix ferme le panneau à tout moment.

## Fichiers

- `popup.js` — toute la logique (3 panneaux : copier sur Salesforce, coller sur Doctolib, coller sur Acuitis)
- `popup.html` — popup fallback
- `manifest.json` — MV3, permissions `activeTab`, `scripting`, `clipboardRead`, `clipboardWrite`

## Installation / mise à jour

`chrome://extensions` → mode développeur → "Charger l'extension décompressée" → pointer sur ce dossier. Après modif de `popup.js`, recharger (↺). Pas de repo git ici — pas de rollback facile, vérifier avant d'écraser.

## Couplé à l'app générateur de mails

Le JSON copié contient aussi les clés `patient`/`partenaire`/`adresse`, lues par les boutons "📋 Coller depuis Salesforce" de l'app générateur de mails (`..\Générateur de mail\`) pour préremplir ses champs — un seul clic ici sert donc aux deux usages (RDV Doctolib/Acuitis + préremplissage de l'app). Voir sa mémoire projet pour le détail.

## Pièges connus

- **Salesforce Console garde plusieurs fiches montées en même temps** (onglets internes) : une fiche en arrière-plan reste dans le DOM à taille nulle. Le code doit filtrer sur la taille rendue (`getBoundingClientRect`) et ne JAMAIS retourner un candidat invisible par défaut — sinon les infos de la mauvaise fiche remontent.
- **Fiche Opportunité** : n'a pas les champs "Nom complet"/"Date de naissance" (propres aux Pistes/Leads) — le nom est extrait du titre de la fiche, le téléphone du panneau "Numéro mobile/fixe du client".
- **Acuitis** : presse-papier bloqué dans son iframe cross-origin, relayé via `postMessage` depuis la frame parente.
