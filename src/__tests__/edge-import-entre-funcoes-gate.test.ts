import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
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
const IMPORT_CRUZADO = /from\s+['"]\.\.\/(?!_shared\/)([A-Za-z0-9_-]+)\//g;

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

export function importsCruzados(): string[] {
  const achados: string[] = [];
  for (const edge of readdirSync(resolve(RAIZ, RAIZ_EDGES))) {
    if (IGNORAR_PASTAS.has(edge)) continue;
    if (!statSync(resolve(RAIZ, RAIZ_EDGES, edge)).isDirectory()) continue;
    for (const arquivo of listarFontes(join(RAIZ_EDGES, edge))) {
      const fonte = removerComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      for (const m of fonte.matchAll(IMPORT_CRUZADO)) {
        achados.push(`${arquivo} → ../${m[1]}/`);
      }
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

  it('o detector enxerga o caso do incidente (controle positivo)', () => {
    const fonte = 'import { normalizarNcm } from "../omie-nfe-recebimento-sync/itens.ts";\nimport { x } from "../_shared/auth.ts";\nimport { y } from "./porta.ts";';
    expect([...fonte.matchAll(IMPORT_CRUZADO)].map((m) => m[1])).toEqual(['omie-nfe-recebimento-sync']);
  });
});
