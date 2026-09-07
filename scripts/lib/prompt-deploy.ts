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

/** Uma edge da leva, com a fatia que o prompt precisa nomear (closure ∪ {mapa}). */
export interface EdgeParaDeploy {
  edge: string;
  arquivos: string[];
}

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
 * Monta a colagem. UMA por LEVA, nunca uma por edge — o cabeçalho declara o total e proíbe pular,
 * cada edge é uma seção numerada com a SUA fatia, e o fecho pede confirmação item a item (que é o
 * relato que a sessão compara com a sonda depois).
 *
 * Lança com leva vazia: quem chama decide o exit, e "prompt vazio" seria uma colagem que não
 * deploya nada e parece trabalho feito.
 */
export function montarPrompt(edges: readonly EdgeParaDeploy[]): string {
  if (edges.length === 0) {
    throw new Error('montarPrompt: leva vazia — nada pendente de deploy, não há prompt a emitir');
  }
  const semArquivo = edges.filter((e) => e.arquivos.length === 0).map((e) => e.edge);
  if (semArquivo.length > 0) {
    throw new Error(
      `montarPrompt: fatia vazia para ${semArquivo.join(', ')} — o closure nunca é vazio (o index.ts está nele), logo isto é falha de leitura, não leva sem arquivo`,
    );
  }

  const lista = (arquivos: readonly string[]): string =>
    arquivos.map((a) => `- \`${a}\``).join('\n');

  if (edges.length === 1) {
    const [only] = edges;
    return [
      `Edit the existing edge function \`${only.edge}\` and update it from the \`main\` branch using`,
      `the current contents of the files listed below. Deploy it **verbatim** — do NOT modify,`,
      `reinterpret, "improve", or reformat any code.`,
      '',
      lista(only.arquivos),
      '',
      `After deploying, confirm that \`${only.edge}\` shows **Active**.`,
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
    `After deploying, list the ${n} function names and confirm that **each one** shows **Active**.`,
  ].join('\n');
}

/**
 * O check barato que segura o modo de falha: TODO arquivo da fatia aparece no prompt, e todo nome
 * de edge também. Falsificado no teste removendo o mapa da fatia — sem isso o check é decorativo.
 *
 * Casa o arquivo entre crases, não solto: `sonda-versao.ts` é substring de `sonda-versao_test.ts`,
 * e um `includes()` cru daria verde para a fatia errada.
 */
export function conferirCobertura(
  prompt: string,
  edges: readonly EdgeParaDeploy[],
): { ok: boolean; faltando: string[] } {
  const faltando: string[] = [];
  for (const e of edges) {
    if (!prompt.includes(`\`${e.edge}\``)) faltando.push(`edge:${e.edge}`);
    for (const arquivo of e.arquivos) {
      if (!prompt.includes(`\`${arquivo}\``)) faltando.push(`${e.edge}:${arquivo}`);
    }
  }
  return { ok: faltando.length === 0, faltando };
}
