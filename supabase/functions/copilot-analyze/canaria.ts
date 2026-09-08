// Canária de deploy da `copilot-analyze` — a prova de COMPORTAMENTO do bundle SERVIDO.
// ====================================================================================
//
// ## O buraco que ela tapa, e por que a sonda NÃO o tapa
//
// A sonda (`{"probe":true}` → `versao.ts`) responde `versao` e `fonte`. Os dois são DECLARADOS:
// `VERSAO` é uma string literal e `fonte` é `FONTE_SHA256[edge]`, uma constante que o
// `sonda:fingerprint` grava em `_shared/sonda-fingerprints.ts` e o deploy carrega junto. Um bundle
// que traga o par declarado certo responde verde tendo o resto do corpo qualquer coisa — os dois
// marcadores viajam DENTRO do mesmo bundle que eles dizem identificar.
//
// O #2362 fechou a outra ponta: o prompt de deploy embute o sha256 por arquivo lido de
// `origin/main`, então o que ENTRA no deploy é provadamente a `main`. Nenhum dos dois olha para o
// que SAI: entre a entrada do deploy e o bundle servido ainda existem cache de build e resolução
// de dependência (`npm:@anthropic-ai/sdk@^0.93.0` e `npm:@supabase/supabase-js@2` são ranges
// ABERTOS, fora do closure, que só anda por import local `./` e `../`).
//
// Esta canária EXECUTA o helper no bundle servido e compara com o que ele tem de responder. É a
// diferença entre "o marcador diz que é a versão nova" e "a versão nova é que respondeu".
//
// ⚠️ O QUE ELA PEGA, E O QUE NÃO PEGA — não deixe virar folclore:
//   · PEGA, de forma decisiva, o bundle VELHO servido (cache de build): o corpo velho não conhece
//     a flag `canary`, cai no fluxo real e responde 401/400 — sem `canary:true`, que já é o
//     veredito, do mesmo jeito que a ausência de `probe:true` é (ver `criarRespostaSonda`).
//   · PEGA divergência de resolução de dependência SOMENTE quando ela muda o comportamento
//     observável deste helper. `normalizarAnalise` é puro e não toca as dependências npm, então
//     uma troca de versão do SDK que não mude o comportamento dele passa despercebida aqui.
//     Medir ISSO exige ecoar a versão RESOLVIDA da dependência, que é fatia própria.
//
// ## Por que as fixtures são estas
//
// Uma canária cujas fixtures não se falsificam mutuamente é teatro: um helper sempre-`null`
// passaria em todo caso cuja resposta esperada é `null`. Os seis casos abaixo se derrubam em
// direções opostas — cada sabotagem plausível do helper mata pelo menos um deles:
//
//   | sabotagem do helper                   | quem morre                                    |
//   |---------------------------------------|-----------------------------------------------|
//   | sempre `null`                         | `completa`, `confianca_em_texto`, `motivos_*` |
//   | validação relaxada (devolve parcial)  | `sem_tipo_de_sugestao`, `enum_invalido`       |
//   | faixa de confiança ignorada           | `confianca_fora_de_faixa`                     |
//   | `Number(null)` no lugar de degradar   | `sem_tipo_de_sugestao` (0 no lugar de `null`) |
//   | motivos não filtrados                 | `motivos_com_lixo`                            |
//
// ## Determinismo
//
// Nada de `Date`, `Math.random`, `crypto` ou leitura de ambiente: a mesma resposta byte a byte a
// cada chamada, em qualquer horário. É o que permite comparar a resposta de ANTES do deploy com a
// de DEPOIS e atribuir qualquer diferença ao bundle, não ao acaso.

import { normalizarAnalise } from "./copiloto-tools.ts";

/**
 * VERSION MARKER da canária, exigido por `docs/agent/deploy.md` §Canárias.
 *
 * Sem ele, um deploy INTEGRALMENTE velho compararia o `esperado` velho com o `obtido` velho e
 * responderia `ok:true` mentindo verde — o `ok` sozinho separa "a função respondeu" de nada. O
 * nome NOMEIA a fatia que a canária atesta (o tudo-ou-nada de `normalizarAnalise`), não a data.
 *
 * ⚠️ BUMP obrigatório a cada fatia que mude o contrato desta canária — vigiado por
 * `bun run canaria:bump`, que julga esta edge pela régua da SUPERFÍCIE (o bloco da canária mais o
 * fecho dos símbolos que ele alcança), porque a edge tem `versao.ts`.
 */
export const CONTRATO_CANARIA = "tudo-ou-nada-normalizar-v1";

interface CasoCanaria {
  /** o que se manda ao helper */
  readonly entrada: unknown;
  /** o que ele TEM de responder — literal, do mesmo bundle (ver o ⚠️ do `contrato`) */
  readonly esperado: unknown;
}

