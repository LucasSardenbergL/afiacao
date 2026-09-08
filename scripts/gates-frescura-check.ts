#!/usr/bin/env bun
/**
 * gates-frescura-check.ts — o manual e a máquina conferem um ao outro, nos DOIS sentidos.
 * =====================================================================================
 *
 * A classe (medida em 2026-09-07, `docs/historico/triagem-armadilhas-por-mecanismo.md`): uma
 * triagem classificou as 23 armadilhas do `CLAUDE.md` pelo teste *"qual comando fica vermelho se
 * eu violar isso?"*, respondendo a partir do que o PRÓPRIO manual afirma sobre a máquina. Uma
 * auditoria independente conferiu no repo: **6 das 17 afirmações eram falsas**. E o PR que trouxe
 * esse registro ficou vermelho num gate (`docs:indice`) que o manual não cita em lugar nenhum.
 *
 * É a mesma perda vista de dois lados, e custa o mesmo dos dois: o gate só reprova DEPOIS do fato,
 * quando podia ter orientado ANTES.
 *
 * ## Sentido 1 — nome citado que não aponta para nada
 *
 * O manual nomeia `manifesto.gate` como se fosse comando: não existe em `package.json` nem em
 * workflow nenhum (a cobertura real é vitest em `src/lib/modulos/__tests__`). Um nome morto é pior
 * que silêncio: o agente procura, não acha, e conclui que a proteção não existe — ou pior, roda
 * outra coisa e acha que provou.
 *
 * Regra: todo comando/gate citado no `CLAUDE.md` precisa **existir** (script do `package.json` ou
 * arquivo versionado) **e ser invocado** por workflow, hook, skill ou por outro script.
 *
 * ## Sentido 2 — gate que existe, reprova, e o manual não cita
 *
 * O simétrico, e o que reprovou o #2328. Aqui a verificação NÃO é "o nome aparece em algum lugar
 * de `docs/`": esse critério é frouxo demais, e foi medido. As únicas menções de `docs:indice`,
 * `docs:links`, `bunpin:check`, `mutcheck:selftest` e `scripts:typecheck` viviam numa mesma frase
 * de `docs/agent/deploy.md` — *"Em 2026-08-23 eram 15 steps: …"*. Um censo DATADO, congelado em 15
 * nomes num CI que hoje tem 25. Ele é a própria classe de afirmação que envelhece que este gate
 * existe para pegar; aceitá-lo como citação faria o gate nascer **incapaz de pegar o seu próprio
 * caso de origem**. Sempre-verde é o espelho de sempre-vermelha — as duas aprovam tudo.
 *
 * Por isso o sentido 2 não varre prosa: ele exige um **censo delimitado** (`CENSO_INICIO` /
 * `CENSO_FIM`) que bata EXATAMENTE com o inventário do `ci.yml` + `settings.json`. Bate exato nos
 * dois lados: gate que falta no censo é vermelho (o manual não avisa), e nome no censo que não é
 * mais gate também é vermelho (o manual mente). Um censo que não pode envelhecer em silêncio.
 *
 * ## O que conta como "gate que reprova" — e o que fica de fora DE PROPÓSITO
 *
 * O `ci.yml` tem step informativo por decisão consciente: `sonda:fanout` é rotulado no próprio
 * arquivo como *"informativo, nunca reprova"* e carrega `continue-on-error: true`. Contar aviso
 * como gate faria o sentido 2 acusar ruído — e gate que acusa ruído é gate que se desliga. Então:
 *
 *   - step de CI com `run`, SEM `continue-on-error: true`, que invoca um script → conta;
 *   - hook do `settings.json` que emite `permissionDecision: "deny"` → conta;
 *   - hook que só imprime aviso (`pipestatus-zsh-guard.sh` se declara *"AVISO, não um bloqueio"*)
 *     → NÃO conta como gate. Segue listado no resumo, à parte: é orientação, não bloqueio.
 *
 * A classificação do hook lê o fonte com `removerComentariosShell` do stripper COMPARTILHADO, e
 * não por acaso. `read-contexto-nudge.sh` menciona `"deny"` três vezes — todas em COMENTÁRIO,
 * explicando por que ele decidiu NÃO negar. Uma varredura crua o promove a bloqueio (falso
 * positivo medido ao desenhar este gate). É a lição de `docs/historico/gates-textuais-cegos.md`
 * cobrada na prática, e a razão de nenhuma limpeza aqui ser regex local.
 *
 * ## O eixo POR FORA
 *
 * Um gate que lê o `ci.yml` para se validar mora DENTRO do `ci.yml` — herda o defeito da máquina
 * que vigia. Três eixos ficam de fora:
 *   1. `gates-frescura-check.test.ts` (vitest) exercita as funções puras sobre fixtures sintéticas,
 *      sem tocar o `ci.yml` real;
 *   2. `scripts/test-gates-frescura.sh` roda o gate DE VERDADE contra cópias sabotadas num
 *      diretório temporário, por outro runner (bash), sob `test:hooks` e `test:falsificacao`;
 *   3. o sentido 1 confere existência contra `package.json` e a árvore versionada — fontes que não
 *      são o `ci.yml`.
 */

