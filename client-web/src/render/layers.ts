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

// ── máscaras de camada (multi-câmera) ────────────────────────────────
// A câmera principal (top-down) fica na máscara default do Babylon
// (0x0FFFFFFF). A câmera de cockpit vê o mundo MENOS os meshes marcados
// MAIN_ONLY (nave própria — as linhas coladas no olho só sujariam a vista —
// e as estrelas, que são um plano e de lado viram um risco) e MAIS os
// meshes exclusivos dela (pano de fundo opaco do viewport).

/** meshes visíveis SÓ na câmera principal (bit dentro da máscara default) */
export const MASK_MAIN_ONLY = 0x2;
/** meshes visíveis SÓ na câmera de cockpit (bit fora da máscara default) */
export const MASK_FP_ONLY = 0x10000000;
/** máscara da câmera de cockpit */
export const FP_CAMERA_MASK = (0x0fffffff & ~MASK_MAIN_ONLY) | MASK_FP_ONLY;
