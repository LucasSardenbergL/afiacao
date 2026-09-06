import { describe, expect, it } from 'vitest';
import {
  chaveDoManifesto,
  classificarVeredito,
  gateG1,
  gateG3,
  gateG4,
  pontoFixoDeArquivos,
  sentinelaStripper,
  type Veredito,
} from './sonda-cron-prova';

const OPTIONS_OK = [
  "Deno.serve(async (req) => {",
  "  if (req.method === 'OPTIONS') {",
  "    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);",
  "    if (sonda) return sonda;",
  "    return new Response(null, { headers: corsHeaders });",
  "  }",
  "  const auth = await authorizeCronOrStaff(req);",
].join("\n");

describe('gateG1 — o ramo dentro do bloco OPTIONS, antes do CORS', () => {
  it('aceita a forma canônica', () => {
    expect(gateG1('monthly-report', OPTIONS_OK)).toBeNull();
  });
  it('reprova ramo ausente, NOMEANDO a edge', () => {
    const sem = OPTIONS_OK.replace(/ {4}const sonda[^\n]*\n {4}if \(sonda\) return sonda;\n/, '');
    expect(gateG1('monthly-report', sem)).toMatch(/monthly-report.*atenderSondaOptions/);
  });
  it('reprova ramo DEPOIS do return de CORS (código morto)', () => {
    const invertido = OPTIONS_OK.replace(
      "    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);\n    if (sonda) return sonda;\n    return new Response(null, { headers: corsHeaders });",
      "    return new Response(null, { headers: corsHeaders });\n    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);\n    if (sonda) return sonda;",
    );
    expect(gateG1('monthly-report', invertido)).toMatch(/DEPOIS do return de CORS/);
  });
  it('reprova IO dentro do bloco — e NÃO se engana com IO citado em comentário', () => {
    const comIo = OPTIONS_OK.replace('    if (sonda) return sonda;', '    if (sonda) return sonda;\n    await supabase.from("t").select();\n    void fetch("x");');
    expect(gateG1('monthly-report', comIo)).toMatch(/IO dentro do bloco OPTIONS/);
    const soComentario = OPTIONS_OK.replace('    if (sonda) return sonda;', '    if (sonda) return sonda;\n    // nunca chame fetch( aqui');
    expect(gateG1('monthly-report', soComentario)).toBeNull();
  });
});

const RELE_OK = [
  'const saida = montarRequestSonda(baseUrl, alvo, await derivarCredencial(chave, alvo));',
  'const violacao = barreiraSaida(saida, baseUrl, alvo, ALLOWLIST);',
  'resposta = await fetch(saida, { signal: AbortSignal.timeout(TIMEOUT_MS) });',
].join('\n');

describe('gateG3 — o relé só emite OPTIONS, e mede a VARIÁVEL', () => {
  it('aceita o relé canônico', () => expect(gateG3(RELE_OK)).toBeNull());
  it('reprova 2 fetch', () => expect(gateG3(`${RELE_OK}\nawait fetch(outraCoisa);`)).toMatch(/2 chamada/));
  it('reprova fetch que não recebe o request da barreira', () => {
    const burlado = RELE_OK.replace('fetch(saida,', 'fetch(new Request(url),');
    expect(gateG3(burlado)).toMatch(/não recebe|nasce de/);
  });
  it('reprova method literal no fetch', () => {
    expect(gateG3(RELE_OK.replace('fetch(saida, {', 'fetch(saida, { method: "POST",'))).toMatch(/method/);
  });
  it('NÃO se engana com x-cron-secret no CORS de entrada (é o header que o cron manda PARA o relé)', () => {
    const comCors = `const corsHeaders = { "Access-Control-Allow-Headers": "content-type, x-cron-secret" };\n${RELE_OK}`;
    expect(gateG3(comCors)).toBeNull();
  });
  it('reprova x-cron-secret montado em headers de SAÍDA', () => {
    const vazando = `${RELE_OK}\nconst h = { headers: { "x-cron-secret": s } };`;
    expect(gateG3(vazando)).toMatch(/cron-secret/);
  });
});

describe('sentinelaStripper — alarme de SUB-limpeza', () => {
  it('acusa quando o texto não tem bloco de comentário grande (stripper cego ou fonte sem doc)', () => {
    expect(sentinelaStripper('const x = 1;\nconst y = 2;')).toMatch(/stripper/);
  });
  it('aceita um cabeçalho real de 10 linhas comentadas', () => {
    const doc = `${Array.from({ length: 10 }, (_, i) => `// linha ${i}`).join('\n')}\nconst x = 1;`;
    expect(sentinelaStripper(doc)).toBeNull();
  });
});

