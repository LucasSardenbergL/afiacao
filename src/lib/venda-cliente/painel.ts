/**
 * Painel do founder — Venda por cliente (Task 7). Lógica pura: tipos do JSON de `venda_painel`
 * e de `venda_repasse_candidatos`, o estado de cada célula de taxa e a validação da aprovação.
 *
 * Regra que governa tudo aqui: ausente ≠ zero. Uma taxa sem base vira "não consegui medir" ou
 * "aguardando", nunca 0%; receita sem venda casada é "—", nunca R$ 0.
 */

import { addDias } from '@/lib/dashboard/sp-date';

export interface ContagemDesfecho {
  virou: number;
  nao_virou: number;
  nao_medivel: number;
  pendentes: number;
}

export interface LinhaPainel extends ContagemDesfecho {
  farmer_user_id: string;
  farmer_nome: string | null;
  /** segunda-feira da semana (YYYY-MM-DD) */
  semana: string;
  na_lista: number;
  mostradas: number;
  contatados: number;
  compraram: number;
  receita_realizada: number | null;
  receita_incompleta: boolean;
  taxa_ativa: number | null;
  na_lista_sombra: number;
  base_historico: ContagemDesfecho;
  taxa_base_historico_mesma_semana: number | null;
  base_sombra: ContagemDesfecho;
  taxa_base_sombra: number | null;
  base_confiavel: boolean;
}

interface OndaBase {
  ligada: boolean;
  ligada_em: string | null;
  condicao_ao_ligar: Record<string, unknown> | null;
}

export interface PainelVenda {
  hoje: string;
  periodo: { de: string; ate: string };
  base_confiavel: boolean;
  /** a RPC de candidatos da Task 6 existe no banco */
  repasse_disponivel: boolean;
  linhas: LinhaPainel[];
  ondas: {
    onda_recompra: OndaBase & {
      prerequisitos: {
        historico_dias: number;
        historico_meta: number;
        sombra_ao_vivo: { dia: string; ao_vivo: boolean }[];
        avaliada_hoje: boolean;
      };
    };
    onda_complemento: OndaBase & {
      prerequisitos: {
        onda_recompra_ligada: boolean;
        semanas: { semana: string; farmers: number; menor_taxa: number | null; ok: boolean }[];
      };
    };
    onda_preco: OndaBase & {
      prerequisitos: { onda_complemento_ligada: boolean; repasse_vigente: boolean | null };
    };
  };
}

/** Acima desta fração de `nao_medivel` entre as sugestões avaliadas, a taxa não é afirmável. */
const LIMITE_NAO_MEDIVEL = 0.2;

export type EstadoTaxa =
  | { tipo: 'valor'; taxa: number }
  | { tipo: 'nao_medi'; motivo: string }
  | { tipo: 'aguardando'; pendentes: number }
  | { tipo: 'sem_lista' };

/**
 * Estado de uma célula de taxa. `exigeBaseConfiavel` vale para as colunas de LINHA DE BASE:
 * enquanto a Onda 1 não ligou pela lista idêntica, a base não foi conferida contra o presente.
 */
export function estadoTaxa(
  c: ContagemDesfecho,
  taxa: number | null,
  opts: { baseConfiavel: boolean; exigeBaseConfiavel: boolean },
): EstadoTaxa {
  if (opts.exigeBaseConfiavel && !opts.baseConfiavel) {
    return { tipo: 'nao_medi', motivo: 'linha de base ainda não conferida contra a lista ao vivo' };
  }
  const avaliadas = c.virou + c.nao_virou + c.nao_medivel;
  if (avaliadas === 0) {
    return c.pendentes > 0 ? { tipo: 'aguardando', pendentes: c.pendentes } : { tipo: 'sem_lista' };
  }
  if (c.nao_medivel / avaliadas > LIMITE_NAO_MEDIVEL) {
    return {
      tipo: 'nao_medi',
      motivo: `${c.nao_medivel} de ${avaliadas} sugestões sem medição (sync atrasado ou cadastro sem vínculo)`,
    };
  }
  if (taxa === null) {
    return { tipo: 'nao_medi', motivo: 'nenhuma sugestão fechada com desfecho medível' };
  }
  return { tipo: 'valor', taxa };
}

