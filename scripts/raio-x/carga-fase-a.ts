// Carga das decisões da fase A (Artifact externo) na tabela raio_x_decisao (Task 14 do plano 2026-10-16).
// MONEY-PATH: precisão > recall; ausente != zero. Qualquer dado faltando/inválido ABORTA (exit 1,
// stdout vazio) — nunca vira 0 nem foto nula.
//
// Uso: bun scripts/raio-x/carga-fase-a.ts --decisoes <decisoes.json> --retrato <retrato.json> --uid <auth.uid> > carga.sql
//   stdout = SQL (begin … commit; última linha `-- CARGA-FASE-A-OK`)
//   stderr = tabela legível (SKU, código, destino, saldo, cmc, valor, decidido_em + totais por destino)
//            para aprovação humana ANTES de aplicar.
import { readFileSync } from 'node:fs';

export const DESTINOS = [
  'trocar',
  'venda_dirigida',
  'liquidar',
  'manter_suspender_recompra',
  'estrategico',
  'erro_cadastro',
] as const;

export class CargaAbortada extends Error {
  constructor(
    public readonly marca: string,
    detalhe: string,
  ) {
    super(`${marca}: ${detalhe}`);
    this.name = 'CargaAbortada';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown, marca: string, ctx: string, positivo = false): number {
  // typeof estrito: null/undefined/string nunca viram 0.
  if (typeof v !== 'number' || !Number.isFinite(v) || (positivo && v <= 0)) {
    throw new CargaAbortada(marca, `${ctx}: valor ${JSON.stringify(v)} inválido`);
  }
  return v;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function dataValida(s: string): boolean {
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

export interface Carga {
  sql: string;
  tabela: string;
}

export function gerarCarga(decisoes: unknown, retrato: unknown, uid: string): Carga {
  if (!UUID_RE.test(uid)) throw new CargaAbortada('UID_INVALIDO', `--uid ${JSON.stringify(uid)} não é UUID`);
  if (!Array.isArray(decisoes) || decisoes.length === 0) {
    throw new CargaAbortada('DECISOES_VAZIA', 'lista de decisões vazia ou não é array');
  }
  if (!ehObj(retrato) || !ehObj(retrato.meta) || !Array.isArray(retrato.itens)) {
    throw new CargaAbortada('RETRATO_INVALIDO', 'esperado { meta, itens[] }');
  }
  const hoje = retrato.meta.hoje;
  if (typeof hoje !== 'string' || !DIA_RE.test(hoje) || !dataValida(hoje)) {
    throw new CargaAbortada('HOJE_INVALIDO', `meta.hoje ${JSON.stringify(hoje)} inválido`);
  }

  const porSku = new Map<number, Obj>();
  for (const it of retrato.itens) {
    if (ehObj(it) && typeof it.sku === 'number') porSku.set(it.sku, it);
  }

  const vistos = new Set<number>();
  const linhas: { tupla: string; sku: number; codigo: string; destino: string; saldo: number; cmc: number; valor: number; em: string }[] = [];

  for (const d of decisoes) {
    if (!ehObj(d)) throw new CargaAbortada('DECISAO_INVALIDA', 'item não é objeto');
    const idTxt = typeof d.id === 'string' ? d.id : String(d.id);
    if (!/^[1-9]\d*$/.test(idTxt) || !Number.isSafeInteger(Number(idTxt))) {
      throw new CargaAbortada('SKU_INVALIDO', `id ${JSON.stringify(d.id)} não é inteiro positivo`);
    }
    const sku = Number(idTxt);
    if (vistos.has(sku)) throw new CargaAbortada('SKU_DUPLICADO', `SKU ${sku} repetido nas decisões`);
    vistos.add(sku);

    if (typeof d.destino !== 'string' || !(DESTINOS as readonly string[]).includes(d.destino)) {
      throw new CargaAbortada('DESTINO_INVALIDO', `SKU ${sku}: destino ${JSON.stringify(d.destino)} fora dos 6 permitidos`);
    }
    if (typeof d.decidido_em !== 'string' || !ISO_RE.test(d.decidido_em) || !dataValida(d.decidido_em)) {
      throw new CargaAbortada('DATA_INVALIDA', `SKU ${sku}: decidido_em ${JSON.stringify(d.decidido_em)} inválido`);
    }

    const item = porSku.get(sku);
    if (!item) throw new CargaAbortada('SKU_AUSENTE', `SKU ${sku} não existe no retrato`);
    const ctx = `SKU ${sku}`;
    const saldo = num(item.saldo, 'SALDO_INVALIDO', ctx);
    const cmc = num(item.cmc, 'CMC_INVALIDO', ctx, true);
    const valor = num(item.valor, 'VALOR_INVALIDO', ctx);
    const categoria = typeof item.categoria === 'string' ? lit(item.categoria) : 'null';
    const codigo = typeof item.codigo === 'string' ? item.codigo : '';

    const tupla =
      `  ('oben', ${sku}, ${lit(d.destino)}, ${lit(uid)}, ${lit(d.decidido_em)}::timestamptz, ` +
      `${saldo}, ${cmc}, ${valor}, ${categoria}, ${lit(`${hoje} 00:00 America/Sao_Paulo`)}::timestamptz, 'artifact_fase_a', false)`;
    linhas.push({ tupla, sku, codigo, destino: d.destino, saldo, cmc, valor, em: d.decidido_em });
  }

  const n = linhas.length;
  const sql = [
    'begin;',
    'insert into raio_x_decisao (empresa, sku_codigo_omie, destino, decidido_por, decidido_em, foto_saldo, foto_cmc, foto_valor, foto_categoria, foto_em, origem, tirou_do_motor) values',
    linhas.map((l) => l.tupla).join(',\n'),
    'on conflict do nothing;',
    'do $$',
    'declare v_n bigint;',
    'begin',
    "  select count(*) into v_n from raio_x_decisao where origem = 'artifact_fase_a';",
    `  if v_n <> ${n} then`,
    `    raise exception 'CARGA-FASE-A: esperado ${n} linhas com origem artifact_fase_a, achei %', v_n;`,
    '  end if;',
    'end $$;',
    'commit;',
    '-- CARGA-FASE-A-OK',
    '',
  ].join('\n');

  const brl = (v: number) => v.toFixed(2);
  const rows = linhas.map((l) =>
    [String(l.sku), l.codigo, l.destino, String(l.saldo), brl(l.cmc), brl(l.valor), l.em],
  );
  const cab = ['SKU', 'CODIGO', 'DESTINO', 'SALDO', 'CMC', 'VALOR', 'DECIDIDO_EM'];
  const larg = cab.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(larg[i])).join('  ').trimEnd();
  const tot = new Map<string, { n: number; valor: number }>();
  for (const l of linhas) {
    const t = tot.get(l.destino) ?? { n: 0, valor: 0 };
    t.n += 1;
    t.valor += l.valor;
    tot.set(l.destino, t);
  }
  const totais = [...tot.entries()].map(([dst, t]) => `TOTAL ${dst}: ${t.n} SKU(s), R$ ${brl(t.valor)}`);
  const geral = `TOTAL geral: ${n} SKU(s), R$ ${brl(linhas.reduce((s, l) => s + l.valor, 0))} (foto de ${hoje})`;
  const tabela = [fmt(cab), ...rows.map(fmt), '', ...totais, geral, ''].join('\n');

  return { sql, tabela };
}

function arg(args: string[], nome: string): string {
  const i = args.indexOf(nome);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (!v || v.startsWith('--')) throw new CargaAbortada('USO', `faltou ${nome}`);
  return v;
}

function lerJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new CargaAbortada('ENTRADA_ILEGIVEL', `${path}: ${(e as Error).message}`);
  }
}

function main(args: string[]): number {
  try {
    const decisoes = lerJson(arg(args, '--decisoes'));
    const retrato = lerJson(arg(args, '--retrato'));
    const { sql, tabela } = gerarCarga(decisoes, retrato, arg(args, '--uid'));
    process.stderr.write(tabela);
    process.stdout.write(sql);
    return 0;
  } catch (e) {
    process.stderr.write(`ABORTADO ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1]?.endsWith('carga-fase-a.ts')) process.exitCode = main(process.argv.slice(2));
