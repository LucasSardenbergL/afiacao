// Gate do M-48: chamada ao Omie só pelo núcleo `_shared/omie-cliente.ts`.
//
// Cada edge tinha o seu `omieCall`, e cada um errava de um jeito (sem teto de relógio — #2017;
// escrita reenviada em 5xx; status lido antes da faultstring — #1614). #1614/#1623 foram correções
// wrapper a wrapper; o núcleo é o lugar ÚNICO dessas regras, e este gate impede que nasça o 26º.
//
// Duas portas, medidas no fonte SEM comentários:
// 1. declarar um wrapper `omieCall` fora de `_shared/` — zero tolerado (os 7 migraram);
// 2. `fetch(` cujo 1º argumento é o host do Omie (`app.omie.com.br` literal ou constante `OMIE_*`)
//    fora de `_shared/` — só no LEGADO, que só encolhe.
// Limite conhecido: `fetch(url` com a URL vinda de parâmetro não é visto pela porta 2 (é o caso de
// `omie-sync-sku-items/consulta.ts` e `omie-sonda-recebimento`); a porta 1 e a revisão cobrem.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

const RAIZ = resolve(__dirname, '../..');
const FUNCOES = 'supabase/functions';
const NUCLEO = 'supabase/functions/_shared/';

const LEGADO: Record<string, string> = {
  'supabase/functions/analyze-unified-order/index.ts': 'fetch cru ao Omie',
  'supabase/functions/cmc-snapshot-backfill/index.ts': 'fetch cru ao Omie',
  'supabase/functions/cmc-snapshot-smoke/index.ts': 'fetch cru ao Omie',
  'supabase/functions/omie-analytics-sync/index.ts': 'relógio próprio (#3001)',
  'supabase/functions/omie-cliente/index.ts': 'fetch cru ao Omie',
  'supabase/functions/omie-desconto-backfill/index.ts': 'fetch cru ao Omie',
  'supabase/functions/omie-financeiro/index.ts': 'fetch cru ao Omie',
  'supabase/functions/omie-sync/index.ts': 'relógio de escrita (#3028)',
  'supabase/functions/omie-sync-ctes-recebidos/index.ts': 'fetch cru ao Omie',
  'supabase/functions/omie-sync-estoque/index.ts': 'fetch cru ao Omie',
  'supabase/functions/omie-sync-metadados/index.ts': 'fetch cru ao Omie',
  'supabase/functions/omie-sync-nfes-recebidas/index.ts': 'fetch cru ao Omie',
  'supabase/functions/omie-sync-pedidos-compra/index.ts': 'fetch cru ao Omie',
  'supabase/functions/omie-vendas-sync/index.ts': 'relógio de escrita (#3028)',
  'supabase/functions/picking-fila-omie/index.ts': 'fetch cru ao Omie',
  'supabase/functions/process-nfe/index.ts': 'fetch cru ao Omie',
  'supabase/functions/sync-reprocess/index.ts': 'fetch cru ao Omie',
  'supabase/functions/tint-omie-sync/index.ts': 'fetch cru ao Omie',
};

