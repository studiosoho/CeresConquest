import { SHIP_RADIUS, mulberry32, type StructureType, type ShipKind } from "@ceres/shared";

/**
 * Geometria wireframe (estilo Asteroids): assets são listas de vértices,
 * derivadas de sementes e da escala de tamanhos — nunca imagens. A mesma
 * definição servirá ao renderer 3D do desktop.
 */

const R = SHIP_RADIUS;

/** Nave inicial/scout: triângulo com entalhe traseiro, apontando para +x. */
export const SHIP_VERTS: Array<{ x: number; y: number }> = [
  { x: R, y: 0 },
  { x: -R * 0.66, y: R * 0.55 },
  { x: -R * 0.33, y: 0 },
  { x: -R * 0.66, y: -R * 0.55 },
];

/**
 * Builder "feijão": silhueta oval arredondada com cabine saliente na frente.
 * Mais rechonchuda que o scout — transmite utilidade, não velocidade.
 */
const BUILDER_VERTS: Array<{ x: number; y: number }> = [
  { x: R * 1.0, y: 0 },
  { x: R * 0.7, y: R * 0.45 },
  { x: R * 0.1, y: R * 0.7 },
  { x: -R * 0.5, y: R * 0.65 },
  { x: -R * 0.9, y: R * 0.3 },
  { x: -R * 0.9, y: -R * 0.3 },
  { x: -R * 0.5, y: -R * 0.65 },
  { x: R * 0.1, y: -R * 0.7 },
  { x: R * 0.7, y: -R * 0.45 },
];

/** Nave de ataque: silhueta mais larga e agressiva (asas). */
const ATTACK_VERTS: Array<{ x: number; y: number }> = [
  { x: R * 1.15, y: 0 },
  { x: -R * 0.3, y: R * 0.4 },
  { x: -R * 0.7, y: R * 0.85 },
  { x: -R * 0.45, y: 0 },
  { x: -R * 0.7, y: -R * 0.85 },
  { x: -R * 0.3, y: -R * 0.4 },
];

/** Nave de mineração: silhueta atarracada de carga. */
const MINING_VERTS: Array<{ x: number; y: number }> = [
  { x: R * 0.8, y: 0 },
  { x: R * 0.2, y: R * 0.6 },
  { x: -R * 0.7, y: R * 0.5 },
  { x: -R * 0.7, y: -R * 0.5 },
  { x: R * 0.2, y: -R * 0.6 },
];

/**
 * Nave de transporte: contêiner longo com cabine estreita na frente —
 * um caminhão espacial, feito para o porão, não para a briga.
 */
const TRANSPORT_VERTS: Array<{ x: number; y: number }> = [
  { x: R * 1.05, y: 0 },
  { x: R * 0.75, y: R * 0.3 },
  { x: R * 0.45, y: R * 0.3 },
  { x: R * 0.35, y: R * 0.6 },
  { x: -R * 0.95, y: R * 0.6 },
  { x: -R * 0.95, y: -R * 0.6 },
  { x: R * 0.35, y: -R * 0.6 },
  { x: R * 0.45, y: -R * 0.3 },
  { x: R * 0.75, y: -R * 0.3 },
];

/** Vértices da nave conforme a classe. */
export function shipVerts(kind: ShipKind): Array<{ x: number; y: number }> {
  if (kind === "attack") return ATTACK_VERTS;
  if (kind === "mining") return MINING_VERTS;
  if (kind === "transport") return TRANSPORT_VERTS;
  return BUILDER_VERTS; // builder
}

/** Velocidade angular normalizada [-1,1] da rotação leve de um asteroide. */
// fonte única no shared — o servidor usa a MESMA função (nave pousada
// gira em sincronia com o visual do asteroide)
export { asteroidSpin } from "@ceres/shared";

/**
 * Silhueta de asteroide em formato "batata", determinística pela shapeSeed:
 * alongamento (aspect) + duas protuberâncias de baixa frequência + pequeno
 * ruído por vértice. Normalizada para que o raio máximo seja exatamente
 * `radius` — mantém coerência com a colisão/mineração do sim-core.
 */
