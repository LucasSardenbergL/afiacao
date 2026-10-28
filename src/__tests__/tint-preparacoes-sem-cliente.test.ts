import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Giro de corante (Fase 1, PR B) — o ramo `/preparations` da edge tint-sync-agent não pode voltar
// a gravar `cliente` (LGPD) nem a ler o corpo cru antes do saneamento. A semântica é provada
// EXECUTANDO o handler em `preparacoes_test.ts` (Deno); este teste fixa a FORMA do index.ts,
// que o Deno não exercita: o ramo só delega ao módulo puro.

const RAIZ = resolve(__dirname, '../..');
const INDEX = removerComentarios(
  readFileSync(resolve(RAIZ, 'supabase/functions/tint-sync-agent/index.ts'), 'utf8'),
);

function ramo(marcaInicio: string, marcaFim: string): string {
  const ini = INDEX.indexOf(marcaInicio);
  const fim = INDEX.indexOf(marcaFim, ini + 1);
  expect(ini, `início do ramo "${marcaInicio}" não encontrado`).toBeGreaterThan(-1);
  expect(fim, `fim do ramo "${marcaFim}" não encontrado`).toBeGreaterThan(ini);
  return INDEX.slice(ini, fim);
}

describe('tint-sync-agent /preparations — sem cliente, delegado ao módulo saneado', () => {
  const preparations = ramo('path === "preparations"', 'path === "keys-snapshot"');

  it('o ramo delega a processarPreparacoes com o corpo como TEXTO', () => {
    expect(preparations).toContain('processarPreparacoes(await req.text()');
  });

  it('o ramo não lê req.json() nem monta cliente', () => {
    expect(preparations).not.toContain('req.json()');
    expect(preparations).not.toMatch(/cliente\s*:/);
  });

  it('o ramo não loga o corpo, a preparação nem o raw', () => {
    const chamadas = [...preparations.matchAll(/logError\(([^)]*)\)/g)].map((m) => m[1]);
    for (const args of chamadas) {
      expect(args, `logError com dado bruto: ${args}`).not.toMatch(/\b(p|body|raw|corpo|item)\b/);
    }
  });

  it('nenhum lugar do index.ts grava cliente em staging de preparação', () => {
    expect(INDEX).not.toMatch(/cliente\s*:\s*p\.cliente/);
    expect(INDEX).not.toContain('TintPreparacaoPayload');
  });

  it('a rota do plano existe e consome o RPC do servidor', () => {
    const plano = ramo('path === "plano"', 'path === "preparations"');
    expect(plano).toContain('"tint_consumo_plano_extracao"');
    expect(plano).toContain('respostaDoPlano(data, error)');
  });
});
