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
import * as analyticsSync from "../omie-analytics-sync/versao.ts";
import * as valorCockpit from "../fin-valor-cockpit/versao.ts";
import * as finFunding from "../fin-funding/versao.ts";
import * as algoAudit from "../algorithm-a-audit/versao.ts";
import * as positivacao from "../carteira-positivacao-snapshot/versao.ts";
import * as omieFinanceiro from "../omie-financeiro/versao.ts";
import * as analyzeOrder from "../analyze-unified-order/versao.ts";
import * as calcScores from "../calculate-scores/versao.ts";
import * as aiOps from "../ai-ops-agent/versao.ts";
import * as statusProdutos from "../omie-sync-status-produtos/versao.ts";
import * as scoringBatch from "../scoring-recalc-batch/versao.ts";
import * as syncReprocess from "../sync-reprocess/versao.ts";
import * as tacticalBatch from "../tactical-plans-batch/versao.ts";
import * as visitBatch from "../visit-score-recalc-batch/versao.ts";
import * as monthlyReport from "../monthly-report/versao.ts";

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
  // Quinta leva (#1889 paginação): a `omie-analytics-sync` escreve product_costs, order_items,
  // sales_orders e inventory_position — mesma regra da terceira leva. Ela JÁ tinha uma canária
  // (`doc_ambiguo_probe`), mas NÃO-VERSIONADA: responde `probe_no_ar:true` igual num bundle de hoje
  // e num de três fatias atrás, então não discrimina deploy integralmente velho (a ⚠️ #2 de
  // docs/agent/deploy.md, que classifica versioná-las como dívida aberta). O marcador fecha isso.
  { nome: "omie-analytics-sync", mod: analyticsSync },
  // Sexta leva (#1889 paginação, parte 2): as cinco edges de MAIOR leitura entre as 17 que
  // ainda serviam o `paginate.ts` velho. Duas delas — `fin-valor-cockpit` e `fin-funding` —
  // são leitura PURA, que a terceira leva excluiu de propósito ("chamá-la já é grátis, então a
  // sonda não resolve problema que ela tenha"). A exceção segue válida para o problema que ela
  // endereçava (efeito colateral caro) e NÃO cobre este: o #1889 é no-op por DESENHO enquanto o
  // `max-rows` de prod for 1000, então a resposta do fluxo real é byte-idêntica nos dois
  // bundles e chamar a edge — de graça ou não — não diz qual está no ar
  // (docs/historico/deploy-no-op-por-desenho.md). Barato de chamar e possível de verificar são
  // propriedades diferentes; só o marcador dá a segunda.
  { nome: "fin-valor-cockpit", mod: valorCockpit },
  { nome: "fin-funding", mod: finFunding },
  { nome: "algorithm-a-audit", mod: algoAudit },
  { nome: "carteira-positivacao-snapshot", mod: positivacao },
  { nome: "omie-financeiro", mod: omieFinanceiro },
  // Sétima leva (#1622 prompt invertido): a PRIMEIRA que entra sem escrever no nosso banco E sem
  // ser leitura barata. O critério dela é o SEGUNDO motivo do #1520 — "não existe caminho de
  // prova": é chamada pelo BROWSER, então não deixa rastro em `net._http_response` nem linha em
  // `cron.job_run_details`, o par que torna uma edge auditável de fora. Ela TEM canária desde o
  // d8cf07152, e a canária é versionada — mas o `contrato` dela nomeia a fatia do MERGE DE PREÇO,
  // não a do prompt, e ela vive depois do gate de staff. Ver `analyze-unified-order/versao.ts`.
  { nome: "analyze-unified-order", mod: analyzeOrder },
  // Oitava leva (#1889/#1901 paginação, parte 3): as 7 dependentes do `paginate.ts` que não
  // tinham sensor NENHUM — nem sonda, nem canária. Enquanto a sexta leva tratava edges cujo
  // deploy era mal verificável, estas eram INVERIFICÁVEIS: sem marcador e sem fixture possível
  // (o #1889 é no-op por DESENHO), a única resposta para "qual bundle está no ar?" era nenhuma.
  // Quatro escrevem direto no nosso banco; três são batches que escrevem por FAN-OUT, chamando
  // outra edge — o custo sai desta edge e cai na de baixo, o que torna o rastro mais difícil de
  // ler depois, não mais fácil. As duas listas abaixo separam os dois casos.
  { nome: "calculate-scores", mod: calcScores },
  { nome: "ai-ops-agent", mod: aiOps },
  { nome: "omie-sync-status-produtos", mod: statusProdutos },
  { nome: "sync-reprocess", mod: syncReprocess },
  { nome: "scoring-recalc-batch", mod: scoringBatch },
  { nome: "visit-score-recalc-batch", mod: visitBatch },
  { nome: "tactical-plans-batch", mod: tacticalBatch },
  // Nona leva (#1889 paginação, parte 4): a edge que o `git grep -l` do helper NÃO enxergava.
  // Separada da oitava de propósito — aquelas eram edges SEM sensor; esta estava fora da própria
  // ENUMERAÇÃO. `monthly-report` chega ao `paginate.ts` por um salto (`_shared/relatorio-mensal.ts`),
  // então nunca aparecia na lista de "quem serve o helper" — a relação é de grafo, o grep é local
  // (docs/historico/enumerar-consumidores-de-helper.md). Entra pelo critério mais duro da lista:
  // o bundle VELHO ignorando `probe` não erra um número, ele ENVIA e-mail para a base inteira,
  // porque os defaults do corpo armam o envio por omissão. Ver `monthly-report/versao.ts`.
  { nome: "monthly-report", mod: monthlyReport },
];

