"""Le catalogue des sources de données, lu par la fenêtre « Données » de la page.

Une source est une unité de lecture : ce que le service va chercher d'un
coup, chez un fournisseur, sous une licence. Elle porte une ou plusieurs
couches d'affichage (les boutons de la page) : les emprises BD TOPO, une
seule lecture, donnent les aérodromes, les postes et les haies.

Le catalogue dit la provenance (fournisseur, licence, lien) et ce que le
service sait servir (`disponible`) ; la page garde le branchement des
couches, et l'utilisateur ce qu'il veut charger. La provenance est écrite ici
une fois, au lieu d'être répétée dans chaque infobulle : c'est elle que les
sources de Géorisques et celles de l'utilisateur viendront compléter.

Trois modes, ceux que la page connaissait déjà :
- `scene` : dans la scène, qui est complète ou n'existe pas. Ses couches se
  masquent, elles ne se désactivent pas.
- `apres-scene` : une couche à part, demandée une fois la scène affichée,
  avec son fichier de cache et sa version. L'utilisateur peut ne pas la
  charger du tout.
- `au-clic` : lue à la demande de l'utilisateur seulement, et datée.
"""

from .bornes import BORNES_VERSION
from .dpe import DPE_VERSION
from .emprises import EMPRISES_VERSION
from .georisques import GEORISQUES_VERSION
from .nuage import NUAGE_VERSION
from .ouvrages import OUVRAGES_VERSION
from .panneaux import PANNEAUX_VERSION
from .postes_enedis import POSTES_ENEDIS_VERSION
from .reseaux import RESEAUX_VERSION
from .scene import SCENE_VERSION
from .vehicules import VEHICULES_VERSION

LICENCE_OUVERTE = "Licence Ouverte 2.0"
GEOSERVICES = "https://geoservices.ign.fr/"