import { parse } from 'yaml';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { removerCercas } from './lib/markdown-codigo';
import { removerComentariosShell } from '@/lib/gates/limpeza-shell';

/** Marcadores ASCII, caixa fixa — o que a falsificação casa nos dois locales. */
const MARCA_OK = 'FRESCURA-OK';
const MARCA_FALHA = 'FRESCURA-FALHA';
const MARCA_ORFAO = 'ORFAO';
const MARCA_NAO_CITADO = 'NAO-CITADO';
const MARCA_CENSO_OBSOLETO = 'CENSO-OBSOLETO';

export const CENSO_INICIO = '<!--gates:frescura inicio-->';
export const CENSO_FIM = '<!--gates:frescura fim-->';

/**
 * Sentido 1 — citações que NÃO precisam apontar para máquina. Curta, e cada linha justifica-se
 * sozinha: é isto que se revisa no diff quando alguém quiser afrouxar o gate.
 */
export const ALLOWLIST_CITACAO: Record<string, string> = {
  // Wrapper de leitura do banco que mora em `~/.config/afiacao/` — fora do repo POR DESENHO
  // (carrega credencial). Nunca será script do `package.json`.
  'psql-ro': 'wrapper fora do repo (~/.config/afiacao/psql-ro), por desenho',
  // `@media (pointer:coarse)` — media feature do CSS. Tem forma de script npm (`a:b`) e nunca
  // sera comando; a alternativa (exigir que o token exista no package.json para ser cobrado)
  // deixaria passar exatamente o nome APODRECIDO que este sentido existe para pegar.
  'pointer:coarse': 'media feature do CSS, nao comando',
};

/**
 * Sentido 2 — gates que NÃO precisam de linha no censo. Também curta, também justificada.
 * O corte é "isto orienta o agente?" — infraestrutura de runner não orienta ninguém.
 */
export const ALLOWLIST_CENSO: Record<string, string> = {
  install: 'infra do runner (bun install --frozen-lockfile), nao orienta decisao de codigo',
  cache: 'infra do runner (actions/cache), nao orienta decisao de codigo',
};

// ---------------------------------------------------------------------------------------------
// Sentido 1 — extração das citações do CLAUDE.md
// ---------------------------------------------------------------------------------------------

export interface Citacao {
  nome: string;
  linha: number;
}

/** Nome de script npm: minúsculo, com ao menos um `:` — `docs:indice`, `sonda:bump`. */
const FORMA_SCRIPT = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)+$/;

/**
 * Extrai o que o manual afirma ser máquina. Três formas, que é o que o `CLAUDE.md` de fato usa:
 *   - `bun run <x>` / `bunx run <x>` — invocação explícita;
 *   - token entre crases com forma de script npm (`docs:indice`);
 *   - token contendo `.gate` (`manifesto.gate`) — o apelido que originou o caso.
 *
 * A cerca de código sai antes (`removerCercas`, o stripper compartilhado): dentro dela o comando
 * ILUSTRA o uso — o bloco `### Scripts` do manual mostra `bun dev`, `bun build`, `heavy bun run
 * test`. Cobrar invocação em CI de um exemplo de uso local seria falso positivo permanente. A
 * crase INLINE fica intacta de propósito: é onde a citação canônica nasce, e passar o texto pelo
 * `removerCodigo` zeraria a medição inteira — verde por cegueira.
 */
