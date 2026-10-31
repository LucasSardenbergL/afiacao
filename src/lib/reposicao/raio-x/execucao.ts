// Plano de execução da decisão do Raio-X (pacote 2): preço piso/canal no liquidar, custo de esperar,
// responsável/prazo/executado. Lógica pura; o escritor único é `raio_x_planejar`.
// Re-decidir não apaga o plano no banco: piso/canal só valem com destino liquidar e "executado" antes do
// decidido_em vigente (o destino mudou depois) NÃO conta como concluído.
// Ausente ≠ zero: custo sem CMC ou sem taxa é null; piso sem unidade de venda única não compara.
import type { CanalLiquidacao, DecisaoRow, Destino, LinhaMedicao } from './tipos';

/** Destinos que pedem alguém executando. Manter/estratégico não têm execução (o motor já resolve). */
export const DESTINOS_EXECUTAVEIS: readonly Destino[] = ['trocar', 'venda_dirigida', 'liquidar', 'erro_cadastro'];

export const CANAIS: readonly CanalLiquidacao[] = ['cliente_especifico', 'promocao_carteira', 'outlet_queima', 'outro'];
export const ROTULO_CANAL: Record<CanalLiquidacao, string> = {
  cliente_especifico: 'Cliente específico',
  promocao_carteira: 'Promoção na carteira',
  outlet_queima: 'Outlet / queima',
  outro: 'Outro',
};

export const PRAZO_PADRAO_DIAS = 14;

const DIA_MS = 86_400_000;
const diasEntre = (de: string, ate: string) => Math.round((Date.parse(ate) - Date.parse(de)) / DIA_MS);

/** 'YYYY-MM-DD' + n dias (UTC puro, sem fuso). */
export function somarDias(dia: string, n: number): string {
  return new Date(Date.parse(dia) + n * DIA_MS).toISOString().slice(0, 10);
}

/** Custo de capital de manter o valor parado por um mês: valor × taxa anual / 12. Sem valor ou taxa → null. */
export function custoEsperarMensal(valor: number | null, taxaAnual: number | null): number | null {
  if (valor === null || taxaAnual === null || !Number.isFinite(valor) || !Number.isFinite(taxaAnual)) return null;
  if (valor <= 0 || taxaAnual <= 0) return null;
  return (valor * taxaAnual) / 12;
}

export const ehExecutavel = (d: Destino | null | undefined): d is Destino =>
  !!d && DESTINOS_EXECUTAVEIS.includes(d);

/** "Executado" que vale para o destino VIGENTE (marcado depois — ou na falta — de decidido_em). */
export function concluidoVigente(d: Pick<DecisaoRow, 'concluido_em' | 'decidido_em'>): boolean {
  if (!d.concluido_em) return false;
  if (!d.decidido_em) return true;
  return Date.parse(d.concluido_em) >= Date.parse(d.decidido_em);
}

export const pisoVigente = (d: DecisaoRow | undefined): number | null =>
  d?.destino === 'liquidar' ? d.preco_piso : null;

export const canalVigente = (d: DecisaoRow | undefined): CanalLiquidacao | null =>
  d?.destino === 'liquidar' ? d.canal_liquidacao : null;

export type SituacaoPlano =
  | { tipo: 'concluido' }
  | { tipo: 'vencido'; dias: number }
  | { tipo: 'sem_responsavel' }
  | { tipo: 'sem_prazo' }
  | { tipo: 'no_prazo'; dias: number };

/**
 * Situação do plano para o badge da linha. `null` = sem decisão ou destino sem execução.
 * Precedência: concluído > vencido > sem responsável > sem prazo > no prazo. `hoje` = 'YYYY-MM-DD' (SP).
 */
export function situacaoPlano(d: DecisaoRow | undefined, hoje: string): SituacaoPlano | null {
  if (!d || !ehExecutavel(d.destino)) return null;
  if (concluidoVigente(d)) return { tipo: 'concluido' };
  if (d.prazo && d.prazo < hoje) return { tipo: 'vencido', dias: diasEntre(d.prazo, hoje) };
  if (!d.responsavel) return { tipo: 'sem_responsavel' };
  if (!d.prazo) return { tipo: 'sem_prazo' };
  return { tipo: 'no_prazo', dias: diasEntre(hoje, d.prazo) };
}

export interface ResumoExecucao {
  /** decisões com destino executável — o denominador. */
  executaveis: number;
  concluidas: number;
  /** prazo passou e não está concluída. */
  vencidas: number;
  /** sem responsável e não concluída (pode sobrepor `vencidas`). */
  semResponsavel: number;
}

export function resumoExecucao(decisoes: Iterable<DecisaoRow>, hoje: string): ResumoExecucao {
  const r: ResumoExecucao = { executaveis: 0, concluidas: 0, vencidas: 0, semResponsavel: 0 };
  for (const d of decisoes) {
    if (!ehExecutavel(d.destino)) continue;
    r.executaveis += 1;
    if (concluidoVigente(d)) { r.concluidas += 1; continue; }
    if (d.prazo && d.prazo < hoje) r.vencidas += 1;
    if (!d.responsavel) r.semResponsavel += 1;
  }
  return r;
}

export interface AlertaPiso {
  sku_codigo_omie: number;
  /** preço médio do período (receita / qtd vendida desde a foto), por unidade de venda. */
  preco: number;
  piso: number;
  abaixo: boolean;
}

/**
 * Venda real × piso, só quando a comparação é honesta: destino liquidar com piso, venda com receita desde a foto
 * e UMA única unidade de venda (piso e preço na mesma unidade). Fora disso → null ("sem comparação").
 */
export function alertaPiso(
  l: Pick<LinhaMedicao, 'sku_codigo_omie' | 'destino' | 'qtd_vendida' | 'receita'>,
  d: DecisaoRow | undefined,
  unidadesVenda: string[] | null | undefined,
): AlertaPiso | null {
  if (l.destino !== 'liquidar' || d?.destino !== 'liquidar') return null;
  const piso = pisoVigente(d);
  if (piso === null) return null;
  if (!unidadesVenda || new Set(unidadesVenda).size !== 1) return null;
  if (l.qtd_vendida === null || l.qtd_vendida <= 0 || l.receita === null) return null;
  const preco = l.receita / l.qtd_vendida;
  if (!Number.isFinite(preco)) return null;
  return { sku_codigo_omie: l.sku_codigo_omie, preco, piso, abaixo: preco < piso };
}
