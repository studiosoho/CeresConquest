/**
 * layers — orçamento de profundidade (Z) da cena. Em câmera ortográfica, Z é
 * puramente ordem de desenho; este módulo é a fonte única das camadas.
 *
 * O plano de jogo é z=0. Asteroides são malhas CENTRADAS que tombam nos 3
 * eixos; o renderer posiciona cada root em z = raioEnvolvente − ROCK_FRONT_REACH,
 * garantindo que NENHUM ponto de rocha avança além de −ROCK_FRONT_REACH em
 * direção à câmera, sob qualquer rotação. A camada de voo (naves, jatos,
 * feixes, projéteis) mora à frente desse limite. O dorso da maior rocha
 * (raio envolvente ≈ 1.07·2000) chega a ~2·2140−300 ≈ 3980 — coberto pelo
 * far plane da câmera. Estrelas ficam em +200, ocluídas pelos corpos.
 */

/** avanço máximo de qualquer ponto de rocha em direção à câmera (unidades) */
export const ROCK_FRONT_REACH = 300;

/** efeitos de voo (jatos, feixes, projéteis, zona de pouso, fronteira) */
export const EFFECTS_LAYER_Z = -(ROCK_FRONT_REACH + 15);
/** naves (todas) — à frente dos efeitos (o jato desenha sob o casco) */
export const SHIP_LAYER_Z = -(ROCK_FRONT_REACH + 18);
/** nave própria — destacada sobre as demais */
export const SHIP_TOP_LAYER_Z = SHIP_LAYER_Z - 2;
