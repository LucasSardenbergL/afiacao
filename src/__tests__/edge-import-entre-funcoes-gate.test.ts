import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, posix } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Gate estrutural: uma edge NÃO importa de OUTRA pasta de função — só de `_shared/` e de si mesma.
//
// Incidente (2026-10-19, PR #3157): `omie-nfe-webhook` v1.3 importava
// `../omie-nfe-recebimento-sync/itens.ts`. Deno, typecheck, sintaxe, fingerprint e os 28 testes da
// edge passaram — o fecho transitivo dos imports até listou o arquivo no pacote de deploy, com hash
// conferido 8/8 pelo agente do Lovable. E o deploy falhou: `Module not found`. O empacotador do
// Lovable sobe SÓ a pasta da função + `_shared/`; o que mora noutra pasta de função não existe no
// bundle. Nenhum gate local enxergava isso, porque todos rodam sobre o repo inteiro.
//
// O que conta: `from "../<pasta>/…"` em arquivo não-teste de `supabase/functions/<edge>/`, com
// `<pasta>` diferente de `_shared`. Comentários são removidos antes (o próprio incidente está
// descrito em comentário no `index.ts` da edge). Baseline ZERO: o único caso foi corrigido no
// mesmo PR; o remédio é mover o módulo para `_shared/`.

const RAIZ = resolve(__dirname, '../..');
const RAIZ_EDGES = 'supabase/functions';
const IGNORAR_PASTAS = new Set(['_shared', 'mcp', 'node_modules']);
// Todo especificador de import relativo: `from '…'`, `import '…'` (efeito colateral) e `import('…')`.
const ESPECIFICADOR = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    if (statSync(resolve(RAIZ, rel)).isDirectory()) {
      if (nome === 'node_modules') continue;
      listarFontes(rel, acc);
    } else if (/\.(ts|tsx|js|mjs)$/.test(nome) && !/_test\.(ts|js)$/.test(nome)) {
      acc.push(rel);
    }
  }
  return acc;
}

/**
 * Pasta de função (ou `_shared`) a que um especificador relativo leva, resolvido a partir do
 * ARQUIVO que importa — `./../x/`, `../../funcs/x/`, `../_shared/../x/` normalizam para o mesmo
 * destino; `../utils/a.ts` de dentro de uma subpasta da própria edge fica na própria edge.
 * `null` quando o destino sai de `supabase/functions/`.
 */
export function pastaDestino(arquivo: string, especificador: string): string | null {
  const destino = posix.normalize(posix.join(posix.dirname(arquivo), especificador));
  if (!destino.startsWith(`${RAIZ_EDGES}/`)) return null;
  return destino.slice(RAIZ_EDGES.length + 1).split('/')[0] ?? null;
}

export function importsCruzadosDe(arquivo: string, fonte: string): string[] {
  const edge = arquivo.slice(RAIZ_EDGES.length + 1).split('/')[0];
  const achados: string[] = [];
  for (const m of removerComentarios(fonte).matchAll(ESPECIFICADOR)) {
    const pasta = pastaDestino(arquivo, m[1]);
    if (pasta !== null && pasta !== edge && pasta !== '_shared') achados.push(`${arquivo} → ${m[1]} (${pasta}/)`);
  }
  return achados;
}

export function importsCruzados(): string[] {
  const achados: string[] = [];
  for (const edge of readdirSync(resolve(RAIZ, RAIZ_EDGES))) {
    if (IGNORAR_PASTAS.has(edge)) continue;
    if (!statSync(resolve(RAIZ, RAIZ_EDGES, edge)).isDirectory()) continue;
    for (const arquivo of listarFontes(join(RAIZ_EDGES, edge))) {
      achados.push(...importsCruzadosDe(arquivo, readFileSync(resolve(RAIZ, arquivo), 'utf8')));
    }
  }
  return achados;
}

describe('edges: import só de _shared/ (o bundle de deploy do Lovable não leva outra pasta de função)', () => {
  it('nenhuma edge importa de outra pasta de função', () => {
    const achados = importsCruzados();
    expect(
      achados,
      `import entre pastas de função — o deploy no Lovable falha com "Module not found". Mova o módulo para supabase/functions/_shared/:\n  ${achados.join('\n  ')}`,
    ).toEqual([]);
  });

  it('controle positivo: o caso do incidente e as variantes que o adversarial reproduziu', () => {
    const arq = 'supabase/functions/omie-nfe-webhook/index.ts';
    const fonte = [
      'import { normalizarNcm } from "../omie-nfe-recebimento-sync/itens.ts";', // o incidente
      "import { a } from './../outra/x.ts';", // ./../
      'import { b } from "../../functions/outra2/x.ts";', // ../../
      'import { c } from "../_shared/../outra3/x.ts";', // passa por _shared e sai
      'const d = await import("../outra4/x.ts");', // dinâmico
      'import "../outra5/efeito.ts";', // sem from
      'export { e } from "../outra6/x.ts";', // reexport
    ].join('\n');
    expect(importsCruzadosDe(arq, fonte).map((a) => a.replace(/.*\((.*)\/\)$/, '$1'))).toEqual([
      'omie-nfe-recebimento-sync', 'outra', 'outra2', 'outra3', 'outra4', 'outra5', 'outra6',
    ]);
  });

  it('controle negativo: _shared, a própria edge (inclusive de subpasta) e npm: não contam', () => {
    const fonte = [
      'import { x } from "../_shared/auth.ts";',
      'import { y } from "./porta.ts";',
      'import { z } from "../utils/x.ts";', // de dentro de uma subpasta da própria edge
      'import { w } from "npm:@supabase/supabase-js@2";',
      '// import { k } from "../outra/x.ts"; (comentado)',
    ].join('\n');
    expect(importsCruzadosDe('supabase/functions/minha-edge/sub/a.ts', fonte)).toEqual([]);
    expect(importsCruzadosDe('supabase/functions/minha-edge/index.ts', 'import { x } from "../_shared/auth.ts";')).toEqual([]);
  });
});
