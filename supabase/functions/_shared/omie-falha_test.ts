// Testa o CÓDIGO REAL de omie-falha.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/omie-falha_test.ts
//
// O que estes testes protegem é a decisão que destrava o `sync_all_clients`: um erro Omie
// PERMANENTE (credencial revogada) tem de abandonar a conta — reportando — em vez de devolver
// o cursor parado na mesma página, que prendia o sync inteiro na primeira conta quebrada.
import {
  atrasoRetentativaMs,
  type ClasseFalhaOmie,
  classificarExcecao,
  classificarFaultstring,
  decidirDesfechoFalha,
  redigirSegredo,
} from "./omie-falha.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// ════════════════════ Amostras ════════════════════
// Faultstrings do contrato Omie, verbatim no formato que a API devolve (com acento e caixa
// originais — a normalização do helper é justamente o que precisa ser exercido).

const EOF_OMIE = [
  "Não existem registros para a página [5]!",
  "ERROR: Não existem registros para a página [140]!",
];

const TRANSITORIAS = [
  "SOAP-ERROR: Broken response from Application Server",
  "Já existe uma requisição desse método [ListarClientes] em andamento. Aguarde 3 segundos.",
  "Consumo redundante detectado",
  "ERROR: Request timeout",
  "error sending request for url (https://app.omie.com.br/api/v1/geral/clientes/)",
  "HTTP 503 Service Unavailable",
  "Bad Gateway",
  "TypeError: fetch failed",
];

const PERMANENTES = [
  "ERROR: Chave de acesso não cadastrada para o aplicativo [1234567890]!",
  "app_key inválido",
  "Acesso não autorizado ao recurso solicitado",
  "Credenciais do Omie (oben) não configuradas",
  "permission denied",
];

// Nem toda falha é classificável — e o helper não pode fingir que é. Estas caem em
// `indeterminada` de propósito: o TETO de tentativas é quem as resolve, não a rotulagem.
const INDETERMINADAS = [
  "ERROR: Ocorreu um erro inesperado ao processar a solicitação",
  "nTotPaginas=100000 acima do teto anti-runaway (2000) — abortando fail-fast antes de paginar",
  "página 3/10 do ListarClientes veio vazia antes do fim declarado",
];

// ════════════════════ classificarFaultstring ════════════════════

Deno.test("classificarFaultstring — EOF do contrato Omie é `fim_de_pagina` (com acento e caixa reais)", () => {
  for (const fs of EOF_OMIE) {
    assertEquals(classificarFaultstring(fs), "fim_de_pagina", `deveria ser fim: ${fs}`);
  }
});

Deno.test("classificarFaultstring — servidor/rede/rate-limit é `transitorio`", () => {
  for (const fs of TRANSITORIAS) {
    assertEquals(classificarFaultstring(fs), "transitorio", `deveria ser transitório: ${fs}`);
  }
});

Deno.test("classificarFaultstring — credencial/autorização é `permanente`", () => {
  for (const fs of PERMANENTES) {
    assertEquals(classificarFaultstring(fs), "permanente", `deveria ser permanente: ${fs}`);
  }
});

Deno.test("classificarFaultstring — o que não casa marcador nenhum é `indeterminada`, não um chute", () => {
  for (const fs of INDETERMINADAS) {
    assertEquals(classificarFaultstring(fs), "indeterminada", `deveria ser indeterminada: ${fs}`);
  }
});

Deno.test("classificarFaultstring — ausente/vazio é `indeterminada` (nunca fim: ausência de sinal não é EOF)", () => {
  assertEquals(classificarFaultstring(null), "indeterminada");
  assertEquals(classificarFaultstring(undefined), "indeterminada");
  assertEquals(classificarFaultstring(""), "indeterminada");
});

// A regra de desempate, escrita como teste porque é o que separa "abandona cedo" de "retenta":
// uma falha de servidor que POR ACASO cita a chave de acesso é falha de SERVIDOR.
Deno.test("classificarFaultstring — empate transitório×permanente cai no lado barato (transitório)", () => {
  assertEquals(
    classificarFaultstring("SOAP-ERROR: Broken response ao validar a Chave de acesso"),
    "transitorio",
  );
});

