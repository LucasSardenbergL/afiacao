/**
 * prompt-deploy.ts — o GERADOR do prompt de deploy por LEVA (lógica pura, sem fs/git/psql).
 *
 * Por quê: o `pendencias-deploy.ts` já decide QUAIS edges estão pendentes, e a forma do prompt
 * está medida em prod (2026-09-06: 8 edges / 70 arquivos / 1 colagem → `pendencias:deploy` de
 * 46/54 para 54/54, zero deploy parcial). O que faltava era o meio: a montagem da lista de
 * arquivos, feita à mão pela sessão. E é exatamente aí que mora o modo de falha temido —
 * "o prompt que nomeia poucos arquivos e a função não boota".
 *
 * ⚠️ A FATIA DE DEPLOY NÃO É O CLOSURE DO HASH. São duas perguntas com respostas que diferem por
 * exatamente um arquivo (`docs/historico/closure-de-hash-nao-e-lista-de-deploy.md`):
 *
 *   que bytes o `fonte` mede?            → fecharGrafo(index.ts)
 *   que arquivos o deploy deve nomear?   → fecharGrafo(index.ts) ∪ {_shared/sonda-fingerprints.ts}
 *
 * A `fecharGrafo()` exclui o mapa DE PROPÓSITO (ele é a SAÍDA do fingerprint; incluí-lo seria
 * ponto-fixo). Quem monta deploy a partir dela sem somar o mapa deploya um bundle que BOOTA e
 * serve `FONTE_SHA256` VELHO — a sonda que existia para provar o deploy nasce cega na fatia que
 * a instrumenta. Por isso `conferirCobertura()` existe e é falsificada no teste.
 */

import type { Estado, Veredito } from './pendencias-deploy';

/** Marca de formato que o `pendencias-deploy --json` emite; o gerador recusa outra. */
export const FORMATO_ACEITO = 'pendencias-deploy/1';

/**
 * Os estados que EXIGEM deploy — e só eles.
 *
 * Fora daqui de propósito: `NUNCA_ATESTADA` e `SEM_FONTE_NO_ECO` são AUSÊNCIA DE DADO, não
 * divergência medida (ausente ≠ zero). O que elas pedem é SONDA, não deploy — pedir deploy de uma
 * edge nunca atestada é o gasto redundante que o ledger existe para evitar. `FORA_DO_MAPA` é edge
 * que a main não mapeia: não há "main" para deployar a partir de.
 */
export const ESTADOS_DE_DEPLOY: readonly Estado[] = [
  'DIVERGE_P1',
  'DIVERGE_P2',
  'INCOERENTE',
  'SEM_MAPA_NO_BUNDLE',
] as const;

/**
 * Um arquivo da fatia, com o sha256 dos bytes que a REF tem — não os do working tree.
 *
 * Não exportada: quem monta a fatia (`pendencias-prompt.ts`) escreve o literal e o tipo é checado
 * estruturalmente por `EdgeParaDeploy`. Exportar sem consumidor que a NOMEIE é export morto, e o
 * `knip` reprova (com razão).
 */
interface ArquivoDaFatia {
  caminho: string;
  /** SHA-256 dos bytes crus, em hex minúsculo: o número que `sha256sum <caminho>` imprime. */
  sha256: string;
}

/** Uma edge da leva, com a fatia que o prompt precisa nomear (closure ∪ {mapa}). */
export interface EdgeParaDeploy {
  edge: string;
  arquivos: ArquivoDaFatia[];
}

/**
 * De onde os hashes saíram. Obrigatória, não opcional: prompt que embute hash sem dizer de QUAL
 * commit é hash sem procedência — quem lê o `get_message` depois não consegue refazer a conta, e o
 * agente não tem como saber contra que estado está comparando.
 */
