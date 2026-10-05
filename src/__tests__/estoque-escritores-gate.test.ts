import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { analisarEscritorEstoque } from '@/lib/gates/estoque-escritores';
import { REGISTRO_ESCRITORES_ESTOQUE } from '@/lib/gates/estoque-escritores-registro';

// GATE da classe "espelho de estoque sem dono do zero" (docs/historico/estoque-dono-unico.md).
// Incidente: a WP07.3900QT ficou sem sugestão de compra desde 27/08 — estoque 0 no Omie, posição
// congelada em 2,43 no espelho que o motor lê (medido em 2026-10-05; 208 posições congeladas).
//
// A regra, partindo do DESTINO da escrita (não da API chamada — Codex no desenho):
//   G1 — todo arquivo das edges que escreve inventory_position, ou omie_products com a chave
//        `estoque`, está no REGISTRO com papel e motivo (writer novo = vermelho);
//   G2 — toda entrada do REGISTRO ainda escreve (entrada morta = vermelho: o registro só encolhe);
//   G3 — o dono do zero CHAMA `zerarConfirmadosForaDaLista` (manter o import e tirar a chamada é a
//        fuga que o import sozinho não pega);
//   G4 — nenhum escritor grava zero LITERAL de saldo/estoque: o zero vem do planejador do zero
//        confirmado (_shared/zeramento-estoque.ts), que não escreve nada.
// Por que TEXTUAL (readFileSync): as edges são Deno e o vitest não as executa.

const RAIZ = resolve(__dirname, '../..');
const DIR = 'supabase/functions';
const IGNORAR = /(_test\.ts$|\.test\.ts$|\.d\.ts$)/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    if (statSync(resolve(RAIZ, rel)).isDirectory()) listarFontes(rel, acc);
    else if (nome.endsWith('.ts') && !IGNORAR.test(rel)) acc.push(rel);
  }
  return acc;
}

const ANALISES = listarFontes(DIR).map((arquivo) => ({
  arquivo,
  ...analisarEscritorEstoque(readFileSync(resolve(RAIZ, arquivo), 'utf8')),
}));
const ESCRITORES = ANALISES.filter((a) => a.tabelas.length > 0);

describe('gate estoque-escritores', () => {
  it('sentinela: o walker anda e o detector acha os dois donos com a posição', () => {
    expect(ANALISES.length).toBeGreaterThan(200);
    const donos = ESCRITORES.filter((a) => a.tabelas.includes('inventory_position')).map((a) => a.arquivo);
    expect(donos).toContain('supabase/functions/omie-analytics-sync/index.ts');
    expect(donos).toContain('supabase/functions/sync-reprocess/index.ts');
  });

  it('G1: todo escritor de espelho de estoque está no registro', () => {
    const fora = ESCRITORES.filter((a) => !(a.arquivo in REGISTRO_ESCRITORES_ESTOQUE)).map((a) => `${a.arquivo} (${a.tabelas.join(', ')})`);
    expect(fora, 'G1: escritor de estoque fora do registro').toEqual([]);
  });

  it('G2: toda entrada do registro ainda escreve um espelho de estoque', () => {
    const escritores = new Set(ESCRITORES.map((a) => a.arquivo));
    const mortas = Object.keys(REGISTRO_ESCRITORES_ESTOQUE).filter((arq) => !escritores.has(arq));
    expect(mortas, 'G2: entrada do registro que não escreve mais (tire-a)').toEqual([]);
  });

  it('G3: o dono do zero chama zerarConfirmadosForaDaLista', () => {
    const semZero = Object.entries(REGISTRO_ESCRITORES_ESTOQUE)
      .filter(([, e]) => e.papel === 'dono-zero-confirmado')
      .map(([arq]) => arq)
      .filter((arq) => !ANALISES.find((a) => a.arquivo === arq)?.chamaZeroConfirmado);
    expect(semZero, 'G3: dono do zero sem a chamada do zero confirmado').toEqual([]);
  });

  it('G4: nenhum escritor grava zero literal de saldo/estoque', () => {
    const comZero = ESCRITORES.filter((a) => a.zerosLiterais > 0).map((a) => `${a.arquivo} (${a.zerosLiterais})`);
    expect(comZero, 'G4: zero literal de estoque num escritor').toEqual([]);
  });
});