# L'ordre est celui de la fenêtre : par thème, du socle au détail.
SOURCES = (
    {"id": "scene", "libelle": "Scène IGN", "theme": "Socle",
     "mode": "scene", "version": SCENE_VERSION,
     "fournisseur": "IGN — BD TOPO, LiDAR HD, RGE ALTI, BD Forêt, orthophotos",
     "licence": LICENCE_OUVERTE, "lien": GEOSERVICES,
     "description": "Bâtiments, toits, relief, végétation, eau, routes, lignes "
                    "haute tension et constructions ponctuelles."},
    {"id": "nuage", "libelle": "Nuage de points LiDAR HD", "theme": "Socle",
     "mode": "apres-scene", "version": NUAGE_VERSION,
     "fournisseur": "IGN — LiDAR HD (dalles COPC)", "licence": LICENCE_OUVERTE,
     "lien": "https://geoservices.ign.fr/lidarhd",
     "description": "Le bâti en points ; les ouvrages ajourés y sont toujours. "
                    "Lu en deux temps : le carré proche, puis la zone entière."},
    {"id": "monuments", "libelle": "Monuments 3D", "theme": "Bâti",
     "mode": "apres-scene", "version": None,
     "fournisseur": "Contributeurs OpenStreetMap (building:part)", "licence": "ODbL",
     "lien": "https://www.openstreetmap.org/copyright",
     "description": "Parties de bâtiments modélisées dans OpenStreetMap, là où "
                    "elles sont plus riches que la BD TOPO."},
    {"id": "ouvrages", "libelle": "Ouvrages", "theme": "Bâti",
     "mode": "apres-scene", "version": OUVRAGES_VERSION,
     "fournisseur": "IGN — BD TOPO", "licence": LICENCE_OUVERTE, "lien": GEOSERVICES,
     "description": "Murs, ponts, terrains de sport, voies ferrées et tramways."},
    {"id": "emprises", "libelle": "Emprises", "theme": "Territoire",
     "mode": "apres-scene", "version": EMPRISES_VERSION,
     "fournisseur": "IGN — BD TOPO", "licence": LICENCE_OUVERTE, "lien": GEOSERVICES,
     "description": "Aérodromes et leurs pistes, postes de transformation, haies."},
    {"id": "reseaux", "libelle": "Canalisations", "theme": "Réseaux et énergie",
     "mode": "apres-scene", "version": RESEAUX_VERSION,
     "fournisseur": "IGN — BD TOPO", "licence": LICENCE_OUVERTE, "lien": GEOSERVICES,
     "description": "Eau, assainissement, gaz, électricité, chaleur, "
                    "télécommunications, drapés sur le relief."},
    {"id": "postes_enedis", "libelle": "Postes HTA/BT", "theme": "Réseaux et énergie",
     "mode": "apres-scene", "version": POSTES_ENEDIS_VERSION,
     "fournisseur": "Enedis — open data", "licence": LICENCE_OUVERTE,
     "lien": "https://opendata.enedis.fr/explore/dataset/poste-electrique/information/",
     "description": "Postes de transformation du réseau de distribution."},
    {"id": "panneaux", "libelle": "Panneaux solaires", "theme": "Réseaux et énergie",
     "mode": "apres-scene", "version": PANNEAUX_VERSION,
     "fournisseur": "OpenPVMapper (G. Kasmi)", "licence": "CC-BY 4.0",
     "lien": "https://doi.org/10.5281/zenodo.19188878",
     "description": "Registre des installations photovoltaïques."},
    {"id": "dpe", "libelle": "DPE", "theme": "Réseaux et énergie",
     "mode": "au-clic", "version": DPE_VERSION,
     "fournisseur": "ADEME", "licence": LICENCE_OUVERTE,
     "lien": "https://data.ademe.fr/datasets/dpe03existant",
     "description": "Diagnostics de performance énergétique, rattachés aux bâtiments."},
    {"id": "inondations", "libelle": "Surfaces inondables (TRI)", "theme": "Risques",
     "mode": "apres-scene", "version": GEORISQUES_VERSION,
     "fournisseur": "Géorisques — directive inondation, rapportage 2020",
     "licence": LICENCE_OUVERTE, "lien": "https://www.georisques.gouv.fr/risques/inondations",
     "description": "Débordement de cours d'eau, ruissellement et submersion marine, "
                    "par scénario (fréquent, moyen, rare), dans les territoires à "
                    "risque important d'inondation."},
    {"id": "old", "libelle": "Débroussaillement (OLD)", "theme": "Risques",
     "mode": "apres-scene", "version": GEORISQUES_VERSION,
     "fournisseur": "IGN pour le ministère de l'Agriculture — zonage informatif",
     "licence": LICENCE_OUVERTE,
     "lien": "https://www.georisques.gouv.fr/risques/feux-de-foret",
     "description": "Massifs exposés aux feux de forêt et bandes de 200 m où "
                    "s'appliquent les obligations légales de débroussaillement."},
    {"id": "cavites", "libelle": "Cavités souterraines", "theme": "Risques",
     "mode": "apres-scene", "version": GEORISQUES_VERSION,
     "fournisseur": "BRGM — BDCavité (Géorisques)", "licence": LICENCE_OUVERTE,
     "lien": "https://www.georisques.gouv.fr/risques/cavites-souterraines",
     "description": "Carrières, caves, ouvrages civils et militaires, cavités "
                    "naturelles, puits : abandonnés et d'origine non minière."},
    {"id": "risques_commune", "libelle": "Risques de la commune", "theme": "Risques",
     "mode": "au-clic", "version": GEORISQUES_VERSION,
     "fournisseur": "Géorisques — base GASPAR", "licence": LICENCE_OUVERTE,
     "lien": "https://www.georisques.gouv.fr/",
     "description": "Atlas des zones inondables, TRI, PAPI et arrêtés de "
                    "catastrophe naturelle liés aux inondations de la commune du "
                    "point ; obligation de débroussaillement au point."},
    {"id": "detections", "libelle": "Lus sur l'orthophoto", "theme": "Mobilité",
     "mode": "apres-scene", "version": VEHICULES_VERSION,
     "fournisseur": "Orthophoto IGN, détection RTMDet-R ou YOLO11-OBB",
     "licence": LICENCE_OUVERTE, "lien": GEOSERVICES,
     "description": "Véhicules, piscines et bateaux, le jour de la prise de vue."},
    {"id": "bornes", "libelle": "Bornes de recharge", "theme": "Mobilité",
     "mode": "au-clic", "version": BORNES_VERSION,
     "fournisseur": "Base nationale des IRVE (data.gouv.fr)", "licence": LICENCE_OUVERTE,
     "lien": "https://www.data.gouv.fr/fr/datasets/5448d3e0c751df01f85d0572/",
     "description": "Bornes de recharge réunies par station."},
)


def catalogue(lire_vehicules=None, lire_panneaux=None):
    """Les sources, et pour chacune si ce service sait la servir : les
    détections demandent un détecteur (VUE3D_VEHICULES), les panneaux un
    registre (VUE3D_PANNEAUX). Les autres sont toujours servies."""
    disponibles = {"detections": bool(lire_vehicules and lire_vehicules.detecteurs),
                   "panneaux": bool(lire_panneaux)}
    return [dict(source, disponible=disponibles.get(source["id"], True))
            for source in SOURCES]