export interface Procedencia {
  /** O ref lido. É o que o Lovable deploya — não o `<sha>` do PR nomeado (#2123). */
  ref: string;
  /** SHA do ref no instante da geração. O prompt carrega; o `get_message` audita depois. */
  sha: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Como UMA linha de arquivo se escreve. Existe como função porque `montarPrompt` e
 * `conferirCobertura` precisam da MESMA definição: se o check remontasse a linha por conta
 * própria, as duas poderiam divergir e o check ficaria verde contra um prompt que não existe.
 *
 * O par caminho↔hash é ATÔMICO de propósito. Conferir os dois soltos (`inclui o caminho?` e
 * `inclui o hash?`) fica verde com os hashes TROCADOS entre dois arquivos — os dois aparecem, cada
 * um ao lado do arquivo errado — e aí o agente confere 8 hashes, acha 8 divergências e aborta um
 * deploy correto. É o mesmo erro de `includes()` cru que a nota de substring abaixo já registrava,
 * num eixo diferente.
 */
function linhaDoArquivo(a: ArquivoDaFatia): string {
  return `- \`${a.caminho}\` — sha256 \`${a.sha256}\``;
}

/**
 * As marcas que a conferência EXIGE na saída. Cada uma existe por um modo de falha nomeado, e
 * `conferirCobertura` reprova se qualquer uma sumir — hash embutido sem ordem de abortar é hash
 * DECORATIVO: o agente compara, vê diferente e deploya assim mesmo.
 *
 *   `sha256sum`      → o COMO. Sem o comando nomeado, "compare os hashes" é recado vago.
 *   `do NOT deploy`  → o ramo de DIVERGÊNCIA medida.
 *   `cannot compute` → o ramo de AUSÊNCIA. Sonda que não roda ≠ sonda verde: sem este ramo, o
 *                      `sha256sum` ausente do sandbox vira deploy aprovado por silêncio
 *                      (`docs/historico/sonda-ausente-em-script-que-apaga.md`).
 */
export const MARCAS_DE_CONFERENCIA: readonly string[] = [
  'sha256sum',
  'do NOT deploy',
  'cannot compute',
] as const;

/**
 * Filtra os vereditos pelos estados que exigem deploy. Ordena por nome para a saída ser
 * determinística — dois runs sobre o mesmo ledger produzem o MESMO prompt, o que permite
 * comparar colagens e detectar que a leva mudou.
 */
export function selecionarParaDeploy(vereditos: readonly Veredito[]): string[] {
  return vereditos
    .filter((v) => ESTADOS_DE_DEPLOY.includes(v.estado))
    .map((v) => v.edge)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

const NUMERAIS: Record<number, string> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
};

/** Numeral por extenso até 12; acima disso o dígito (o prompt é lido por humano e por LLM). */
export function numeral(n: number): string {
  return NUMERAIS[n] ?? String(n);
}

/**
 * O bloco fail-CLOSED — o miolo desta entrega.
 *
 * ## Por que hash, e por que no PROMPT
 *
 * O deploy de edge no Lovable sai do SANDBOX do projeto (`supabase--deploy_edge_functions`), não de
 * um checkout limpo da `main`, e o sandbox pode estar atrasado na hora do deploy. Não é hipótese:
 * em 2026-08-08 o bot empurrou a linha VELHA de volta 2 min 36 s depois de um merge e deployou dali
 * (`5f5523df9` → `942a69b89` → `aa00a3909`, `@2`→`@^2` em `carteira-positivacao-snapshot`). Ali ele
 * COMMITOU, então vimos. Se tivesse deployado sem commitar, `git log`, `list_edits` e `get_diff`
 * ficariam limpos — o estado exato em que o piloto do MCP declarou "nenhuma edição registrada" — e
 * o `fonte` da sonda bateria assim mesmo, porque ele é fingerprint DECLARADO (lê a constante
 * `FONTE_SHA256[edge]` de um arquivo commitado), não hash calculado sobre o bundle servido. A
 * taxa-base não é zero: o bot commita na main 171×/60 dias.
 *
 * Hash é dado que LLM não fabrica. Ele fecha esse buraco SEM depender de commit do bot, de
 * `list_edits` nem do `fonte` declarado — e vale para o canal MANUAL também, que é onde a maioria
 * dos deploys acontece. Detalhe em `docs/historico/piloto-deploy-mcp-lovable.md`.
 *
 * ## Os três ramos, e por que o terceiro não é preciosismo
 *
 * "Confira e, se diferir, aborte" cobre dois estados e deixa o terceiro em aberto: NÃO CONSEGUI
 * conferir. Sem ramo próprio, o `sha256sum` ausente cai em "não achei diferença" — que é ausência
 * de dado lida como aprovação, exatamente a falha do
 * `docs/historico/sonda-ausente-em-script-que-apaga.md`. Por isso os três ramos são explícitos, e
 * a última linha fecha as duas saídas laterais que um agente prestativo inventaria sozinho:
 * "conserto o arquivo" e "deployo só os que bateram" (= deploy parcial, o modo de falha que o
 * gerador inteiro existe para evitar).
 *
 * ## O que isto NÃO pega
 *
 * Divergência que nasce DEPOIS da entrada do deploy — resolução de dependência e cache de build.
 * `copilot-analyze/index.ts` importa `npm:@anthropic-ai/sdk@^0.93.0` e `npm:@supabase/supabase-js@2`,
 * ranges ABERTOS que estão fora do closure (que só anda em imports locais `./` e `../`): o bundle
 * pode mudar sem uma linha do repo mudar. Isso é a canária determinística com fixture, entrega
 * separada. Não prometa aqui o que este bloco não entrega.
 */
export function blocoDeConferencia(p: Procedencia): string {
  return [
    `**Verify the files before deploying.** The \`sha256\` values above were computed from`,
    `\`${p.ref}\` at commit \`${p.sha}\` — that is the exact state that must go live. For EACH file`,
    `listed, run \`sha256sum <path>\` and compare the result with the hash printed next to it.`,
    '',
    `- Every hash matches → deploy.`,
    `- ANY hash differs → **do NOT deploy.** Reply with a table of \`file | expected | actual\` for`,
    `  every file you checked, and stop.`,
    `- You **cannot compute** a hash for a listed file — file missing, command unavailable, or any`,
    `  error → **do NOT deploy.** Say which file and why, and stop. Not being able to check is not`,
    `  the same as checking and matching.`,
    '',
    `Do not resolve a mismatch by editing files, and do not deploy the subset that matched.`,
    `Report and stop.`,
  ].join('\n');
}

/**
 * Monta a colagem. UMA por LEVA, nunca uma por edge — o cabeçalho declara o total e proíbe pular,
 * cada edge é uma seção numerada com a SUA fatia (cada arquivo com o sha256 esperado), e o fecho
 * pede confirmação item a item (que é o relato que a sessão compara com a sonda depois).
 *
 * Lança com leva vazia: quem chama decide o exit, e "prompt vazio" seria uma colagem que não
 * deploya nada e parece trabalho feito. Lança também com hash que não é hex de 64 — placeholder
 * renderizado vira comparação contra nada, e o agente aprova por vacuidade.
 */
export function montarPrompt(edges: readonly EdgeParaDeploy[], proc: Procedencia): string {
  if (edges.length === 0) {
    throw new Error('montarPrompt: leva vazia — nada pendente de deploy, não há prompt a emitir');
  }
  const semArquivo = edges.filter((e) => e.arquivos.length === 0).map((e) => e.edge);
  if (semArquivo.length > 0) {
    throw new Error(
      `montarPrompt: fatia vazia para ${semArquivo.join(', ')} — o closure nunca é vazio (o index.ts está nele), logo isto é falha de leitura, não leva sem arquivo`,
    );
  }
  const semHash = edges.flatMap((e) =>
    e.arquivos.filter((a) => !HEX64.test(a.sha256)).map((a) => `${e.edge}:${a.caminho}`),
  );
  if (semHash.length > 0) {
    throw new Error(
      `montarPrompt: sha256 ausente ou malformado em ${semHash.join(', ')} — o prompt manda o ` +
        `agente COMPARAR, e comparar contra placeholder é aprovar por vacuidade`,
    );
  }
  if (!/^[0-9a-f]{7,40}$/.test(proc.sha) || proc.ref === '') {
    throw new Error(
      `montarPrompt: procedência inválida (ref "${proc.ref}", sha "${proc.sha}") — hash sem dizer ` +
        `de que commit é hash sem procedência`,
    );
  }

  const lista = (arquivos: readonly ArquivoDaFatia[]): string =>
    arquivos.map(linhaDoArquivo).join('\n');

  if (edges.length === 1) {
    const [only] = edges;
    return [
      `Edit the existing edge function \`${only.edge}\` and update it from the \`main\` branch using`,
      `the current contents of the files listed below. Deploy it **verbatim** — do NOT modify,`,
      `reinterpret, "improve", or reformat any code.`,
      '',
      lista(only.arquivos),
      '',
      blocoDeConferencia(proc),
      '',
      `After deploying, confirm that \`${only.edge}\` shows **Active**, and report the result of the`,
      `hash check.`,
    ].join('\n');
  }

  const n = numeral(edges.length);
  const secoes = edges
    .map((e, i) => `**${i + 1}. \`${e.edge}\`**\n${lista(e.arquivos)}`)
    .join('\n\n');

  return [
    `Edit the following **${n}** existing edge functions and update **each** of them from the \`main\``,
    `branch using the current contents of the files listed under it. Deploy all of them **verbatim** —`,
    `do NOT modify, reinterpret, "improve", or reformat any code. Deploy every function listed; do not`,
    `skip any.`,
    '',
    secoes,
    '',
    blocoDeConferencia(proc),
    '',
    `After deploying, list the ${n} function names and confirm that **each one** shows **Active**,`,
    `and report the result of the hash check.`,
  ].join('\n');
}

/**
 * O check barato que segura o modo de falha: TODO arquivo da fatia aparece no prompt COM o seu
 * hash, todo nome de edge também, e as marcas do ramo fail-closed continuam lá. Falsificado no
 * teste removendo o mapa da fatia, zerando o hash e amputando cada marca — sem isso o check é
 * decorativo.
 *
 * Casa o arquivo entre crases, não solto: `sonda-versao.ts` é substring de `sonda-versao_test.ts`,
 * e um `includes()` cru daria verde para a fatia errada.
 *
 * O hash entra no check porque a colagem sem ele não é "menos completa": é OUTRO artefato — um que
 * manda deployar sem conferir nada, e que o agente obedece igual. E entra PAREADO com o caminho
 * (via `linhaDoArquivo`), não solto: hash certo ao lado do arquivo errado passaria num
 * `includes(hash)` e faria o agente abortar um deploy correto.
 */
export function conferirCobertura(
  prompt: string,
  edges: readonly EdgeParaDeploy[],
): { ok: boolean; faltando: string[] } {
  const faltando: string[] = [];
  for (const e of edges) {
    if (!prompt.includes(`\`${e.edge}\``)) faltando.push(`edge:${e.edge}`);
    for (const arquivo of e.arquivos) {
      if (!prompt.includes(`\`${arquivo.caminho}\``)) {
        faltando.push(`${e.edge}:${arquivo.caminho}`);
        continue; // arquivo ausente já está acusado; somar `:sha256` seria ruído do mesmo defeito
      }
      if (!prompt.includes(linhaDoArquivo(arquivo))) {
        faltando.push(`${e.edge}:${arquivo.caminho}:sha256`);
      }
    }
  }
  for (const marca of MARCAS_DE_CONFERENCIA) {
    if (!prompt.includes(marca)) faltando.push(`fail-closed:${marca}`);
  }
  return { ok: faltando.length === 0, faltando };
}
