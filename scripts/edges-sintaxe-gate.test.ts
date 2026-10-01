import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classificarNodeCheck, enumerarModulos, main, transpilar } from './edges-sintaxe-gate';

/**
 * Os módulos recusados abaixo têm a FORMA dos 4 commits reais da classe (cabeçalho do gate):
 * `resposta` do #2700 (let no topo do handler + const no fim, mesmo escopo), a função de módulo
 * declarada 2× da `omie-cliente@a0596c33f`, e o arquivo truncado da
 * `omie-sync-nfes-recebidas@b880daeb1`. O blob inteiro fica fora (1.000+ linhas, e o CI clona sem
 * histórico); a prova contra os blobs reais é a falsificação registrada no PR.
 *
 * Os testes de integração rodam o `node --check` DE VERDADE: o valor do gate está em acertar o que
 * o V8 recusa, e um `node` simulado testaria o parser contra a minha suposição.
 */

/** stderr REAL do `node --check` (node v26.5.0) para o módulo do caso `resposta`. */
const STDERR_REDECLARACAO = `/tmp/edges-sintaxe-x/supabase__functions__quebrada__index.ts.mjs:4
  const resposta = { ok: true };
        ^

SyntaxError: Identifier 'resposta' has already been declared
    at checkSyntax (node:internal/main/check_syntax:72:5)

Node.js v26.5.0
`;

const INCIDENTE_2700 = `import { montarRespostaAnalise } from "./saida-ia.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  let resposta: { content: unknown[] } | undefined;
  try {
    resposta = await chamarModelo(req);
  } catch (_e) {
    return new Response("erro", { status: 502 });
  }
  const resposta = montarRespostaAnalise({ products: [], message: "ok" });
  return new Response(JSON.stringify(resposta));
});
`;

const FUNCAO_DUPLICADA = `import { createClient } from "npm:@supabase/supabase-js@2";

async function upsertAddressFromOmie(cliente: unknown): Promise<boolean> {
  return cliente !== null;
}

async function upsertAddressFromOmie(cliente: unknown, forcar = false): Promise<boolean> {
  return forcar || cliente !== null;
}

Deno.serve(async () => new Response(String(await upsertAddressFromOmie(createClient))));
`;

const TRUNCADO = `Deno.serve(async (req: Request) => {
  const corpo = await req.json();
  if (corpo.probe) {
    return new Response("ok");
  }
  return new Response(JSON.stringify(corpo));
`;

/** Módulo LIMPO com o que as edges reais usam: tipos, import remoto, top-level await, enum. */
const LIMPO = `import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "npm:zod@3";
import type { Produto } from "../_shared/tipos.ts";
import { VERSAO } from "./versao.ts";

enum Conta { Oben = "oben", Colacor = "colacor" }
const configuracao = await Promise.resolve({ conta: Conta.Oben });
const precoDe = (p: Produto): number | null => p.preco ?? null;

class Cliente {
  constructor(private readonly id: string) {}
  get chave(): string { return this.id satisfies string; }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const corpo = z.object({ id: z.string() }).parse(await req.json());
  const cliente = new Cliente(corpo.id);
  return new Response(JSON.stringify({ VERSAO, chave: cliente.chave, configuracao, createClient, precoDe }));
});
`;

const raizes: string[] = [];
afterAll(() => {
  for (const r of raizes) rmSync(r, { recursive: true, force: true });
});

/** Monta um repo sintético: `{ 'ok/index.ts': '...' }` vira `supabase/functions/ok/index.ts`. */
function repo(arquivos: Record<string, string>): string {
  const raiz = mkdtempSync(join(tmpdir(), 'edges-sintaxe-teste-'));
  raizes.push(raiz);
  mkdirSync(join(raiz, 'supabase/functions'), { recursive: true });
  for (const [rel, fonte] of Object.entries(arquivos)) {
    const destino = join(raiz, 'supabase/functions', rel);
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, fonte);
  }
  return raiz;
}