/** Análise íntegra: todo campo que a tela afirma ao vendedor está presente e no enum. */
const COMPLETA = {
  intent: "objecao_preco",
  phase: "proposta",
  direction: "risco",
  direction_reasons: ["cliente citou concorrente mais barato"],
  suggestion: "Traga o custo por peça afiada em vez do preço do serviço.",
  suggestion_type: "argumento_economico",
  confidence: 78,
} as const;

const CASOS: Readonly<Record<string, CasoCanaria>> = {
  // Prova positiva: sem ela, um helper sempre-`null` passaria em 3 dos 6 casos e ninguém veria.
  completa: {
    entrada: COMPLETA,
    esperado: {
      intent: "objecao_preco",
      phase: "proposta",
      direction: "risco",
      direction_reasons: ["cliente citou concorrente mais barato"],
      suggestion: "Traga o custo por peça afiada em vez do preço do serviço.",
      suggestion_type: "argumento_economico",
      confidence: 78,
    },
  },
  // O tudo-ou-nada: meia análise chega à tela com a MESMA aparência de leitura completa.
  sem_tipo_de_sugestao: {
    entrada: { ...COMPLETA, suggestion_type: undefined },
    esperado: null,
  },
  // `ausente ≠ zero` na faixa: 150 não é confiança, e degradar para `null` é o desenho.
  confianca_fora_de_faixa: {
    entrada: { ...COMPLETA, confidence: 150 },
    esperado: null,
  },
  // O LLM devolve número em string com frequência; recusar isso apagaria leitura boa.
  confianca_em_texto: {
    entrada: { ...COMPLETA, confidence: "78" },
    esperado: {
      intent: "objecao_preco",
      phase: "proposta",
      direction: "risco",
      direction_reasons: ["cliente citou concorrente mais barato"],
      suggestion: "Traga o custo por peça afiada em vez do preço do serviço.",
      suggestion_type: "argumento_economico",
      confidence: 78,
    },
  },
  // Motivo que não é string derrubaria a renderização: sai da lista, sem derrubar a análise.
  motivos_com_lixo: {
    entrada: { ...COMPLETA, direction_reasons: ["preço citado", { a: 1 }, "", "  ", "prazo"] },
    esperado: {
      intent: "objecao_preco",
      phase: "proposta",
      direction: "risco",
      direction_reasons: ["preço citado", "prazo"],
      suggestion: "Traga o custo por peça afiada em vez do preço do serviço.",
      suggestion_type: "argumento_economico",
      confidence: 78,
    },
  },
  // Fora do enum é afirmação que a tela não sabe renderizar — recusa, não passa adiante.
  enum_invalido: {
    entrada: { ...COMPLETA, intent: "curiosidade" },
    esperado: null,
  },
};

export interface ResultadoCaso {
  readonly ok: boolean;
  readonly esperado: unknown;
  readonly obtido: unknown;
}

export interface RespostaCanaria {
  readonly canary: true;
  readonly contrato: string;
  readonly ok: boolean;
  readonly casos: Record<string, ResultadoCaso>;
}

/** Comparação estrutural estável — as chaves saem em ordem fixa dos literais acima e do helper. */
function iguais(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Executa as fixtures contra o helper do BUNDLE e devolve o corpo da canária.
 *
 * O `contrato` entra por PARÂMETRO, e não é capricho: o corpo servido sai INTEIRO daqui, então o
 * `index.ts` não tem como falsear o `ok` remontando o objeto — trocar `ok: resultado.ok` por
 * `ok: true` lá deixaria todo teste verde e a canária mentindo. Como bônus, a chamada
 * `executarCanaria({ contrato: '...' })` põe o literal no `index.ts`, que é onde o `canaria:bump`
 * o procura. A constante `CONTRATO_CANARIA` continua sendo a fonte da verdade, e a igualdade das
 * duas pontas é vigiada por `scripts/canaria-contrato-espelhado.test.ts`.
 *
 * Pura: sem rede, sem Anthropic, sem banco, sem cota. É o que permite chamá-la em produção antes
 * e depois de um deploy sem efeito colateral nenhum — e é por isso que o bloco que a chama vive
 * ANTES do `createClient`/`consumirCota`/`anthropic.messages.create` no `index.ts`.
 */
export function executarCanaria(opcoes: { contrato: string }): RespostaCanaria {
  const casos: Record<string, ResultadoCaso> = {};
  let tudoOk = true;

  for (const [nome, caso] of Object.entries(CASOS)) {
    const obtido = normalizarAnalise(caso.entrada);
    const ok = iguais(obtido, caso.esperado);
    if (!ok) tudoOk = false;
    casos[nome] = { ok, esperado: caso.esperado, obtido };
  }

  return { canary: true, contrato: opcoes.contrato, ok: tudoOk, casos };
}
