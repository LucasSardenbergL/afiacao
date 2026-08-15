// Gate de CONTRATO das sondas de versão: uma linha por edge instrumentada.
//
// Por que um arquivo só, em vez de um teste por edge: o classificador já é compartilhado e testado
// em `sonda-versao_test.ts`; o que sobra por edge é o MARCADOR. Concentrar aqui torna visível o
// conjunto — quem adicionar a sonda numa edge nova e esquecer de registrar percebe no diff, e quem
// quebrar o formato de um marcador quebra um teste com nome que diz qual edge é.
//
// Estes imports atravessam diretórios de function DE PROPÓSITO e só valem em teste: os `versao.ts`
// não têm import remoto (o classificador vem de `_shared/`; a `generate-tactical-plan` também puxa
// o `plano-helpers.ts` dela, que não importa nada), então `--no-remote` passa. Nenhum código de
// produção importa através dessa fronteira.

import * as disparar from "../disparar-pedidos-aprovados/versao.ts";
import * as portalSayerlack from "../enviar-pedido-portal-sayerlack/versao.ts";
import * as conciliar from "../conciliar-pedido-portal/versao.ts";
import * as gerarDiario from "../gerar-pedidos-diario/versao.ts";
import * as programado from "../pedido-programado-enviar/versao.ts";
import * as tactical from "../generate-tactical-plan/versao.ts";

const EDGES: Array<{ nome: string; mod: { VERSAO: string; EFEITO: string } }> = [
  { nome: "disparar-pedidos-aprovados", mod: disparar },
  { nome: "enviar-pedido-portal-sayerlack", mod: portalSayerlack },
  { nome: "conciliar-pedido-portal", mod: conciliar },
  { nome: "gerar-pedidos-diario", mod: gerarDiario },
  { nome: "pedido-programado-enviar", mod: programado },
  { nome: "generate-tactical-plan", mod: tactical },
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

Deno.test("generate-tactical-plan: o marcador NOMEIA a fatia — 'sensor-inicial' aqui seria falso", () => {
  // As outras cinco nasceram com o sensor, então `v1.0-sensor-inicial` descreve a verdade delas.
  // Nesta o sensor é ANTERIOR (o `{"probe":true}` do #1618): o que nasce agora é o MARCADOR, e ele
  // nasce nomeando o contrato do #1520 — a entrega cuja prova de deploy faltou. Normalizar para
  // "sensor-inicial" apagaria justamente a informação pela qual o marcador existe.
  // A anotação `: string` é NECESSÁRIA, não ruído: `VERSAO` é `const`, então o TS a estreita ao tipo
  // literal e recusa a comparação com TS2367 ("no overlap") — o compilador já sabe que hoje difere.
  // O teste guarda a mudança FUTURA, que é runtime. Os outros asserts deste arquivo escapam disso
  // por passarem pelo `EDGES`, cujo tipo declarado já alarga para `string`.
  const versaoTactical: string = tactical.VERSAO;
  if (versaoTactical === "v1.0-sensor-inicial") {
    throw new Error("generate-tactical-plan: a sonda é pré-existente (#1618) — o marcador tem de nomear a fatia");
  }
});