// ⚠️ REGRESSÃO (achado Codex, provado executando o helper): a 1ª versão listava "503" CRU como
// marcador transitório, e a app_key ecoada na mensagem de credencial contém 503 — o erro
// permanente mais comum do Omie virava "transitorio" e queimava 6 chamadas antes de abandonar.
// Não é número de negócio improvável: é a própria chave, presente em toda mensagem da família.
Deno.test("classificarFaultstring — dígito de código HTTP DENTRO da app_key ecoada não vira transitório", () => {
  assertEquals(
    classificarFaultstring("ERROR: Chave de acesso não cadastrada para o aplicativo [1503123456]!"),
    "permanente",
  );
  assertEquals(classificarFaultstring("app_key [4029384756] inválida"), "permanente");
});

Deno.test("classificarFaultstring — código HTTP ANCORADO na forma do wrapper é transitório", () => {
  assertEquals(classificarFaultstring("Erro HTTP 503 do Omie (ListarClientes)"), "transitorio");
  assertEquals(classificarFaultstring("Erro HTTP 429 do Omie (ListarClientes)"), "transitorio");
});

// A 1ª lista ancorada enumerava 500/502/503/504 À MÃO, então um 5xx FORA da enumeração
// (501/505/520 — as formas que gateway e CDN emitem) caía em `indeterminada` e, no wrapper do
// omie-analytics-sync, abortava na 1ª tentativa SEM backoff: falha de servidor tratada como
// permanente (achado do challenge Codex do #1623). A enumeração à mão é a mesma classe de erro
// do dígito solto — só que pelo avesso: lá o marcador casava demais, aqui casa de menos.
Deno.test("classificarFaultstring — 5xx FORA da enumeração à mão (501/505/520) também é transitório", () => {
  for (const codigo of [500, 501, 502, 503, 504, 505, 520, 521, 522, 598]) {
    assertEquals(
      classificarFaultstring(`Omie (vendas): HTTP ${codigo}`),
      "transitorio",
      `HTTP ${codigo} tinha de ser transitório (5xx é falha de servidor, sempre)`,
    );
  }
});

// O alargamento acima NÃO pode reabrir a porta que o #1614 fechou: a âncora (`http `/`status `)
// é o que separa "código HTTP" de "dígito dentro de um identificador ecoado". Sem este negativo,
// trocar a enumeração por um padrão genérico de 5xx é indistinguível de voltar ao dígito cru.
Deno.test("classificarFaultstring — 5xx genérico NÃO afrouxa a âncora: dígito solto segue não casando", () => {
  // app_key contendo 520/501: a família de mensagem que MAIS aparece precisa seguir permanente.
  assertEquals(classificarFaultstring("Chave de acesso não cadastrada para o aplicativo [1520123456]"), "permanente");
  assertEquals(classificarFaultstring("app_key [5019384756] inválida"), "permanente");
  // Sem âncora e sem marcador nenhum: indeterminada, não transitório fabricado.
  assertEquals(classificarFaultstring("Produto 520 sem estrutura cadastrada"), "indeterminada");
  assertEquals(classificarFaultstring("idProduto=1503498712 nao possui malha"), "indeterminada");
  // 4xx que NÃO é 429 não é retentável — só o rate-limit é.
  assertEquals(classificarFaultstring("Omie (vendas): HTTP 400"), "indeterminada");
  assertEquals(classificarFaultstring("Omie (vendas): HTTP 404"), "indeterminada");
});

// "Falha temporária ao validar credenciais" casava `credencia` e virava permanente — abandonava
// a conta por um erro que passa sozinho. `temporari` entra antes, no lado que retenta.
Deno.test("classificarFaultstring — falha TEMPORÁRIA que cita credencial é transitória, não permanente", () => {
  assertEquals(classificarFaultstring("Falha temporária ao validar credenciais"), "transitorio");
});

// ⚠️ INVARIANTE money-path: nenhuma FALHA pode ser lida como fim de conta. É a única leitura
// que fabricaria completude — a conta sairia marcada como concluída com o import parcial.
Deno.test("INVARIANTE — nenhuma falha (de qualquer classe) é classificada como fim de conta", () => {
  for (const fs of [...TRANSITORIAS, ...PERMANENTES, ...INDETERMINADAS]) {
    const classe = classificarFaultstring(fs);
    if (classe === "fim_de_pagina") {
      throw new Error(`FALHA lida como fim de conta — completude fabricada: ${fs}`);
    }
  }
});

