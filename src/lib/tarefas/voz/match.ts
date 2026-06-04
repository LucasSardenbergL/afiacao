// src/lib/tarefas/voz/match.ts
import type { ClienteCandidato, MatchCliente, MatchVendedora, VendedoraOpcao } from './types';

export function normalizarNome(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STEM = 3; // mínimo de chars para stem matching (ex.: 'tati' → 'tat' casa 'tatyana')

/** Score 0..1 entre nome falado e candidato (token-overlap + stem de apelido). */
export function scoreNome(falado: string, candidato: string): number {
  const a = normalizarNome(falado), b = normalizarNome(candidato);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(' '), tb = new Set(b.split(' '));
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  const overlap = inter / ta.length;                              // fração dos tokens falados presentes
  // stem matching: 'tati' casa 'tatyana' porque 'tat'=primeiros 3 chars batem
  const stemOk = ta.some((x) =>
    [...tb].some((y) => {
      if (x.length < STEM || y.length < STEM) return false;
      return y.startsWith(x.slice(0, STEM)) || x.startsWith(y.slice(0, STEM));
    }),
  );
  const prefixo = stemOk ? 0.6 : 0;
  const contido = b.includes(a) || a.includes(b) ? 0.5 : 0;
  return Math.min(1, Math.max(overlap, prefixo, contido));
}

function classificar<T extends { score: number }>(
  ordenados: T[], pisoUnico: number, pisoAmbiguo: number, folga: number,
): 'unico' | 'ambiguo' | 'sem_match' {
  if (ordenados.length === 0 || ordenados[0].score < pisoAmbiguo) return 'sem_match';
  const top = ordenados[0].score;
  const segundo = ordenados[1]?.score ?? 0;
  if (top >= pisoUnico && top - segundo >= folga) return 'unico';
  return 'ambiguo';
}

export function casarVendedora(nomeFalado: string | null, vendedoras: VendedoraOpcao[]): MatchVendedora {
  if (!nomeFalado?.trim()) return { user_id: null, nome: null, status: 'sem_match' };
  const ord = vendedoras.map((v) => ({ ...v, score: scoreNome(nomeFalado, v.nome) }))
    .sort((a, b) => b.score - a.score);
  const status = classificar(ord, 0.5, 0.3, 0.15);
  if (status === 'unico') return { user_id: ord[0].user_id, nome: ord[0].nome, status };
  return { user_id: null, nome: null, status };
}

export function casarCliente(nomeFalado: string | null, candidatos: ClienteCandidato[]): MatchCliente {
  if (!nomeFalado?.trim()) return { customer_user_id: null, nome: null, status: 'sem_match', candidatos };
  const ord = candidatos.map((c) => ({ ...c, score: scoreNome(nomeFalado, c.nome) }))
    .sort((a, b) => b.score - a.score);
  let status = classificar(ord, 0.6, 0.4, 0.4);
  // tarefa exige id resolvido: melhor sem id não pode ser 'unico'
  if (status === 'unico' && !ord[0].customer_user_id) status = 'ambiguo';
  if (status === 'unico') {
    return { customer_user_id: ord[0].customer_user_id, nome: ord[0].nome, status, candidatos: ord };
  }
  return { customer_user_id: null, nome: null, status, candidatos: ord };
}
