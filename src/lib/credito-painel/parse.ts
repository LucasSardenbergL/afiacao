// Painel de crédito (crédito-IA PR 8) — borda tipada do jsonb de `credito_painel_resumo`.
//
// Ausente ≠ zero (docs/agent/money-path.md §2): número que não veio, ou veio não-numérico, é `null` —
// nunca 0. Bloco cuja fonte ainda não existe chega como `{ disponivel: false, motivo }` e continua
// assim até a tela (o front mostra "sem dado ainda" + o motivo). O banco é quem decide; aqui só se lê.
import type { Json } from '@/integrations/supabase/types';

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;

/** numeric do Postgres chega como number em jsonb; string numérica também é aceita. Resto = null. */
export const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Mapa `{chave: número}`; valor não-numérico vira null (não some). */
const mapaNum = (v: unknown): Record<string, number | null> =>
  Object.fromEntries(Object.entries(obj(v) ?? {}).map(([k, x]) => [k, num(x)]));

export type Indisponivel = { disponivel: false; motivo: string };
type Bloco<T> = ({ disponivel: true } & T) | Indisponivel;

/** `disponivel` ausente ou não-booleano é tratado como indisponível (fail-closed na leitura). */
function bloco<T>(v: unknown, ler: (o: Obj) => T): Bloco<T> {
  const o = obj(v);
  if (!o || o.disponivel !== true) {
    return { disponivel: false, motivo: str(o?.motivo) ?? 'fonte não informou o motivo' };
  }
  return { disponivel: true, ...ler(o) };
}

type GrupoExposicao = {
  grupoUserId: string;
  nome: string | null;
  empresas: string[];
  parcialColacorSc: boolean;
  titulos: number | null;
  titulosIndeterminados: number | null;
  titulosPagtoParcial: number | null;
  abertoConhecido: number | null;
  vencidoConhecido: number | null;
  vencido60Conhecido: number | null;
  titulosVencidos60: number | null;
  diasMaiorAtraso: number | null;
  reservado: number | null;
  limiteBrl: number | null;
  prazoMaxDias: number | null;
  risco: string | null;
  usoPct: number | null;
};

type NaoConsolidado = {
  motivo: string;
  pares: number | null;
  titulos: number | null;
  abertoConhecido: number | null;
  titulosIndeterminados: number | null;
};

type FaixaMotivo = { faixa: string; motivo: string; decisoes: number | null };
/** `pisoBloqueado` null = o piso não informou (ausente ≠ "não bloqueou"). */
type V2XPiso = { faixa: string; pisoBloqueado: boolean | null; decisoes: number | null };

type LiberadoAtrasado = {
  salesOrderId: string;
  company: string;
  omieNumeroPedido: string | null;
  total: number | null;
  createdAt: string | null;
  via: string;
  saldoAtrasado: number | null;
  diasAtraso: number | null;
};

type BloqueioRecente = {
  createdAt: string | null;
  company: string;
  omieCodigoCliente: number | null;
  acao: string;
  vencido: number | null;
  titulos: number | null;
  nome: string | null;
};

export type PainelCredito = {
  geradoEm: string | null;
  hojeSp: string | null;
  periodoDias: number | null;
  frescorCr: Record<string, string | null>;
  exposicao: {
    totais: {
      grupos: number | null;
      abertoConhecido: number | null;
      vencidoConhecido: number | null;
      vencido60Conhecido: number | null;
      titulosIndeterminados: number | null;
      gruposComLimite: number | null;
      gruposVencido60: number | null;
    };
    reservas: Indisponivel | { disponivel: true };
    grupos: GrupoExposicao[];
    gruposOmitidos: number | null;
    naoConsolidados: NaoConsolidado[];
  };
  bloqueios: {
    logTotalHistorico: number | null;
    pedidosAppPeriodo: Record<string, number | null>;
    porAcao: { acao: string; eventos: number | null; vencidoConhecido: number | null; semValor: number | null }[];
    recentes: BloqueioRecente[];
    gateV2: Bloco<{ porMotivo: FaixaMotivo[] }>;
  };
  limites: Bloco<{ vigentes: number | null; propostas: Record<string, number | null> }> & {
    propostasPendentes: number | null;
  };
  concordancia: {
    concordancia: Indisponivel | { disponivel: true };
    sombra: Bloco<{ pvs: number | null; porFaixa: FaixaMotivo[]; v2XPiso: V2XPiso[] }>;
  };
  fila: Bloco<{ abertas: number | null; abertaMaisAntiga: string | null; decididasPeriodo: number | null }>;
  liberados: {
    definicao: string | null;
    coberturaParcial: boolean;
    coberturaMotivo: string | null;
    liberados: number | null;
    liberadosValor: number | null;
    porVia: Record<string, number | null>;
    comTitulo: number | null;
    maturados: number | null;
    atrasados: number | null;
    saldoAtrasadoConhecido: number | null;
    titulosAtrasadosSemSaldo: number | null;
    taxaAtrasoPct: number | null;
    lista: LiberadoAtrasado[];
  };
};