// Detector-par do invariante acima (§"O DETECTOR mente"): se `fim_de_pagina` nunca fosse
// devolvido — marcador quebrado, normalização errada — o teste anterior passaria VAZIO e
// "não confunde falha com fim" seria indistinguível de "a classe fim está morta".
Deno.test("DETECTOR — a classe `fim_de_pagina` existe de verdade (senão o invariante acima é tautologia)", () => {
  const fins = EOF_OMIE.map(classificarFaultstring).filter((c) => c === "fim_de_pagina");
  assertEquals(fins.length, EOF_OMIE.length, "o marcador de EOF parou de casar — o invariante virou tautologia");
});

// ════════════════════ classificarExcecao ════════════════════
// O EOF do contrato Omie chega como `faultstring` numa resposta 200 — nunca como throw. E
// `fim_de_pagina` é a ÚNICA classe cujo desfecho não termina (não retenta, não abandona), porque
// quem lê a resposta já decidiu o fim antes. Encaminhar uma exceção como fim faria o catch nem
// sair do laço nem avançar a página: o laço quente original, por outra porta.

Deno.test("classificarExcecao — exceção cujo texto CITA o EOF do Omie não vira fim de conta", () => {
  assertEquals(
    classificarExcecao(new Error("Não existem registros para a página [3]!")),
    "indeterminada",
  );
});

Deno.test("classificarExcecao — preserva as demais classes e aceita valor não-Error", () => {
  assertEquals(classificarExcecao(new Error("SOAP-ERROR: Broken response")), "transitorio");
  assertEquals(classificarExcecao(new Error("app_key inválido")), "permanente");
  assertEquals(classificarExcecao("Chave de acesso não cadastrada"), "permanente");
  assertEquals(classificarExcecao(null), "indeterminada");
});

// ⚠️ A propriedade que fecha o laço, e a razão de a normalização morar aqui em vez do call-site:
// NENHUMA exceção pode produzir um desfecho que não termine. Vale para toda amostra conhecida,
// inclusive as de EOF.
Deno.test("INVARIANTE — toda exceção produz um desfecho que TERMINA (retenta ou abandona)", () => {
  for (const amostra of [...EOF_OMIE, ...TRANSITORIAS, ...PERMANENTES, ...INDETERMINADAS]) {
    const classe = classificarExcecao(new Error(amostra));
    if (classe === "fim_de_pagina") throw new Error(`exceção lida como fim de conta: ${amostra}`);
    for (let t = 1; t <= 4; t++) {
      const d = decidirDesfechoFalha({ classe, tentativasNaPagina: t, maxTentativas: 2 });
      if (!d.retentarPagina && !d.abandonarConta) {
        throw new Error(`desfecho que NÃO TERMINA (${classe}, tentativa ${t}): ${amostra}`);
      }
    }
  }
});

// ════════════════════ redigirSegredo ════════════════════
// O motivo da falha sai da edge, é persistido em acoes_execucoes.detalhes e exibido num toast.
// A mensagem de credencial do Omie ECOA a app_key — publicá-la nesses dois sinks é vazamento.

Deno.test("redigirSegredo — a app_key ecoada na mensagem de credencial não sai da edge", () => {
  const redigido = redigirSegredo("ERROR: Chave de acesso não cadastrada para o aplicativo [1503123456]!");
  if (redigido.includes("1503123456")) throw new Error(`app_key vazou: ${redigido}`);
  // O que sobra tem de continuar diagnosticável — senão trocamos vazamento por motivo inútil.
  if (!redigido.includes("Chave de acesso")) throw new Error(`motivo perdeu o diagnóstico: ${redigido}`);
});

Deno.test("redigirSegredo — app_secret em hex longo também é mascarado", () => {
  const redigido = redigirSegredo("secret a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 rejeitado");
  if (/[0-9a-f]{24,}/i.test(redigido)) throw new Error(`hex longo vazou: ${redigido}`);
});