describe('gateG4 — o espelho no banco ⊆ allowlist', () => {
  it('reprova INSERT com slug fora, nomeando o slug', () => {
    const m = [{ nome: 'm.sql', sql: "INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES ('omie-webhook', 'x');" }];
    expect(gateG4(m, ['monthly-report'])).toMatch(/omie-webhook/);
  });
  it('aceita slug da allowlist e ignora migration que não menciona a tabela', () => {
    const m = [
      { nome: 'm.sql', sql: "INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES ('monthly-report', 'x');" },
      { nome: 'n.sql', sql: 'CREATE TABLE outra ();' },
    ];
    expect(gateG4(m, ['monthly-report'])).toBeNull();
  });
});

const chamada = (over: Record<string, unknown> = {}) => ({
  status: 200, probe: false, efeitos: 0, fetches: 0, corpoHash: 'h', headers: {}, quiesceu: true, ...over,
});
const base = (): Veredito => ({
  importErro: null,
  efeitosNoImport: 0,
  handler: true,
  a: chamada(),
  b: ['preflight-browser', 'hex-invalido', 'credencial-errada', 'outra-edge'].map((nome) => ({ nome, ...chamada() })),
  c: { classe: 'controle', efeitos: 2, fetches: 0, degrau: 'controle-0' },
});

describe('classificarVeredito', () => {
  it('PASSA quando inerte com controle positivo', () => expect(classificarVeredito(base(), false)).toBe('PASSA'));
  it('FALHA com efeito no OPTIONS', () => {
    expect(classificarVeredito({ ...base(), a: chamada({ efeitos: 1 }) }, false)).toBe('FALHA');
  });
  it('FALHA com IO no import, mesmo que o import tenha lançado', () => {
    expect(classificarVeredito({ ...base(), efeitosNoImport: 1, importErro: 'boom' }, false)).toBe('FALHA');
  });
  it('FALHA quando um negativo responde diferente do preflight', () => {
    const v = base();
    v.b[3] = { ...v.b[3], corpoHash: 'outro' };
    expect(classificarVeredito(v, false)).toBe('FALHA');
  });
  it('FALHA quando um closure SEM o ramo responde probe, e quando um COM o ramo não responde', () => {
    expect(classificarVeredito({ ...base(), a: chamada({ probe: true }) }, false)).toBe('FALHA');
    expect(classificarVeredito(base(), true)).toBe('FALHA');
    expect(classificarVeredito({ ...base(), a: chamada({ probe: true }) }, true)).toBe('PASSA');
  });
  it('FALHA quando o relógio virtual não quiesceu', () => {
    expect(classificarVeredito({ ...base(), a: chamada({ quiesceu: false }) }, false)).toBe('FALHA');
  });
  it('INVERIFICAVEL: import falhou sem efeito, ou controle inconclusivo', () => {
    expect(classificarVeredito({ ...base(), importErro: 'Module not found', handler: false }, false)).toBe('INVERIFICAVEL');
    expect(classificarVeredito({ ...base(), c: { classe: 'inconclusivo', efeitos: 0, fetches: 0, degrau: null } }, false)).toBe('INVERIFICAVEL');
  });
});

describe('cache e enumeração', () => {
  it('a chave muda com o harness — closure igual, instrumento diferente, veredito a refazer', () => {
    expect(chaveDoManifesto('c1', 'h1')).not.toBe(chaveDoManifesto('c1', 'h2'));
    expect(chaveDoManifesto('c1', 'h1')).toBe(chaveDoManifesto('c1', 'h1'));
  });
  it('o ponto fixo alcança dependência que só existia no passado, e os commits QUE SÓ ELA tem', () => {
    // O caso real: `_shared/velho.ts` não existe mais hoje, mas um `index.ts` antigo o importava.
    // O histórico do index já traz o commit em que isso acontecia (s2); o fecho DESSE sha revela o
    // arquivo; e o histórico DO ARQUIVO traz um commit (s3) que o histórico do index não tinha —
    // um closure distinto que a enumeração ingênua perderia inteiro.
    const fechos: Record<string, string[]> = {
      s1: ['a/index.ts', '_shared/x.ts'],
      s2: ['a/index.ts', '_shared/velho.ts'],
      s3: ['a/index.ts', '_shared/velho.ts'],
    };
    const historico = (files: string[]) => (files.includes('_shared/velho.ts') ? ['s1', 's2', 's3'] : ['s1', 's2']);
    expect(pontoFixoDeArquivos(['a/index.ts'], historico, (sha) => fechos[sha])).toEqual({
      arquivos: ['_shared/velho.ts', '_shared/x.ts', 'a/index.ts'],
      shas: ['s1', 's2', 's3'],
    });
  });
});
