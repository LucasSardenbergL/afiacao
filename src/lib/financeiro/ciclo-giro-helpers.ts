// Giro de estoque por SKU (aba Ciclo, frente 3). A REGRA (classe, dias, candidatos) vive na RPC
// fin_ciclo_giro_sku; aqui só normaliza e resume — sem recalcular nada que o banco já decidiu.
// Spec: docs/superpowers/specs/2026-10-18-ciclo-giro-sku-design.md (§5.3, §5.4).
import { num } from '@/lib/financeiro/ciclo-cliente-helpers';

/** Espelho dos limiares da RPC (teste trava a igualdade com a migration). Só para os textos da tela. */
export const LIMIAR_COBERTURA_ALVO_DIAS = 90;
export const LIMIAR_SEGURAR_COMPRA_DIAS = 180;
export const LIMIAR_GIRO_MORTO_DIAS_FIN = 270;

/** Espelho de MANUAL_VALIDADE_DIAS da edge (estoque-pme.ts): override manual vale de hoje−45 até hoje (dia SP). */
export const MANUAL_VALIDADE_DIAS = 45;

/** O motor só usa o inventário manual dentro da janela; fora dela, salvar não muda PME/NCG. */
export function overrideManualVigente(dataRef: string, fonte: string | null | undefined, hoje: string, inicioJanela: string): boolean {
  return fonte === 'manual' && dataRef >= inicioJanela && dataRef <= hoje;
}

type ClasseEstoque = 'giro' | 'fora_giro' | 'sem_classificacao';
type AcaoGiro = 'liquidar' | 'segurar_compra';

export type GiroSku = {
  omieCodigoProduto: number; codigo: string | null; descricao: string | null;
  tipoProduto: string | null; familia: string | null; classe: ClasseEstoque; divergenciaCadastro: boolean;
  saldo: number; cmc: number | null; valorParado: number | null;
  consumoQtd365d: number | null; diasCobertura: number | null;
  ultimaSaida: string | null; diasSemSaida: number | null; valorExcedente: number | null;
  acao: AcaoGiro | null; motivoAcao: string | null; motivoConsumo: string | null;
};

const CLASSES: readonly string[] = ['giro', 'fora_giro', 'sem_classificacao'];
const txt = (x: unknown): string | null => (typeof x === 'string' && x.trim() !== '' ? x : null);

/** Linha sem código, sem saldo ou com classe desconhecida é descartada (nunca default fabricado). */
export function normalizarGiro(r: Record<string, unknown>): GiroSku | null {
  const cod = num(r.omie_codigo_produto);
  const saldo = num(r.saldo);
  if (cod === null || saldo === null || typeof r.classe !== 'string' || !CLASSES.includes(r.classe)) return null;
  const acao = r.acao === 'liquidar' || r.acao === 'segurar_compra' ? r.acao : null;
  return {
    omieCodigoProduto: cod, codigo: txt(r.codigo), descricao: txt(r.descricao),
    tipoProduto: txt(r.tipo_produto), familia: txt(r.familia), classe: r.classe as ClasseEstoque,
    divergenciaCadastro: r.divergencia_cadastro === true,
    saldo, cmc: num(r.cmc), valorParado: num(r.valor_parado),
    consumoQtd365d: num(r.consumo_qtd_365d), diasCobertura: num(r.dias_cobertura),
    ultimaSaida: txt(r.ultima_saida), diasSemSaida: num(r.dias_sem_saida), valorExcedente: num(r.valor_excedente),
    acao, motivoAcao: txt(r.motivo_acao), motivoConsumo: txt(r.motivo_consumo),
  };
}

export type ResumoGiro = {
  valorGiro: number | null; skusSemCusto: number; valorLiquidar: number | null;
  valorExcedenteSegurar: number | null; valorForaGiro: number | null; valorSemClassificacao: number | null;
  temFonteConsumo: boolean;
};

/** Σ só de termos não-null; nenhum termo → null (nunca 0). */
function somar(vs: Array<number | null>): number | null {
  let s = 0;
  let n = 0;
  for (const v of vs) if (v !== null) { s += v; n++; }
  return n > 0 ? s : null;
}

export function resumirGiro(rows: GiroSku[]): ResumoGiro {
  const giro = rows.filter((r) => r.classe === 'giro');
  return {
    valorGiro: somar(giro.map((r) => r.valorParado)),
    skusSemCusto: giro.filter((r) => r.valorParado === null).length,
    valorLiquidar: somar(giro.filter((r) => r.acao === 'liquidar').map((r) => r.valorParado)),
    valorExcedenteSegurar: somar(giro.filter((r) => r.acao === 'segurar_compra').map((r) => r.valorExcedente)),
    valorForaGiro: somar(rows.filter((r) => r.classe === 'fora_giro').map((r) => r.valorParado)),
    valorSemClassificacao: somar(rows.filter((r) => r.classe === 'sem_classificacao').map((r) => r.valorParado)),
    temFonteConsumo: giro.some((r) => r.motivoConsumo === null),
  };
}

export function separarListas(rows: GiroSku[]): { giro: GiroSku[]; foraGiro: GiroSku[] } {
  return { giro: rows.filter((r) => r.classe === 'giro'), foraGiro: rows.filter((r) => r.classe !== 'giro') };
}

/** Texto humano do motivo de "—" (consumo/ação). Domínio fechado vindo da RPC. */
export const MOTIVO_TEXTO: Record<string, string> = {
  sem_consumo_por_sku: 'sem consumo por SKU (NF-e só da Oben)',
  consumo_incompleto: 'histórico de NF-e curto demais (< 330 dias)',
  consumo_desatualizado: 'NF-e desatualizadas (> 7 dias sem sync)',
  unidade_divergente: 'unidade da malha de produção difere do cadastro',
  fora_do_giro: 'fora do giro (imobilizado / uso e consumo / sem tipo)',
  substituido: 'código substituído — demanda migrou para o novo',
  cold_start: 'SKU novo (cold start) — sem histórico para julgar',
  compra_recente: 'comprado nos últimos 90 dias',
};
