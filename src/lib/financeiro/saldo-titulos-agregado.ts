// Leitura do envelope da RPC `fin_saldo_titulos_por_status` (plano v4, lote 13 — C6) e composição
// dos totais de CR/CP abertos e vencidos por empresa, em CENTAVOS inteiros.
//
// A RPC soma `saldo` no banco (numeric exato) agrupado por (tabela, empresa, status) e devolve a
// soma como STRING decimal: número JSON → `Number` perde centavo em valores grandes (contraexemplo
// na prova db/test-fin-saldo-titulos-por-status.sh). Aqui a soma dos grupos é em BigInt de centavos
// e só vira `number` no fim, se couber exato.
//
// Ausente ≠ zero: qualquer coisa que não seja o envelope da versão 1 LANÇA (o supabase-js converte
// 404 com corpo `[]` em {data: [], error: null}); empresa pedida que não veio `ok` (sem_acesso /
// desconhecida / ausente) LANÇA; grupo com saldo NULL LANÇA. Grupo AUSENTE numa empresa `ok` é o
// único zero legítimo — "nenhum título nesses status".

export type TabelaTitulos = 'receber' | 'pagar';

export interface SaldoTitulosEmpresa {
  total_a_receber: number;
  total_a_pagar: number;
  total_vencido_receber: number;
  total_vencido_pagar: number;
}

interface GrupoSaldo {
  tabela: TabelaTitulos;
  company: string;
  status_titulo: string;
  n_saldo_nulo: number;
  centavos: bigint | null;
}

const DECIMAL = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/** "1234.5" → 123450n. Recusa o que não for decimal com até 2 casas (nunca arredonda). */
export function decimalParaCentavos(s: string): bigint {
  const m = DECIMAL.exec(s);
  if (!m) throw new Error(`saldo fora do formato decimal: ${JSON.stringify(s)}`);
  const cent = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cent : cent;
}

/**
 * Centavos → reais em `number`, só se o centavo sobreviver à conversão. `isSafeInteger` não basta:
 * 9007199254740990n passa, mas `/ 100` exibe ",91" em vez de ",90" (parecer Codex) — então o
 * resultado precisa formatar com 2 casas EXATAMENTE como o decimal de origem.
 */
export function centavosParaReais(c: bigint): number {
  const n = Number(c);
  const reais = n / 100;
  const abs = c < 0n ? -c : c;
  const exato = `${c < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  if (!Number.isSafeInteger(n) || reais.toFixed(2) !== exato) {
    throw new Error(`soma fora da faixa exata de number: ${c} centavos`);
  }
  return reais;
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lerGrupo(g: unknown, i: number): GrupoSaldo {
  if (!ehObjeto(g)) throw new Error(`grupo ${i} não é objeto`);
  const { tabela, company, status_titulo, n_titulos, n_saldo_nulo, saldo } = g;
  if (tabela !== 'receber' && tabela !== 'pagar') throw new Error(`grupo ${i}: tabela inválida`);
  if (typeof company !== 'string' || typeof status_titulo !== 'string') throw new Error(`grupo ${i}: chave inválida`);
  if (typeof n_titulos !== 'number' || typeof n_saldo_nulo !== 'number'
      || !Number.isSafeInteger(n_titulos) || !Number.isSafeInteger(n_saldo_nulo)) {
    throw new Error(`grupo ${i}: contagem inválida`);
  }
  if (saldo === null) {
    // sum() de só-NULL: legítimo apenas quando TODO título do grupo tem saldo NULL.
    if (n_saldo_nulo !== n_titulos) throw new Error(`grupo ${i}: saldo null com título de saldo conhecido`);
    return { tabela, company, status_titulo, n_saldo_nulo, centavos: null };
  }
  if (typeof saldo !== 'string') throw new Error(`grupo ${i}: saldo não é string decimal`);
  return { tabela, company, status_titulo, n_saldo_nulo, centavos: decimalParaCentavos(saldo) };
}

/**
 * Compõe os 4 totais de cada empresa pedida a partir do envelope. `abertos` e `vencidos` são os
 * conjuntos de status do TS (OPEN_TITLE_STATUSES / VENCIDO_TITLE_STATUSES) — a RPC foi chamada com
 * `abertos`, e `vencidos` tem de estar contido nele.
 */
export function comporSaldoTitulos(
  envelope: unknown,
  companies: readonly string[],
  abertos: readonly string[],
  vencidos: readonly string[],
): Record<string, SaldoTitulosEmpresa> {
  for (const s of vencidos) {
    if (!abertos.includes(s)) throw new Error(`status vencido "${s}" fora do conjunto pedido à RPC`);
  }
  if (!ehObjeto(envelope) || envelope.versao !== 1 || !Array.isArray(envelope.empresas) || !Array.isArray(envelope.grupos)) {
    throw new Error('resposta da RPC fora do envelope versão 1');
  }
  const estados = new Map<string, unknown>();
  for (const e of envelope.empresas) {
    if (!ehObjeto(e) || typeof e.company !== 'string') throw new Error('empresa do envelope inválida');
    estados.set(e.company, e.estado);
  }
  for (const co of companies) {
    const estado = estados.get(co);
    if (estado !== 'ok') {
      throw new Error(`saldo de títulos indisponível (${co}): ${typeof estado === 'string' ? estado : 'ausente da resposta'}`);
    }
  }

  const grupos = envelope.grupos.map(lerGrupo);
  const somar = (tabela: TabelaTitulos, co: string, statuses: readonly string[]): number => {
    let total = 0n;
    for (const g of grupos) {
      if (g.tabela !== tabela || g.company !== co || !statuses.includes(g.status_titulo)) continue;
      if (g.n_saldo_nulo > 0 || g.centavos === null) {
        throw new Error(`saldo de títulos indisponível (${co}): ${g.n_saldo_nulo} título(s) de ${tabela} sem saldo em ${g.status_titulo}`);
      }
      total += g.centavos;
    }
    return centavosParaReais(total);
  };

  const out: Record<string, SaldoTitulosEmpresa> = {};
  for (const co of companies) {
    out[co] = {
      total_a_receber: somar('receber', co, abertos),
      total_a_pagar: somar('pagar', co, abertos),
      total_vencido_receber: somar('receber', co, vencidos),
      total_vencido_pagar: somar('pagar', co, vencidos),
    };
  }
  return out;
}