const faixas = (v: unknown): FaixaMotivo[] =>
  arr(v).flatMap((x) => {
    const o = obj(x);
    const faixa = str(o?.faixa);
    const motivo = str(o?.motivo);
    return o && faixa && motivo ? [{ faixa, motivo, decisoes: num(o.decisoes) }] : [];
  });

/** Lança se o payload não tem a forma mínima (o hook transforma em estado de erro, nunca em zeros). */
export function lerPainelCredito(raw: Json | null): PainelCredito {
  const r = obj(raw);
  if (!r) throw new Error('credito_painel_resumo: resposta vazia ou não-objeto');
  const exp = obj(r.exposicao);
  const blq = obj(r.bloqueios);
  const lib = obj(r.liberados_atrasaram);
  const lim = obj(r.limites);
  const conc = obj(r.concordancia);
  if (!exp || !blq || !lib || !lim || !conc) {
    throw new Error('credito_painel_resumo: bloco obrigatório ausente');
  }
  const tot = obj(exp.totais) ?? {};

  const grupos: GrupoExposicao[] = arr(exp.grupos).flatMap((x) => {
    const g = obj(x);
    const id = str(g?.grupo_user_id);
    if (!g || !id) return [];
    return [{
      grupoUserId: id,
      nome: str(g.nome),
      empresas: arr(g.empresas).filter((e): e is string => typeof e === 'string'),
      parcialColacorSc: bool(g.parcial_colacor_sc) === true,
      titulos: num(g.titulos),
      titulosIndeterminados: num(g.titulos_indeterminados),
      titulosPagtoParcial: num(g.titulos_pagto_parcial),
      abertoConhecido: num(g.aberto_conhecido),
      vencidoConhecido: num(g.vencido_conhecido),
      vencido60Conhecido: num(g.vencido_60_conhecido),
      titulosVencidos60: num(g.titulos_vencidos_60),
      diasMaiorAtraso: num(g.dias_maior_atraso),
      reservado: num(g.reservado),
      limiteBrl: num(g.limite_brl),
      prazoMaxDias: num(g.prazo_max_dias),
      risco: str(g.risco),
      usoPct: num(g.uso_pct),
    }];
  });

  const limBloco = bloco(lim, (o) => ({ vigentes: num(o.vigentes), propostas: mapaNum(o.propostas) }));
  const propostas = mapaNum(lim.propostas);

  return {
    geradoEm: str(r.gerado_em),
    hojeSp: str(r.hoje_sp),
    periodoDias: num(r.periodo_dias),
    frescorCr: Object.fromEntries(Object.entries(obj(r.frescor_cr) ?? {}).map(([k, v]) => [k, str(v)])),
    exposicao: {
      totais: {
        grupos: num(tot.grupos),
        abertoConhecido: num(tot.aberto_conhecido),
        vencidoConhecido: num(tot.vencido_conhecido),
        vencido60Conhecido: num(tot.vencido_60_conhecido),
        titulosIndeterminados: num(tot.titulos_indeterminados),
        gruposComLimite: num(tot.grupos_com_limite),
        gruposVencido60: num(tot.grupos_vencido_60),
      },
      reservas: obj(exp.reservas)?.disponivel === true
        ? { disponivel: true }
        : { disponivel: false, motivo: str(obj(exp.reservas)?.motivo) ?? 'fonte não informou o motivo' },
      grupos,
      gruposOmitidos: num(exp.grupos_omitidos),
      naoConsolidados: arr(exp.nao_consolidados).flatMap((x) => {
        const n = obj(x);
        const motivo = str(n?.motivo);
        return n && motivo ? [{
          motivo,
          pares: num(n.pares),
          titulos: num(n.titulos),
          abertoConhecido: num(n.aberto_conhecido),
          titulosIndeterminados: num(n.titulos_indeterminados),
        }] : [];
      }),
    },
    bloqueios: {
      logTotalHistorico: num(blq.log_total_historico),
      pedidosAppPeriodo: mapaNum(blq.pedidos_app_periodo),
      porAcao: arr(blq.por_acao).flatMap((x) => {
        const a = obj(x);
        const acao = str(a?.acao);
        return a && acao ? [{ acao, eventos: num(a.eventos), vencidoConhecido: num(a.vencido_conhecido), semValor: num(a.sem_valor) }] : [];
      }),
      recentes: arr(blq.recentes).flatMap((x) => {
        const b = obj(x);
        const company = str(b?.company);
        const acao = str(b?.acao);
        return b && company && acao ? [{
          createdAt: str(b.created_at),
          company,
          omieCodigoCliente: num(b.omie_codigo_cliente),
          acao,
          vencido: num(b.vencido),
          titulos: num(b.titulos),
          nome: str(b.nome),
        }] : [];
      }),
      gateV2: bloco(blq.gate_v2, (o) => ({ porMotivo: faixas(o.por_motivo) })),
    },
    limites: { ...limBloco, propostasPendentes: propostas.pendente ?? (Object.keys(propostas).length ? 0 : null) },
    concordancia: {
      concordancia: conc.disponivel === true
        ? { disponivel: true }
        : { disponivel: false, motivo: str(conc.motivo) ?? 'fonte não informou o motivo' },
      sombra: bloco(conc.sombra, (o) => ({
        pvs: num(o.pvs),
        porFaixa: faixas(o.por_faixa),
        v2XPiso: arr(o.v2_x_piso).flatMap((x) => {
          const v = obj(x);
          const faixa = str(v?.faixa);
          return v && faixa ? [{ faixa, pisoBloqueado: bool(v.piso_bloqueado), decisoes: num(v.decisoes) }] : [];
        }),
      })),
    },
    fila: bloco(r.fila, (o) => ({
      abertas: num(o.abertas),
      abertaMaisAntiga: str(o.aberta_mais_antiga),
      decididasPeriodo: num(o.decididas_periodo),
    })),
    liberados: {
      definicao: str(lib.definicao),
      coberturaParcial: bool(obj(lib.cobertura)?.parcial) !== false,
      coberturaMotivo: str(obj(lib.cobertura)?.motivo),
      liberados: num(lib.liberados),
      liberadosValor: num(lib.liberados_valor),
      porVia: mapaNum(lib.por_via),
      comTitulo: num(lib.com_titulo),
      maturados: num(lib.maturados),
      atrasados: num(lib.atrasados),
      saldoAtrasadoConhecido: num(lib.saldo_atrasado_conhecido),
      titulosAtrasadosSemSaldo: num(lib.titulos_atrasados_sem_saldo),
      taxaAtrasoPct: num(lib.taxa_atraso_pct),
      lista: arr(lib.lista).flatMap((x) => {
        const l = obj(x);
        const id = str(l?.sales_order_id);
        const company = str(l?.company);
        return l && id && company ? [{
          salesOrderId: id,
          company,
          omieNumeroPedido: str(l.omie_numero_pedido),
          total: num(l.total),
          createdAt: str(l.created_at),
          via: str(l.via) ?? 'desconhecida',
          saldoAtrasado: num(l.saldo_atrasado),
          diasAtraso: num(l.dias_atraso),
        }] : [];
      }),
    },
  };
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

/** Moeda sem fabricar zero: `null` → "—". `parcial` (há título sem saldo) prefixa "≥". */
export function brl(v: number | null, parcial = false): string {
  if (v === null) return '—';
  return `${parcial ? '≥ ' : ''}${BRL.format(v)}`;
}

/** Inteiro sem fabricar zero. */
export function int(v: number | null): string {
  return v === null ? '—' : v.toLocaleString('pt-BR');
}

export const NOME_EMPRESA: Record<string, string> = { oben: 'Oben', colacor: 'Colacor', colacor_sc: 'Colacor SC' };
