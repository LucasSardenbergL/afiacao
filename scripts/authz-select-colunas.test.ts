import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { AUTHZ_TABELAS_FECHADAS } from './authz-tabelas-fechadas';

/**
 * Incidente 2026-11-21 (Meu dia do CEO, PR #4025): `fetch-pedidos-mtd` e `fetch-pedidos-sem-nota`
 * pediam `sales_orders.vendedor_user_id` no `.select()` do PostgREST. A tabela é fechada POR COLUNA
 * para `authenticated` e essa coluna não tem GRANT → 403 na leitura INTEIRA, os 3 tiles do placar
 * "indisponível" em prod. Os testes da leitura passavam porque mockam o supabase — nenhum deles
 * conhece o ACL.
 *
 * Esta checagem liga o front ao CONTRATO de authz: toda cadeia `.from('<tabela fechada por coluna>')`
 * … `.select('<literal>')` em `src/` só pode pedir colunas que o contrato deixa `authenticated` ler.
 * Coluna fechada → pela RPC (ex.: `pedidos_vendedor`), nunca por GRANT novo.
 */

type Achado = { arquivo: string; linha: number; tabela: string; colunas: string[] };

/** Tabelas fechadas por coluna para SELECT de authenticated → as colunas liberadas. */
function tabelasPorColuna(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [nome, t] of Object.entries(AUTHZ_TABELAS_FECHADAS)) {
    const sel = t.colunasPermitidas?.authenticated?.SELECT;
    if (!sel || t.permitido.authenticated.includes('SELECT')) continue;
    out.set(nome.replace(/^public\./, ''), new Set(sel));
  }
  return out;
}

/** Colunas de 1º nível de um select do PostgREST: tira embeds `rel(...)`, alias `a:b` e cast `::t`. */
export function colunasDoSelect(sel: string): string[] {
  let s = sel;
  // embeds podem aninhar: remove o parêntese mais interno até não sobrar nenhum.
  while (/\([^()]*\)/.test(s)) s = s.replace(/[\w!:.]*\([^()]*\)/g, '');
  return s
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => c.split('::')[0].split(':').pop()!.trim());
}

/** Apaga comentários (`//` de linha e `/* *\/`) preservando as quebras — doc com exemplo não é código. */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (c, pre: string) => pre + ' '.repeat(c.length - pre.length));
}

export function colunasForaDoContrato(
  arquivo: string,
  fonteCrua: string,
  contrato: Map<string, Set<string>>,
): Achado[] {
  const fonte = semComentarios(fonteCrua);
  const achados: Achado[] = [];
  const re = /\.from\(\s*['"](\w+)['"]\s*\)([\s\S]{0,400}?)\.select\(\s*(['"`])([\s\S]*?)\3/g;
  for (const m of fonte.matchAll(re)) {
    const [, tabela, entre, , sel] = m;
    const liberadas = contrato.get(tabela);
    if (!liberadas || entre.includes('.from(')) continue;
    if (sel.includes('${')) continue; // template dinâmico: fora do alcance estático
    const fora = colunasDoSelect(sel).filter((c) => !liberadas.has(c));
    if (fora.length) {
      achados.push({ arquivo, linha: fonte.slice(0, m.index).split('\n').length, tabela, colunas: fora });
    }
  }
  return achados;
}

/**
 * Exceções CONHECIDAS, com dono. Cada uma é um 403 em prod esperando conserto — não um "pode".
 * Vazia: a última (checkout lendo `omie_response`, #2932) passou a ler pela RPC
 * pedido_por_checkout (migration 20261121160000). Entrada nova aqui exige o 403 medido e o dono.
 */
const CONHECIDOS = new Set<string>();

describe('authz: select do front × colunas fechadas', () => {
  const contrato = tabelasPorColuna();

  it('o contrato tem sales_orders fechada por coluna (senão a checagem não vê nada)', () => {
    expect(contrato.get('sales_orders')?.has('id')).toBe(true);
    expect(contrato.get('sales_orders')?.has('vendedor_user_id')).toBe(false);
  });

  it('[INCIDENTE] o select do #4025 é pego (vendedor_user_id) — e o de hoje passa', () => {
    const antigo = `supabase\n  .from('sales_orders')\n  .select('total, status, customer_user_id, order_date_kpi, vendedor_user_id')`;
    expect(colunasForaDoContrato('x.ts', antigo, contrato)).toEqual([
      { arquivo: 'x.ts', linha: 2, tabela: 'sales_orders', colunas: ['vendedor_user_id'] },
    ]);
    const novo = `supabase.from('sales_orders').select('id, total, status, customer_user_id, order_date_kpi')`;
    expect(colunasForaDoContrato('x.ts', novo, contrato)).toEqual([]);
  });

  it('comentário com exemplo de select não conta', () => {
    const doc = `/** ex.: .from('sales_orders').select('vendedor_user_id') */\n// .from('sales_orders').select('omie_payload')\nx`;
    expect(colunasForaDoContrato('x.ts', doc, contrato)).toEqual([]);
  });

  it('embed, alias e cast não viram coluna falsa', () => {
    expect(colunasDoSelect('id, cliente:customer_user_id, total::text, order_items(desconto_valor, p:produtos(nome))')).toEqual([
      'id', 'customer_user_id', 'total',
    ]);
  });

  it('nenhum select de src/ pede coluna fechada (fora das exceções conhecidas)', () => {
    const arquivos = (readdirSync('src', { recursive: true }) as string[])
      .map((f) => `src/${f.split('\\').join('/')}`)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes('__tests__') && !f.endsWith('integrations/supabase/types.ts'));
    expect(arquivos.length).toBeGreaterThan(100);
    const achados = arquivos.flatMap((f) => colunasForaDoContrato(f, readFileSync(f, 'utf8'), contrato));
    const novos = achados.flatMap((a) =>
      a.colunas
        .filter((c) => !CONHECIDOS.has(`${a.arquivo}:${a.tabela}:${c}`))
        .map((c) => `${a.arquivo}:${a.linha} pede ${a.tabela}.${c} (fechada para authenticated — leia por RPC)`),
    );
    expect(novos).toEqual([]);
    // exceção consertada → tire-a daqui (a lista não pode virar cemitério).
    const vivos = new Set(achados.flatMap((a) => a.colunas.map((c) => `${a.arquivo}:${a.tabela}:${c}`)));
    expect([...CONHECIDOS].filter((k) => !vivos.has(k))).toEqual([]);
  });
});
