// Gate de CONTRATO das sondas de versão: uma linha por edge instrumentada.
//
// Por que um arquivo só, em vez de um teste por edge: o classificador já é compartilhado e testado
// em `sonda-versao_test.ts`; o que sobra por edge é o MARCADOR. Concentrar aqui torna visível o
// conjunto — quem adicionar a sonda numa edge nova e esquecer de registrar percebe no diff, e quem
// quebrar o formato de um marcador quebra um teste com nome que diz qual edge é.
//
// Estes imports atravessam diretórios de function DE PROPÓSITO e só valem em teste: os `versao.ts`
// não têm import remoto (o classificador vem de `_shared/`), então `--no-remote` passa. Nenhum
// código de produção importa através dessa fronteira.

import * as disparar from "../disparar-pedidos-aprovados/versao.ts";
import * as portalSayerlack from "../enviar-pedido-portal-sayerlack/versao.ts";
import * as conciliar from "../conciliar-pedido-portal/versao.ts";
import * as gerarDiario from "../gerar-pedidos-diario/versao.ts";
import * as programado from "../pedido-programado-enviar/versao.ts";
import * as argumento from "../generate-bundle-argument/versao.ts";
import * as tatico from "../generate-tactical-plan/versao.ts";

const EDGES: Array<{ nome: string; mod: { VERSAO: string; EFEITO: string } }> = [
  { nome: "disparar-pedidos-aprovados", mod: disparar },
  { nome: "enviar-pedido-portal-sayerlack", mod: portalSayerlack },
  { nome: "conciliar-pedido-portal", mod: conciliar },
  { nome: "gerar-pedidos-diario", mod: gerarDiario },
  { nome: "pedido-programado-enviar", mod: programado },
  { nome: "generate-bundle-argument", mod: argumento },
  { nome: "generate-tactical-plan", mod: tatico },
];

Deno.test("toda edge instrumentada declara VERSAO no formato vN.N-slug", () => {
  for (const { nome, mod } of EDGES) {
    if (typeof mod.VERSAO !== "string" || !/^v\d+\.\d+-[a-z0-9-]+$/.test(mod.VERSAO)) {
      throw new Error(`${nome}: VERSAO fora do formato vN.N-slug: ${JSON.stringify(mod.VERSAO)}`);
    }
  }
});

Deno.test("toda edge instrumentada declara EFEITO que NOMEIA o custo real", () => {
  // O EFEITO vai na recusa de `probe` ambíguo. Um texto genérico ("operação sensível") não ajuda
  // quem tomou o 400 a decidir se pode retentar — tem de dizer O QUE acontece se ele executar.
  for (const { nome, mod } of EDGES) {
    if (typeof mod.EFEITO !== "string" || mod.EFEITO.trim().length < 30) {
      throw new Error(`${nome}: EFEITO ausente ou curto demais: ${JSON.stringify(mod.EFEITO)}`);
    }
    if (/^(operação|acao|ação) sensível/i.test(mod.EFEITO.trim())) {
      throw new Error(`${nome}: EFEITO genérico demais: ${JSON.stringify(mod.EFEITO)}`);
    }
  }
});

Deno.test("marcadores são únicos por edge OU explicitamente iguais só no valor inicial", () => {
  // Marcador repetido entre edges não é erro (todas nascem em v1.0), mas DUAS edges presas no
  // mesmo marcador depois de uma delas mudar de comportamento seria — e isso só se pega relendo.
  // O assert aqui é fraco de propósito: garante que o valor inicial é o combinado, para que um
  // bump futuro seja obrigatoriamente deliberado.
  const iniciais = EDGES.filter((e) => e.mod.VERSAO === "v1.0-sensor-inicial").map((e) => e.nome);
  if (iniciais.includes("disparar-pedidos-aprovados")) {
    throw new Error("disparar-pedidos-aprovados já passou de v1.0 (#1739/#1747) — marcador regrediu");
  }
});

Deno.test("disparar-pedidos-aprovados: o EFEITO precisa avisar que dry_run NÃO protege", () => {
  // É a armadilha que originou o #1747: `dry_run` chama IncluirPedCompra incondicionalmente e cria
  // PO real. Se esta frase sumir da recusa, o próximo a ler "dry_run" repete o erro.
  if (!/dry_run/.test(disparar.EFEITO)) {
    throw new Error(`EFEITO não menciona dry_run: ${disparar.EFEITO}`);
  }
});

