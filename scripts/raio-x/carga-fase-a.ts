// Carga das decisões da fase A (Artifact externo) na tabela raio_x_decisao (Task 14 do plano 2026-10-16).
// MONEY-PATH: precisão > recall; ausente != zero. Qualquer dado faltando/inválido ABORTA (exit 1,
// stdout vazio) — nunca vira 0 nem foto nula.
//
// Uso: bun scripts/raio-x/carga-fase-a.ts --decisoes <decisoes.json> --retrato <retrato.json> --uid <auth.uid> --esperado <n> > db/<arquivo>.sql
//   stdout = SQL para o `bun run db:aplicar` (SEM begin/commit/meta-comando psql: a transação e o
//            EXECUTE são do db:aplicar). Última linha `-- CARGA-FASE-A-OK` = guarda de truncamento.
//            Texto vira literal SQL só depois de validado (sem barra invertida nem apóstrofo): o corpo
//            roda dentro de um EXECUTE, então SET LOCAL standard_conforming_strings não ajuda.
//            Datas: decidido_em precisa ser UTC (Z) e fazer round-trip; sem milissegundos no arquivo,
//            emite-se normalizado com `.000Z` (determinístico).
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
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CATEGORIA_RE = /^[\p{L}\p{N} _-]+$/u;
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

