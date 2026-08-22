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

import { removerComentarios } from "./limpeza-fonte.ts";
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
import * as omieCliente from "../omie-cliente/versao.ts";
import * as recommendMod from "../recommend/versao.ts";
import * as cashflow from "../fin-cashflow-engine/versao.ts";
import * as syncEstoque from "../omie-sync-estoque/versao.ts";
import * as syncNfes from "../omie-sync-nfes-recebidas/versao.ts";
import * as nfeWebhook from "../omie-nfe-webhook/versao.ts";

/**
 * `respostaSonda` (a maioria) ou `respostaSondaTactical` (a `generate-tactical-plan`, que embrulha o
 * contrato num composer). O gate abaixo exige que UMA das duas exista — edge instrumentada sem
 * nenhuma delas não tem como ser verificada em produção.
 */
type CorpoSonda = { ok: true; probe: true; versao: string; edge: string };
type ModSonda = {
  VERSAO: string;
  EFEITO: string;
  respostaSonda?: (versao: string) => CorpoSonda;
  respostaSondaTactical?: () => CorpoSonda;
};

const EDGES: Array<{ nome: string; mod: ModSonda }> = [
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
  // Terceira leva (#1767): escrita money-path no NOSSO banco, nenhuma delas tinha sensor. A leitura
  // pura (fin-funding, fin-valor-engine, …) ficou de fora de propósito: chamá-la já é grátis, então
  // a sonda não resolve problema que ela tenha.
  { nome: "omie-cliente", mod: omieCliente },
  { nome: "fin-cashflow-engine", mod: cashflow },
  { nome: "omie-sync-estoque", mod: syncEstoque },
  { nome: "omie-sync-nfes-recebidas", mod: syncNfes },
  { nome: "omie-nfe-webhook", mod: nfeWebhook },
  // Quarta leva (#canaria-recommend): mesma regra da terceira — escrita money-path no NOSSO
  // banco. `recommend` grava `recommendation_log`, que é o SENSOR DE DESFECHO do motor
  // (#1851): sondar sem guarda inventaria uma recomendação que ninguém fez e enviesaria a
  // própria medição de acerto. Não é leitura pura — por isso não cai na exceção declarada
  // acima (fin-funding, fin-valor-engine).
  { nome: "recommend", mod: recommendMod },
];

/** As cinco da terceira leva — os gates estruturais abaixo varrem todas. */
const ESCRITA_NOSSO_BANCO = [
  "recommend",
  "omie-cliente",
  "fin-cashflow-engine",
  "omie-sync-estoque",
  "omie-sync-nfes-recebidas",
  "omie-nfe-webhook",
];

/** Destas o gate NÃO aceita `x-cron-secret`, então a sonda precisa de gate PRÓPRIO. */
const GATE_PROPRIO = ["omie-cliente", "omie-nfe-webhook"];

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
//
// A limpeza vem do módulo COMPARTILHADO (espelho byte-idêntico de `src/lib/gates/limpeza-fonte.ts`,
// amarrado por `limpeza-fonte.parity.test.ts`). A cópia local que vivia aqui era regex pura: não
// sabia o que era string — um abre-bloco dentro de aspas pareava com o próximo fecha-bloco REAL do
// arquivo e apagava tudo entre os dois ANTES da medição, verde por CEGUEIRA
// (docs/historico/gates-textuais-cegos.md). Ela também só descartava a linha que COMEÇAVA com
// barra-barra, deixando comentário de fim-de-linha ser medido como código.
function codigoDaEdge(nome: string): string {
  return removerComentarios(Deno.readTextFileSync(`supabase/functions/${nome}/index.ts`));
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
  const semComentario = removerComentarios;

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
  }
});

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

// ─────────────────────────────────────────────
// Terceira leva (#1767) — as cinco que ESCREVEM money-path no nosso banco. Os três gates abaixo
// varrem o conjunto em vez de citar edge por edge: o que se quer garantir é a FORMA (fail-closed,
// IO-free, nunca sem auth), e ela vale igual para as cinco. Um gate por edge envelheceria pior —
// a sexta entraria sem ninguém notar que ficou de fora.
// ─────────────────────────────────────────────

/** Só o corpo do handler: em várias destas edges há `createClient` em helper de topo de arquivo,
 *  e medir o arquivo inteiro compararia a sonda com uma âncora que nem roda por requisição. */
function trechoDoHandler(nome: string): string {
  const codigo = codigoDaEdge(nome);
  const i = codigo.indexOf("Deno.serve(");
  if (i < 0) throw new Error(`${nome}: 'Deno.serve(' não encontrado — o gate mediu o arquivo errado`);
  return codigo.slice(i);
}