const IGNORAR = /(_test\.ts$|\.test\.ts$|\.d\.ts$)/;
const WRAPPER = /\bfunction\s+omieCall\b|\b(?:const|let|var)\s+omieCall\s*=/;
const FETCH_OMIE = /\bfetch\(\s*(?:["'`]https?:\/\/app\.omie\.com\.br|`\$\{\s*OMIE_[A-Z0-9_]*\s*\}|OMIE_[A-Z0-9_]+\b)/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    if (statSync(resolve(RAIZ, rel)).isDirectory()) listarFontes(rel, acc);
    else if (/\.ts$/.test(nome) && !IGNORAR.test(nome)) acc.push(rel);
  }
  return acc;
}

const fontes = listarFontes(FUNCOES).map((rel) => ({
  rel,
  src: removerComentarios(readFileSync(resolve(RAIZ, rel), 'utf8')),
}));
const foraDoNucleo = fontes.filter((f) => !f.rel.startsWith(NUCLEO));

describe('gate: chamada ao Omie só pelo _shared/omie-cliente.ts (M-48)', () => {
  it('sentinela: os padrões têm dente e o gate enxerga o legado (senão está cego)', () => {
    expect(WRAPPER.test('async function omieCall(url: string) {')).toBe(true);
    expect(WRAPPER.test('const omieCall = async () => {}')).toBe(true);
    expect(FETCH_OMIE.test('await fetch("https://app.omie.com.br/api/v1/geral/clientes/", {')).toBe(true);
    expect(FETCH_OMIE.test('await fetch(`${OMIE_API_URL}/${endpoint}`, {')).toBe(true);
    expect(FETCH_OMIE.test('await fetch(OMIE_ENDPOINT, {')).toBe(true);
    expect(FETCH_OMIE.test('await fetch(`${SUPA_URL}/auth/v1/user`)')).toBe(false);
    expect(foraDoNucleo.filter((f) => FETCH_OMIE.test(f.src)).length).toBeGreaterThan(0);
  });

  it('sentinela: o núcleo existe e as edges migradas passam por ele', () => {
    const nucleo = fontes.find((f) => f.rel === `${NUCLEO}omie-cliente.ts`);
    expect(nucleo?.src).toContain('export async function chamarOmie(');
    const migradas = [
      'disparar-pedidos-aprovados',
      'omie-malha-sync',
      'omie-nfe-recebimento-sync',
      'omie-nfe-recebimento',
      'omie-nfe-reconcile',
      'omie-sync-status-produtos',
      'omie-sync-vendas-items',
    ];
    for (const edge of migradas) {
      const f = fontes.find((x) => x.rel === `${FUNCOES}/${edge}/index.ts`);
      expect(f?.src, `${edge} não importa o núcleo`).toContain('from "../_shared/omie-cliente.ts"');
    }
  });

  it('nenhum wrapper omieCall fora do _shared', () => {
    const intrusos = foraDoNucleo.filter((f) => WRAPPER.test(f.src)).map((f) => f.rel);
    expect(intrusos, 'use chamarOmie/enviarOmie de _shared/omie-cliente.ts').toEqual([]);
  });

  it('nenhum fetch cru ao Omie fora do _shared e do legado', () => {
    const intrusos = foraDoNucleo.filter((f) => FETCH_OMIE.test(f.src) && !(f.rel in LEGADO)).map((f) => f.rel);
    expect(intrusos, 'use chamarOmie/enviarOmie de _shared/omie-cliente.ts').toEqual([]);
  });

  it('o legado só encolhe: entrada migrada sai da lista', () => {
    const comFetch = new Set(foraDoNucleo.filter((f) => FETCH_OMIE.test(f.src)).map((f) => f.rel));
    const velhas = Object.keys(LEGADO).filter((f) => !comFetch.has(f));
    expect(velhas, 'já migrou — tire do LEGADO').toEqual([]);
  });
});

// A correção de dinheiro do M-48 mora no adaptador do omie-nfe-recebimento: a escrita
// indeterminada (ConcluirRecebimento sem resposta/5xx) tem de chegar ao passo como FALHA sem
// marcar a flag `_ok` e sem passar pelo `erroBenigno` — que, casando "já concluído", a
// transformaria em sucesso fabricado. O núcleo é provado no Deno; isto prova a fiação.
describe('fiação: omie-nfe-recebimento trata a escrita indeterminada como falha do passo', () => {
  const rel = `${FUNCOES}/omie-nfe-recebimento/index.ts`;
  const src = fontes.find((f) => f.rel === rel)?.src ?? '';
  const fatia = (de: string, ate: string) => {
    const i = src.indexOf(de);
    const f = i >= 0 ? src.indexOf(ate, i) : -1;
    return i >= 0 && f > i ? src.slice(i, f) : '';
  };
  const adaptador = fatia('async function chamadaOmie(', '\n}\n');
  const passo = fatia('const executarPasso = async', '\n      };\n');

  it('sentinela: as fatias existem', () => {
    expect(adaptador.length, 'adaptador mudou de nome ou de forma').toBeGreaterThan(0);
    expect(passo.length, 'executarPasso mudou de forma').toBeGreaterThan(0);
  });

  it('o adaptador marca a indeterminada em vez de devolvê-la como erro comum', () => {
    expect(adaptador).toMatch(/if \(ehEscritaIndeterminada\(err\)\) return \{ error: true, indeterminada: true,/);
  });

  it('o passo sai como falha ANTES do erroBenigno e sem marcar a flag', () => {
    const i = passo.indexOf('if (res.error && res.indeterminada)');
    expect(i, 'o ramo da indeterminada sumiu').toBeGreaterThan(-1);
    expect(i, 'o erroBenigno roda antes do ramo da indeterminada').toBeLessThan(passo.indexOf('erroBenigno('));
    const ramo = passo.slice(i, passo.indexOf('const cls = classificarRespostaOmie(', i));
    expect(ramo).toContain('return false;');
    expect(ramo, 'a indeterminada marcou a flag _ok').not.toContain('[flagCol]: true');
  });
});
