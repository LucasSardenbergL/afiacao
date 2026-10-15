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
// Limites conhecidos (revisão adversarial do M-48): a porta 1 casa o NOME, e a porta 2 só o 1º
// argumento — `fetch(url` com a URL vinda de parâmetro (`omie-sync-sku-items/consulta.ts`,
// `omie-sonda-recebimento`), constante sem `OMIE_` ou `fetch(base + x)` escapam. Um sinal
// estrutural (corpo com `app_secret`) foi medido e descartado: casa também os leitores de
// credencial. O gate barra o caminho usual; o resto é revisão.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

const RAIZ = resolve(__dirname, '../..');
const FUNCOES = 'supabase/functions';
const NUCLEO = 'supabase/functions/_shared/';

// Chamadas `fetch` cruas ao Omie POR ARQUIVO (não só o arquivo: um legado não pode ganhar mais).
const LEGADO: Record<string, number> = {
  'supabase/functions/analyze-unified-order/index.ts': 1,
  'supabase/functions/cmc-snapshot-backfill/index.ts': 1,
  'supabase/functions/omie-analytics-sync/index.ts': 1,
  'supabase/functions/omie-cliente/index.ts': 1,
  'supabase/functions/omie-desconto-backfill/index.ts': 1,
  'supabase/functions/omie-financeiro/index.ts': 1,
  'supabase/functions/omie-sync-ctes-recebidos/index.ts': 1,
  'supabase/functions/omie-sync-estoque/index.ts': 2,
  'supabase/functions/omie-sync-metadados/index.ts': 1,
  'supabase/functions/omie-sync-nfes-recebidas/index.ts': 1,
  'supabase/functions/omie-sync-pedidos-compra/index.ts': 1,
  'supabase/functions/omie-sync/index.ts': 1,
  'supabase/functions/omie-vendas-sync/index.ts': 1,
  'supabase/functions/picking-fila-omie/index.ts': 1,
  'supabase/functions/process-nfe/index.ts': 1,
  'supabase/functions/sync-reprocess/index.ts': 1,
  'supabase/functions/tint-omie-sync/index.ts': 1,
};

const IGNORAR = /(_test\.ts$|\.test\.ts$|\.d\.ts$)/;
const WRAPPER = /\bfunction\s+omieCall\b|\b(?:const|let|var)\s+omieCall\s*=/;
const FETCH_OMIE = /\bfetch\(\s*(?:["'`]https?:\/\/app\.omie\.com\.br|`\$\{\s*OMIE_[A-Z0-9_]*\s*\}|OMIE_[A-Z0-9_]+\b)/g;

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
const fetchesOmie = (src: string) => (src.match(FETCH_OMIE) ?? []).length;
const temFetchOmie = (src: string) => fetchesOmie(src) > 0;

describe('gate: chamada ao Omie só pelo _shared/omie-cliente.ts (M-48)', () => {
  it('sentinela: os padrões têm dente e o gate enxerga o legado (senão está cego)', () => {
    expect(WRAPPER.test('async function omieCall(url: string) {')).toBe(true);
    expect(WRAPPER.test('const omieCall = async () => {}')).toBe(true);
    expect(temFetchOmie('await fetch("https://app.omie.com.br/api/v1/geral/clientes/", {')).toBe(true);
    expect(temFetchOmie('await fetch(`${OMIE_API_URL}/${endpoint}`, {')).toBe(true);
    expect(temFetchOmie('await fetch(OMIE_ENDPOINT, {')).toBe(true);
    expect(temFetchOmie('await fetch(`${SUPA_URL}/auth/v1/user`)')).toBe(false);
    expect(fetchesOmie('fetch(OMIE_A, x); fetch(OMIE_B, y)')).toBe(2);
    expect(foraDoNucleo.filter((f) => temFetchOmie(f.src)).length).toBeGreaterThan(0);
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

  it('nenhum fetch cru ao Omie novo — fora do _shared, nem a mais num arquivo do legado', () => {
    const intrusos = foraDoNucleo
      .filter((f) => fetchesOmie(f.src) > (LEGADO[f.rel] ?? 0))
      .map((f) => `${f.rel} (${LEGADO[f.rel] ?? 0}→${fetchesOmie(f.src)})`);
    expect(intrusos, 'use chamarOmie/enviarOmie de _shared/omie-cliente.ts').toEqual([]);
  });

  it('o legado só encolhe: chamada migrada baixa a contagem (arquivo zerado sai da lista)', () => {
    const porArquivo = new Map(foraDoNucleo.map((f) => [f.rel, fetchesOmie(f.src)]));
    const velhas = Object.entries(LEGADO)
      .filter(([f, n]) => (porArquivo.get(f) ?? 0) < n)
      .map(([f, n]) => `${f} (${n}→${porArquivo.get(f) ?? 0})`);
    expect(velhas, 'já migrou — baixe a contagem no LEGADO').toEqual([]);
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