export function extrairCitacoes(markdown: string): Citacao[] {
  const { texto } = removerCercas(markdown);
  const achados: Citacao[] = [];
  const vistos = new Set<string>();

  texto.split('\n').forEach((linha, i) => {
    const registrar = (nome: string) => {
      const chave = `${nome}`;
      if (vistos.has(chave)) return;
      vistos.add(chave);
      achados.push({ nome, linha: i + 1 });
    };

    for (const m of linha.matchAll(/\bbunx?\s+run\s+([a-zA-Z0-9:_.-]+)/g)) registrar(m[1]);
    for (const m of linha.matchAll(/`([^`]+)`/g)) {
      const t = m[1].trim();
      if (FORMA_SCRIPT.test(t)) registrar(t);
      else if (/\.gate\b/.test(t)) registrar(t);
    }
  });

  return achados;
}

// ---------------------------------------------------------------------------------------------
// Sentido 2 — inventário da máquina
// ---------------------------------------------------------------------------------------------

export interface GateCI {
  nome: string;
  linha: number;
  step: string;
  job: string;
}

/**
 * Nomes de script (`package.json`) que um `run:` invoca. É a ÚNICA definição de "este step tem
 * nome de comando" no repo, de propósito: `inventarioCI` a usa para incluir, e
 * `bloqueantesSemScript` (aqui) e `bloqueantesOpacos` (na máquina de exclusividade) a usam para o
 * complemento — contar quem ficou de fora. Se as duas pontas usassem regras diferentes, um step
 * poderia cair na fresta e sumir das DUAS listas, que é exatamente o silêncio que os contadores
 * existem para quebrar.
 */
export function nomesDeScript(run: string): Set<string> {
  const nomes = new Set<string>();
  for (const m of run.matchAll(/\bbunx?\s+run\s+([a-zA-Z0-9:_.-]+)/g)) nomes.add(m[1]);
  for (const m of run.matchAll(/\bbunx\s+(?!run\b)([a-z][a-zA-Z0-9_.-]*)/g)) nomes.add(m[1]);
  for (const m of run.matchAll(/\bbun\s+(?!run\b|x\b)([a-z][a-zA-Z0-9_-]*)/g)) nomes.add(m[1]);
  return nomes;
}

/**
 * Todo step com `run` que invoca um script e NÃO carrega `continue-on-error: true`.
 * O YAML é lido por parser (`yaml`), nunca por regex: `continue-on-error` é a diferença entre
 * bloqueio e aviso, e errá-la nos dois sentidos (acusar ruído / aprovar buraco) desliga o gate.
 */
export function inventarioCI(fonte: string): GateCI[] {
  const doc = parse(fonte) as { jobs?: Record<string, { steps?: unknown[] }> };
  const linhas = fonte.split('\n');
  const achados = new Map<string, GateCI>();

  for (const [job, corpo] of Object.entries(doc.jobs ?? {})) {
    for (const bruto of corpo?.steps ?? []) {
      const st = bruto as { name?: string; run?: unknown; 'continue-on-error'?: unknown };
      if (typeof st.run !== 'string') continue;
      if (st['continue-on-error'] === true) continue;

      const nomes = nomesDeScript(st.run);

      const alvo = st.name ? `name: ${st.name}` : st.run.split('\n')[0].trim();
      const idx = linhas.findIndex((l) => l.includes(alvo));

      for (const nome of nomes) {
        if (nome in ALLOWLIST_CENSO) continue;
        if (achados.has(nome)) continue;
        achados.set(nome, { nome, linha: idx >= 0 ? idx + 1 : 0, step: st.name ?? '(sem nome)', job });
      }
    }
  }
  return [...achados.values()].sort((a, b) => a.nome.localeCompare(b.nome));
}

/**
 * Steps BLOQUEANTES que o inventário não consegue identificar por nome, porque não invocam um
 * script (`bun`/`bunx`). Hoje são 2 — o download do shellcheck pinado e o step que converte o
 * `exit 2` do carimbo em falha do monitor — e nenhum dos dois orienta decisão de código.
 *
 * Existe como CONTADOR VISÍVEL no resumo, e não como filtro calado, porque exclusão silenciosa é o
 * mesmo veneno do censo datado: "29 gates conferidos" lê como cobertura TOTAL tanto quando é
 * quanto quando deixou algo de fora. Um gate futuro escrito em python ou em shell puro cairia
 * aqui — e o número no log é o que faz alguém perceber, em vez de descobrir pelo PR vermelho.
 */
export function bloqueantesSemScript(fonte: string): string[] {
  const doc = parse(fonte) as { jobs?: Record<string, { steps?: unknown[] }> };
  const saida: string[] = [];
  for (const [job, corpo] of Object.entries(doc.jobs ?? {})) {
    for (const bruto of corpo?.steps ?? []) {
      const st = bruto as { name?: string; run?: unknown; 'continue-on-error'?: unknown };
      if (typeof st.run !== 'string' || st['continue-on-error'] === true) continue;
      if (nomesDeScript(st.run).size > 0) continue;
      saida.push(`${job}: ${st.name ?? '(sem nome)'}`);
    }
  }
  return saida;
}

export interface GateHook {
  arquivo: string;
  evento: string;
  bloqueia: boolean;
}

/**
 * Hooks do `settings.json`, separados em bloqueio e aviso. A leitura do fonte passa pelo stripper
 * COMPARTILHADO de shell: `read-contexto-nudge.sh` cita `"deny"` só em comentário, explicando por
 * que NÃO nega — regex crua o promove a bloqueio.
 */
export function inventarioHooks(
  settingsJson: string,
  lerHook: (arquivo: string) => string | null,
): GateHook[] {
  const s = JSON.parse(settingsJson) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
  const achados = new Map<string, GateHook>();

  for (const [evento, grupos] of Object.entries(s.hooks ?? {})) {
    for (const g of grupos ?? []) {
      for (const h of g.hooks ?? []) {
        const m = (h.command ?? '').match(/([\w.-]+\.(?:sh|ts|js))/);
        if (!m) continue;
        const arquivo = m[1];
        if (achados.has(arquivo)) continue;
        const fonte = lerHook(arquivo);
        const bloqueia =
          fonte !== null && /permissionDecision"?\s*:\s*"?deny/.test(removerComentariosShell(fonte));
        achados.set(arquivo, { arquivo, evento, bloqueia });
      }
    }
  }
  return [...achados.values()].sort((a, b) => a.arquivo.localeCompare(b.arquivo));
}

/** Nomes entre crases dentro do bloco delimitado. `achou: false` = bloco ausente (exit 2). */
export function lerCenso(markdown: string): { nomes: string[]; achou: boolean } {
  const i = markdown.indexOf(CENSO_INICIO);
  const f = markdown.indexOf(CENSO_FIM);
  if (i < 0 || f < 0 || f < i) return { nomes: [], achou: false };
  const bloco = markdown.slice(i + CENSO_INICIO.length, f);
  const nomes = [...bloco.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  return { nomes: [...new Set(nomes)].sort(), achou: true };
}

// ---------------------------------------------------------------------------------------------
// Sentido 1 — existe? é invocado?
// ---------------------------------------------------------------------------------------------

/**
 * Casa a INVOCAÇÃO, não a menção. `test` aparece em quase todo arquivo do repo; `bun run test`
 * aparece onde alguém de fato roda. Token com `:` ou `.` (`docs:indice`, `manifesto.gate`) não
 * tem esse problema e vale nu — é nome que ninguém digita por acaso.
 */
export function padraoInvocacao(nome: string): RegExp {
  const esc = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nu = /[:.]/.test(nome) ? `|${esc}(?![\\w:.-])` : '';
  return new RegExp(`(?:\\b(?:bunx?|npm|pnpm|yarn)\\s+(?:run\\s+)?${esc}(?![\\w:.-]))${nu}`);
}

export interface VeredictoCitacao {
  citacao: Citacao;
  existe: boolean;
  invocado: boolean;
  motivo: string;
}

export function conferirCitacoes(
  citacoes: Citacao[],
  scripts: Record<string, string>,
  arquivosNaArvore: string[],
  invocadores: string,
): VeredictoCitacao[] {
  return citacoes
    .filter((c) => !(c.nome in ALLOWLIST_CITACAO))
    .map((c) => {
      const ehScript = c.nome in scripts;
      const ehArquivo = arquivosNaArvore.some((a) => a.includes(c.nome));
      const existe = ehScript || ehArquivo;

      const padrao = padraoInvocacao(c.nome);
      // Corpo de OUTRO script do package.json conta como invocador: `test:hooks` roda
      // `scripts/test-*.sh` no laço, e quem cita o laço cita o script.
      const viaScripts = Object.entries(scripts).some(([k, v]) => k !== c.nome && padrao.test(v));
      // `*.test.ts` é descoberto por glob pelo vitest — nenhum workflow o nomeia, e `bun run test`
      // (que É step do CI) o roda. Nomear o arquivo de teste é invocação legítima.
      const viaVitest = arquivosNaArvore.some((a) => a.includes(c.nome) && a.endsWith('.test.ts'));
      const invocado = padrao.test(invocadores) || viaScripts || viaVitest;

      const motivo = !existe
        ? 'nao existe em package.json nem na arvore versionada'
        : !invocado
          ? 'existe, mas nenhum workflow, hook, skill ou script o invoca'
          : '';
      return { citacao: c, existe, invocado, motivo };
    })
    .filter((v) => v.motivo !== '');
}

// ---------------------------------------------------------------------------------------------
// Coleta de arquivos
// ---------------------------------------------------------------------------------------------

function lerSeExistir(p: string): string | null {
  return existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : null;
}

function varrer(dir: string, filtro: (f: string) => boolean, saida: string[] = []): string[] {
  if (!existsSync(dir)) return saida;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) varrer(p, filtro, saida);
    else if (filtro(e.name)) saida.push(p);
  }
  return saida;
}

/**
 * O texto onde se procura invocação. Workflows entram pelos blocos `run` (parseados, não pelo
 * texto cru: comentário de YAML não invoca nada); hooks entram sem comentário; skills entram
 * inteiras — o `CLAUDE.md` cita DE PROPÓSITO comandos que só skill roda (`pendencias:deploy` vive
 * em `/fecho` e `lovable-deploy-verify`), e skill é invocador de verdade.
 */
function montarInvocadores(raiz: string): string {
  const partes: string[] = [];

  for (const wf of varrer(join(raiz, '.github/workflows'), (f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    const fonte = lerSeExistir(wf);
    if (!fonte) continue;
    try {
      const doc = parse(fonte) as { jobs?: Record<string, { steps?: { run?: unknown }[] }> };
      for (const job of Object.values(doc.jobs ?? {}))
        for (const st of job?.steps ?? []) if (typeof st.run === 'string') partes.push(st.run);
    } catch {
      partes.push(fonte); // YAML ilegível: melhor contar demais do que acusar órfão falso
    }
  }

  for (const h of varrer(join(raiz, '.claude/hooks'), (f) => f.endsWith('.sh'))) {
    const fonte = lerSeExistir(h);
    if (fonte) partes.push(removerComentariosShell(fonte));
  }

  const settings = lerSeExistir(join(raiz, '.claude/settings.json'));
  if (settings) partes.push(settings);

  for (const s of varrer(join(raiz, '.claude/skills'), (f) => f.endsWith('.md'))) {
    const fonte = lerSeExistir(s);
    if (fonte) partes.push(fonte);
  }

  return partes.join('\n');
}

function arvoreDeArquivos(raiz: string): string[] {
  // Varredura do FILESYSTEM, não do índice do git — e o nome diz isso de propósito. A diferença
  // é real: um arquivo não versionado satisfaz "existe" aqui e some no CI, então o veredito local
  // é mais frouxo que o do CI, nunca mais apertado. Fica assim porque a raiz sintética da suíte
  // de falsificação não é um repositório git, e `git ls-files` não teria o que responder lá.
  const ignorar = new Set(['node_modules', '.git', 'dist', 'coverage', '.next']);
  const saida: string[] = [];
  const anda = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (ignorar.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) anda(p);
      else saida.push(relative(raiz, p));
    }
  };
  anda(raiz);
  return saida;
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

/** Onde mora o censo delimitado — a seção "O que BLOQUEIA o PR" do doc de deploy. */
const ARQUIVO_CENSO = 'docs/agent/deploy.md';

function main(): number {
  const argv = process.argv.slice(2);
  const iRaiz = argv.indexOf('--raiz');
  const raiz = iRaiz >= 0 ? argv[iRaiz + 1] : process.cwd();

  const faltando = ['CLAUDE.md', '.github/workflows/ci.yml', 'package.json', ARQUIVO_CENSO].filter(
    (p) => !existsSync(join(raiz, p)),
  );
  if (faltando.length > 0) {
    console.error(`${MARCA_FALHA}: arquivo obrigatorio ausente: ${faltando.join(', ')}`);
    return 2;
  }

  const claude = readFileSync(join(raiz, 'CLAUDE.md'), 'utf8');
  const ciFonte = readFileSync(join(raiz, '.github/workflows/ci.yml'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  const censoFonte = readFileSync(join(raiz, ARQUIVO_CENSO), 'utf8');

  let gatesCI: GateCI[];
  try {
    gatesCI = inventarioCI(ciFonte);
  } catch (e) {
    console.error(`${MARCA_FALHA}: ci.yml ilegivel como YAML: ${(e as Error).message}`);
    return 2;
  }

  const settingsPath = join(raiz, '.claude/settings.json');
  let hooks: GateHook[] = [];
  if (existsSync(settingsPath)) {
    try {
      hooks = inventarioHooks(readFileSync(settingsPath, 'utf8'), (arq) =>
        lerSeExistir(join(raiz, '.claude/hooks', arq)),
      );
    } catch (e) {
      console.error(`${MARCA_FALHA}: settings.json ilegivel: ${(e as Error).message}`);
      return 2;
    }
  }

  const censo = lerCenso(censoFonte);
  if (!censo.achou) {
    console.error(`${MARCA_FALHA}: bloco do censo ausente em ${ARQUIVO_CENSO} (${CENSO_INICIO})`);
    return 2;
  }

  // ---- Sentido 1 -----------------------------------------------------------------------------
  const citacoes = extrairCitacoes(claude);
  const orfaos = conferirCitacoes(citacoes, scripts, arvoreDeArquivos(raiz), montarInvocadores(raiz));

  // ---- Sentido 2 -----------------------------------------------------------------------------
  const bloqueiam = [
    ...gatesCI.map((g) => ({ nome: g.nome, onde: `.github/workflows/ci.yml:${g.linha}`, o: g.step })),
    ...hooks
      .filter((h) => h.bloqueia)
      .map((h) => ({ nome: h.arquivo, onde: `.claude/settings.json:${h.evento}`, o: 'hook deny' })),
  ];
  const noCenso = new Set(censo.nomes);
  const naoCitados = bloqueiam.filter((g) => !noCenso.has(g.nome));

  const conhecidos = new Set(bloqueiam.map((g) => g.nome));
  const obsoletos = censo.nomes.filter((n) => !conhecidos.has(n));

  // ---- Relatório -----------------------------------------------------------------------------
  const avisos = hooks.filter((h) => !h.bloqueia);
  console.log(
    `frescura: ${citacoes.length} citacoes no CLAUDE.md | ${gatesCI.length} gates do ci.yml | ` +
      `${hooks.filter((h) => h.bloqueia).length} hooks deny | ${avisos.length} hooks de aviso (nao sao gate) | ` +
      `${censo.nomes.length} nomes no censo | allowlist: ${Object.keys(ALLOWLIST_CITACAO).length} citacao + ${Object.keys(ALLOWLIST_CENSO).length} censo`,
  );
  const opacos = bloqueantesSemScript(ciFonte);
  console.log(
    `frescura: ${opacos.length} step(s) bloqueante(s) SEM invocacao de script — fora do censo por nao terem nome de comando:` +
      (opacos.length > 0 ? `\n  - ${opacos.join('\n  - ')}` : ' (nenhum)'),
  );

  for (const v of orfaos) {
    console.error(`${MARCA_ORFAO}: \`${v.citacao.nome}\` em CLAUDE.md:${v.citacao.linha} — ${v.motivo}`);
  }
  for (const g of naoCitados) {
    console.error(`${MARCA_NAO_CITADO}: \`${g.nome}\` reprova em ${g.onde} e nao esta no censo de ${ARQUIVO_CENSO} — ${g.o}`);
  }
  for (const n of obsoletos) {
    console.error(`${MARCA_CENSO_OBSOLETO}: \`${n}\` esta no censo de ${ARQUIVO_CENSO} mas nao reprova nada hoje`);
  }

  const total = orfaos.length + naoCitados.length + obsoletos.length;
  if (total > 0) {
    console.error(
      `${MARCA_FALHA}: ${orfaos.length} orfao(s) + ${naoCitados.length} nao-citado(s) + ${obsoletos.length} obsoleto(s)`,
    );
    return 1;
  }
  console.log(`${MARCA_OK}: manual e maquina conferem nos dois sentidos`);
  return 0;
}

if (import.meta.main) process.exit(main());
