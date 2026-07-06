// F5 Concentração de recebíveis — helper puro (testado em vitest).
// Spec: docs/superpowers/specs/2026-07-05-concentracao-recebiveis-design.md
// Money-path: empty ≠ zero (o helper recebe FonteStatus e NÃO calcula sobre fonte
// podre → nunca fabrica 'sem_carteira'); linha inválida NÃO some (vira fonte_parcial);
// nunca fabrica número. Nome NÃO entra aqui (é enriquecimento de apresentação).

import type {
  FonteStatus,
  TituloAberto,
  ConcentracaoResult,
  ImpactoAbsoluto,
  LinhaExposicao,
} from './concentracao-types';

/** Política de materialidade (TOM, nunca oculta). Keyed na maior exposição absoluta.
 *  Tunável — não é verdade científica (Codex C). */
export const PISO_MODERADO = 25000;
export const PISO_ALTO = 75000;

/** menor nº de códigos (share desc) cujo acumulado atinge ≥ 50% da carteira. */
export function c50(sharesDesc: number[]): number {
  let acc = 0;
  for (let i = 0; i < sharesDesc.length; i++) {
    acc += sharesDesc[i];
    if (acc >= 0.5) return i + 1;
  }
  return sharesDesc.length;
}

/** HHI = Σ share². Secundário (tendência/sanidade, nunca headline). */
export function hhi(shares: number[]): number {
  return shares.reduce((s, x) => s + x * x, 0);
}

function impactoDaMaior(maior: number, pisoModerado: number, pisoAlto: number): ImpactoAbsoluto {
  if (maior < pisoModerado) return 'baixo';
  if (maior < pisoAlto) return 'moderado';
  return 'alto';
}

function resultadoSemCalculo(
  motivo: ConcentracaoResult['motivo'],
  totalAberto: number | null,
  linhasInvalidas: number,
): ConcentracaoResult {
  return {
    motivo,
    clientes: null,
    totalAberto,
    maiorExposicao: null,
    top1Pct: null,
    top5Pct: null,
    c50: null,
    hhi: null,
    nEfetivo: null,
    impactoAbsoluto: null,
    topN: [],
    linhasInvalidas,
  };
}

/**
 * Concentração de crédito por código Omie (proxy de sacado), por empresa.
 * `fonte` é atestado pela camada de leitura: 'ok' (query completa), 'parcial'
 * (truncada/dados suspeitos) ou 'indisponivel' (falha/RLS/timeout). Ordem dos gates
 * na spec §3 — cada ramo justificado por money-path.
 */
export function concentracaoEmpresa(
  titulos: TituloAberto[],
  fonte: FonteStatus,
  opts: { topN?: number; pisoModerado?: number; pisoAlto?: number } = {},
): ConcentracaoResult {
  const topNLimit = opts.topN ?? 10;
  const pisoModerado = opts.pisoModerado ?? PISO_MODERADO;
  const pisoAlto = opts.pisoAlto ?? PISO_ALTO;

  // Gate 1 (P0-1): fonte indisponível → NÃO calcula. Lista vazia aqui pode ser falha,
  // não carteira zerada — afirmar zero seria fabricar.
  if (fonte === 'indisponivel') return resultadoSemCalculo('fonte_indisponivel', null, 0);

  // Gate 2 (Codex E): particiona válidas/inválidas. Linha inválida NUNCA some — conta.
  const validas: TituloAberto[] = [];
  let linhasInvalidas = 0;
  for (const it of titulos) {
    if (it.omie_codigo_cliente != null && Number.isFinite(it.saldo) && it.saldo > 0) {
      validas.push(it);
    } else {
      linhasInvalidas++;
    }
  }
  const temInvalida = linhasInvalidas > 0;

  // Gate 3/4: sem linha válida.
  if (validas.length === 0) {
    // Zero PROVADO: só quando a fonte é 'ok' E não houve linha inválida escondida.
    if (fonte === 'ok' && !temInvalida) return resultadoSemCalculo('sem_carteira', 0, 0);
    // Truncada, ou tudo inválido → não afirma zero.
    return resultadoSemCalculo('fonte_parcial', null, linhasInvalidas);
  }

  // Gate 5: agrega por código (saldo + parcela vencida) e ordena desc por saldo.
  const porCodigo = new Map<number, { saldo: number; vencido: number }>();
  for (const it of validas) {
    const cod = it.omie_codigo_cliente as number;
    const cur = porCodigo.get(cod) ?? { saldo: 0, vencido: 0 };
    cur.saldo += it.saldo;
    if (it.atrasado) cur.vencido += it.saldo;
    porCodigo.set(cod, cur);
  }
  const linhas = [...porCodigo.entries()]
    .map(([codigo, v]) => ({ codigo, saldo: v.saldo, vencido: v.vencido }))
    .sort((a, b) => b.saldo - a.saldo);

  const totalAberto = linhas.reduce((s, l) => s + l.saldo, 0);
  const shares = linhas.map((l) => l.saldo / totalAberto);
  const maiorExposicao = linhas[0].saldo;
  const hhiVal = hhi(shares);

  const topN: LinhaExposicao[] = linhas.slice(0, topNLimit).map((l) => ({
    codigo: l.codigo,
    saldo: l.saldo,
    vencido: l.vencido,
    pctVencidoProprio: l.saldo > 0 ? l.vencido / l.saldo : 0,
    share: l.saldo / totalAberto,
  }));

  return {
    // fonte 'parcial' ou linha inválida rebaixa o motivo, mesmo com métricas calculadas.
    motivo: fonte === 'parcial' || temInvalida ? 'fonte_parcial' : 'ok',
    clientes: linhas.length,
    totalAberto,
    maiorExposicao,
    top1Pct: shares[0],
    top5Pct: shares.slice(0, 5).reduce((s, x) => s + x, 0),
    c50: c50(shares),
    hhi: hhiVal,
    nEfetivo: hhiVal > 0 ? 1 / hhiVal : null,
    impactoAbsoluto: impactoDaMaior(maiorExposicao, pisoModerado, pisoAlto),
    topN,
    linhasInvalidas,
  };
}