export function asteroidVerts(
  shapeSeed: number,
  radius: number,
): Array<{ x: number; y: number }> {
  const rng = mulberry32(shapeSeed);
  const n = 10 + Math.floor(rng() * 7); // 10–16 vértices

  // alongamento tipo batata, distribuído entre os dois eixos
  const aspect = 1 + rng() * 1.0; // 1.0 – 2.0
  const sx = Math.sqrt(aspect);
  const sy = 1 / sx;
  const rot = rng() * Math.PI * 2;

  // duas ondas de baixa frequência dão a lombada irregular da batata
  const a1 = 0.12 + rng() * 0.18;
  const p1 = rng() * Math.PI * 2;
  const k1 = 2 + Math.floor(rng() * 2); // 2–3
  const a2 = 0.04 + rng() * 0.1;
  const p2 = rng() * Math.PI * 2;
  const k2 = 4 + Math.floor(rng() * 3); // 4–6

  const raw: Array<{ x: number; y: number }> = [];
  let maxD = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr =
      1 + a1 * Math.sin(k1 * t + p1) + a2 * Math.sin(k2 * t + p2) + (rng() - 0.5) * 0.08;
    const px = Math.cos(t) * rr * sx;
    const py = Math.sin(t) * rr * sy;
    const cx = px * Math.cos(rot) - py * Math.sin(rot);
    const cy = px * Math.sin(rot) + py * Math.cos(rot);
    const d = Math.hypot(cx, cy);
    if (d > maxD) maxD = d;
    raw.push({ x: cx, y: cy });
  }

  const k = radius / maxD; // normaliza para bounding = radius
  return raw.map((v) => ({ x: v.x * k, y: v.y * k }));
}

