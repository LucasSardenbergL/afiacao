import { describe, expect, it } from 'vitest';

import {
  auditar,
  auditarFonte,
  removerImports,
  reprovar,
  TETO_BLOCO_DESCARTADO,
  universo,
} from './gate-sonda-autentica';

/**
 * Fonte de edge mínimo, na FORMA dominante do repo: o classificador decide, e o gate mora dentro
 * do `if`, antes de a resposta ser emitida.
 */
const CORRETA = `
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { classificarSonda, respostaSonda, VERSAO } from "./versao.ts";

Deno.serve(async (req) => {
  const corpo = await req.json();
  const d = classificarSonda(corpo);
  if (d.tipo !== "disparo") {
    const auth = await authorizeCronOrStaff(req);
    if (!auth.ok) return auth.response;
    if (d.tipo === "sonda") return json(respostaSonda(VERSAO), 200);
  }
  return fluxoReal(req);
});
`;

describe('gate-sonda-autentica — a premissa do controle ativo, imposta', () => {
  it('a forma dominante do repo PASSA', () => {
    expect(reprovar(auditarFonte('boa', CORRETA))).toBeNull();
  });

  // O caso que o gate existe para pegar: a resposta sai antes de qualquer autenticação. Um 2xx
  // dessa edge não prova credencial, e o `controle_ativo` o contaria como testemunha.
  it('REPROVA quando a resposta de sonda é emitida ANTES do gate', () => {
    const ruim = CORRETA.replace(
      `    const auth = await authorizeCronOrStaff(req);
    if (!auth.ok) return auth.response;
    if (d.tipo === "sonda") return json(respostaSonda(VERSAO), 200);`,
      `    if (d.tipo === "sonda") return json(respostaSonda(VERSAO), 200);
    const auth = await authorizeCronOrStaff(req);
    if (!auth.ok) return auth.response;`,
    );
    expect(ruim).not.toEqual(CORRETA); // a sabotagem CASOU o fonte
    expect(reprovar(auditarFonte('ruim', ruim))).toMatch(/ANTES de authorizeCron/);
  });

  it('REPROVA quando não há gate de cron nenhum', () => {
    const semGate = CORRETA.replace(/const auth = await authorizeCronOrStaff\(req\);\n/, '')
      .replace(/if \(!auth\.ok\) return auth\.response;\n/, '')
      .replace(/import \{ authorizeCronOrStaff \}.*\n/, '');
    expect(reprovar(auditarFonte('sem-gate', semGate))).toMatch(/NÃO chama authorizeCron/);
  });

  // O furo clássico do gate textual: `import { authorizeCronOrStaff }` fica no TOPO do arquivo e
  // satisfaria "gate antes da emissão" sem ninguém chamar nada. Verde por cegueira.
  it('o IMPORT do gate não satisfaz a regra sozinho', () => {
    const soImport = `
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { respostaSonda, VERSAO } from "./versao.ts";

Deno.serve(async (req) => {
  return json(respostaSonda(VERSAO), 200);
});
`;
    expect(reprovar(auditarFonte('so-import', soImport))).toMatch(/NÃO chama authorizeCron/);
  });

  it('removerImports tira a declaração mas PRESERVA o import() dinâmico, que é código', () => {
    const fonte = `import { a } from "./x";\nconst m = await import("./y");\n`;
    const semImports = removerImports(fonte);
    expect(semImports).not.toMatch(/import \{ a \}/);
    expect(semImports).toMatch(/await import\("\.\/y"\)/);
  });

  // `atenderSondaOptions` autentica por HMAC e só atende OPTIONS — método que o pg_net não emite.
  // Ele sai da medição, mas NÃO pode valer como gate do POST: se valesse, esta edge passaria.
  it('atenderSondaOptions não vale como gate do POST', () => {
    const soOptions = `
import { atenderSondaOptions } from "../_shared/sonda-cron.ts";
import { respostaSonda, VERSAO } from "./versao.ts";

Deno.serve(async (req) => {
  const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
  if (sonda) return sonda;
  return json(respostaSonda(VERSAO), 200);
});
`;
    expect(reprovar(auditarFonte('so-options', soOptions))).toMatch(/NÃO chama authorizeCron/);
  });

  it('a via OPTIONS sozinha não REPROVA a edge que autentica o POST', () => {
    const comOptions = `
import { atenderSondaOptions } from "../_shared/sonda-cron.ts";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { respostaSonda, VERSAO } from "./versao.ts";

Deno.serve(async (req) => {
  const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
  if (sonda) return sonda;
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;
  return json(respostaSonda(VERSAO), 200);
});
`;
    expect(reprovar(auditarFonte('com-options', comOptions))).toBeNull();
  });

  it('chamada de atenderSondaOptions multilinha REPROVA — a remoção deixaria resto', () => {
    const multilinha = `
import { atenderSondaOptions } from "../_shared/sonda-cron.ts";
Deno.serve(async (req) => {
  const sonda = await atenderSondaOptions(
    req, respostaSonda, VERSAO);
  if (sonda) return sonda;
  return json(respostaSonda(VERSAO), 200);
});
`;
    expect(reprovar(auditarFonte('multi', multilinha))).toMatch(/várias linhas/);
  });

  // Os DOIS lados do alarme de stripper. Sem o de SUB-limpeza, um stripper que devolvesse o texto
  // cru faria o gate medir o arquivo com comentários — onde o `import` volta a satisfazer a regra.
  it('SUB-limpeza REPROVA: arquivo com comentário que a limpeza não encurtou', () => {
    const achado = auditarFonte('sub', CORRETA);
    expect(reprovar({ ...achado, temComentario: true, limpou: false })).toMatch(
      /stripper NÃO rodou/,
    );
  });

  it('SOBRE-limpeza REPROVA: bloco descartado acima do teto', () => {
    const achado = auditarFonte('sobre', CORRETA);
    expect(
      reprovar({ ...achado, blocoDescartado: TETO_BLOCO_DESCARTADO + 1 }),
    ).toMatch(/comeu CÓDIGO/);
  });

  // O eixo POR FORA: o denominador vem do disco (contagem de `versao.ts`), não do stripper. Um
  // universo que desaba não pode sair verde por ausência — é a falha que `for` sobre lista vazia
  // comete em silêncio.
  it('o universo real é não-vazio e a auditoria cobre TODAS as edges dele', () => {
    const raiz = new URL('..', import.meta.url).pathname;
    const edges = universo(raiz);
    expect(edges.length).toBeGreaterThan(10);
    expect(auditar(raiz).auditadas).toBe(edges.length);
  });

  // O VEREDITO sobre o repo real NÃO mora aqui — mora no step `sonda:autentica` do `ci.yml`, que é
  // bloqueante e roda este mesmo `auditar()` em ~133 ms. Até 2026-09-18 vivia aqui um
  // `it('o repo INTEIRO passa hoje')` com `expect(motivos).toEqual([])`: mesmo código, mesma árvore,
  // mesmo CI — SEGUNDA PORTA, não segundo detector. O preço não era o tempo, era a LEITURA: o motor
  // de exclusividade mede o STEP, via o `test` co-pegando todo defeito deste eixo e carimbava
  // EXCLUSIVIDADE_ZERO ("redundância medida") no único dono de uma premissa money-path — o
  // `controle_ativo` do `sonda-versao-sql.ts` trata a resposta de sonda como TESTEMUNHA de que o
  // `x-cron-secret` foi aceito. Quem lesse o carimbo concluiria que dá para aposentar o gate. Mesma
  // resolução do #2378 no `docs:indice`, que o #2391 levou a `[SO ELE]`; a classe está em
  // docs/historico/exclusividade-media-outra-coisa.md ("segundas portas").
  //
  // Medido ao tirar (mesma invocação, 2 locales): com o defeito aplicado numa edge real, a suíte
  // INTEIRA fica verde e o `sonda:autentica` reprova — a duplicata saiu, a detecção ficou.
  //
  // O que fica aqui é o que o step não dá: as formas sintéticas acima (calibração e falsificação) e o
  // eixo POR FORA logo atrás, que prova o denominador. Não devolva o veredito para cá.
});