/** As cinco da terceira leva — os gates estruturais abaixo varrem todas. */
const ESCRITA_NOSSO_BANCO = [
  "recommend",
  "omie-cliente",
  "fin-cashflow-engine",
  "omie-sync-estoque",
  "omie-sync-nfes-recebidas",
  "omie-nfe-webhook",
  "omie-analytics-sync",
  // Oitava leva: escrita DIRETA. `calculate-scores` aplica `apply_score_updates`; `ai-ops-agent`
  // apaga e regrava `ai_decisions`; `omie-sync-status-produtos` reescreve `sku_status_omie` e o
  // flag `ativo` de `omie_products`; `sync-reprocess` deleta/reinsere `order_items` e faz upsert
  // em `product_costs`.
  "calculate-scores",
  "ai-ops-agent",
  "omie-sync-status-produtos",
  "sync-reprocess",
];

/**
 * Oitava leva, o outro caso: batches que NÃO escrevem — eles CHAMAM a edge que escreve.
 *
 * Lista própria, e não uma linha a mais em `ESCRITA_NOSSO_BANCO`, porque a diferença é operacional
 * e muda o veredito de quem sonda: aqui o efeito de um disparo acidental não aparece nesta edge,
 * aparece na de baixo (`scoring-recalc-client`, `visit-score-recalc-client`,
 * `generate-tactical-plan`). Chamar isso de "escrita no nosso banco" faria o próximo leitor
 * procurar o rastro no lugar errado. A FORMA exigida delas é a mesma — por isso entram inteiras em
 * `FORMA_NORMALIZADA` logo abaixo.
 */
const FAN_OUT_QUE_ESCREVE = [
  "scoring-recalc-batch",
  "visit-score-recalc-batch",
  "tactical-plans-batch",
];

/**
 * Os gates estruturais abaixo (fail-closed, IO-free, nunca sem auth) varrem ESTA lista, não só a
 * terceira leva: a FORMA que eles exigem não tem nada a ver com escrever no banco — vale para
 * qualquer edge instrumentada. A sexta leva entra junto porque nasceu já nessa forma; as levas 1
 * e 2 ficam de fora porque têm formas legadas que nunca foram normalizadas, e alargar a
 * varredura para elas é mudança de escopo próprio, não carona desta.
 */
const FORMA_NORMALIZADA = [
  ...ESCRITA_NOSSO_BANCO,
  "fin-valor-cockpit",
  "fin-funding",
  "algorithm-a-audit",
  "carteira-positivacao-snapshot",
  "omie-financeiro",
  // Sétima leva: não escreve no banco, mas manda o catálogo inteiro para o modelo (token pago) —
  // paga o mesmo preço se um `probe` mal grafado cair no fluxo real, que é o que estes gates
  // existem para impedir. Confirma a regra do bloco acima: a FORMA não tem a ver com escrever.
  "analyze-unified-order",
  ...FAN_OUT_QUE_ESCREVE,
  // Nona leva: entra na varredura estrutural pelo mesmo motivo da sétima — o preço de um `probe`
  // mal grafado caindo no fluxo real. Aqui ele é o mais alto de todos (e-mail a clientes reais,
  // que não se desfaz). Fica FORA de GATE_PROPRIO de propósito: o gate dela é
  // `authorizeCronOrStaff`, que já aceita o `x-cron-secret` do SQL Editor.
  "monthly-report",
];

/**
 * Onde o client do handler NÃO nasce de um `createClient(` literal.
 *
 * O gate de posição abaixo compara a sonda com a criação do client, e a `omie-sync-status-produtos`
 * a esconde atrás de `makeClient()` — uma fábrica de topo de arquivo que existe para capturar o
 * tipo do client por inferência. Sem este mapa o gate não acha a âncora e cai no ramo
 * "controle positivo vazio", que é vermelho — correto, mas pela razão errada.
 *
 * O default fica no `??` para que uma edge NOVA não precise de linha aqui; declarar o desvio é o
 * caso raro. Renomear a fábrica sem atualizar este mapa deixa o gate VERMELHO por âncora ausente,
 * que é o desfecho certo: melhor um gate que para do que um que mede a coisa errada.
 */
const ANCORA_CLIENT: Record<string, string> = {
  "omie-sync-status-produtos": "makeClient(",
};

