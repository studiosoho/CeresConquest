/**
 * Camadas de voo.
 *
 * O jogo tem dois níveis de altitude, e o nível decide contra o que a nave
 * colide — a câmera é ortográfica e vê tudo de cima, então a camada é a única
 * coisa que separa "passar por cima de uma rocha" de "bater nela":
 *
 *  - `cruise` (cruzeiro): acima do cinturão. Rochas e Ceres ficam por baixo e
 *    não são tocadas; só a fronteira da arena e as outras naves em cruzeiro
 *    (com dano proporcional ao impulso do choque, aplicado pelo servidor).
 *  - `surface` (superfície): no nível dos asteroides e das estações. Rochas e
 *    Ceres são sólidas; asteroide com estação PRÓPRIA é atravessável, com
 *    estação INIMIGA é sólido. Colide com as outras naves na superfície.
 *  - `attack` (modo ataque de estação): a nave de ataque sobre o asteroide de
 *    uma estação desce ao nível dela SEM colisão nenhuma — nem rocha, nem
 *    estação, nem outras naves; só a fronteira. É preso à área da estação (as
 *    regras de entrada e saída são do servidor).
 *
 * Camadas diferentes não colidem e não combatem. Durante a TRANSIÇÃO entre
 * camadas a nave não colide com nada e é invulnerável.
 */
export type ShipLayer = "cruise" | "surface" | "attack";

/** Duração (s) de uma transição entre camadas — subida ou descida. */
export const LAYER_TRANSITION_TIME = 1.0;

/**
 * Folga (u) além do raio do asteroide da estação atacada: a nave em modo
 * ataque que se afasta mais que isso do centro dele sobe sozinha ao cruzeiro —
 * o modo ataque não colide com nada, e solto pelo mapa atravessaria rochas.
 */
export const ATTACK_ZONE_MARGIN = 200;
