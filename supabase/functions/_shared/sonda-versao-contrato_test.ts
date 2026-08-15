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
import * as argumento from "../generate-bundle-argument/versao.ts";
import * as nfeRecebimento from "../omie-nfe-recebimento/versao.ts";
import * as processNfe from "../process-nfe/versao.ts";
import * as capturaPrecos from "../sayerlack-captura-precos/versao.ts";
import * as deparaAuto from "../reposicao-depara-sayerlack-auto/versao.ts";

const EDGES: Array<{ nome: string; mod: { VERSAO: string; EFEITO: string } }> = [
  { nome: "disparar-pedidos-aprovados", mod: disparar },
  { nome: "enviar-pedido-portal-sayerlack", mod: portalSayerlack },
  { nome: "conciliar-pedido-portal", mod: conciliar },
  { nome: "gerar-pedidos-diario", mod: gerarDiario },
  { nome: "pedido-programado-enviar", mod: programado },
  { nome: "generate-tactical-plan", mod: tactical },
  { nome: "generate-bundle-argument", mod: argumento },
  // Segunda leva (#1753): efeito irreversível FORA do nosso banco, nenhuma delas tinha sensor.
  { nome: "omie-nfe-recebimento", mod: nfeRecebimento },
  { nome: "process-nfe", mod: processNfe },
  { nome: "sayerlack-captura-precos", mod: capturaPrecos },
  { nome: "reposicao-depara-sayerlack-auto", mod: deparaAuto },
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

// ─────────────────────────────────────────────────────────────────────────────
// generate-bundle-argument — a irmã da tactical-plan no #1520, e o caso mais agudo: a única das
// duas SEM sensor nenhum (nem sonda, nem canária), e a única cujo dano já é ATIVO. O front
// publicado parou de mandar `margin`/`lieBundle`; o bundle anterior imprime `p.margin.toFixed(2)`
// incondicionalmente → TypeError → HTTP 500, o argumento de venda não gera.
// ─────────────────────────────────────────────────────────────────────────────

// Fonte da edge SEM comentário — o gate proíbe uma FORMA de código, e o comentário que explica por
// que a forma saiu cita a forma. Sem o filtro, o gate fica vermelho contra uma edge correta
// (aconteceu na primeira execução deste arquivo). Mesma solução do gate `afinidade não é dinheiro`.
// Os blocos de comentário saem ANTES do filtro de linha: um JSDoc não começa com barra-barra em
// toda linha, então o filtro de linha sozinho o deixaria passar inteiro.
function codigoDaEdge(nome: string): string {
  return Deno.readTextFileSync(`supabase/functions/${nome}/index.ts`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

Deno.test("generate-bundle-argument: a sonda decide por classificarSonda, não por `=== true` cru", () => {
  // O founder invoca do SQL Editor, onde `jsonb_build_object('probe', true)` vira a STRING "true"
  // com facilidade. Um `=== true` cru mandaria a verificação para o fluxo real — token gasto, e
  // pior: a resposta ficaria indistinguível de "bundle velho", corrompendo a única prova que a
  // sonda existe para dar.
  const codigo = codigoDaEdge("generate-bundle-argument");
  if (!/classificarSonda\(/.test(codigo)) {
    throw new Error("não chama classificarSonda — a sonda não é fail-closed");
  }
  if (/\bbody\.probe\s*===\s*true/.test(codigo)) {
    throw new Error("voltou o `body.probe === true` cru — \"true\" string cai no fluxo real");
  }
});

Deno.test("generate-bundle-argument: a sonda responde ANTES do createClient e do modelo", () => {
  // O valor da sonda é ser o único caminho sem custo. Se ela migrar para depois do `createClient`
  // ou do `new Anthropic`, deixa de ser barata e volta a haver motivo para não rodá-la.
  const codigo = codigoDaEdge("generate-bundle-argument");
  const posSonda = codigo.indexOf("classificarSonda(");
  const posCliente = codigo.indexOf("createClient(");
  const posModelo = codigo.indexOf("new Anthropic(");
  if (posSonda < 0 || posCliente < 0 || posModelo < 0) {
    throw new Error("âncoras não encontradas — o gate mediu o arquivo errado (controle positivo vazio)");
  }
  if (posSonda > posCliente || posSonda > posModelo) {
    throw new Error("a sonda desceu para depois do createClient/Anthropic — deixou de ser IO-free");
  }
});

Deno.test("CALIBRAÇÃO: os padrões reprovam a forma PRÉ-fix e o filtro não cega o gate", () => {
  // Sem isto os dois testes acima só provariam que o arquivo existe (deploy.md: "canária que não
  // discrimina é teatro verde"). A forma antiga tem de FALHAR, e o filtro de comentário tem de
  // apagar SÓ comentário — se comesse código, a forma proibida voltaria em silêncio.
  const semComentario = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  const soComentario = "  // `classificarSonda` no lugar de `body.probe === true`: o SQL Editor manda string";
  if (/\bbody\.probe\s*===\s*true/.test(semComentario(soComentario))) {
    throw new Error("o filtro não removeu o comentário — o gate reprovaria edge correta");
  }
  const codigoProibido = "    if (body.probe === true) {";
  if (!/\bbody\.probe\s*===\s*true/.test(semComentario(codigoProibido))) {
    throw new Error("o filtro comeu CÓDIGO — o gate deixaria a forma proibida voltar em silêncio");
  }
  const jsdoc = "/**\n * exemplo com body.probe === true dentro de bloco\n */";
  if (/\bbody\.probe\s*===\s*true/.test(semComentario(jsdoc))) {
    throw new Error("bloco /* */ escapou do filtro — JSDoc citando a forma reprovaria edge correta");
Deno.test("as duas edges que EFETIVAM NF-e dizem isso no EFEITO", () => {
  // `omie-nfe-recebimento` e `process-nfe` são GÊMEAS: rodam a MESMA tríade no Omie
  // (AlterarRecebimento → AlterarEtapaRecebimento etapa 40 → ConcluirRecebimento), que dá entrada
  // de estoque e fiscal no ERP. O risco de quem lê só uma é achar que corrigiu as duas — o assert
  // existe para que a segunda não fique para trás em silêncio num bump futuro.
  for (const { nome, mod } of [
    { nome: "omie-nfe-recebimento", mod: nfeRecebimento },
    { nome: "process-nfe", mod: processNfe },
  ]) {
    if (!/efetiva/i.test(mod.EFEITO) || !/omie/i.test(mod.EFEITO)) {
      throw new Error(`${nome}: EFEITO não diz que EFETIVA a NF-e no Omie: ${mod.EFEITO}`);
    }
  }
});

Deno.test("process-nfe: o EFEITO precisa avisar que NÃO existe dry_run", () => {
  // Das edges instrumentadas até aqui, esta é a que menos perdoa: efetiva NF-e e não tem modo de
  // teste NENHUM — nem `dry_run`, nem o `diagnostico` read-only que a gêmea tem. Quem procurar um
  // caminho seguro no corpo do arquivo não vai achar, e precisa descobrir isso pela recusa.
  if (!/dry_run/.test(processNfe.EFEITO)) {
    throw new Error(`EFEITO não menciona a ausência de dry_run: ${processNfe.EFEITO}`);
  }
});

Deno.test("sayerlack-captura-precos: o EFEITO precisa dizer que é o portal do FORNECEDOR", () => {
  // Ela não envia pedido (teste-invariante próprio garante), mas monta linha no pedido do portal
  // para ler preço — e um aborto deixa rascunho que o operador humano confunde com pedido próprio.
  // Sem "fornecedor" no texto, a recusa parece falar de uma tabela nossa.
  if (!/fornecedor/i.test(capturaPrecos.EFEITO)) {
    throw new Error(`EFEITO não menciona o fornecedor: ${capturaPrecos.EFEITO}`);
  }
});