/** Um `node` falso: responde `--version` e, no resto, executa o corpo dado. */
function nodeFalso(corpo: string): string {
  const raiz = mkdtempSync(join(tmpdir(), 'edges-sintaxe-node-falso-'));
  raizes.push(raiz);
  const bin = join(raiz, 'node');
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v99.0.0; exit 0; fi\n${corpo}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

async function rodar(raiz: string, node?: string): Promise<{ codigo: number; saida: string }> {
  const linhas: string[] = [];
  const codigo = await main(['--raiz', raiz], { node, saida: (l) => linhas.push(l) });
  return { codigo, saida: linhas.join('\n') };
}

const INTEGRACAO = { timeout: 60_000 };

describe('classificarNodeCheck — o que o V8 disse, e o que é "não consegui checar"', () => {
  it('exit 0 → aceito', () => {
    expect(classificarNodeCheck({ status: 0, sinal: null, stderr: '' })).toEqual({ tipo: 'aceito' });
  });

  it('exit 1 com SyntaxError → recusado, com a mensagem do V8 e a linha do JS', () => {
    const r = classificarNodeCheck({ status: 1, sinal: null, stderr: STDERR_REDECLARACAO });
    expect(r).toEqual({
      tipo: 'recusado',
      mensagem: "Identifier 'resposta' has already been declared",
      trecho: 'const resposta = { ok: true };',
    });
  });

  it('exit 1 SEM SyntaxError → nao-checado (não é veredito do parser)', () => {
    const r = classificarNodeCheck({ status: 1, sinal: null, stderr: 'Error: EACCES: permission denied' });
    expect(r.tipo).toBe('nao-checado');
  });

  it('morto por sinal (teto estourado) → nao-checado', () => {
    const r = classificarNodeCheck({ status: null, sinal: 'SIGKILL', stderr: '' });
    expect(r.tipo).toBe('nao-checado');
    expect(r.tipo === 'nao-checado' && r.motivo).toContain('SIGKILL');
  });

  it('o processo nem subiu (ENOENT) → nao-checado', () => {
    const r = classificarNodeCheck({ status: null, sinal: null, stderr: '', erro: 'spawn node ENOENT' });
    expect(r.tipo).toBe('nao-checado');
  });
});

describe('transpilar — por que são DUAS camadas', () => {
  it('o truncado (b880daeb1) dá diagnóstico de parse no fonte, com linha', () => {
    const { diagnosticos } = transpilar(TRUNCADO, 'nfes/index.ts');
    expect(diagnosticos.length).toBeGreaterThan(0);
    expect(diagnosticos[0].mensagem).toBe("'}' expected.");
    expect(diagnosticos[0].linha).toBe(7);
  });

  it('a redeclaração (#2700) passa pelo transpile com ZERO diagnósticos — só o V8 a pega', () => {
    expect(transpilar(INCIDENTE_2700, 'analyze/index.ts').diagnosticos).toEqual([]);
    expect(transpilar(FUNCAO_DUPLICADA, 'omie-cliente/index.ts').diagnosticos).toEqual([]);
  });

  it('o transpile apaga os tipos e mantém o import remoto como texto', () => {
    const { js, diagnosticos } = transpilar(LIMPO, 'ok/index.ts');
    expect(diagnosticos).toEqual([]);
    expect(js).toContain('https://esm.sh/@supabase/supabase-js@2.45.0');
    expect(js).not.toContain('import type');
    expect(js).not.toContain(': Promise<Response>');
  });
});

describe('enumerarModulos — o que entra no gate', () => {
  it('pega todo .ts não-teste de supabase/functions (inclusive _shared) e conta as edges pelo index.ts', () => {
    const raiz = repo({
      'a/index.ts': LIMPO,
      'a/helper.ts': 'export const x = 1;\n',
      'a/helper_test.ts': 'Deno.test("x", () => {});\n',
      'b/index.ts': LIMPO,
      'b/regra.test.ts': 'Deno.test("y", () => {});\n',
      '_shared/cors.ts': 'export const corsHeaders = {};\n',
      '_shared/test.ts': 'Deno.test("z", () => {});\n',
      '_shared/dados.json': '{}\n',
    });
    expect(enumerarModulos(raiz)).toEqual({
      modulos: [
        'supabase/functions/_shared/cors.ts',
        'supabase/functions/a/helper.ts',
        'supabase/functions/a/index.ts',
        'supabase/functions/b/index.ts',
      ],
      edges: 2,
    });
  });
});

describe('main — o gate de ponta a ponta, com o node --check de verdade', () => {
  it('reprova o caso do #2700 (redeclaração) e nomeia o arquivo e as linhas do fonte', INTEGRACAO, async () => {
    const raiz = repo({ 'ok/index.ts': LIMPO, 'quebrada/index.ts': INCIDENTE_2700 });
    const { codigo, saida } = await rodar(raiz);
    expect(codigo).toBe(1);
    expect(saida).toContain('RECUSADO supabase/functions/quebrada/index.ts [v8]');
    expect(saida).toContain("Identifier 'resposta' has already been declared");
    expect(saida).toContain('linhas 4 e 10');
    expect(saida).not.toContain('RECUSADO supabase/functions/ok/');
  });

  it('reprova a função de módulo declarada 2× (omie-cliente@a0596c33f)', INTEGRACAO, async () => {
    const { codigo, saida } = await rodar(repo({ 'omie-cliente/index.ts': FUNCAO_DUPLICADA }));
    expect(codigo).toBe(1);
    expect(saida).toContain('RECUSADO supabase/functions/omie-cliente/index.ts [v8]');
    expect(saida).toContain("Identifier 'upsertAddressFromOmie' has already been declared");
  });

  it('reprova o truncado (b880daeb1) pela camada do parser TS — o node sozinho o aprovaria', INTEGRACAO, async () => {
    const { codigo, saida } = await rodar(repo({ 'nfes/index.ts': TRUNCADO }));
    expect(codigo).toBe(1);
    expect(saida).toContain("RECUSADO supabase/functions/nfes/index.ts:7:1 [ts-parse] '}' expected.");
  });

  it('aprova o repo limpo e diz quanto checou', INTEGRACAO, async () => {
    const raiz = repo({ 'a/index.ts': LIMPO, 'b/index.ts': LIMPO, '_shared/cors.ts': 'export const c = 1;\n' });
    const { codigo, saida } = await rodar(raiz);
    expect(codigo).toBe(0);
    expect(saida).toContain('OK edges:sintaxe');
    expect(saida).toContain('3 modulos de 2 edges');
  });

  it('zero módulos → NAO_CHECADO (gate sem alvo não é gate verde)', INTEGRACAO, async () => {
    const { codigo, saida } = await rodar(repo({}));
    expect(codigo).toBe(2);
    expect(saida).toContain('NAO_CHECADO');
  });

  it('node que aprova tudo → a calibração o recusa: NAO_CHECADO, nunca OK', INTEGRACAO, async () => {
    const { codigo, saida } = await rodar(repo({ 'quebrada/index.ts': INCIDENTE_2700 }), nodeFalso('exit 0'));
    expect(codigo).toBe(2);
    expect(saida).toContain('NAO_CHECADO');
    expect(saida).toContain('calibracao');
    expect(saida).not.toContain('OK edges:sintaxe');
  });

  it('node que recusa tudo → a calibração o recusa: NAO_CHECADO, nunca RECUSADO', INTEGRACAO, async () => {
    const falso = nodeFalso('echo "SyntaxError: sempre" >&2\nexit 1');
    const { codigo, saida } = await rodar(repo({ 'ok/index.ts': LIMPO }), falso);
    expect(codigo).toBe(2);
    expect(saida).toContain('calibracao');
    expect(saida).not.toContain('RECUSADO supabase/');
  });

  it('node inexistente → NAO_CHECADO', INTEGRACAO, async () => {
    const { codigo, saida } = await rodar(repo({ 'ok/index.ts': LIMPO }), '/caminho/que/nao/existe/node');
    expect(codigo).toBe(2);
    expect(saida).toContain('NAO_CHECADO');
  });
});