/** Destas o gate NÃO aceita `x-cron-secret`, então a sonda precisa de gate PRÓPRIO. */
// `recommend` entra aqui porque seu gate normal é JWT e o `getUser` PRECISA do client — mas a
// sonda responde ANTES do `createClient` (o gate acima exige). Sobrava só o
// `startsWith("Bearer ")`: verificado em PROD, `Authorization: Bearer x` (token inválido)
// devolvia a versão. Semi-público por acidente, não por decisão.
// `fin-valor-cockpit` (authorizeGestorOuMaster), `fin-funding` (authorizeMaster) e
// `omie-financeiro` entram pelo mesmo motivo com causas distintas: as duas primeiras exigem
// `Authorization: Bearer` + role e nunca leram `x-cron-secret`; a terceira LÊ o cron-secret, mas
// dentro de `validateCaller(req, supabase)` — que precisa do client, criado depois do ponto onde
// a sonda tem de responder. Nos três casos o caminho do SQL Editor não chega ao gate normal, e a
// sonda só pode vir antes dele trazendo `authorizeCronOrStaff` própria.
// `analyze-unified-order` é o caso mais agudo da lista: ela não tem `authorizeCronOrStaff`
// NENHUM no fluxo real — o gate é JWT de usuário + `user_roles` (employee/master), precedido de um
// `startsWith("Bearer ")` que responde antes de tudo. Sem gate próprio a sonda ou ficaria
// inalcançável pelo SQL Editor, ou obrigaria a afrouxar o gate de uma edge que lê perfil de
// cliente e paga o modelo. É também o que a separa da canária de preço dela, que vive DEPOIS
// desse gate e por isso só o app logado alcança.
// `ai-ops-agent` entra pela causa mais direta de todas: o gate dela é JWT de usuário staff
// (`Authorization: Bearer` + `user_roles` em employee/master) e é a PRIMEIRA coisa do handler. O
// `net.http_post` do SQL Editor manda `x-cron-secret` e nenhum Bearer, então uma sonda atrás desse
// gate seria inalcançável exatamente para quem precisa dela — o furo medido em prod na `recommend`
// (#1882). A contrapartida é que a sonda não pode responder sem auth nenhuma: daí o gate próprio.
const GATE_PROPRIO = [
  "omie-cliente",
  "omie-nfe-webhook",
  "recommend",
  "fin-valor-cockpit",
  "fin-funding",
  "omie-financeiro",
  "analyze-unified-order",
  "ai-ops-agent",
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

/** Trecho entre o delimitador de sentença mais próximo (`;`, `{` ou `}`) e a posição dada. */
function prefixoDaSentenca(codigo: string, ate: number): string {
  const inicio = Math.max(
    codigo.lastIndexOf(";", ate),
    codigo.lastIndexOf("{", ate),
    codigo.lastIndexOf("}", ate),
  );
  return codigo.slice(inicio + 1, ate);
}

/**
 * O corpo da sonda ALCANÇA a resposta HTTP — ou é calculado e descartado?
 *
 * Buraco medido ao falsificar uma sonda experimental na `omie-vendas-sync` (2026-08-23): trocar
 * `return new Response(JSON.stringify(respostaSonda(VERSAO)), …)` por
 * `console.log(respostaSonda(VERSAO)); return new Response(JSON.stringify({ ok: true }), …)`
 * deixava TODOS os gates VERDES — o de baixo afirmava que a função é CHAMADA e que a edge ramifica
 * em "sonda", e nenhum dos dois nota a diferença. Em produção isso é uma sonda que responde 200 SEM
 * o eco `probe:true` — e `probe:true` ausente é exatamente o corpo pelo qual a canária conclui
 * "bundle velho, e ele rodou o efeito caro" (docs/agent/deploy.md §Canárias, armadilha 1). A edge
 * passaria por instrumentada enquanto faz a canária dizer a mentira mais cara que existe.
 *
 * Por que NÃO enumerar os embrulhos (`JSON.stringify|jsonRes|jsonResponse`): a medição de
 * 2026-08-24 achou QUATRO formas legítimas entre as edges instrumentadas — as três acima e uma
 * INDIRETA (`ai-ops-agent`, `omie-financeiro`), em que o corpo vai para uma variável e o `return`
 * embrulha a VARIÁVEL, sem embrulho nenhum adjacente à chamada. Uma lista de nomes reprovaria essas
 * duas hoje e a próxima forma amanhã, e o conserto de um gate que reprova edge correta é sempre
 * afrouxá-lo. Por isso o teste aqui é POSICIONAL: exige que a chamada esteja na cadeia de um
 * `return`, não que o embrulho tenha nome conhecido. Embrulho novo passa sem tocar neste arquivo;
 * `console.log` não passa.
 */
function corpoDaSondaViraResposta(codigo: string): boolean {
  // `\w*` porque a resposta pode ter nome próprio: `generate-tactical-plan` exporta
  // `respostaSondaTactical()`. Exigir o nome exato reprovava uma edge que responde certo.
  const chamada = /respostaSonda\w*\(/g;
  for (let m = chamada.exec(codigo); m; m = chamada.exec(codigo)) {
    const prefixo = prefixoDaSentenca(codigo, m.index);
    // Forma direta (A/B/C): `return <embrulho>(… respostaSonda(VERSAO) …)`. O delimitador de
    // sentença é o que impede o falso verde: o `return` de uma LINHA anterior fica fora do prefixo.
    if (/\breturn\b/.test(prefixo)) return true;
    // Forma indireta (D): o corpo vai para uma variável e o `return` seguinte embrulha ELA. O
    // identificador exclui `$` de propósito — ele é metacaractere de regex, e um nome não
    // reconhecido aqui deixa o gate VERMELHO (falha segura), nunca verde por acidente.
    const atribuicao = /\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=/.exec(prefixo);
    if (!atribuicao) continue;
    // O PRÓXIMO `return`, não qualquer um: um `return` distante que mencione um nome comum
    // (`corpo`) provaria coincidência de nome, não caminho de dados.
    const posReturn = codigo.indexOf("return", m.index);
    if (posReturn < 0) continue;
    const fim = codigo.indexOf(";", posReturn);
    const sentenca = codigo.slice(posReturn, fim < 0 ? codigo.length : fim);
    if (new RegExp(`\\b${atribuicao[1]}\\b`).test(sentenca)) return true;
  }
  return false;
}

Deno.test("toda edge instrumentada RESPONDE à sonda (chamar classificarSonda não basta)", () => {
  // Buraco encontrado ao falsificar a canária da `recommend`: apagar a linha que RESPONDE
  // (`if (decisao.tipo === "sonda") return ...respostaSonda(VERSAO)`) deixava todos os gates
  // VERDES. Os vizinhos afirmam que `classificarSonda` é CHAMADA e que vem antes do
  // `createClient` — nenhum afirma que a decisão vira RESPOSTA. Uma edge assim classifica a
  // sonda e segue para o fluxo real: o efeito caro roda, e quem sondou lê o resultado do
  // disparo como se fosse diagnóstico. É o pior desfecho que a sonda existe para evitar,
  // passando por instrumentado.
  for (const { nome } of EDGES) {
    const codigo = codigoDaEdge(nome);
    if (!/respostaSonda\w*\(/.test(codigo)) {
      throw new Error(`${nome}: classifica a sonda mas nunca chama respostaSonda — o diagnóstico não sai`);
    }
    // E o corpo montado tem de virar a RESPOSTA. Sem este assert, `console.log(respostaSonda(…))`
    // seguido de um `return` qualquer passa pelos dois vizinhos — ver `corpoDaSondaViraResposta`.
    if (!corpoDaSondaViraResposta(codigo)) {
      throw new Error(
        `${nome}: chama respostaSonda mas o corpo não alcança nenhum return — a sonda responde 200 SEM \`probe:true\`, e a canária lê isso como "bundle velho que rodou o efeito caro"`,
      );
    }
    if (!/["\x27]sonda["\x27]/.test(codigo)) {
      throw new Error(`${nome}: não ramifica no tipo "sonda" — a decisão é calculada e descartada`);
    }
  }
});

Deno.test("CALIBRAÇÃO: o gate de RESPOSTA reprova a forma `calcula e descarta`", () => {
  // Sem isto o gate acima nasceria cego igual ao que ele substitui: um predicado que devolve `true`
  // para tudo passa nas 32 edges reais sem afirmar nada. Cada forma abaixo é montada como TEXTO —
  // não dá para sabotar as edges reais de dentro do teste.
  const reprovadas: Array<[string, string]> = [
    [
      "console.log — a forma exata medida na omie-vendas-sync",
      'console.log(respostaSonda(VERSAO));\n  return new Response(JSON.stringify({ ok: true }), { status: 200 });',
    ],
    [
      "calcula, guarda e descarta",
      'const corpo = respostaSonda(VERSAO);\n  return new Response(JSON.stringify({ ok: true }), { status: 200 });',
    ],
    [
      "guarda numa variável e retorna OUTRA",
      'const corpo = respostaSonda(VERSAO);\n  const saida = { ok: true };\n  return jsonRes(saida, 200);',
    ],
  ];
  for (const [rotulo, forma] of reprovadas) {
    if (corpoDaSondaViraResposta(forma)) {
      throw new Error(`o gate aprovaria a forma que existe para barrar (${rotulo})`);
    }
  }

  // Controle positivo: as QUATRO formas reais medidas em 2026-08-24 têm de passar, senão o gate
  // reprova edge correta — e o conserto de um gate assim é afrouxá-lo até parar de medir.
  const aprovadas: Array<[string, string]> = [
    ["A: new Response(JSON.stringify(", 'if (d.tipo === "sonda") {\n  return new Response(JSON.stringify(respostaSonda(VERSAO)), { status: 200 });\n}'],
    ["B: jsonRes(", 'if (d.tipo === "sonda") return jsonRes(respostaSonda(VERSAO), 200);'],
    ["C: jsonResponse(", 'if (d.tipo === "sonda") return jsonResponse(respostaSonda(VERSAO), 200);'],
    [
      "D: indireta, o return embrulha a variável",
      'const ehSonda = d.tipo === "sonda";\n  const corpo = ehSonda\n    ? respostaSonda(VERSAO)\n    : { error: erroSondaAmbigua(d.valor, EFEITO) };\n  return new Response(JSON.stringify(corpo), {\n    status: ehSonda ? 200 : 400,\n  });',
    ],
    // Embrulho que ainda não existe: o gate é posicional de propósito, então a próxima edge não
    // precisa vir aqui pedir licença. Este caso é o que trava a volta para uma lista de nomes.
    ["embrulho novo, nome desconhecido", "return respostaJson(respostaSondaTactical(), 200);"],
    ["nome próprio (generate-tactical-plan)", "return new Response(JSON.stringify(respostaSondaTactical()), { status: 200 });"],
  ];
  for (const [rotulo, forma] of aprovadas) {
    if (!corpoDaSondaViraResposta(forma)) {
      throw new Error(`o gate reprovaria uma forma legítima (${rotulo}) — edge correta ficaria vermelha`);
    }
  }

  // O gate mede o código SEM comentário (`codigoDaEdge` passa pelo `removerComentarios`
  // compartilhado). Sem este caso, uma edge cuja única resposta certa está COMENTADA passaria — é
  // a mesma cegueira dos gates textuais de docs/historico/gates-textuais-cegos.md.
  const soEmComentario = '// return new Response(JSON.stringify(respostaSonda(VERSAO)), { status: 200 });\n  console.log(respostaSonda(VERSAO));\n  return new Response(JSON.stringify({ ok: true }), { status: 200 });';
  if (corpoDaSondaViraResposta(removerComentarios(soEmComentario))) {
    throw new Error("o gate aprovaria uma edge cuja resposta certa está COMENTADA");
  }
});

Deno.test("forma normalizada: a sonda decide por classificarSonda, não por `=== true` cru", () => {
  // Mesmo motivo do gate da generate-bundle-argument: o founder invoca do SQL Editor, onde
  // `jsonb_build_object('probe', true)` vira a STRING "true" com facilidade. Aqui o preço de cair
  // no fluxo real é criar placeholder+profile, reescrever saldo ou gravar projeção de caixa.
  for (const nome of FORMA_NORMALIZADA) {
    const codigo = codigoDaEdge(nome);
    if (!/classificarSonda\(/.test(codigo)) {
      throw new Error(`${nome}: não chama classificarSonda — a sonda não é fail-closed`);
    }
    if (/\bbody\.probe\s*===\s*true/.test(codigo)) {
      throw new Error(`${nome}: voltou o \`body.probe === true\` cru — "true" string cai no fluxo real`);
    }
  }
});

Deno.test("forma normalizada: a sonda responde ANTES do createClient do handler", () => {
  // O valor da sonda é ser o único caminho sem custo. Na `omie-sync-nfes-recebidas` o parse do
  // corpo estava DEPOIS do `createClient` e teve de subir; este gate é o que impede a volta.
  for (const nome of FORMA_NORMALIZADA) {
    const h = trechoDoHandler(nome);
    const ancora = ANCORA_CLIENT[nome] ?? "createClient(";
    const posSonda = h.indexOf("classificarSonda(");
    const posCliente = h.indexOf(ancora);
    if (posSonda < 0 || posCliente < 0) {
      throw new Error(
        `${nome}: âncoras não encontradas no handler (procurei \`${ancora}\`) — controle positivo vazio`,
      );
    }
    if (posSonda > posCliente) {
      throw new Error(`${nome}: a sonda desceu para depois do ${ancora} — deixou de ser IO-free`);
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

/**
 * Edges cujo handler tem um `startsWith("Bearer ")` PRÓPRIO antes do fluxo real. Nelas a sonda
 * precisa vir antes dele, senão `x-cron-secret` nunca alcança o `authorizeCronOrStaff`. Virou
 * lista quando a segunda apareceu: herdar a regra é o que impede a terceira nessa forma de ficar
 * de fora em silêncio.
 */
const BEARER_NO_HANDLER = ["recommend", "analyze-unified-order"];

Deno.test("onde o handler tem gate de Bearer próprio, a sonda vem ANTES dele", () => {
  // Medido em prod (2026-08-22): `net.http_post` com `x-cron-secret` e SEM `Authorization`
  // devolveu 401 {"error":"Não autorizado"} — a mensagem do HANDLER, não do helper. Causa: o
  // `startsWith("Bearer ")` do handler estava ANTES da sonda, então o request morria ali e
  // nunca alcançava `authorizeCronOrStaff` — justamente quem sabe validar `x-cron-secret`.
  //
  // O efeito é uma credencial que o gate ACEITA no papel e o fluxo REJEITA na prática: das três
  // que o helper reconhece (cron secret, service role, JWT), só as que por acaso vêm em
  // `Authorization: Bearer` chegam até ele. O caminho documentado (SQL Editor via
  // net.http_post) é exatamente o que não passa.
  // A `analyze-unified-order` tem o MESMO desenho e chegou pelo #1622: gate de JWT de usuário +
  // `user_roles`, com o `startsWith("Bearer ")` respondendo antes de tudo.
  for (const nome of BEARER_NO_HANDLER) {
    const h = trechoDoHandler(nome);
    const posSonda = h.indexOf("classificarSonda(");
    const posBearer = h.indexOf('startsWith("Bearer ")');
    if (posSonda < 0 || posBearer < 0) {
      throw new Error(`${nome}: âncoras não encontradas (controle positivo vazio)`);
    }
    if (posSonda > posBearer) {
      throw new Error(
        `${nome}: a sonda está DEPOIS do gate de Bearer — x-cron-secret nunca chega ao authorizeCronOrStaff`,
      );
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

  // A âncora DECLARADA (`ANCORA_CLIENT`) tem de reprovar igual à padrão. Sem este caso, trocar o
  // valor do mapa por uma string que não existe no arquivo faria o gate cair no ramo de âncora
  // ausente para SEMPRE — vermelho, mas por não achar nada, e um gate que nunca mede vira ruído
  // que a próxima pessoa silencia.
  const handlerFabrica = 'Deno.serve(async (req) => {\n  const c = makeClient();\n  classificarSonda(body);\n';
  const ancoraFabrica = ANCORA_CLIENT["omie-sync-status-produtos"];
  if (handlerFabrica.indexOf(ancoraFabrica) < 0) {
    throw new Error("a âncora declarada não casa nem a forma que ela existe para medir");
  }
  if (!(handlerFabrica.indexOf("classificarSonda(") > handlerFabrica.indexOf(ancoraFabrica))) {
    throw new Error("o gate de posição não reprovaria uma sonda depois da fábrica de client");
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

// ─────────────────────────────────────────────────────────────────────────────
// Oitava leva (#1889/#1901) — o que é específico DESTA fatia. Os gates de FORMA acima já varrem
// as 7 novas; o que sobra aqui é o que elas trouxeram de próprio: o BUMP como pré-requisito, o
// parse de corpo que teve de subir, e a cobertura do conjunto que serve o `paginate.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/** As 7 que nasceram com sensor nesta fatia — o `FORMA_NORMALIZADA` as varre, isto as NOMEIA. */
const OITAVA_LEVA = [
  "calculate-scores",
  "ai-ops-agent",
  "omie-sync-status-produtos",
  "sync-reprocess",
  ...FAN_OUT_QUE_ESCREVE,
];

Deno.test("bump #1889/#1901: as 3 edges com sonda pré-existente não podem voltar ao marcador antigo", () => {
  // A regra que este gate materializa (docs/historico/deploy-no-op-por-desenho.md, lição 1): o
  // #1889 é no-op por DESENHO — enquanto o `max-rows` de prod for 1000, bundle novo e velho
  // devolvem bytes idênticos, então nenhuma canária de comportamento discrimina o deploy. Só o
  // marcador prova, e marcador IGUAL na `main` e em prod responde a mesma string tendo o deploy
  // acontecido ou não. Era exatamente a situação destas três: `omie-cliente` e
  // `reposicao-depara-sayerlack-auto` presas em `v1.0-sensor-inicial`, e `generate-tactical-plan`
  // em `v1.0-custo-fora-do-browser` desde o #1754.
  //
  // Um `git revert` do bump devolveria a sonda a "responde verde sem provar nada" — o pior estado,
  // porque parece verificado. O gate lê o valor ANTIGO literal para que a regressão seja nomeada.
  const BUMPADAS: Array<{ nome: string; mod: ModSonda; antigo: string }> = [
    { nome: "omie-cliente", mod: omieCliente, antigo: "v1.0-sensor-inicial" },
    { nome: "reposicao-depara-sayerlack-auto", mod: deparaAuto, antigo: "v1.0-sensor-inicial" },
    { nome: "generate-tactical-plan", mod: tactical, antigo: "v1.0-custo-fora-do-browser" },
  ];
  for (const { nome, mod, antigo } of BUMPADAS) {
    if (mod.VERSAO === antigo) {
      throw new Error(
        `${nome}: marcador REGREDIU para ${antigo} — o valor que já respondia em produção. A sonda ` +
          `volta a responder igual com ou sem deploy, e o #1889 não tem canária que discrimine.`,
      );
    }
  }
});

Deno.test("bump v1.1-corpo-tipado: analyze-unified-order não pode voltar ao marcador congelado do #1930", () => {
  // Mesma classe do gate acima, mas o congelamento aqui aconteceu SEM ninguém reverter nada: o
  // #1930 escreveu `v1.0-prompt-invertido-cacheado` e o #1938 alterou a edge sem bumpar. A sonda
  // então provava "≥ #1930" e nada mais — respondia byte-idêntico para os dois bundles. Medido em
  // prod 2026-08-25 (request_id 59657): `versao=v1.0-prompt-invertido-cacheado`, uma resposta que
  // não distingue o bundle de #1930 do de #1938.
  //
  // ⚠️ O que este gate cobre e o que NÃO cobre. Ele impede a REGRESSÃO (voltar ao valor que já
  // respondia em produção); ele não força o bump na PRÓXIMA fatia — nenhum gate de texto sabe se
  // uma mudança de comportamento mereceu marcador novo. A trava real dessa metade é humana e está
  // escrita no `versao.ts`: bumpar ANTES do deploy. O gate é a rede de baixo, não a regra.
  //
  // A canária de preço NÃO substitui isto: o `contrato` dela (`praticado-vence-omie-v1`) nomeia a
  // fatia do MERGE DE PREÇO, não a do corpo/prompt, e responde igual antes e depois desta entrega.
  // `: string` é NECESSÁRIO, não ruído — mesma razão documentada no gate da `generate-tactical-plan`
  // acima: `VERSAO` é `const`, o TS a estreita ao tipo literal e recusa a comparação com TS2367
  // ("no overlap"), porque o compilador já sabe que HOJE difere. O que este teste guarda é a
  // mudança FUTURA, que é runtime. (O `BUMPADAS` logo acima escapa disso por passar pelo tipo
  // `ModSonda`, cujo `VERSAO: string` já alarga.)
  const ANTIGO = "v1.0-prompt-invertido-cacheado";
  const versaoAnalyze: string = analyzeOrder.VERSAO;
  if (versaoAnalyze === ANTIGO) {
    throw new Error(
      `analyze-unified-order: marcador REGREDIU para ${ANTIGO} — o valor que ficou congelado do ` +
        `#1930 ao #1938. A sonda volta a responder igual com ou sem deploy, e a canária de preço ` +
        `não discrimina esta fatia (o contrato dela é o do merge de preço).`,
    );
  }
});

Deno.test("bump v1.1-mapa-codigo-sem-alias: omie-analytics-sync não pode voltar ao marcador do #1905", () => {
  // Terceira ocorrência da MESMA classe, e a que prova que o gate acima é rede-de-baixo e não
  // regra: ele mergeou às 01:24 UTC de 2026-08-25 e o #1971 repetiu a omissão às 01:31 — 7 minutos
  // depois, noutra edge. O `v1.0-sensor-inicial` nasceu no #1905 e o #1971 alterou o `index.ts`
  // (removeu a fonte `customer_canonical_alias` do `fetchCodigoUserMap`) sem tocar o marcador.
  //
  // ⚠️ Este bump NÃO recupera a discriminação do #1971 — ela está perdida. Quem sondar prod e
  // receber `v1.0-sensor-inicial` continua sem saber se o bundle é o do #1905 ou o do #1971. O que
  // o bump devolve é o sentido POSITIVO: `v1.1-mapa-codigo-sem-alias` na resposta prova que o
  // bundle inclui esta entrega e, por ancestralidade, o #1971. Falso NEGATIVO (marcador velho num
  // bundle que já tem o #1971) segue possível até o próximo deploy, e é o lado certo da assimetria:
  // ele faz continuar verificando, ao contrário do falso positivo, que encerra.
  const ANTIGO = "v1.0-sensor-inicial";
  const versaoAnalytics: string = analyticsSync.VERSAO;
  if (versaoAnalytics === ANTIGO) {
    throw new Error(
      `omie-analytics-sync: marcador REGREDIU para ${ANTIGO} — o valor que ficou congelado do ` +
        `#1905 ao #1971. A canária que a edge já tinha (doc_ambiguo_probe) é NÃO-versionada e ` +
        `responde igual em qualquer bundle, então nada mais discrimina o deploy desta edge.`,
    );
  }
});

Deno.test("oitava leva: o corpo do Request é lido UMA vez só", () => {
  // O corpo de um `Request` só se lê uma vez: a segunda chamada devolve `{}` (ou lança). Como a
  // sonda obrigou o parse a SUBIR para antes do client, toda leitura que existia depois teve de
  // passar a reusar a variável. Um `req.json()` a mais reintroduz o bug em SILÊNCIO — na
  // `omie-sync-status-produtos` ele faria o `empresa` do corpo ser ignorado e o sync mudar de
  // escopo sem erro nenhum; na `sync-reprocess`, o `action` sumiria e todo run viraria
  // "Ação desconhecida".
  for (const nome of OITAVA_LEVA) {
    const ocorrencias = trechoDoHandler(nome).match(/req\.json\(\)/g) ?? [];
    if (ocorrencias.length !== 1) {
      throw new Error(
        `${nome}: o handler lê req.json() ${ocorrencias.length}× — o corpo só se lê UMA vez, ` +
          `a segunda leitura devolve vazio e o parâmetro é descartado em silêncio`,
      );
    }
  }
});

Deno.test("sync-reprocess: o parse que subiu PRESERVA o throw do corpo inválido", () => {
  // Aqui o parse não pôde ser `.catch(() => ({}))` como nas outras seis. O código original era
  // `await req.json()` PELADO dentro do try geral: corpo quebrado virava 500 com a mensagem do
  // catch. Engolir o erro mudaria o desfecho para `action: undefined` → `400 "Ação desconhecida"`,
  // que manda o chamador consertar a coisa errada (a mesma armadilha que o `corpoJsonInvalido` do
  // `fin-funding` existe para evitar). O erro é guardado e RELANÇADO no ponto antigo.
  const h = trechoDoHandler("sync-reprocess");
  if (!/throw erroParseCorpo/.test(h)) {
    throw new Error(
      "sync-reprocess: o erro de parse não é relançado — corpo JSON quebrado passou a responder " +
        "'Ação desconhecida' em vez do 500 original",
    );
  }
  const posSonda = h.indexOf("classificarSonda(");
  const posThrow = h.indexOf("throw erroParseCorpo");
  if (posSonda < 0 || posThrow < 0) {
    throw new Error("sync-reprocess: âncoras não encontradas (controle positivo vazio)");
  }
  if (posThrow < posSonda) {
    throw new Error(
      "sync-reprocess: o relance subiu para ANTES da sonda — corpo inválido passaria a dar 500 " +
        "sem nem classificar o probe, e a sonda ficaria refém do JSON do chamador",
    );
  }
});

/**
 * Dependente do `paginate.ts` cuja prova de deploy NÃO é sonda, e sim canária VERSIONADA.
 *
 * Só a `omie-vendas-sync`: o `identidade_probe` dela responde um `contrato` versionado,
 * um marcador que nomeia a fatia — logo discrimina bundle novo de velho, que é tudo o que se pede
 * aqui. Exigir sonda dela seria exigir um segundo sensor para responder a mesma pergunta.
 *
 * O valor no mapa é conferido CONTRA O ARQUIVO: uma exceção que aponta para um contrato que a edge
 * não emite mais é pior que exceção nenhuma, porque some da lista de pendências parecendo resolvida.
 */
const VERIFICAVEL_POR_CANARIA: Record<string, string> = {
  // Bumpado de `identidade-fail-closed-v1` ao ganhar a assinatura comportamental do #1888
  // (`assinatura-a2.ts`): o marcador nomeia a fatia que a canária verifica HOJE, e a de hoje
  // cobre o P0-B E o A2. Ver `omie-vendas-sync/assinatura-a2.ts`.
  "omie-vendas-sync": "identidade-a2-client-to-user-v2",
};

Deno.test("nenhuma edge que serve o paginate.ts fica SEM prova de deploy", () => {
  // O gate que fecha a classe, em vez de fechar os 7 casos de hoje. O problema desta fatia não foi
  // "faltou sonda em 7 edges" — foi que ninguém percebia a falta até precisar verificar um deploy,
  // e aí já era tarde (o marcador tem de existir ANTES). Uma edge NOVA que passe a importar o
  // helper nasce agora com o sensor obrigatório, ou fica vermelha com o próprio nome no erro.
  //
  // Mede o import LITERAL do `_shared/paginate.ts` — inclusive o `import type`, que é como as
  // edges que paginam via `_shared/mapas-paginados.ts` aparecem. NÃO resolve o grafo transitivo:
  // uma dependência que chegue só por um terceiro módulo escapa daqui, e fechar isso exigiria um
  // resolvedor de módulos, não um regex. É um piso, e está declarado como piso.
  const registradas = new Set(EDGES.map((e) => e.nome));
  const semProva: string[] = [];
  const excecaoPodre: string[] = [];

  for (const entrada of Deno.readDirSync("supabase/functions")) {
    if (!entrada.isDirectory || entrada.name === "_shared") continue;
    let codigo: string;
    try {
      codigo = Deno.readTextFileSync(`supabase/functions/${entrada.name}/index.ts`);
    } catch {
      continue; // diretório sem index.ts não é uma edge
    }
    if (!codigo.includes("_shared/paginate.ts")) continue;
    if (registradas.has(entrada.name)) continue;

    const contrato = VERIFICAVEL_POR_CANARIA[entrada.name];
    if (!contrato) {
      semProva.push(entrada.name);
    } else if (!codigo.includes(contrato)) {
      excecaoPodre.push(`${entrada.name} (não emite mais \`${contrato}\`)`);
    }
  }

  if (excecaoPodre.length > 0) {
    throw new Error(
      `exceção de VERIFICAVEL_POR_CANARIA apontando para contrato que a edge não emite: ` +
        `${excecaoPodre.join(", ")} — a dispensa da sonda caducou junto`,
    );
  }
  if (semProva.length > 0) {
    throw new Error(
      `edges que servem o _shared/paginate.ts sem prova de deploy: ${semProva.join(", ")} — ` +
        `instale a sonda (\`_shared/sonda-versao.ts\`) e registre em EDGES, ou declare a canária ` +
        `VERSIONADA em VERIFICAVEL_POR_CANARIA. Sem marcador o deploy é inverificável, e o #1889 ` +
        `é no-op por desenho: não há canária de comportamento que discrimine.`,
    );
  }
});
