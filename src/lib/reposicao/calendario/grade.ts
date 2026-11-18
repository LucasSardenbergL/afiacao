/**
 * Helpers PUROS da tela "Calendário de operação": a grade do mês, os períodos por fornecedor, o fim do
 * recesso e o rótulo "recebe em DD/MM" da lista de pedidos.
 */
import { addDias } from '@/lib/time/sp-day';
import { diaDaSemanaIso } from './pendencias';

export type StatusDia = 'aberto' | 'fechado' | 'meia_equipe' | 'pendente_dado';
export const STATUS_DIA: readonly StatusDia[] = ['aberto', 'fechado', 'meia_equipe', 'pendente_dado'];

export const ROTULO_STATUS: Record<StatusDia, string> = {
  aberto: 'Aberto',
  fechado: 'Fechado',
  meia_equipe: 'Meia equipe',
  pendente_dado: 'Pendente de dado',
};

export type LinhaDiaEmpresa = {
  data: string;
  status: string;
  peso: number;
  motivo: string | null;
  origem: string;
};

export type CelulaGrade = {
  data: string;
  /** 1 = segunda … 7 = domingo */
  diaSemana: number;
  status: StatusDia;
  /** `true` = o status veio da REGRA BASE (sem linha): seg–sex aberto, sáb/dom fechado */
  regraBase: boolean;
  linha: LinhaDiaEmpresa | null;
  feriado: string | null;
};

/** Peso gravado pela tela: fechado ⇒ 0 (CHECK do banco); qualquer outro status ⇒ 1. */
export function pesoDoStatus(status: StatusDia): number {
  return status === 'fechado' ? 0 : 1;
}

function ehStatusDia(s: string): s is StatusDia {
  return (STATUS_DIA as readonly string[]).includes(s);
}

/** Regra base: dia SEM linha é aberto de segunda a sexta e fechado no sábado e no domingo. */
function statusRegraBase(iso: string): StatusDia {
  return diaDaSemanaIso(iso) >= 6 ? 'fechado' : 'aberto';
}

/** Os dias do mês (1-12) com o status efetivo — a linha da tabela quando existe, a regra base senão. */
export function montarGradeMes(
  ano: number,
  mes: number,
  linhas: LinhaDiaEmpresa[],
  feriados: { data: string; nome: string }[],
): CelulaGrade[] {
  const porData = new Map(linhas.map((l) => [l.data, l]));
  const feriadoPorData = new Map(feriados.map((f) => [f.data, f.nome]));
  const primeiro = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const out: CelulaGrade[] = [];
  for (let d = primeiro; d.slice(0, 7) === primeiro.slice(0, 7); d = addDias(d, 1)) {
    const linha = porData.get(d) ?? null;
    const status = linha && ehStatusDia(linha.status) ? linha.status : statusRegraBase(d);
    out.push({
      data: d,
      diaSemana: diaDaSemanaIso(d),
      status,
      regraBase: linha === null,
      linha,
      feriado: feriadoPorData.get(d) ?? null,
    });
  }
  return out;
}

export type PeriodoFornecedor = { fornecedor_nome: string; de: string; ate: string; dias: number; motivo: string | null };

/** Agrupa datas consecutivas do mesmo fornecedor em períodos [de, ate]. */
export function agruparPeriodos(
  linhas: { data: string; fornecedor_nome: string; motivo: string | null }[],
): PeriodoFornecedor[] {
  const ordenadas = [...linhas].sort(
    (a, b) => a.fornecedor_nome.localeCompare(b.fornecedor_nome) || a.data.localeCompare(b.data),
  );
  const out: PeriodoFornecedor[] = [];
  for (const l of ordenadas) {
    const ult = out[out.length - 1];
    if (ult && ult.fornecedor_nome === l.fornecedor_nome && addDias(ult.ate, 1) === l.data) {
      ult.ate = l.data;
      ult.dias += 1;
      if (!ult.motivo && l.motivo) ult.motivo = l.motivo;
    } else {
      out.push({ fornecedor_nome: l.fornecedor_nome, de: l.data, ate: l.data, dias: 1, motivo: l.motivo });
    }
  }
  return out;
}

/** Todas as datas de [de, ate] (inclusive). Lança se invertido ou maior que `max`. */
export function datasDoPeriodo(de: string, ate: string, max = 62): string[] {
  if (ate < de) throw new RangeError('O fim do período é anterior ao início.');
  const out: string[] = [];
  for (let d = de; d <= ate; d = addDias(d, 1)) {
    out.push(d);
    if (out.length > max) throw new RangeError(`Período maior que ${max} dias.`);
  }
  return out;
}

/**
 * Último dia FECHADO do recesso de fim de ano da empresa: o maior `fechado` entre 15/12 e 15/01 da
 * janela que vem. `null` = não há recesso cadastrado (a tela diz isso — não inventa uma data).
 */
export function fimDoRecesso(linhas: { data: string; status: string }[], hoje: string): string | null {
  const ano = Number(hoje.slice(0, 4));
  const base = hoje.slice(5, 10) <= '01-15' ? ano - 1 : ano;
  const de = `${base}-12-15`;
  const ate = `${base + 1}-01-15`;
  let fim: string | null = null;
  for (const l of linhas) {
    if (l.status === 'fechado' && l.data >= de && l.data <= ate && (fim === null || l.data > fim)) fim = l.data;
  }
  return fim;
}

/**
 * "recebe em DD/MM" na lista de pedidos — SÓ quando a edge ajustou a chegada pelo calendário
 * (`recebimento_ajustado_calendario === true`) e há data. Qualquer outro caso: `null` (nada muda).
 */
export function rotuloRecebeEm(p: {
  recebimento_ajustado_calendario?: boolean | null;
  data_recebimento_prevista?: string | null;
}): string | null {
  if (p.recebimento_ajustado_calendario !== true || !p.data_recebimento_prevista) return null;
  const d = p.data_recebimento_prevista;
  return `recebe em ${d.slice(8, 10)}/${d.slice(5, 7)}`;
}
