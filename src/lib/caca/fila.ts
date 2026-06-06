/**
 * Montagem da "fila de caça": look-alike dos melhores clientes → hunter.
 *
 * Pipeline por empresa-alvo (oben, colacor):
 *   1. compradores da empresa → selecionarMelhores → perfilPorLift
 *   2. candidatos da empresa → CandidatoFeatures → rankearCaca (rank ordinal POR empresa)
 *
 * Em seguida, MERGE cross-empresa: como cada lista vem com `rankFinal` ordinal
 * relativo à PRÓPRIA empresa, recomputamos um valor de ordenação GLOBAL
 * (score × confianca × boostSabor) e reordenamos a fila inteira; o `rankFinal`
 * é então reatribuído globalmente (1 = melhor da fila inteira).
 *
 * Degradação honesta:
 *   - empresa sem compradores → melhores []/base [] → perfil de lifts vazios;
 *     rankearCaca ainda funciona (dimensões caem em lift neutro 1).
 *   - candidato sem linha de enriquecimento (improvável: a view traz tudo junto)
 *     → nome/telefone null e clienteUserId null.
 *
 * Helper PURO — sem IO, sem imports externos além dos tipos e dos outros helpers puros.
 */

import type {
  CacaCandidatoDisplay,
  CacaResultado,
  CandidatoFeatures,
  CandidatoRow,
  CompradorRow,
  EmpresaAlvo,
} from './types';
import { selecionarMelhores } from './melhores';
import { perfilPorLift } from './perfil';
import { rankearCaca, boostSabor } from './ranking';

/** Empresas-alvo onde a caça opera na v1 (colacor_sc fora de escopo). */
const EMPRESAS_ALVO: readonly EmpresaAlvo[] = ['oben', 'colacor'] as const;

interface MontarFilaOpts {
  /** Tamanho máximo da fila final (default 150). */
  topK?: number;
  /** Corte de dormência em meses, repassado a rankearCaca (default 6). */
  dormenteMeses?: number;
}

/** Chave de enriquecimento (grão = documento × empresa-alvo). */
function chaveEnriquecimento(documento: string, empresaAlvo: EmpresaAlvo): string {
  return `${documento}|${empresaAlvo}`;
}

/**
 * Mapeia a linha crua da view (`CandidatoRow`, snake_case) para as features
 * consumidas pelo motor de ranking (`CandidatoFeatures`, camelCase).
 *
 * Decisões da v1:
 *   - compraNaEmpresaAlvo é SEMPRE false: a view `v_caca_candidatos` só traz
 *     quem NÃO é ativo na empresa-alvo (por definição). O sabor nunca cai no
 *     ramo "já compra na alvo".
 *   - atrasoRelativo é null: sem histórico de ciclo próprio calculado na v1.
 */
function toCandidatoFeatures(row: CandidatoRow): CandidatoFeatures {
  return {
    documento: row.documento,
    empresaAlvo: row.empresa_alvo,
    cidadeUf: row.cidade_uf,
    ramo: row.ramo,
    ticketFaixa: row.ticket_faixa,
    familias: row.familias,
    compraEmOutraEmpresa: row.compra_em_outra_empresa,
    compraNaEmpresaAlvo: false,
    ultimaCompraGrupoDias: row.ultima_compra_grupo_dias,
    atrasoRelativo: null,
  };
}

/** Valor de ordenação GLOBAL: mesma fórmula do rank intra-empresa, recomputada. */
function valorGlobal(r: CacaResultado): number {
  return r.score * r.confianca * boostSabor(r.sabor);
}

/**
 * Monta a fila de caça unificada a partir das linhas cruas das duas views.
 *
 * @param compradores  Linhas de `v_caca_compradores` (todas as empresas).
 * @param candidatos   Linhas de `v_caca_candidatos` (todas as empresas-alvo).
 * @param opts         topK (default 150) e dormenteMeses (default 6).
 */
export function montarFilaCaca(
  compradores: CompradorRow[],
  candidatos: CandidatoRow[],
  opts: MontarFilaOpts = {},
): CacaCandidatoDisplay[] {
  const topK = opts.topK ?? 150;
  const dormenteMeses = opts.dormenteMeses ?? 6;

  // 1. Índice de enriquecimento por (documento × empresa-alvo).
  //    O grão da view de candidatos já é (documento × empresa-alvo), então a
  //    chave é única — um mesmo documento pode ter 2 linhas (uma por empresa).
  const indiceEnriquecimento = new Map<string, CandidatoRow>();
  for (const row of candidatos) {
    indiceEnriquecimento.set(chaveEnriquecimento(row.documento, row.empresa_alvo), row);
  }

  // 2. Para cada empresa-alvo: perfil dos melhores + ranking dos candidatos.
  const resultados: CacaResultado[] = [];
  for (const emp of EMPRESAS_ALVO) {
    const compradoresEmp = compradores.filter((c) => c.empresa === emp);
    const { melhores, base } = selecionarMelhores(compradoresEmp);
    const perfil = perfilPorLift(melhores, base);

    const candFeatures = candidatos
      .filter((c) => c.empresa_alvo === emp)
      .map(toCandidatoFeatures);

    const rankeados = rankearCaca(candFeatures, perfil, dormenteMeses);
    resultados.push(...rankeados);
  }

  // 3. MERGE cross-empresa: o rankFinal vindo do rankearCaca é ordinal POR
  //    empresa; recomputa o valor global e ordena a fila inteira (desc).
  //    Tiebreak determinístico por documento (asc).
  resultados.sort((a, b) => {
    const diff = valorGlobal(b) - valorGlobal(a);
    if (diff !== 0) return diff;
    return a.features.documento.localeCompare(b.features.documento);
  });

  // 4. Corte topK.
  const cortados = resultados.slice(0, topK);

  // 5. Enriquecimento + reatribuição do rankFinal GLOBAL (1 = melhor da fila inteira).
  return cortados.map((r, i) => {
    const linha = indiceEnriquecimento.get(
      chaveEnriquecimento(r.features.documento, r.features.empresaAlvo),
    );
    return {
      ...r,
      rankFinal: i + 1,
      nome: linha?.nome ?? null,
      telefone: linha?.telefone ?? null,
      clienteUserId: linha?.cliente_user_id ?? null,
    };
  });
}