Deno.test("enviar-pedido-portal-sayerlack: o EFEITO precisa dizer que o FORNECEDOR recebe", () => {
  // O custo aqui não é banco nem ERP: é um terceiro recebendo um pedido que não dá para desfazer.
  if (!/fornecedor/i.test(portalSayerlack.EFEITO)) {
    throw new Error(`EFEITO não menciona o fornecedor: ${portalSayerlack.EFEITO}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Edges do farmer (#1520) — o marcador aqui existe para discriminar FATIA, não provedor.
// As duas nasceram sem prova de deploy: a `generate-bundle-argument` não tinha sensor nenhum, e a
// `generate-tactical-plan` tinha dois que respondem verde com o bundle anterior.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("edges do farmer: o marcador NOMEIA a fatia, não é o genérico inicial", () => {
  // `v1.0-sensor-inicial` diz "existe sensor" e nada mais. Nestas duas o sensor nasceu para provar
  // uma MUDANÇA específica (#1520), então o slug tem de citá-la — senão o próximo a verificar lê
  // "sensor no ar" e conclui, errado, que a fatia subiu.
  const esperado: Array<[string, string]> = [
    ["generate-bundle-argument", "v1.0-prompt-sem-margem"],
    ["generate-tactical-plan", "v1.0-afinidade-ordena"],
  ];
  const real: Record<string, string> = {
    "generate-bundle-argument": argumento.VERSAO,
    "generate-tactical-plan": tatico.VERSAO,
  };
  for (const [nome, marcador] of esperado) {
    if (real[nome] !== marcador) {
      throw new Error(
        `${nome}: marcador mudou sem atualizar este gate (${real[nome]} ≠ ${marcador}). ` +
          `Bump é legítimo — atualize aqui E em docs/agent/deploy.md, senão a verificação passa a ` +
          `comparar com um valor que não existe mais.`,
      );
    }
  }
});

const fonteDaEdge = (nome: string) => Deno.readTextFileSync(`supabase/functions/${nome}/index.ts`);

/**
 * Fonte SEM linha de comentário. O gate abaixo proíbe uma FORMA de código, e o comentário que
 * explica por que aquela forma saiu cita a forma — foi assim que este teste ficou vermelho na
 * primeira execução, contra uma edge correta. Mesma solução do gate `afinidade não é dinheiro`.
 */
const codigoDaEdge = (nome: string) =>
  fonteDaEdge(nome).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

Deno.test("edges do farmer: a sonda decide por classificarSonda, não por `=== true` cru", () => {
  // O founder invoca do SQL Editor, onde `jsonb_build_object('probe', true)` vira a STRING "true"
  // com facilidade. Um `body.probe === true` cru mandaria essa chamada para o fluxo real — LLM,
  // e no tactical-plan a GRAVAÇÃO do plano via service_role.
  for (const nome of ["generate-bundle-argument", "generate-tactical-plan"]) {
    const codigo = codigoDaEdge(nome);
    if (!/classificarSonda\(/.test(codigo)) {
      throw new Error(`${nome}: não chama classificarSonda — a sonda não é fail-closed`);
    }
    if (/\bbody\.probe\s*===\s*true/.test(codigo)) {
      throw new Error(`${nome}: voltou o \`body.probe === true\` cru — "true" string cai no fluxo real`);
    }
  }
});

Deno.test("generate-tactical-plan: a canária ecoa `contrato`, senão mente verde", () => {
  // Armadilha 2 de docs/agent/deploy.md: deploy integralmente velho carrega o `expected` velho e
  // compara velho×velho. `ok:true` sozinho não discrimina reversão de fatia.
  const codigo = codigoDaEdge("generate-tactical-plan");
  const bloco = codigo.slice(codigo.indexOf("body.canary === true"));
  if (!/canary:\s*true[^}]*contrato:\s*VERSAO/.test(bloco)) {
    throw new Error("a resposta da canária não ecoa `contrato: VERSAO` junto do `canary: true`");
  }
});

Deno.test("CALIBRAÇÃO: os padrões acima reprovam a forma PRÉ-fix e aprovam a PÓS", () => {
  // Sem isto os três testes acima só provariam que os arquivos existem (docs/agent/deploy.md:
  // "canária que não discrimina é teatro verde"). Aqui a forma antiga tem de FALHAR.
  const preSonda = `if (body.probe === true) {\n  return new Response(JSON.stringify({ ok: true, motor: 'anthropic' }));\n}`;
  if (!/body\.probe\s*===\s*true/.test(preSonda)) {
    throw new Error("o padrão do `=== true` cru não casa a forma pré-fix — não detectaria a volta");
  }
  if (/classificarSonda\(/.test(preSonda)) {
    throw new Error("o padrão de classificarSonda casa a forma pré-fix — falso verde");
  }

  const preCanaria = `JSON.stringify({ canary: true, ok, resultados })`;
  if (/canary:\s*true[^}]*contrato:\s*VERSAO/.test(preCanaria)) {
    throw new Error("o padrão do `contrato` aprova a canária SEM marcador — falso verde");
  }
  const posCanaria = `JSON.stringify({ canary: true, contrato: VERSAO, ok, resultados })`;
  if (!/canary:\s*true[^}]*contrato:\s*VERSAO/.test(posCanaria)) {
    throw new Error("o padrão do `contrato` reprova a forma pós-fix — falso vermelho");
  }

  // O filtro de comentário não pode CEGAR o gate: ele tira a linha que só EXPLICA a forma proibida
  // (foi o que deixou este arquivo vermelho contra uma edge correta), mas a forma em CÓDIGO tem de
  // continuar visível. Sem este par, "ignore comentários" viraria "ignore tudo".
  const semComentario = (s: string) =>
    s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const soComentario = "  // `classificarSonda` no lugar de `body.probe === true`: o SQL Editor manda string";
  if (/\bbody\.probe\s*===\s*true/.test(semComentario(soComentario))) {
    throw new Error("o filtro não removeu o comentário — o gate reprovaria edge correta");
  }
  const codigoProibido = "    if (body.probe === true) {";
  if (!/\bbody\.probe\s*===\s*true/.test(semComentario(codigoProibido))) {
    throw new Error("o filtro comeu CÓDIGO — o gate deixaria a forma proibida voltar em silêncio");
  }
});
