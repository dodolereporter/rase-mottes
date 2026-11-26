# Décisions

- **Auteur des commits** : commits au nom du propriétaire du dépôt, sans mention de co-auteur (demande explicite).
- **Commits** : les étapes 1 à 8 ont été regroupées en quelques commits plus gros, chacun compilable et jouable, plutôt qu'un commit par étape. Développer chaque étape isolément aurait multiplié les allers-retours sans gain.
- **Extraction tangage/roulis** : à partir de `q_rel`, on fait tourner le vecteur « haut de l'écran ». Roulis = `atan2(u.x, u.y)`, tangage = `asin(-u.z)`. On utilise l'événement `deviceorientation` relatif (gyroscope), qui ne dérive pas avec la boussole.
- **Équité** : le tube libre (largeur `minGap`, de 15 m à 6,5 m selon la difficulté) est centré sur un chemin dont la pente est bornée à 0,24. La vitesse latérale max est de 0,6 × la vitesse avant, donc le chemin est toujours suivable. Tous les obstacles, y compris l'enveloppe complète des obstacles mobiles, sont découpés hors de ce tube. Le test vérifie cela point par point sur 1000 graines.
- **Obstacles mobiles** : tout est fait de boîtes alignées (collision exacte = rendu exact). La « grue qui tourne » est une flèche qui balaie le couloir en translation (une boîte orientée aurait demandé des collisions OBB). Les portes se ferment jusqu'au bord du tube libre, et les lasers clignotent en alternance avec un trou autour du tube.
- **Rase-mottes** : voler à moins de 3,5 m du sol compte comme un frôlement toutes les 0,5 s (clin d'œil au nom du jeu).
- **Score** : distance (×2 en boost) + bonus. Frôlement : 50 × combo, anneau : 100 × combo, anneau parfait : 250 × combo.
- **Ralenti (bonus)** : en solo, il ralentit tout le monde (temps du monde ×0,6). En soirée, il ne ralentit que le missile du joueur.
- **Soirée** : le gagnant est celui qui a le plus de distance cumulée sur les 3 manches. Les manches gagnées sont affichées. Les scores de soirée ne vont pas au classement.
- **Fantôme** : stocké dans le `localStorage` du PC (c'est « mon » meilleur essai sur cette machine), à 20 Hz.
- **Pseudo au clavier** : sans téléphone, le pseudo est « Pilote ».
- **Docker** : `python3 make g++` sont installés dans les étapes de build, au cas où le binaire précompilé de `better-sqlite3` ne serait pas téléchargeable.
- **WebRTC (étape 9, optionnelle)** : non fait. Sur un même Wi-Fi, la latence du WebSocket relayé reste faible, et le ping est affiché.
