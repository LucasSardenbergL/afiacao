import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

// repo root: src/__tests__ → src → repo (2 níveis).
const CWD = resolve(__dirname, '../..');
const DIR_EDGES = resolve(CWD, 'supabase/functions');

// ── Guard: edge NÃO hardcoda o host do app — o host vem da env APP_URL ──
// Por que existe: o CTA "Agendar Afiação" do relatório mensal apontava para
// `https://afiacao.lovable.app/new-order` — domínio MORTO (HTTP 404 "Project not found",
// verificado 2026-07-18; o canônico é steu.lovable.app). Pior: esse botão só é renderizado
// quando `overdue_count > 0`, ou seja, ia exatamente para o cliente de MAIOR intenção — que
// clicava e caía num 404. O padrão certo já existia nas edges de reposição desde sempre; nada
// no CI apontava que a monthly-report divergia, e o link não quebra build nem teste.
// Textual (lê o arquivo, não importa) pelo mesmo motivo do edge-money-path-invariants.test.ts:
// edge é Deno, roda no Lovable Cloud, fora do typecheck/vitest do src/.
const DOMINIO_MORTO = 'afiacao.lovable.app';

// Única citação permitida de um host do app: o fallback da env. Tolerante a aspas/espaçamento,
// rígida quanto à FORMA (tem de vir de `Deno.env.get('APP_URL')`) — o que se proíbe é o literal nu.
const FALLBACK_APP_URL =
  /Deno\.env\.get\(\s*['"]APP_URL['"]\s*\)\s*\?\?\s*['"]https:\/\/steu\.lovable\.app['"]/;

function arquivosTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) return arquivosTs(caminho);
    return entrada.isFile() && caminho.endsWith('.ts') ? [caminho] : [];
  });
}

// Toda linha, em qualquer edge, que cite um host *.lovable.app.
const citacoes = arquivosTs(DIR_EDGES).flatMap((abs) =>
  readFileSync(abs, 'utf8')
    .split('\n')
    .map((texto, i) => ({ arquivo: relative(CWD, abs), linha: i + 1, texto }))
    .filter((l) => l.texto.includes('lovable.app')),
);

describe('edges: host do app vem da env APP_URL', () => {
  it('nenhuma edge cita o domínio morto afiacao.lovable.app', () => {
    const mortas = citacoes.filter((c) => c.texto.includes(DOMINIO_MORTO));
    expect(mortas.map((c) => `${c.arquivo}:${c.linha}`)).toEqual([]);
  });

  it('toda citação de host *.lovable.app é o fallback de Deno.env.get("APP_URL")', () => {
    const nuas = citacoes.filter((c) => !FALLBACK_APP_URL.test(c.texto));
    expect(nuas.map((c) => `${c.arquivo}:${c.linha} → ${c.texto.trim()}`)).toEqual([]);
  });

  it('o guard enxerga as edges (senão passa vazio e não prova nada)', () => {
    // Anti-falso-verde: se a varredura quebrar (path errado, glob vazio), os dois asserts acima
    // ficam verdes por vacuidade. As edges de reposição são a linha de base conhecida.
    expect(citacoes.length).toBeGreaterThanOrEqual(2);
  });
});
