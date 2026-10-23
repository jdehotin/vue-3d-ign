"""Les routes du serveur, par page : la scène (`scene`), la vue en voiture
(`voiture`), et ce que les deux partagent (`service`). Chaque module rend
son blueprint d'une fabrique, à laquelle `vue3d.app.creer_app` passe l'état
du service : cache, quotas, stocks."""
