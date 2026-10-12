import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// ── GATE: cliente Anthropic sem coleira de relógio (M-33) ─────────────────────────────────────
// `new Anthropic({ apiKey })` herda 10 MINUTOS por tentativa e 2 retentativas do SDK; numa edge
// isso vira socket sem teto até o kill da plataforma (~150s), e a resposta sai como 5xx genérico
// em vez do erro mapeado. O cliente com coleira é `_shared/anthropic-cliente.ts`
// (`criarClienteAnthropic`), e este gate barra cópia nova fora dele.
//
// LEGADO: edges de módulos CONGELADOS pelo §0.3 do plano de melhorias
// (docs/superpowers/plans/2026-09-05-plano-melhorias-codebase/README.md) — "parar de corrigir".
// Regra "canônico quando tocar" (§0.5): quem descongelar o módulo migra a edge e a tira daqui.
// A lista só encolhe: entrada que já não tem `new Anthropic(` reprova (baseline velha esconde
// regressão futura no mesmo arquivo).

const RAIZ = resolve(__dirname, '../..');
const FUNCOES = 'supabase/functions';
const PERMITIDO = 'supabase/functions/_shared/anthropic-cliente.ts';

const LEGADO: Record<string, string> = {
  'supabase/functions/analyze-services/index.ts': 'loja-afiacao (congelado)',
  'supabase/functions/identify-tool/index.ts': 'loja-afiacao (congelado)',
  'supabase/functions/claude-spin-analyze/index.ts': 'telefonia (congelado)',
  'supabase/functions/copilot-analyze/index.ts': 'telefonia (congelado)',
  'supabase/functions/extrair-sinais-ligacao/index.ts': 'telefonia (congelado)',
  'supabase/functions/kb-extract-specs/index.ts': 'knowledge-base (congelado)',
  'supabase/functions/compare-customer-process/index.ts': 'knowledge-base (congelado)',
  'supabase/functions/structure-customer-process/index.ts': 'admin-crm (congelado)',
  'supabase/functions/melhoria-triagem/index.ts': 'governanca (congelado)',
  'supabase/functions/tarefa-extrair-voz/index.ts': 'tarefas (congelado)',
};

const IGNORAR = /(_test\.ts$|\.test\.ts$|\.d\.ts$)/;
const PADRAO = /\bnew\s+Anthropic\s*\(/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    if (statSync(resolve(RAIZ, rel)).isDirectory()) listarFontes(rel, acc);
    else if (/\.ts$/.test(nome) && !IGNORAR.test(nome)) acc.push(rel);
  }
  return acc;
}

function constroiCliente(rel: string): boolean {
  return PADRAO.test(removerComentarios(readFileSync(resolve(RAIZ, rel), 'utf8')));
}

describe('gate: cliente Anthropic só pelo _shared/anthropic-cliente.ts', () => {
  const comCliente = listarFontes(FUNCOES).filter(constroiCliente);

  it('sentinela: o gate enxerga o próprio cliente compartilhado (senão está cego)', () => {
    expect(comCliente).toContain(PERMITIDO);
  });

  it('nenhuma edge fora do legado congelado constrói o cliente na mão', () => {
    const intrusos = comCliente.filter((f) => f !== PERMITIDO && !(f in LEGADO));
    expect(intrusos, 'use criarClienteAnthropic de _shared/anthropic-cliente.ts').toEqual([]);
  });

  it('o legado só encolhe: entrada migrada sai da lista', () => {
    const velhas = Object.keys(LEGADO).filter((f) => !comCliente.includes(f));
    expect(velhas, 'já migrou — tire do LEGADO').toEqual([]);
  });
});