// Nada com barra invertida/apóstrofo vira literal: o corpo roda dentro de EXECUTE, onde não dá para
// confiar em standard_conforming_strings. Aborta em vez de escapar.
const lit = (s: string) => {
  if (/[\\']/.test(s)) throw new CargaAbortada('TEXTO_INVALIDO', `texto ${JSON.stringify(s)} contém barra invertida ou apóstrofo`);
  return `'${s}'`;
};

/** Devolve o instante canônico (com ms) se `s` for UTC estrito e fizer round-trip; senão null. */
function instanteCanonico(s: string): string | null {
  if (!ISO_RE.test(s)) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return iso === s || iso.replace('.000Z', 'Z') === s ? iso : null;
}

function diaValido(s: string): boolean {
  if (!DIA_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export interface Carga {
  sql: string;
  tabela: string;
}

export function gerarCarga(decisoes: unknown, retrato: unknown, uid: string, esperado: number): Carga {
  if (!UUID_RE.test(uid)) throw new CargaAbortada('UID_INVALIDO', `--uid ${JSON.stringify(uid)} não é UUID`);
  if (!Array.isArray(decisoes) || decisoes.length === 0) {
    throw new CargaAbortada('DECISOES_VAZIA', 'lista de decisões vazia ou não é array');
  }
  if (!Number.isSafeInteger(esperado) || esperado <= 0 || decisoes.length !== esperado) {
    throw new CargaAbortada('CONTAGEM_DIVERGENTE', `esperado ${esperado} decisões, o arquivo tem ${decisoes.length}`);
  }
  if (!ehObj(retrato) || !ehObj(retrato.meta) || !Array.isArray(retrato.itens)) {
    throw new CargaAbortada('RETRATO_INVALIDO', 'esperado { meta, itens[] }');
  }
  const hoje = retrato.meta.hoje;
  if (typeof hoje !== 'string' || !diaValido(hoje)) {
    throw new CargaAbortada('HOJE_INVALIDO', `meta.hoje ${JSON.stringify(hoje)} inválido`);
  }

  const porSku = new Map<number, Obj>();
  for (const it of retrato.itens) {
    if (ehObj(it) && typeof it.sku === 'number') {
      if (porSku.has(it.sku)) throw new CargaAbortada('RETRATO_SKU_DUPLICADO', `SKU ${it.sku} repetido no retrato`);
      porSku.set(it.sku, it);
    }
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
    const em = typeof d.decidido_em === 'string' ? instanteCanonico(d.decidido_em) : null;
    if (em === null) {
      throw new CargaAbortada('DATA_INVALIDA', `SKU ${sku}: decidido_em ${JSON.stringify(d.decidido_em)} inválido`);
    }

    const item = porSku.get(sku);
    if (!item) throw new CargaAbortada('SKU_AUSENTE', `SKU ${sku} não existe no retrato`);
    const ctx = `SKU ${sku}`;
    const saldo = num(item.saldo, 'SALDO_INVALIDO', ctx);
    const cmc = num(item.cmc, 'CMC_INVALIDO', ctx, true);
    const valor = num(item.valor, 'VALOR_INVALIDO', ctx);
    if (item.categoria != null && (typeof item.categoria !== 'string' || !CATEGORIA_RE.test(item.categoria))) {
      throw new CargaAbortada('TEXTO_INVALIDO', `SKU ${sku}: categoria ${JSON.stringify(item.categoria)} fora de [letras, números, espaço, _ , -]`);
    }
    const categoria = typeof item.categoria === 'string' ? lit(item.categoria) : 'null::text';
    const codigo = typeof item.codigo === 'string' ? item.codigo : '';

    const tupla =
      `  ('oben', ${sku}, ${lit(d.destino)}, ${lit(uid)}::uuid, ${lit(em)}::timestamptz, ` +
      `${saldo}::numeric, ${cmc}::numeric, ${valor}::numeric, ${categoria}, ${lit(`${hoje} 00:00 America/Sao_Paulo`)}::timestamptz, 'artifact_fase_a', false)`;
    linhas.push({ tupla, sku, codigo, destino: d.destino, saldo, cmc, valor, em });
  }

  const n = linhas.length;
  // Tuplas montadas UMA vez; o mesmo texto alimenta o INSERT e a CTE `esperado` da postcondição.
  const valores = linhas.map((l) => l.tupla).join(',\n');
  const sql = [
    '-- Carga das decisões da fase A do Raio-X (Oben). Corpo para o db:aplicar: sem begin/commit.',
    'insert into raio_x_decisao (empresa, sku_codigo_omie, destino, decidido_por, decidido_em, foto_saldo, foto_cmc, foto_valor, foto_categoria, foto_em, origem, tirou_do_motor) values',
    valores,
    'on conflict do nothing;',
    'do $$',
    'declare v_exato bigint; v_total bigint;',
    'begin',
    '  with esperado (empresa, sku, destino, decidido_por, decidido_em, saldo, cmc, valor, categoria, foto_em, origem, tirou) as (values',
    valores,
    '  )',
    '  select count(*) into v_exato',
    '    from raio_x_decisao d join esperado e on d.empresa = e.empresa and d.sku_codigo_omie = e.sku',
    "   where d.empresa = 'oben' and d.origem = 'artifact_fase_a'",
    '     and d.destino is not distinct from e.destino',
    '     and d.decidido_por is not distinct from e.decidido_por',
    '     and d.decidido_em is not distinct from e.decidido_em',
    '     and d.foto_saldo is not distinct from e.saldo',
    '     and d.foto_cmc is not distinct from e.cmc',
    '     and d.foto_valor is not distinct from e.valor',
    '     and d.foto_categoria is not distinct from e.categoria',
    '     and d.foto_em is not distinct from e.foto_em',
    '     and d.tirou_do_motor is not distinct from e.tirou;',
    `  if v_exato is distinct from ${n} then`,
    `    raise exception 'POSTCONDICAO_TUPLAS: esperado ${n} linhas identicas as tuplas da carga, achei %', v_exato;`,
    '  end if;',
    "  select count(*) into v_total from raio_x_decisao where origem = 'artifact_fase_a';",
    `  if v_total is distinct from ${n} then`,
    `    raise exception 'POSTCONDICAO_ORIGEM: esperado ${n} linhas com origem artifact_fase_a (todas as empresas), achei %', v_total;`,
    '  end if;',
    'end $$;',
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
    const esp = arg(args, '--esperado');
    if (!/^[1-9]\d*$/.test(esp)) throw new CargaAbortada('USO', `--esperado ${JSON.stringify(esp)} não é inteiro positivo`);
    const { sql, tabela } = gerarCarga(decisoes, retrato, arg(args, '--uid'), Number(esp));
    process.stderr.write(tabela);
    process.stdout.write(sql);
    return 0;
  } catch (e) {
    process.stderr.write(`ABORTADO ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1]?.endsWith('carga-fase-a.ts')) process.exitCode = main(process.argv.slice(2));
