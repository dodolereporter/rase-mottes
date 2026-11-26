# Décisions

- **Auteur des commits** : commits au nom du propriétaire du dépôt, sans mention de co-auteur (demande explicite).
- **Commits** : les étapes 1 à 8 ont été regroupées en quelques commits plus gros, chacun compilable et jouable, plutôt qu'un commit par étape. Développer chaque étape isolément aurait multiplié les allers-retours sans gain.
- **Pilotage** : la direction et le tangage viennent de la gravité vue dans le repère de l’écran (méthode des jeux de course mobiles), relative à la position de calibrage. On n’utilise ni alpha ni la boussole, donc ni dérive ni saut, et le pilotage marche que le téléphone soit tenu droit, à 45° ou à plat. Le quaternion ZXY corrigé de l’écran sert à calculer cette gravité ; le « haut » de l’écran est déduit de la gravité au calibrage (screen.orientation.angle est faux sur certains iPhone). Le calcul q_rel est conservé (`relativePitchRoll`) mais n’est plus utilisé pour piloter : il réagissait à l’inverse selon la tenue.
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
- **Direction artistique (refonte)** : éclairage PBR (soleil + ciel + reflets de l'environnement), ombres portées, une heure du jour par quartier (coucher de soleil, brume ambrée, plein jour, nuit de tunnel, aube sur le port), routes dont les marquages suivent le tracé, eau animée au port. Tout reste procédural : aucun fichier externe.
- **Caméra** : posée sur le décor. Elle suit l'axe de la rue et ne suit le missile que partiellement (30 à 60 % selon la largeur de la rue), donc c'est le missile qui se déplace dans l'image.
- **Level design** : les obstacles viennent par séquences thématiques (slalom de portes, dessus/dessous, colonnes en quinconce, barres tournantes alternées, murs de blocs, conteneurs, lasers, portes, trains), séparées par des respirations avec anneaux. Le tracé ondule exprès pour rendre le slalom lisible, et l'écart entre éléments est calé sur le temps (~0,85 s → 0,5 s).
- **Ville** : pâtés de maisons alignés des deux côtés, rues transversales, hauteurs cohérentes par îlot.