/** Silhueta geométrica de uma estrutura, reconhecível pelo contorno. */
export function structureVerts(
  type: StructureType,
  radius: number,
): Array<{ x: number; y: number }> {
  if (type === "hq") {
    // QUARTEL-GENERAL ESPACIAL (HQ)
    // Uma estrutura imponente com uma torre central, asas/hangares laterais angulares 
    // e uma base defensiva reforçada.
    return [
      { x: 0, y: -radius },          // Topo da torre de comando principal
      { x: radius * 0.15, y: -radius * 0.4 }, // Descida da torre
      { x: radius * 0.4, y: -radius * 0.4 },  // Extensão do teto do hangar direito
      { x: radius * 0.9, y: 0 },              // Ponta da asa direita / Plataforma de pouso
      { x: radius * 0.5, y: radius * 0.3 },   // Recorte inferior da asa direita
      { x: radius * 0.6, y: radius * 0.8 },   // Gerador/Propulsor inferior direito
      { x: radius * 0.2, y: radius * 0.8 },   // Base inferior direita
      { x: 0, y: radius * 0.5 },              // Recorte central inferior (entrada de naves capitais)
      { x: -radius * 0.2, y: radius * 0.8 },  // Base inferior esquerda
      { x: -radius * 0.6, y: radius * 0.8 },  // Gerador/Propulsor inferior esquerdo
      { x: -radius * 0.5, y: radius * 0.3 },  // Recorte inferior da asa esquerda
      { x: -radius * 0.9, y: 0 },             // Ponta da asa esquerda / Plataforma de pouso
      { x: -radius * 0.4, y: -radius * 0.4 }, // Extensão do teto do hangar esquerdo
      { x: -radius * 0.15, y: -radius * 0.4 },// Subida para a torre de comando
    ];
  }
  if (type === "initialBase") {
    // BASE INICIAL — elo com a Terra
    // Cúpula habitacional sobre plataforma larga de pouso, com antena de
    // longo alcance (fala com a Terra) e silos de rações nas laterais.
    return [
      { x: 0, y: -radius },                    // ponta da antena para a Terra
      { x: radius * 0.08, y: -radius * 0.55 }, // haste da antena
      { x: radius * 0.35, y: -radius * 0.45 }, // ombro direito da cúpula
      { x: radius * 0.55, y: -radius * 0.1 },  // borda direita da cúpula
      { x: radius * 0.9, y: -radius * 0.1 },   // silo de rações direito (topo)
      { x: radius * 0.9, y: radius * 0.35 },   // silo de rações direito (base)
      { x: radius * 0.6, y: radius * 0.35 },   // recuo até a plataforma
      { x: radius * 0.75, y: radius * 0.7 },   // apoio direito da plataforma
      { x: -radius * 0.75, y: radius * 0.7 },  // apoio esquerdo da plataforma
      { x: -radius * 0.6, y: radius * 0.35 },  // recuo até a plataforma
      { x: -radius * 0.9, y: radius * 0.35 },  // silo de rações esquerdo (base)
      { x: -radius * 0.9, y: -radius * 0.1 },  // silo de rações esquerdo (topo)
      { x: -radius * 0.55, y: -radius * 0.1 }, // borda esquerda da cúpula
      { x: -radius * 0.35, y: -radius * 0.45 },// ombro esquerdo da cúpula
      { x: -radius * 0.08, y: -radius * 0.55 },// haste da antena
    ];
  }
  // ESTAÇÃO DE MINERAÇÃO DE ASTEROIDES
  // Uma estrutura industrial assimétrica com braços coletores abertos na base (para capturar rochas)
  // e antenas/painéis de processamento no topo.
  if (type === "rationCenter") {
    // CENTRO DE DISTRIBUIÇÃO DE RAÇÕES
    // Silo central com antena de longo alcance e braços de lançamento de drones.
    return [
      { x: 0,              y: -radius },           // ponta da antena
      { x: radius * 0.08,  y: -radius * 0.55 },    // haste
      { x: radius * 0.28,  y: -radius * 0.45 },    // ombro direito
      { x: radius * 0.55,  y: -radius * 0.55 },    // braço de lançamento direito (topo)
      { x: radius * 0.7,   y: -radius * 0.35 },    // ponta do braço direito
      { x: radius * 0.55,  y: -radius * 0.15 },    // base do braço direito
      { x: radius * 0.65,  y: radius * 0.2 },      // silo direito (topo)
      { x: radius * 0.65,  y: radius * 0.65 },     // silo direito (base)
      { x: radius * 0.2,   y: radius * 0.8 },      // base inferior direita
      { x: 0,              y: radius * 0.6 },       // recorte central inferior
      { x: -radius * 0.2,  y: radius * 0.8 },      // base inferior esquerda
      { x: -radius * 0.65, y: radius * 0.65 },     // silo esquerdo (base)
      { x: -radius * 0.65, y: radius * 0.2 },      // silo esquerdo (topo)
      { x: -radius * 0.55, y: -radius * 0.15 },    // base do braço esquerdo
      { x: -radius * 0.7,  y: -radius * 0.35 },    // ponta do braço esquerdo
      { x: -radius * 0.55, y: -radius * 0.55 },    // braço de lançamento esquerdo (topo)
      { x: -radius * 0.28, y: -radius * 0.45 },    // ombro esquerdo
      { x: -radius * 0.08, y: -radius * 0.55 },    // haste
    ];
  }
  // ESTAÇÃO DE MINERAÇÃO DE ASTEROIDES
  // Uma estrutura industrial assimétrica com braços coletores abertos na base (para capturar rochas)
  // e antenas/painéis de processamento no topo.
  return [
    { x: 0, y: -radius * 0.9 },          // Antena de comunicação superior
    { x: radius * 0.1, y: -radius * 0.5 },// Base da antena
    { x: radius * 0.5, y: -radius * 0.5 },// Painel solar / Refinaria superior direita
    { x: radius * 0.3, y: -radius * 0.1 },// Corpo central (zona de processamento)
    { x: radius * 0.8, y: radius * 0.3 }, // Braço extrator direito (ponta externa)
    { x: radius * 0.7, y: radius * 0.6 }, // Garra/Broca direita (ponta interna)
    { x: radius * 0.2, y: radius * 0.2 }, // Recorte do poço de trituração central (lado direito)
    { x: 0, y: radius * 0.4 },            // Fundo do poço onde o asteroide é processado
    { x: -radius * 0.2, y: radius * 0.2 },// Recorte do poço de trituração central (lado esquerdo)
    { x: -radius * 0.7, y: radius * 0.6 },// Garra/Broca esquerda (ponta interna)
    { x: -radius * 0.8, y: radius * 0.3 },// Braço extrator esquerdo (ponta externa)
    { x: -radius * 0.3, y: -radius * 0.1 },// Corpo central (lado esquerdo)
    { x: -radius * 0.5, y: -radius * 0.5 },// Painel solar / Refinaria superior esquerda
    { x: -radius * 0.1, y: -radius * 0.5 },// Base da antena (lado esquerdo)
  ];
}