const PCT = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const BRL_CENTAVOS = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export const formatarPct = (v: number) => PCT.format(v);
/** null = ausente → "—" (nunca R$ 0). */
export const formatarReais = (v: number | null) => (v === null ? '—' : BRL.format(v));
export const formatarPreco = (v: number | null) => (v === null ? '—' : BRL_CENTAVOS.format(v));

/** "13/10" a partir de "2026-10-13" (sem fuso: a data já é do calendário de SP). */
export function rotuloSemana(semana: string): string {
  const [, m, d] = semana.split('-');
  return `${d}/${m}`;
}

// ── Repasses (Task 6) ────────────────────────────────────────────────────────────────────────

/** Situação do candidato na recompra: substituído não é repasse (vem sem preço sugerido). */
export type SituacaoCompraRepasse = 'comprando' | 'parado' | 'substituido';

interface SubstitutoRepasse {
  omie_codigo_produto: number;
  codigo: string | null;
  descricao: string | null;
  primeira_compra: string;
  ultima_compra: string;
  dias_com_compra: number;
}

export interface CandidatoRepasse {
  comprador_id: string;
  empresa: 'oben';
  omie_codigo_produto: number;
  descricao: string | null;
  status_defasagem: string | null;
  motivo: string | null;
  abaixo_piso: boolean | null;
  ultimo_preco: number | null;
  data_ultima_compra: string | null;
  preco_sugerido: number | null;
  alta_custo_perc: number | null;
  valor_anual_recuperavel: number | null;
  n_pedidos: number | null;
  cadencia_dias: number | null;
  qtd_sugerida: number | null;
  /** Ainda compra o SKU? NULL = sem cadência para afirmar (20261031233000). */
  situacao_compra: SituacaoCompraRepasse | null;
  dias_sem_comprar: number | null;
  /** SKU de outra base, mesma família, que entrou depois que o candidato parou (só em 'substituido'). */
  substituto: SubstitutoRepasse | null;
  repasse_atual: {
    id: string;
    preco_alvo: number;
    valido_ate: string;
    revogado: boolean;
    vigente: boolean;
  } | null;
}

export type ValidacaoAprovacao = { ok: true } | { ok: false; motivo: string };

/** Aritmética de calendário (sem relógio/fuso) — o helper canônico do repo. */
export const somarDias = addDias;

/**
 * Espelha as recusas de `venda_aprovar_repasse` (22023) para o botão nunca prometer o que o
 * servidor recusa: alvo ACIMA do último preço praticado (preço alvo nunca sugere baixar), até
 * 2× o último (digitação), em centavos; validade em (hoje, hoje + 365]. O servidor revalida
 * contra o último preço AO VIVO — esta checagem é só a primeira barreira.
 */
export function validarAprovacao(args: {
  precoAlvo: number | null;
  ultimoPreco: number | null;
  validoAte: string;
  hoje: string;
}): ValidacaoAprovacao {
  const { precoAlvo, ultimoPreco, validoAte, hoje } = args;
  if (ultimoPreco === null || !Number.isFinite(ultimoPreco) || ultimoPreco <= 0) {
    return { ok: false, motivo: 'Sem último preço praticado provado — não dá para aprovar.' };
  }
  if (precoAlvo === null || !Number.isFinite(precoAlvo) || precoAlvo <= 0) {
    return { ok: false, motivo: 'Informe o preço alvo.' };
  }
  if (Math.round(precoAlvo * 100) / 100 !== precoAlvo) {
    return { ok: false, motivo: 'Preço alvo em centavos (no máximo 2 casas).' };
  }
  if (precoAlvo <= ultimoPreco) {
    return { ok: false, motivo: `O alvo precisa ficar acima do último preço (${formatarPreco(ultimoPreco)}).` };
  }
  if (precoAlvo > 2 * ultimoPreco) {
    return { ok: false, motivo: 'Alvo acima de 2× o último preço — confira a digitação.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validoAte)) {
    return { ok: false, motivo: 'Informe a validade.' };
  }
  if (validoAte <= hoje || validoAte > somarDias(hoje, 365)) {
    return { ok: false, motivo: 'Validade entre amanhã e daqui a 1 ano.' };
  }
  return { ok: true };
}

/** Lê "12,50" ou "12.50" como número; vazio/ilegível = null (nunca 0). */
export function lerPreco(texto: string): number | null {
  const t = texto.trim().replace(/\s/g, '');
  if (!t) return null;
  const normal = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^\d+(\.\d+)?$/.test(normal)) return null;
  return Number(normal);
}