Deno.test("toda edge instrumentada RESPONDE à sonda (chamar classificarSonda não basta)", () => {
  // Buraco encontrado ao falsificar a canária da `recommend`: apagar a linha que RESPONDE
  // (`if (decisao.tipo === "sonda") return ...respostaSonda(VERSAO)`) deixava todos os gates
  // VERDES. Os vizinhos afirmam que `classificarSonda` é CHAMADA e que vem antes do
  // `createClient` — nenhum afirma que a decisão vira RESPOSTA. Uma edge assim classifica a
  // sonda e seguve para o fluxo real: o efeito caro roda, e quem sondou lê o resultado do
  // disparo como se fosse diagnóstico. É o pior desfecho que a sonda existe para evitar,
  // passando por instrumentado.
  for (const { nome } of EDGES) {
    const codigo = codigoDaEdge(nome);
    // `\w*` porque a resposta pode ter nome próprio: `generate-tactical-plan` exporta
    // `respostaSondaTactical()`. Exigir o nome exato reprovava uma edge que responde certo.
    if (!/respostaSonda\w*\(/.test(codigo)) {
      throw new Error(`${nome}: classifica a sonda mas nunca chama respostaSonda — o diagnóstico não sai`);
    }
    if (!/["\x27]sonda["\x27]/.test(codigo)) {
      throw new Error(`${nome}: não ramifica no tipo "sonda" — a decisão é calculada e descartada`);
    }
  }
});

Deno.test("terceira leva: a sonda decide por classificarSonda, não por `=== true` cru", () => {
  // Mesmo motivo do gate da generate-bundle-argument: o founder invoca do SQL Editor, onde
  // `jsonb_build_object('probe', true)` vira a STRING "true" com facilidade. Aqui o preço de cair
  // no fluxo real é criar placeholder+profile, reescrever saldo ou gravar projeção de caixa.
  for (const nome of ESCRITA_NOSSO_BANCO) {
    const codigo = codigoDaEdge(nome);
    if (!/classificarSonda\(/.test(codigo)) {
      throw new Error(`${nome}: não chama classificarSonda — a sonda não é fail-closed`);
    }
    if (/\bbody\.probe\s*===\s*true/.test(codigo)) {
      throw new Error(`${nome}: voltou o \`body.probe === true\` cru — "true" string cai no fluxo real`);
    }
  }
});

Deno.test("terceira leva: a sonda responde ANTES do createClient do handler", () => {
  // O valor da sonda é ser o único caminho sem custo. Na `omie-sync-nfes-recebidas` o parse do
  // corpo estava DEPOIS do `createClient` e teve de subir; este gate é o que impede a volta.
  for (const nome of ESCRITA_NOSSO_BANCO) {
    const h = trechoDoHandler(nome);
    const posSonda = h.indexOf("classificarSonda(");
    const posCliente = h.indexOf("createClient(");
    if (posSonda < 0 || posCliente < 0) {
      throw new Error(`${nome}: âncoras não encontradas no handler (controle positivo vazio)`);
    }
    if (posSonda > posCliente) {
      throw new Error(`${nome}: a sonda desceu para depois do createClient — deixou de ser IO-free`);
    }
  }
});

Deno.test("gate próprio: onde o gate da edge não aceita cron-secret, a sonda NÃO fica sem auth", () => {
  // `omie-cliente` e `omie-nfe-webhook` respondem a sonda ANTES do gate delas (por-ação numa,
  // `x-webhook-secret` na outra) — nenhum dos dois aceita `x-cron-secret`, que é como o founder
  // invoca do SQL Editor. O desvio só é legítimo porque a sonda traz gate PRÓPRIO. Sem este
  // assert, apagar a linha do `authorizeCronOrStaff` abriria um caminho anônimo — e na
  // `omie-cliente` ele seria PÚBLICO de fato, já que `buscar_por_documento` não exige JWT.
  for (const nome of GATE_PROPRIO) {
    const h = trechoDoHandler(nome);
    const posSonda = h.indexOf("classificarSonda(");
    const posResposta = h.indexOf("respostaSonda(");
    if (posSonda < 0 || posResposta < 0 || posResposta < posSonda) {
      throw new Error(`${nome}: âncoras da sonda não encontradas em ordem (controle positivo vazio)`);
    }
    if (!/authorizeCronOrStaff\(req\)/.test(h.slice(posSonda, posResposta))) {
      throw new Error(`${nome}: a sonda responde sem gate próprio entre a classificação e a resposta`);
    }
  }
});

Deno.test("CALIBRAÇÃO: os gates da terceira leva reprovam a forma errada", () => {
  // Sem isto os três acima só provariam que os arquivos existem (deploy.md: "canária que não
  // discrimina é teatro verde"). Cada padrão é exercitado contra a forma que ele existe para
  // barrar, montada aqui como texto — não dá para sabotar as edges reais dentro do teste.
  const handlerErrado = 'Deno.serve(async (req) => {\n  const c = createClient(a, b);\n  classificarSonda(body);\n';
  const iSonda = handlerErrado.indexOf("classificarSonda(");
  const iCliente = handlerErrado.indexOf("createClient(");
  if (!(iSonda > iCliente)) {
    throw new Error("o gate de posição não reprovaria uma sonda depois do createClient");
  }
  const semGate = 'classificarSonda(body);\n  return jsonRes(respostaSonda(VERSAO), 200);';
  if (/authorizeCronOrStaff\(req\)/.test(semGate.slice(0, semGate.indexOf("respostaSonda(")))) {
    throw new Error("o gate de auth não reprovaria uma sonda sem gate próprio");
  }
  const cru = "    if (body.probe === true) {";
  if (!/\bbody\.probe\s*===\s*true/.test(cru)) {
    throw new Error("o padrão do `=== true` cru não casa a própria forma que proíbe");
  }
});

Deno.test("omie-cliente: o EFEITO precisa nomear `profiles` — o discriminante dos aliases fiscais", () => {
  // É a lição mais cara do repo já redescoberta 2× (CLAUDE.md §Armadilhas / database.md §5): a
  // AUSÊNCIA de `profiles` é o que separa os ~1.633 aliases fiscais `@placeholder.local` de lixo
  // de import. Esta edge CRIA os dois (auth.users + profiles). Se a recusa não nomear `profiles`,
  // quem tomar o 400 lê "sincroniza clientes" e retenta achando que o custo é uma chamada ao Omie.
  if (!/profiles/i.test(omieCliente.EFEITO)) {
    throw new Error(`EFEITO não menciona profiles: ${omieCliente.EFEITO}`);
  }
  if (!/auth\.users/i.test(omieCliente.EFEITO)) {
    throw new Error(`EFEITO não menciona auth.users: ${omieCliente.EFEITO}`);
  }
});

Deno.test("omie-sync-nfes-recebidas: o EFEITO precisa avisar que o run FABRICA frescor", () => {
  // `fin_sync_log` é lido SEM filtro de `action` por `_data_health_compute` e
  // `fin_calcular_confiabilidade` (só o `fin_sync_heartbeat` filtra) — o mesmo desenho que fez a
  // probe do `omie-financeiro` precisar do `PROBE_ACTIONS`/`logId=""`. Um run supérfluo aqui não
  // custa só tempo: sobe a confiabilidade que o financeiro exibe.
  if (!/fin_sync_log/.test(syncNfes.EFEITO)) {
    throw new Error(`EFEITO não menciona fin_sync_log: ${syncNfes.EFEITO}`);
  }
});

Deno.test("omie-sync-estoque: o EFEITO precisa dizer que o run APAGA o sinal de que foi ruim", () => {
  // Ela avança o marcador de frescor do Sentinela junto com o saldo. É a falha silenciosa por
  // desenho: o run parcial escreve saldo pela metade E carimba "fresco", então o próprio sensor
  // que deveria acusar passa a atestar. Sem isto no texto, a recusa parece falar de um upsert
  // qualquer — e a decisão de retentar sai errada.
  if (!/sync_state|frescor|marcador/i.test(syncEstoque.EFEITO)) {
    throw new Error(`EFEITO não menciona o marcador de frescor: ${syncEstoque.EFEITO}`);
  }
});

Deno.test("a resposta da sonda IDENTIFICA a edge que respondeu", () => {
  // O bug que este gate fecha (2026-08-18): `versao` sozinho NÃO identifica quem respondeu — o
  // marcador nasce igual em toda uma leva (o gate de marcadores acima até assere isso). Dez sondas
  // voltaram 200 com corpos byte a byte idênticos e o veredito por edge foi IMPOSSÍVEL de emitir;
  // nada no banco desfaz o empate (`net._http_response` não guarda a URL, a fila é esvaziada, os
  // headers são só do Cloudflare). Ver `docs/historico/verificar-sonda-versao.md` §7.
  for (const { nome, mod } of EDGES) {
    const corpo = mod.respostaSonda?.(mod.VERSAO) ?? mod.respostaSondaTactical?.();
    if (!corpo) {
      throw new Error(`${nome}: não exporta respostaSonda nem respostaSondaTactical`);
    }
    if (corpo.edge !== nome) {
      throw new Error(
        `${nome}: a sonda se identifica como ${JSON.stringify(corpo.edge)} — o nome tem de ser o do ` +
          `diretório da function, senão o veredito aponta para a edge errada`,
      );
    }
    if (corpo.probe !== true) throw new Error(`${nome}: sonda sem o eco probe:true`);
    if (corpo.versao !== mod.VERSAO) {
      throw new Error(`${nome}: sonda devolve versao ${JSON.stringify(corpo.versao)} ≠ VERSAO`);
    }
  }
});

Deno.test("duas edges NUNCA produzem respostas de sonda idênticas", () => {
  // A asserção que falha no desenho antigo: sem o campo `edge`, todas as edges de uma mesma leva
  // devolviam exatamente o mesmo corpo. É esta indistinguibilidade — não a ausência do nome em si —
  // que destrói a verificação quando mais de uma sonda é disparada.
  const porCorpo = new Map<string, string[]>();
  for (const { nome, mod } of EDGES) {
    const corpo = mod.respostaSonda?.(mod.VERSAO) ?? mod.respostaSondaTactical?.();
    const chave = JSON.stringify(corpo);
    porCorpo.set(chave, [...(porCorpo.get(chave) ?? []), nome]);
  }
  const colisoes = [...porCorpo.values()].filter((edges) => edges.length > 1);
  if (colisoes.length > 0) {
    throw new Error(
      `respostas de sonda indistinguíveis entre edges: ${
        colisoes.map((e) => e.join(" ≡ ")).join("; ")
      }`,
    );
  }
});