// Detector-par: um redator que apagasse TUDO passaria nos dois testes acima e destruiria o
// motivo. Número curto é o que torna a falha acionável (página, código HTTP, código do cliente).
Deno.test("redigirSegredo — número CURTO (página, código HTTP) sobrevive: é o que torna o motivo útil", () => {
  assertEquals(redigirSegredo("Erro HTTP 503 na página 12 do ListarClientes"), "Erro HTTP 503 na página 12 do ListarClientes");
});

// ════════════════════ decidirDesfechoFalha ════════════════════

Deno.test("permanente ABANDONA a conta já na 1ª tentativa (retentar credencial revogada não muda nada)", () => {
  assertEquals(
    decidirDesfechoFalha({ classe: "permanente", tentativasNaPagina: 1, maxTentativas: 2 }),
    { retentarPagina: false, abandonarConta: true },
  );
});

Deno.test("transitório retenta até o teto e só então abandona a conta", () => {
  assertEquals(
    decidirDesfechoFalha({ classe: "transitorio", tentativasNaPagina: 1, maxTentativas: 2 }),
    { retentarPagina: true, abandonarConta: false },
  );
  assertEquals(
    decidirDesfechoFalha({ classe: "transitorio", tentativasNaPagina: 2, maxTentativas: 2 }),
    { retentarPagina: false, abandonarConta: true },
  );
});

Deno.test("indeterminada segue a MESMA política do transitório (não classificar não pode travar)", () => {
  assertEquals(
    decidirDesfechoFalha({ classe: "indeterminada", tentativasNaPagina: 1, maxTentativas: 2 }),
    { retentarPagina: true, abandonarConta: false },
  );
  assertEquals(
    decidirDesfechoFalha({ classe: "indeterminada", tentativasNaPagina: 2, maxTentativas: 2 }),
    { retentarPagina: false, abandonarConta: true },
  );
});

// O laço quente que este PR fecha era exatamente este: a decisão nunca terminava.
Deno.test("INVARIANTE — toda classe de FALHA termina (retenta ou abandona), nunca as duas nem nenhuma", () => {
  const classes: ClasseFalhaOmie[] = ["transitorio", "permanente", "indeterminada"];
  for (const classe of classes) {
    for (let t = 1; t <= 5; t++) {
      const d = decidirDesfechoFalha({ classe, tentativasNaPagina: t, maxTentativas: 2 });
      if (d.retentarPagina && d.abandonarConta) throw new Error(`${classe}/${t}: desfecho ambíguo`);
      // Além do teto, a única saída possível é abandonar — senão o cursor volta a girar parado.
      if (t > 2 && !d.abandonarConta) throw new Error(`${classe}/${t}: passou do teto sem abandonar — laço quente`);
    }
  }
});

Deno.test("fim_de_pagina encaminhado por engano não vira falha reportada nem retentativa", () => {
  assertEquals(
    decidirDesfechoFalha({ classe: "fim_de_pagina", tentativasNaPagina: 9, maxTentativas: 2 }),
    { retentarPagina: false, abandonarConta: false },
  );
});

// ════════════════════ atrasoRetentativaMs ════════════════════

Deno.test("atraso — backoff exponencial a partir de 800ms, com teto de 5s", () => {
  assertEquals(atrasoRetentativaMs(1), 800);
  assertEquals(atrasoRetentativaMs(2), 1600);
  assertEquals(atrasoRetentativaMs(3), 3200);
  assertEquals(atrasoRetentativaMs(4), 5000);
  assertEquals(atrasoRetentativaMs(40), 5000, "teto não pode explodir o orçamento de tempo da edge");
});

Deno.test("atraso — honra o 'Aguarde N segundos' do rate-limit do Omie, ainda sob o teto", () => {
  assertEquals(atrasoRetentativaMs(1, "Já existe uma requisição desse método. Aguarde 3 segundos."), 3500);
  assertEquals(
    atrasoRetentativaMs(1, "Aguarde 90 segundos"),
    5000,
    "pedido absurdo do Omie não pode estourar o tempo da invocação",
  );
});

Deno.test("atraso — tentativa 0/negativa não vira atraso negativo nem zero", () => {
  assertEquals(atrasoRetentativaMs(0), 800);
  assertEquals(atrasoRetentativaMs(-3), 800);
});
