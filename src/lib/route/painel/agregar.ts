// src/lib/route/painel/agregar.ts
import type { SnapshotRow, ContatoRow, PainelAgregado, GrupoEficacia } from './types';
import { taxaComGating } from './gating';

const key = (d: string, f: string | null, c: string | null) => `${d}|${f ?? ''}|${c ?? ''}`;
const num = (x: number | null | undefined) => (typeof x === 'number' && isFinite(x) ? x : 0);

function grupo(chave: string, contatos: ContatoRow[]): GrupoEficacia {
  const n = contatos.length;
  const convertido = contatos.filter((c) => c.status === 'convertido').length;
  const atendido = contatos.filter((c) => c.status === 'respondido' || c.status === 'convertido').length;
  const optout = contatos.filter((c) => c.status === 'opt_out').length;
  const valor_capturado = contatos.filter((c) => c.status === 'convertido').reduce((s, c) => s + num(c.valor_da_ligacao), 0);
  return {
    chave, contatos: n,
    resposta: taxaComGating(atendido, n),
    conversao: taxaComGating(convertido, n),
    optout: taxaComGating(optout, n),
    valor_capturado,
  };
}

function agrupar(contatos: ContatoRow[], chaveDe: (c: ContatoRow) => string): GrupoEficacia[] {
  const m = new Map<string, ContatoRow[]>();
  for (const c of contatos) {
    const k = chaveDe(c);
    const arr = m.get(k); if (arr) arr.push(c); else m.set(k, [c]);
  }
  return [...m.entries()].map(([k, cs]) => grupo(k, cs));
}

export function agregarPainel(snapshots: SnapshotRow[], contatos: ContatoRow[]): PainelAgregado {
  // índice de elegíveis (snapshot) por chave
  const snapByKey = new Map<string, SnapshotRow>();
  for (const s of snapshots) snapByKey.set(key(s.data_rota, s.farmer_id, s.customer_user_id), s);

  // contatos de ligação que casam com um snapshot → "contatados"
  const ligacoes = contatos.filter((c) => c.canal === 'ligacao');
  const contatadasKeys = new Set<string>();
  for (const c of ligacoes) {
    const k = key(c.data_rota, c.farmer_id, c.customer_user_id);
    if (snapByKey.has(k)) contatadasKeys.add(k);
  }

  const elegiveis_n = snapshots.length;
  const contatados_n = contatadasKeys.size;
  const elegiveis_valor = snapshots.reduce((s, e) => s + num(e.valor_da_ligacao), 0);
  const contatados_valor = snapshots
    .filter((e) => contatadasKeys.has(key(e.data_rota, e.farmer_id, e.customer_user_id)))
    .reduce((s, e) => s + num(e.valor_da_ligacao), 0);
  const gap_valor = elegiveis_valor - contatados_valor;

  // dias com snapshot (denominador disponível) vs dias com contato-de-ligação sem snapshot
  const diasComSnapshot = new Set(snapshots.map((s) => s.data_rota));
  const diasContatoLigacao = new Set(ligacoes.map((c) => c.data_rota));
  const dias_sem_denominador = [...diasContatoLigacao].filter((d) => !diasComSnapshot.has(d)).length;

  // capacidade: contatos de ligação por dia (sobre dias COM dado de contato)
  const contatos_total = ligacoes.length;
  const dias_com_dado = diasContatoLigacao.size;
  const contatos_por_dia = dias_com_dado > 0 ? contatos_total / dias_com_dado : 0;

  return {
    elegiveis_n,
    contatados_n,
    cobertura_count: taxaComGating(contatados_n, elegiveis_n, 1), // cobertura: min=1 (sempre exibe se há fila)
    elegiveis_valor,
    contatados_valor,
    gap_valor,
    contatos_total,
    dias_com_dado,
    contatos_por_dia,
    dias_sem_denominador,
    global: grupo('global', ligacoes),
    por_vendedora: agrupar(contatos, (c) => c.farmer_id ?? '—'),  // TODOS os canais (test: r+t)
    por_bucket: agrupar(ligacoes, (c) => c.bucket ?? '—'),
    por_canal: agrupar(contatos, (c) => c.canal),  // TODOS os canais
  };
}
