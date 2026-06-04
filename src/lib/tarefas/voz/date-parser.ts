// src/lib/tarefas/voz/date-parser.ts
import type { ResultadoData } from './types';

const DIAS_SEMANA: Record<string, number> = {
  domingo: 0, dom: 0,
  segunda: 1, seg: 1,
  terca: 2, ter: 2,
  quarta: 3, qua: 3,
  quinta: 4, qui: 4,
  sexta: 5, sex: 5,
  sabado: 6, sab: 6,
};

function normaliza(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
function pad(n: number): string { return String(n).padStart(2, '0'); }
function ymd(y: number, m: number, d: number): string { return `${y}-${pad(m)}-${pad(d)}`; }
function parse(s: string): [number, number, number] {
  const [y, m, d] = s.split('-').map(Number);
  return [y, m, d];
}
/** Soma `dias` a uma data yyyy-mm-dd usando aritmética UTC (sem fuso — é data de calendário). */
function addDias(hoje: string, dias: number): string {
  const [y, m, d] = parse(hoje);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function diaDaSemana(hoje: string): number {
  const [y, m, d] = parse(hoje);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function ultimoDiaDoMes(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // dia 0 do mês seguinte = último deste
}

export function resolverDataPtBr(rawDateText: string | null, hojeSP: string): ResultadoData {
  if (!rawDateText || !rawDateText.trim()) {
    return { modo: 'interacao', due_date: null, interacao_tipo: 'ligacao', status: 'sem_data' };
  }
  const t = normaliza(rawDateText);

  const comData = (due: string): ResultadoData => ({
    modo: 'data', due_date: due, interacao_tipo: null,
    status: due < hojeSP ? 'passado' : 'resolvida',
  });
  const ambigua: ResultadoData = { modo: 'data', due_date: null, interacao_tipo: null, status: 'ambigua' };

  if (/\bhoje\b/.test(t)) return comData(hojeSP);
  if (/\bdepois de amanha\b/.test(t)) return comData(addDias(hojeSP, 2));
  if (/\bamanha\b/.test(t)) return comData(addDias(hojeSP, 1));

  for (const [nome, alvo] of Object.entries(DIAS_SEMANA)) {
    if (new RegExp(`\\b${nome}(\\b|-feira)`).test(t)) {
      const delta = (alvo - diaDaSemana(hojeSP) + 7) % 7;          // hoje conta (0 se for hoje)
      const queVem = /que vem|proxima|semana que vem/.test(t);
      return comData(addDias(hojeSP, queVem ? delta + 7 : delta));
    }
  }

  const mDia = t.match(/\bdia (\d{1,2})\b/);
  if (mDia) {
    const n = Number(mDia[1]);
    if (n >= 1 && n <= 31) {
      const [y, m, d] = parse(hojeSP);
      let ty = y, tm = m;
      if (n < d) { tm = m === 12 ? 1 : m + 1; ty = m === 12 ? y + 1 : y; }
      const dia = Math.min(n, ultimoDiaDoMes(ty, tm)); // clamp (ex.: dia 31 em mês de 30)
      return comData(ymd(ty, tm, dia));
    }
  }

  if (/fim do mes|final do mes/.test(t)) {
    const [y, m] = parse(hojeSP);
    return comData(ymd(y, m, ultimoDiaDoMes(y, m)));
  }

  if (/semana que vem|mes que vem|proxima semana|proximo mes/.test(t)) return ambigua;

  return { modo: 'data', due_date: null, interacao_tipo: null, status: 'nao_resolvida' };
}
