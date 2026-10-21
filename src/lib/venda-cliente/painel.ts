/**
 * Painel do founder — Venda por cliente (Task 7). Lógica pura: tipos do JSON de `venda_painel`
 * e de `venda_repasse_candidatos`, o estado de cada célula de taxa e a validação da aprovação.
 *
 * Regra que governa tudo aqui: ausente ≠ zero. Uma taxa sem base vira "não consegui medir" ou
 * "aguardando", nunca 0%; receita sem venda casada é "—", nunca R$ 0.
 */

import type { Json } from '@/integrations/supabase/types';
import { addDias } from '@/lib/dashboard/sp-date';
import {
  booleanoJson,
  booleanoOuNuloJson,
  listaJson,
  numeroJson,
  numeroOuNuloJson,
  objetoJson,
  textoJson,
  textoOuNuloJson,
  type ObjetoJson,
} from '@/lib/json-forma';

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

// ── Leitura por forma do `jsonb` de `venda_painel` ───────────────────────────────────────────
// O gerador tipa o retorno como `Json`. A forma vem do corpo da RPC na prod (conferido em 2026-10-21):
// contagens são COALESCE(…, 0); taxas, receita, `farmer_nome`, `menor_taxa`, `ligada_em` e
// `condicao_ao_ligar` podem ser NULL; `repasse_vigente` é NULL quando não dá para saber. Chave
// ausente ou tipo trocado LANÇA — nunca vira 0, "" ou false (ausente ≠ zero).

const F_PAINEL = 'venda_painel';

function lerContagem(v: Json | undefined, fonte: string): ContagemDesfecho {
  const o = objetoJson(v, fonte);
  return {
    virou: numeroJson(o, 'virou', fonte),
    nao_virou: numeroJson(o, 'nao_virou', fonte),
    nao_medivel: numeroJson(o, 'nao_medivel', fonte),
    pendentes: numeroJson(o, 'pendentes', fonte),
  };
}

function lerLinha(v: Json): LinhaPainel {
  const f = `${F_PAINEL}.linhas[]`;
  const o = objetoJson(v, f);
  return {
    ...lerContagem(o, f),
    farmer_user_id: textoJson(o, 'farmer_user_id', f),
    farmer_nome: textoOuNuloJson(o, 'farmer_nome', f),
    semana: textoJson(o, 'semana', f),
    na_lista: numeroJson(o, 'na_lista', f),
    mostradas: numeroJson(o, 'mostradas', f),
    contatados: numeroJson(o, 'contatados', f),
    compraram: numeroJson(o, 'compraram', f),
    receita_realizada: numeroOuNuloJson(o, 'receita_realizada', f),
    receita_incompleta: booleanoJson(o, 'receita_incompleta', f),
    taxa_ativa: numeroOuNuloJson(o, 'taxa_ativa', f),
    na_lista_sombra: numeroJson(o, 'na_lista_sombra', f),
    base_historico: lerContagem(o.base_historico, `${f}.base_historico`),
    taxa_base_historico_mesma_semana: numeroOuNuloJson(o, 'taxa_base_historico_mesma_semana', f),
    base_sombra: lerContagem(o.base_sombra, `${f}.base_sombra`),
    taxa_base_sombra: numeroOuNuloJson(o, 'taxa_base_sombra', f),
    base_confiavel: booleanoJson(o, 'base_confiavel', f),
  };
}

function lerOndaBase(o: ObjetoJson, fonte: string): OndaBase {
  const c = o.condicao_ao_ligar;
  return {
    ligada: booleanoJson(o, 'ligada', fonte),
    ligada_em: textoOuNuloJson(o, 'ligada_em', fonte),
    condicao_ao_ligar: c === null ? null : objetoJson(c, `${fonte}.condicao_ao_ligar`),
  };
}

