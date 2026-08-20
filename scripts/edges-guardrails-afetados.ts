#!/usr/bin/env bun
/**
 * edges-guardrails-afetados.ts — "quem LÊ este arquivo?" para edge functions.
 * ============================================================================================
 *
 * ## A classe: "comando por tecnologia" é um mapa errado do CI
 *
 * A validação de edge deste repo tem TRÊS pernas e nenhuma cobre a outra (docs/agent/deploy.md):
 * `test:edges` (suíte Deno), `edges:typecheck` (deno check) e o **vitest** — que reprova edge por
 * TESTE DE FORMA, lendo `supabase/functions/` como TEXTO a partir de `src/`.
 *
 * Medido no PR #1772: a sonda de versão em 5 edges money-path saiu com os três comandos "de edge"
 * VERDES, exit 0 capturado em cada um — e o `validate` vermelho. Quem reprovou foi
 * `src/__tests__/edge-money-path-invariants.test.ts`, que exigia `status: 409` a até 700 chars de
 * `if (mappingError)` em `supabase/functions/omie-cliente/index.ts`; a centralização das respostas
 * num helper `jsonRes(body, status)` virou `jsonRes(..., 409)`. Semântica intacta, forma mudada.
 *
 * O erro não foi esquecer um comando: foi a PERGUNTA. "Qual runtime é este arquivo" não prediz
 * quem o valida — um teste em `src/` valida uma edge em `supabase/functions/`. A pergunta que
 * prediz é **quem LÊ este arquivo**. Este motor responde exatamente isso.
 *
 * O PR #1777 já registrou a regra em texto nos quatro lugares. Pela meta-regra do `/matar-classe`:
 * contramedida textual reincide, gate estrutural para. Este é o gate — no LOOP DE FEEDBACK LOCAL,
 * não no CI: o CI já pega (foi ele que reprovou o #1772); o buraco é descobrir só depois do push.
 *
 * ## Como resolve: literal de string, prefixo por SEGMENTO
 *
 * Um `*.test.ts` é guardrail-de-forma quando cita `supabase/functions` num literal E lê o disco
 * (`readFileSync`/`readdirSync`). Cada literal é um ALCANCE, e o alcance cobre o arquivo editado
 * quando é ele mesmo ou um diretório ancestral. As duas formas reais no repo caem no mesmo teste:
 *
 *   · `const OMIE_CLIENTE = 'supabase/functions/omie-cliente/index.ts'`  → cobre 1 arquivo
 *   · `const DIRS = ['src', 'supabase/functions', 'scripts']`            → cobre TODA edge
 *
 * A fronteira é de SEGMENTO, não de string: `supabase/functions/omie-sync` NÃO cobre
 * `supabase/functions/omie-sync-pedidos-compra/index.ts`. Prefixo de string casaria — e este repo
 * tem os dois diretórios, então o falso-positivo seria permanente, não hipotético.
 *
 * ## Precisão > recall (mesma doutrina do `edges:typecheck` e do `docs-indice-gate-check`)
 *
 * Guardrail que monte o caminho dinamicamente (fora de literal) escapa deste motor, e tudo bem: o
 * CI continua sendo a rede. O que NÃO pode é gritar errado — gate que grita errado treina a
 * ignorar. Por isso só literal ENTRE ASPAS conta: `// vide supabase/functions/x` é prosa, não
 * leitura, e citar não é ler.
 *
 * Uso:  bun scripts/edges-guardrails-afetados.ts supabase/functions/omie-cliente/index.ts
 * Hook: .claude/hooks/edge-guardrail-nudge.sh (PreToolUse Write|Edit)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** raiz das edge functions, relativa à raiz do repo */
export const RAIZ_EDGES = 'supabase/functions';

/** diretórios varridos atrás de teste — espelha o `include` do vitest (vitest.config.ts) */
const DIRS_TESTE = ['src', 'scripts'];

/** quantos guardrails o nudge lista antes de resumir o resto */
const MAX_LISTADOS = 8;

export interface EntradaIndice {
  /** caminho do arquivo de teste, relativo à raiz do repo */
  teste: string;
  /** literais `supabase/functions…` que o teste cita (já normalizados) */
  alcances: string[];
}

export interface Guardrail {
  /** caminho do arquivo de teste, relativo à raiz do repo */
  teste: string;
  /** o literal mais específico que casou com algum arquivo editado */
  alcance: string;
  /** true quando o alcance é um diretório ancestral (varredura), false quando é o arquivo exato */
  varredura: boolean;
}

/**
 * Reduz um caminho à forma canônica relativa à raiz do repo: absoluto do worktree, `./x` e barra
 * final viram a mesma string. Caminho que não passa por `supabase/functions` volta só normalizado.
 */
