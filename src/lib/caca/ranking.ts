/**
 * Rankeamento final dos candidatos à caça.
 *
 * rankFinal = score × confianca × boostSabor(sabor)
 * Ordem descendente de rankFinal.
 *
 * Boosts por sabor (calibrados para hierarquia cross > dormente > frio):
 *   cross_empresa: 1.3  — já demonstrou propensão a comprar no grupo; zero na alvo
 *   dormente:      1.0  — comprou antes, vale re-ativar
 *   frio:          0.6  — sem histórico; maior incerteza, menor prioridade
 *
 * Helper PURO — sem IO, sem imports externos.
 */

import type { CacaResultado, CandidatoFeatures, PerfilMelhores, SaborCaca } from './types';
import { classificarSabor } from './sabor';
import { scoreCandidato } from './score';

/**
 * Retorna o fator de boost por sabor de caça.
 * cross_empresa > dormente > frio por design.
 */
export function boostSabor(s: SaborCaca): number {
  switch (s) {
    case 'cross_empresa':
      return 1.3;
    case 'dormente':
      return 1.0;
    case 'frio':
      return 0.6;
  }
}

/**
 * Monta as razões interpretáveis em pt-BR para o vendedor.
 * Degradação honesta:
 *   - ramo=null → nunca afirma ramo; menciona "sem ramo conhecido"
 *   - região/família com lift <= 1 → não menciona (não é diferencial)
 */
export function montarPorque(
  c: CandidatoFeatures,
  perfil: PerfilMelhores,
  sabor: SaborCaca,
): string[] {
  const razoes: string[] = [];

  // Cross: sinal mais forte de intenção
  if (sabor === 'cross_empresa') {
    razoes.push('já compra de outra empresa do grupo, mas ainda não compra aqui');
  }

  // Região: só menciona quando é diferencial (lift > 1)
  if (c.cidadeUf !== null) {
    const lift = perfil.regiaoLift[c.cidadeUf] ?? 1;
    if (lift > 1) {
      razoes.push(`mesma região dos seus melhores clientes (${c.cidadeUf})`);
    }
  }

  // Ramo: degradação honesta
  if (c.ramo !== null) {
    const lift = perfil.ramoLift[c.ramo] ?? 1;
    if (lift > 1) {
      razoes.push(`ramo compatível com seu perfil de melhores clientes (${c.ramo})`);
    }
  } else {
    // ramo desconhecido → sempre mencionar para o vendedor saber
    razoes.push('sem ramo conhecido — perfil de ramo não disponível');
  }

  // Famílias: menciona quando há família com lift > 1
  const familiasComLift = c.familias.filter((f) => (perfil.familiaLift[f] ?? 1) > 1);
  if (familiasComLift.length > 0) {
    razoes.push(
      `compra famílias que seus melhores compram (${familiasComLift.slice(0, 3).join(', ')})`,
    );
  }

  return razoes;
}

/**
 * Rankeia candidatos à caça, descartando quem já compra na empresa-alvo.
 *
 * Para cada candidato válido:
 *   1. Classifica o sabor (descarta null = já compra na alvo)
 *   2. Calcula score/confiança/dimensões
 *   3. Monta as razões
 *   4. rankFinal = score × confianca × boostSabor
 *
 * Ordena por rankFinal desc. Tiebreak por documento para estabilidade.
 */
/** Tipo intermediário para o acumulador antes de atribuir o rank ordinal. */
interface ResultadoComValor {
  features: CandidatoFeatures;
  sabor: SaborCaca;
  score: number;
  confianca: number;
  dimensoesUsadas: CacaResultado['dimensoesUsadas'];
  porque: string[];
  /** Valor bruto de rankeamento (score × confianca × boost) para ordenação. */
  valorRank: number;
}

export function rankearCaca(
  candidatos: CandidatoFeatures[],
  perfil: PerfilMelhores,
  dormenteMeses = 6,
): CacaResultado[] {
  const acumulados: ResultadoComValor[] = [];

  for (const c of candidatos) {
    const sabor = classificarSabor(c, dormenteMeses);
    if (sabor === null) continue; // descarta quem já compra na alvo ou não se encaixa

    const { score, confianca, dimensoesUsadas } = scoreCandidato(c, perfil);
    const porque = montarPorque(c, perfil, sabor);
    const valorRank = score * confianca * boostSabor(sabor);

    acumulados.push({ features: c, sabor, score, confianca, dimensoesUsadas, porque, valorRank });
  }

  // Ordena por valorRank desc; tiebreak por documento para estabilidade determinística
  acumulados.sort((a, b) => {
    const diff = b.valorRank - a.valorRank;
    if (diff !== 0) return diff;
    return a.features.documento.localeCompare(b.features.documento);
  });

  // Atribui rank ordinal (1 = melhor) e monta o resultado final
  return acumulados.map(({ valorRank: _v, ...r }, i) => ({ ...r, rankFinal: i + 1 }));
}