/** O `jsonb` de `venda_painel` lido campo a campo; qualquer desvio da forma lança com a chave. */
export function lerPainelVenda(v: Json | null): PainelVenda {
  if (v === null) throw new Error('venda_painel devolveu vazio');
  const o = objetoJson(v, F_PAINEL);
  const periodo = objetoJson(o.periodo, `${F_PAINEL}.periodo`);
  const ondas = objetoJson(o.ondas, `${F_PAINEL}.ondas`);

  const f1 = `${F_PAINEL}.ondas.onda_recompra`;
  const o1 = objetoJson(ondas.onda_recompra, f1);
  const p1 = objetoJson(o1.prerequisitos, `${f1}.prerequisitos`);
  const f2 = `${F_PAINEL}.ondas.onda_complemento`;
  const o2 = objetoJson(ondas.onda_complemento, f2);
  const p2 = objetoJson(o2.prerequisitos, `${f2}.prerequisitos`);
  const f3 = `${F_PAINEL}.ondas.onda_preco`;
  const o3 = objetoJson(ondas.onda_preco, f3);
  const p3 = objetoJson(o3.prerequisitos, `${f3}.prerequisitos`);

  return {
    hoje: textoJson(o, 'hoje', F_PAINEL),
    periodo: { de: textoJson(periodo, 'de', `${F_PAINEL}.periodo`), ate: textoJson(periodo, 'ate', `${F_PAINEL}.periodo`) },
    base_confiavel: booleanoJson(o, 'base_confiavel', F_PAINEL),
    repasse_disponivel: booleanoJson(o, 'repasse_disponivel', F_PAINEL),
    linhas: listaJson(o.linhas, `${F_PAINEL}.linhas`).map(lerLinha),
    ondas: {
      onda_recompra: {
        ...lerOndaBase(o1, f1),
        prerequisitos: {
          historico_dias: numeroJson(p1, 'historico_dias', `${f1}.prerequisitos`),
          historico_meta: numeroJson(p1, 'historico_meta', `${f1}.prerequisitos`),
          sombra_ao_vivo: listaJson(p1.sombra_ao_vivo, `${f1}.prerequisitos.sombra_ao_vivo`).map((d) => {
            const fd = `${f1}.prerequisitos.sombra_ao_vivo[]`;
            const od = objetoJson(d, fd);
            return { dia: textoJson(od, 'dia', fd), ao_vivo: booleanoJson(od, 'ao_vivo', fd) };
          }),
          avaliada_hoje: booleanoJson(p1, 'avaliada_hoje', `${f1}.prerequisitos`),
        },
      },
      onda_complemento: {
        ...lerOndaBase(o2, f2),
        prerequisitos: {
          onda_recompra_ligada: booleanoJson(p2, 'onda_recompra_ligada', `${f2}.prerequisitos`),
          semanas: listaJson(p2.semanas, `${f2}.prerequisitos.semanas`).map((s) => {
            const fs = `${f2}.prerequisitos.semanas[]`;
            const os = objetoJson(s, fs);
            return {
              semana: textoJson(os, 'semana', fs),
              farmers: numeroJson(os, 'farmers', fs),
              menor_taxa: numeroOuNuloJson(os, 'menor_taxa', fs),
              ok: booleanoJson(os, 'ok', fs),
            };
          }),
        },
      },
      onda_preco: {
        ...lerOndaBase(o3, f3),
        prerequisitos: {
          onda_complemento_ligada: booleanoJson(p3, 'onda_complemento_ligada', `${f3}.prerequisitos`),
          repasse_vigente: booleanoOuNuloJson(p3, 'repasse_vigente', `${f3}.prerequisitos`),
        },
      },
    },
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
  repasse_atual: {
    id: string;
    preco_alvo: number;
    valido_ate: string;
    revogado: boolean;
    vigente: boolean;
  } | null;
}

const F_CAND = 'venda_repasse_candidatos';

/**
 * O `jsonb` de `venda_repasse_candidatos` lido campo a campo (forma conferida no corpo da RPC na
 * prod, 2026-10-21). As chaves de evidência de custo (`c_last`, `c_now`) não fazem parte do tipo e
 * são ignoradas. `empresa` fora de 'oben' lança: a tela só aprova repasse da Oben.
 */
export function lerCandidatosRepasse(v: Json | null): CandidatoRepasse[] {
  return listaJson(v ?? undefined, F_CAND).map((item) => {
    const f = `${F_CAND}[]`;
    const o = objetoJson(item, f);
    if (o.empresa !== 'oben') throw new Error(`${f}: "empresa" fora da forma ('oben')`);
    const r = o.repasse_atual;
    let repasse: CandidatoRepasse['repasse_atual'] = null;
    if (r !== null) {
      const fr = `${f}.repasse_atual`;
      const or = objetoJson(r, fr);
      repasse = {
        id: textoJson(or, 'id', fr),
        preco_alvo: numeroJson(or, 'preco_alvo', fr),
        valido_ate: textoJson(or, 'valido_ate', fr),
        revogado: booleanoJson(or, 'revogado', fr),
        vigente: booleanoJson(or, 'vigente', fr),
      };
    }
    return {
      comprador_id: textoJson(o, 'comprador_id', f),
      empresa: 'oben',
      omie_codigo_produto: numeroJson(o, 'omie_codigo_produto', f),
      descricao: textoOuNuloJson(o, 'descricao', f),
      status_defasagem: textoOuNuloJson(o, 'status_defasagem', f),
      motivo: textoOuNuloJson(o, 'motivo', f),
      abaixo_piso: booleanoOuNuloJson(o, 'abaixo_piso', f),
      ultimo_preco: numeroOuNuloJson(o, 'ultimo_preco', f),
      data_ultima_compra: textoOuNuloJson(o, 'data_ultima_compra', f),
      preco_sugerido: numeroOuNuloJson(o, 'preco_sugerido', f),
      alta_custo_perc: numeroOuNuloJson(o, 'alta_custo_perc', f),
      valor_anual_recuperavel: numeroOuNuloJson(o, 'valor_anual_recuperavel', f),
      n_pedidos: numeroOuNuloJson(o, 'n_pedidos', f),
      cadencia_dias: numeroOuNuloJson(o, 'cadencia_dias', f),
      qtd_sugerida: numeroOuNuloJson(o, 'qtd_sugerida', f),
      repasse_atual: repasse,
    };
  });
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