function normalizar(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const i = s.indexOf(`${RAIZ_EDGES}/`);
  if (i >= 0) s = s.slice(i);
  else if (s.endsWith(RAIZ_EDGES)) s = RAIZ_EDGES;
  return s.replace(/^\.\//, '');
}

/** true quando o caminho (já normalizado) está sob `supabase/functions` */
function ehEdge(p: string): boolean {
  return p === RAIZ_EDGES || p.startsWith(`${RAIZ_EDGES}/`);
}

/**
 * Extrai os alcances de um fonte de teste: literais entre aspas (simples, duplas ou template) que
 * contenham `supabase/functions`. Glob (`**` / `*.ts`) degrada para o diretório pai — é o que um
 * glob de fato alcança. Menção em prosa (sem aspas) fica de fora de propósito.
 */
export function extrairAlcances(fonte: string): string[] {
  const achados = new Set<string>();
  const re = /(['"`])([^'"`\n]*supabase\/functions[^'"`\n]*)\1/g;
  for (const m of fonte.matchAll(re)) {
    let bruto = m[2];
    const estrela = bruto.indexOf('*');
    if (estrela >= 0) bruto = bruto.slice(0, bruto.lastIndexOf('/', estrela));
    const alc = normalizar(bruto);
    if (ehEdge(alc)) achados.add(alc);
  }
  return [...achados];
}

/** true quando o fonte é um guardrail de FORMA de edge: cita edge num literal E lê o disco */
export function ehGuardrailDeForma(fonte: string): boolean {
  return /read(?:File|dir)Sync/.test(fonte) && extrairAlcances(fonte).length > 0;
}

/** true quando o alcance cobre o arquivo — igualdade ou ancestral, com fronteira de SEGMENTO */
export function alcanceCobre(alcance: string, arquivo: string): boolean {
  const a = normalizar(alcance);
  const f = normalizar(arquivo);
  return f === a || f.startsWith(`${a}/`);
}

function varrerTestes(raiz: string, dir: string, saida: string[]): void {
  let entradas;
  try {
    entradas = readdirSync(join(raiz, dir), { withFileTypes: true });
  } catch {
    return; // diretório ausente (worktree parcial): fail-open, não é erro
  }
  for (const e of entradas) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      varrerTestes(raiz, rel, saida);
    } else if (/\.(?:test|spec)\.tsx?$/.test(e.name)) {
      saida.push(rel);
    }
  }
}

/**
 * Raiz do repo. Sob `bun` (o caso do hook) `import.meta.url` é um `file:` e a raiz sai do PRÓPRIO
 * arquivo — melhor que `cwd`, porque o hook pode ser chamado de qualquer diretório. Sob vitest o
 * Vite transforma o módulo e a URL NÃO é `file:` (`fileURLToPath` lança "The URL must be of scheme
 * file"); ali o `cwd` é a raiz do projeto e serve. Medido: o teste de integração deste motor foi
 * quem pegou — a 1ª versão só tinha o ramo `file:` e a suíte inteira nem coletava.
 */
export function raizRepo(): string {
  const url = import.meta.url;
  if (url && url.startsWith('file:')) return fileURLToPath(new URL('..', url));
  return process.cwd();
}

/** Lê o repo e monta o índice dos guardrails de forma que existem hoje. */
export function carregarIndice(raiz = raizRepo()): EntradaIndice[] {
  const arquivos: string[] = [];
  for (const d of DIRS_TESTE) varrerTestes(raiz, d, arquivos);

  const indice: EntradaIndice[] = [];
  for (const teste of arquivos.sort()) {
    let fonte: string;
    try {
      fonte = readFileSync(join(raiz, teste), 'utf8');
    } catch {
      continue;
    }
    if (!ehGuardrailDeForma(fonte)) continue;
    indice.push({ teste, alcances: extrairAlcances(fonte) });
  }
  return indice;
}

/**
 * Dado o índice e os arquivos editados, devolve os guardrails que leem algum deles — um por
 * teste, com o alcance mais específico que casou. Específicos primeiro (mais informativos).
 */
export function guardrailsAfetados(indice: EntradaIndice[], arquivos: string[]): Guardrail[] {
  const alvos = arquivos.map(normalizar).filter(ehEdge);
  if (alvos.length === 0) return [];

  const achados: Guardrail[] = [];
  for (const entrada of indice) {
    let melhor: Guardrail | null = null;
    for (const alcance of entrada.alcances) {
      for (const alvo of alvos) {
        if (!alcanceCobre(alcance, alvo)) continue;
        const a = normalizar(alcance);
        if (melhor && melhor.alcance.length >= a.length) continue;
        melhor = { teste: entrada.teste, alcance: a, varredura: a !== alvo };
      }
    }
    if (melhor) achados.push(melhor);
  }

  return achados.sort(
    (x, y) =>
      Number(x.varredura) - Number(y.varredura) ||
      y.alcance.length - x.alcance.length ||
      x.teste.localeCompare(y.teste),
  );
}

/** Texto do nudge. Primeira linha = resumo (o hook usa como `systemMessage`). Vazio = nada a dizer. */
export function formatarNudge(arquivos: string[], guardrails: Guardrail[]): string {
  if (guardrails.length === 0) return '';

  const alvos = arquivos.map(normalizar).filter(ehEdge);
  const quem = alvos.length === 1 ? alvos[0] : `${alvos.length} edges`;
  const linhas = [
    `GUARDRAIL-DE-FORMA: ${guardrails.length} teste(s) do vitest leem ${quem} como TEXTO — mudar a FORMA reprova o \`bun run test\` mesmo com a semântica intacta, e nenhum dos 3 comandos de edge (test:edges/edges:typecheck/lint) enxerga isso (PR #1772).`,
  ];
  for (const g of guardrails.slice(0, MAX_LISTADOS)) {
    linhas.push(`  · ${g.teste}${g.varredura ? `  (varre ${g.alcance}/)` : '  (literal do arquivo)'}`);
  }
  if (guardrails.length > MAX_LISTADOS) linhas.push(`  · … +${guardrails.length - MAX_LISTADOS}`);
  linhas.push(
    `Antes de entregar, rode-os: heavy bunx vitest run ${guardrails.map((g) => g.teste).join(' ')}`,
  );
  return linhas.join('\n');
}

if (import.meta.main) {
  const alvos = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const texto = formatarNudge(alvos, guardrailsAfetados(carregarIndice(), alvos));
  if (texto) console.log(texto);
}
