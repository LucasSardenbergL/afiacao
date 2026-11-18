/**
 * Pendências do calendário de operação — PURO (sem supabase, sem relógio: `hoje` entra pela porta).
 *
 * Quatro tipos, cada um com uma decisão humana atrás:
 *  - `emenda_sem_decisao`  feriado em terça/quinta cujo dia-ponte (segunda antes / sexta depois)
 *                          NÃO tem linha na tabela da empresa. Todas aparecem; `urgente` se o dia-ponte
 *                          está a ≤ 90 dias.
 *  - `dia_sem_nf`          cada data devolvida por `calendario_dias_sem_nf` (dia útil passado, sem linha
 *                          e sem NF) E cada linha `pendente_dado` que ainda não foi decidida na tela
 *                          (origem ≠ 'manual' — a carga histórica traz 7 dessas, e a RPC não as devolve
 *                          porque elas JÁ têm linha).
 *  - `calendario_curto`    último dia cadastrado < hoje + 12 meses (ou nenhum cadastrado).
 *  - `fornecedor_sem_recesso` fornecedor habilitado sem NENHUM dia fechado entre 21/12 e 03/01 do próximo
 *                          fim de ano — pega quem foi habilitado depois da carga.
 */
import { addDias } from '@/lib/time/sp-day';

export type TipoPendencia =
  | 'emenda_sem_decisao'
  | 'dia_sem_nf'
  | 'calendario_curto'
  | 'fornecedor_sem_recesso';

export type Pendencia = {
  tipo: TipoPendencia;
  /** a data sobre a qual se decide (dia-ponte, dia sem NF, último dia, início da janela de fim de ano) */
  data: string;
  urgente: boolean;
  texto: string;
  /** só em `fornecedor_sem_recesso` */
  fornecedor_nome?: string;
};

export type EntradaPendencias = {
  hoje: string;
  feriados: { data: string; nome: string }[];
  diasEmpresa: { data: string; status: string; origem: string }[];
  diasSemNf: string[];
  ultimoDiaCadastrado: string | null;
  fornecedoresHabilitados?: string[];
  fechamentosFornecedor?: { data: string; fornecedor_nome: string }[];
};

export const DIAS_URGENCIA_EMENDA = 90;
export const DIAS_URGENCIA_RECESSO_FORNECEDOR = 90;

/** 1 = segunda … 7 = domingo (ISO), em UTC puro — a data é de calendário, sem fuso. */
export function diaDaSemanaIso(iso: string): number {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Diferença em dias de calendário `b − a`. */
export function diasEntre(a: string, b: string): number {
  const ms = Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Mesma data, `n` meses à frente (dia 29–31 cai no último dia do mês de destino). */
export function addMeses(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const alvo = new Date(Date.UTC(y, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  const dia = Math.min(d, ultimo);
  return `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * A janela de fim de ano "que vem": 21/12 do ano corrente a 03/01 do seguinte. Se hoje já está
 * dentro dos primeiros dias de janeiro (≤ 03/01), a janela vigente é a que começou em dezembro passado.
 */
export function janelaFimDeAno(hoje: string): { de: string; ate: string } {
  const ano = Number(hoje.slice(0, 4));
  const base = hoje.slice(5, 10) <= '01-03' ? ano - 1 : ano;
  return { de: `${base}-12-21`, ate: `${base + 1}-01-03` };
}

const fmtBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function calcularPendencias(e: EntradaPendencias): Pendencia[] {
  const out: Pendencia[] = [];
  const comLinha = new Set(e.diasEmpresa.map((d) => d.data));
  const feriadoEm = new Set(e.feriados.map((f) => f.data));

  // (a) emendas
  for (const f of e.feriados) {
    const dow = diaDaSemanaIso(f.data);
    if (dow !== 2 && dow !== 4) continue;
    const ponte = dow === 2 ? addDias(f.data, -1) : addDias(f.data, 1);
    if (ponte < e.hoje) continue; // decisão passada não é mais decisão
    if (comLinha.has(ponte) || feriadoEm.has(ponte)) continue;
    const falta = diasEntre(e.hoje, ponte);
    out.push({
      tipo: 'emenda_sem_decisao',
      data: ponte,
      urgente: falta <= DIAS_URGENCIA_EMENDA,
      texto:
        `${f.nome} (${fmtBr(f.data)}, ${dow === 2 ? 'terça' : 'quinta'}): ` +
        `decidir se ${dow === 2 ? 'a segunda' : 'a sexta'} ${fmtBr(ponte)} é emenda — faltam ${falta} dia(s).`,
    });
  }

  // (b) dia sem NF — da RPC (sem linha) e das linhas pendente_dado ainda não decididas na tela
  const vistos = new Set<string>();
  for (const d of e.diasSemNf) {
    if (vistos.has(d)) continue;
    vistos.add(d);
    out.push({
      tipo: 'dia_sem_nf',
      data: d,
      urgente: false,
      texto: `${fmtBr(d)}: dia útil sem nenhuma NF emitida — a empresa estava fechada ou o dado está faltando?`,
    });
  }
  for (const d of e.diasEmpresa) {
    if (d.status !== 'pendente_dado' || d.origem === 'manual' || vistos.has(d.data)) continue;
    vistos.add(d.data);
    out.push({
      tipo: 'dia_sem_nf',
      data: d.data,
      urgente: false,
      texto: `${fmtBr(d.data)}: marcado como pendente de dado — confirme se a empresa estava fechada ou aberta.`,
    });
  }

  // (c) calendário curto
  const limite = addMeses(e.hoje, 12);
  if (e.ultimoDiaCadastrado === null || e.ultimoDiaCadastrado < limite) {
    out.push({
      tipo: 'calendario_curto',
      data: e.ultimoDiaCadastrado ?? e.hoje,
      urgente: e.ultimoDiaCadastrado === null || e.ultimoDiaCadastrado < addMeses(e.hoje, 3),
      texto:
        e.ultimoDiaCadastrado === null
          ? 'Nenhum dia cadastrado para esta empresa: o calendário não cobre o futuro.'
          : `O calendário só vai até ${fmtBr(e.ultimoDiaCadastrado)} — menos de 12 meses à frente (até ${fmtBr(limite)}).`,
    });
  }

  // (d) fornecedor habilitado sem recesso no próximo fim de ano
  if (e.fornecedoresHabilitados && e.fechamentosFornecedor) {
    const jan = janelaFimDeAno(e.hoje);
    const comRecesso = new Set(
      e.fechamentosFornecedor
        .filter((x) => x.data >= jan.de && x.data <= jan.ate)
        .map((x) => x.fornecedor_nome),
    );
    const falta = diasEntre(e.hoje, jan.de);
    for (const nome of [...new Set(e.fornecedoresHabilitados)].sort()) {
      if (comRecesso.has(nome)) continue;
      out.push({
        tipo: 'fornecedor_sem_recesso',
        data: jan.de,
        urgente: falta <= DIAS_URGENCIA_RECESSO_FORNECEDOR,
        fornecedor_nome: nome,
        texto: `${nome}: nenhum dia fechado entre ${fmtBr(jan.de)} e ${fmtBr(jan.ate)} — confirme o recesso com o fornecedor.`,
      });
    }
  }

  return out.sort((a, b) => Number(b.urgente) - Number(a.urgente) || a.data.localeCompare(b.data));
}
