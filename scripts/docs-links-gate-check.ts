#!/usr/bin/env bun
/**
 * docs-links-gate-check.ts — gate de CI que prova que todo link relativo de `.md` RESOLVE.
 * ============================================================================================
 *
 * A classe: link markdown cujo caminho relativo aponta para lugar nenhum. É SILENCIOSO por
 * construção — o markdown não valida nada, o CI fica verde, e o leitor só descobre no clique.
 * O irmão mais caro dessa classe é o caminho escrito **a partir da raiz do repo** dentro de um doc
 * que não está na raiz: `](docs/historico/x.md)` num arquivo de `docs/historico/` resolve para
 * `docs/historico/docs/historico/x.md`. O link PARECE certo em revisão de PR — o alvo existe, o
 * texto está correto, só o ponto de partida é outro.
 *
 * Medido neste repo (2026-08-21, #1863): ao editar `.claude/skills/fecho/SKILL.md` escreveu-se
 * `](../../docs/historico/mergeabilidade-assincrona.md)`. De `.claude/skills/fecho/`, `../../` é
 * `.claude/` — o link apontava para `.claude/docs/historico/…`. Os DOIS gates de docs do CI ficaram
 * verdes: o `docs:indice` só confere que todo `.md` de diretório com README tem linha no índice, e
 * o `docs:citacoes` só confere citação de LINHA (`arquivo.md:123<!--cita: trecho-->`). Nenhum dos
 * dois resolve link. E `.claude/skills/` — 35 arquivos, o maior corpo de instrução operacional do
 * projeto — não tinha cobertura automatizada NENHUMA: `git grep -l '.claude/skills' src/ scripts/`
 * devolve vazio, nenhum código do repo lê as skills.
 *
 * Por que um gate e não uma revisão mais atenta: ao nascer, este gate achou **10 links quebrados
 * vivos na main**, todos da variante "caminho a partir da raiz" (`auditoria-ux-redesign.md` →
 * `docs/ux-audit/*`, `bugs-resolvidos.md` → `docs/superpowers/specs/*`, `lovable-supabase.md` →
 * `docs/migrations-audit.md`, `schema-security-report.md` → `superpowers/specs/*`). Os alvos todos
 * EXISTEM, em outro caminho — é a assinatura da classe, e ela sobreviveu a todas as revisões
 * humanas que passaram por esses docs. É a meta-regra do catálogo de retrabalho: contramedida
 * textual reincide, gate estrutural para.
 *
 * ## Precisão, não recall (mesma doutrina do `docs:indice` e do `edges:typecheck`)
 *
 * O gate só olha o que ele consegue julgar com certeza:
 *
 *  - **Só alvo terminado em `.md`.** Link para diretório, imagem ou âncora pura (`](#secao)`) fica
 *    de fora — resolver isso pedia entender o renderizador, e um gate que chuta treina a ignorar o
 *    vermelho. A ÂNCORA de um `.md` (`](x.md#secao)`) é aceita e só a parte do ARQUIVO é resolvida:
 *    linkar a seção certa de um doc longo é uso normal de markdown, e recusar isso seria o
 *    falso-positivo mais provável da regra.
 *  - **`http(s)://`, `mailto:` e qualquer outro esquema ficam de fora.** Link externo é problema de
 *    rede, não de estrutura de arquivo; checá-lo tornaria o CI dependente da internet e FLAKY.
 *  - **Código não é link — é EXEMPLO.** Medido: os 5 únicos falsos-positivos do corpus são docs que
 *    DOCUMENTAM o formato do gate irmão — `gate-indice-docs.md:60` tem `` `[a.md](b.md)` `` como
 *    ilustração da invariante "TEXTO = DESTINO". São **inline code** (crase), não bloco cercado:
 *    remover só ``` deixaria o gate nascer com 5 exceções. Nascer com exceção é nascer ignorado.
 *
 * ## Por que um stripper LOCAL e não o `removerComentarios` compartilhado
 *
 * A regra do CLAUDE.md ("gate textual limpa comentário com o stripper COMPARTILHADO") existe por
 * causa de regex de comentário que come o miolo do arquivo. Aqui o stripper compartilhado é a
 * ferramenta ERRADA, não uma reutilização que deixei de fazer: `removerComentarios` remove `//` de
 * JS/TS — em markdown isso decapitaria **todo `https://`** do corpus (267 links). O que se herda
 * dele é a LIÇÃO, não o código:
 *
 *  - a remoção **preserva a numeração de linha** (a linha é esvaziada, nunca deletada), senão o erro
 *    aponta para a linha errada e o gate vira caça ao tesouro;
 *  - a crase é casada **dentro da MESMA linha**. Um `[\s\S]*?` entre crases faria exatamente o
 *    estrago do catálogo (`docs/historico/gates-textuais-cegos.md`): uma crase solta em prosa
 *    engoliria até a próxima crase, dezenas de linhas adiante, e o gate ficaria verde por CEGUEIRA.
 *    Sem par na linha, a crase é tratada como TEXTO — que é o que ela é;
 *  - **cerca não fechada é ERRO, não silêncio** (invariante 4). É o único jeito de o stripper
 *    esvaziar um bloco grande, então ele grita em vez de descartar.
 *
 * ## A autoridade é o ÍNDICE DO GIT, não o `existsSync`
 *
 * O gate resolve contra o conjunto de arquivos RASTREADOS. Duas razões, as duas medidas em falha
 * real de outro time:
 *
 *  1. **Caixa.** O APFS do macOS é case-INSENSITIVE: `](../Historico/x.md)` passa no `existsSync` do
 *     laptop e quebra no Linux do CI e no GitHub. Um `Set` de caminhos do git compara caixa de forma
 *     exata nos dois sistemas — o mesmo veredito no laptop e no runner.
 *  2. **Arquivo não commitado** existe no disco de quem escreveu e em mais lugar nenhum. Para o
 *     leitor (GitHub, clone novo) o link está quebrado; o `existsSync` diria que está ótimo.
 *
 * O `existsSync` continua a ser chamado, mas só para DISCRIMINAR a mensagem ("não existe" vs.
 * "existe no disco e não está no git"), que é o que torna o erro acionável.
 *
 * ## Escopo: todo `.md` rastreado
 *
 * A tarefa pedia `docs/`, `.claude/skills/`, `.claude/agents/`, `CLAUDE.md` e `README.md`. O gate
 * varre o superconjunto — todo `.md` do `git ls-files` — por três motivos baratos: (a) `git
 * ls-files` já exclui `node_modules`/untracked de graça, coisa que um walk de diretório pediria
 * lista de exceção; (b) os 13 `.md` fora daquelas raízes são todos de primeira mão (`supabase/`,
 * `src/content/help`, `db/`, `connector/`) e um deles, `supabase/schema-security-report.md`, tem um
 * dos 10 links quebrados; (c) `.claude/agents/` não existe hoje — uma lista fixa de raízes teria de
 * tolerar raiz ausente, e o `ls-files` cobre o diretório no dia em que o primeiro agente nascer,
 * sem ninguém lembrar de voltar aqui.
 *
 * ## As quatro invariantes
 *
 *  1. RESOLVE — o alvo relativo existe no índice do git.
 *  2. RASTREADO — alvo que existe no disco mas não está no git é link quebrado para todo mundo que
 *     não seja o autor.
 *  3. DENTRO DO REPO — `../` a mais escapa a raiz; o link não tem como funcionar em lugar nenhum.
 *  4. CERCA FECHADA — bloco ``` sem fechamento cegaria o próprio gate: o resto do doc some da
 *     medição. Fail-closed, mas só COM VÍTIMA — a cerca aberta é erro quando engoliu ao menos um
 *     link, e a mensagem nomeia quais. Medido: os dois únicos casos vivos do corpus são cerca
 *     pendurada na ÚLTIMA linha do arquivo (`2026-05-24-financeiro-a4-proxima-acao.md:841` de 841
 *     linhas), que não esconde link nenhum. Acusar esses dois seria gritar sem vítima, e é assim
 *     que um gate ensina a ignorar o vermelho.
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, normalize, relative } from 'node:path/posix';

export interface DocMd {
  /** caminho do doc, relativo à raiz do repo, sempre com `/` (posix, como o git guarda) */
  arquivo: string;
  texto: string;
}

export interface LinkMd {
  arquivo: string;
  /** linha 1-based no doc, para o erro ser clicável no editor */
  linha: number;
  /** o alvo cru, como escrito (`../x.md#secao`) */
  alvo: string;
  /** o caminho resolvido a partir da raiz do repo, sem âncora */
  destino: string;
}

/**
 * Por que o link foi reprovado. Existe para que teste (e qualquer consumidor) asserte SEMÂNTICA em
 * vez de prosa: a mensagem é texto para humano, muda de redação, e um teste preso a ela quebra por
 * caixa/acento sem que nada de real tenha mudado — foi o que aconteceu ao escrever este gate.
 */
export type CausaLink = 'ausente' | 'nao-rastreado' | 'fora-do-repo' | 'cerca-aberta';

export interface AchadoLink {
  level: 'error';
  arquivo: string;
  linha: number;
  alvo: string;
  causa: CausaLink;
  msg: string;
}

/** Uma cerca aberta e nunca fechada — invariante 4, o modo de falha que cegaria a medição. */
export interface CercaAberta {
  linha: number;
  marca: string;
  /** o texto cru que a cerca engoliu (da abertura ao fim do arquivo) — quem julga é o auditor */
  textoEngolido: string;
}

/**
 * Esvazia o que é CÓDIGO (cerca ``` / ~~~ e trecho entre crases), preservando a numeração de linha.
 *
 * Devolve também a cerca não fechada, se houver: quem chama transforma isso em erro em vez de
 * aceitar um bloco grande descartado em silêncio (a lição de `gates-textuais-cegos.md`).
 */
export function removerCodigo(texto: string): { texto: string; cercaAberta: CercaAberta | null } {
  const linhas = texto.split('\n');
  const saida: string[] = [];
  let cerca: { marca: string; tamanho: number; linha: number } | null = null;

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    // Cerca: >= 3 crases/tis, até 3 espaços de indentação. O fechamento é do MESMO caractere e não
    // tem info string — `~~~` não fecha ```, e ```ts abre sem fechar.
    const m = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/.exec(linha);
    if (m) {
      const [, marca, info] = m;
      if (!cerca) {
        cerca = { marca: marca[0], tamanho: marca.length, linha: i + 1 };
        saida.push('');
        continue;
      }
      if (marca[0] === cerca.marca && marca.length >= cerca.tamanho && info === '') {
        cerca = null;
        saida.push('');
        continue;
      }
    }
    saida.push(cerca ? '' : removerCrasesDaLinha(linha));
  }

  return {
    texto: saida.join('\n'),
    cercaAberta: cerca
      ? {
          linha: cerca.linha,
          marca: cerca.marca.repeat(cerca.tamanho),
          textoEngolido: linhas.slice(cerca.linha - 1).join('\n'),
        }
      : null,
  };
}

/**
 * Remove os trechos entre crases de UMA linha. A restrição à linha é o ponto: uma crase sem par
 * NÃO abre um bloco que come o resto do documento — sem par, ela é texto, porque é isso que ela é.
 */
function removerCrasesDaLinha(linha: string): string {
  let saida = '';
  let i = 0;
  while (i < linha.length) {
    if (linha[i] !== '`') {
      saida += linha[i++];
      continue;
    }
    let n = 0;
    while (linha[i + n] === '`') n++;
    const abre = '`'.repeat(n);
    const fim = linha.indexOf(abre, i + n);
    // Fechamento tem de ser uma run EXATA de n crases, não o prefixo de uma maior.
    if (fim === -1 || linha[fim + n] === '`') {
      saida += linha.slice(i, i + n);
      i += n;
      continue;
    }
    i = fim + n;
  }
  return saida;
}

/**
 * O alvo de um link markdown: `](destino)`, `](<destino>)` e `](destino "Título")`.
 * A classe exclui `)` e espaço — o que já descarta o título e para na borda certa.
 */
const RE_LINK = /\]\(\s*(<[^>\n]*>|[^()\s]+)/g;

/** Alvo que o gate não julga — ver "Precisão, não recall" no cabeçalho. */
export function ehExterno(alvo: string): boolean {
  return alvo.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(alvo);
}

/** Resolve o alvo para um caminho a partir da raiz do repo. `/x.md` é raiz do repo (semântica do GitHub). */
export function resolverDestino(arquivo: string, alvo: string): string {
  const semAncora = alvo.split('#')[0];
  if (semAncora.startsWith('/')) return normalize(semAncora.replace(/^\/+/, ''));
  return normalize(join(dirname(arquivo), semAncora));
}

/** Varre links candidatos de um texto JÁ tratado. `linha0` desloca a numeração para o doc real. */
function linksCandidatos(arquivo: string, texto: string, linha0 = 0): LinkMd[] {
  const links: LinkMd[] = [];
  texto.split('\n').forEach((linha, i) => {
    for (const m of linha.matchAll(RE_LINK)) {
      const alvo = decodificar(m[1].replace(/^<|>$/g, '').trim());
      if (alvo === '' || ehExterno(alvo)) continue;
      if (!alvo.split('#')[0].endsWith('.md')) continue;
      links.push({
        arquivo,
        linha: linha0 + i + 1,
        alvo,
        destino: resolverDestino(arquivo, alvo),
      });
    }
  });
  return links;
}

export function extrairLinks(doc: DocMd): {
  links: LinkMd[];
  cercaAberta: CercaAberta | null;
  /** links que a cerca aberta escondeu da medição — é isto que torna a invariante 4 um problema */
  escondidos: LinkMd[];
} {
  const { texto, cercaAberta } = removerCodigo(doc.texto);
  const links = linksCandidatos(doc.arquivo, texto);
  const escondidos = cercaAberta
    ? linksCandidatos(doc.arquivo, cercaAberta.textoEngolido, cercaAberta.linha - 1)
    : [];

  // Cerca aberta que não engoliu link nenhum não cega NADA — ver a invariante 4 no cabeçalho.
  return { links, cercaAberta: escondidos.length > 0 ? cercaAberta : null, escondidos };
}

/** `%20` e afins. Alvo malformado fica como está — o erro de "não resolve" já é a mensagem certa. */
function decodificar(alvo: string): string {
  try {
    return decodeURIComponent(alvo);
  } catch {
    return alvo;
  }
}

/**
 * Sugere o caminho certo. As duas formas cobrem a classe MEDIDA (10/10 dos links quebrados vivos):
 * o autor escreveu o caminho a partir da RAIZ do repo, e o alvo existe — só o ponto de partida é
 * outro. Sem candidato ÚNICO não sugere nada: chute em mensagem de erro é pior que silêncio.
 */
export function sugerirCaminho(arquivo: string, alvo: string, rastreados: Set<string>): string | null {
  const semAncora = alvo.split('#')[0];
  const ancora = alvo.slice(semAncora.length);
  const candidatos: string[] = [];

  const comoRaiz = normalize(semAncora.replace(/^\/+/, ''));
  if (rastreados.has(comoRaiz)) {
    candidatos.push(comoRaiz);
  } else {
    const base = basename(semAncora);
    const porNome = [...rastreados].filter((p) => basename(p) === base);
    if (porNome.length === 1) candidatos.push(porNome[0]);
  }

  if (candidatos.length !== 1) return null;
  const rel = relative(dirname(arquivo), candidatos[0]);
  return (rel.startsWith('.') ? rel : `./${rel}`) + ancora;
}

export function auditarLinks(
  docs: DocMd[],
  rastreados: Set<string>,
  existeNoDisco: (p: string) => boolean = existsSync,
): AchadoLink[] {
  const achados: AchadoLink[] = [];

  for (const doc of docs) {
    const { links, cercaAberta, escondidos } = extrairLinks(doc);

    // 4. CERCA FECHADA — antes de tudo: se a cerca ficou aberta, a MEDIÇÃO deste doc é suspeita.
    if (cercaAberta) {
      achados.push({
        level: 'error',
        arquivo: doc.arquivo,
        linha: cercaAberta.linha,
        alvo: cercaAberta.marca,
        causa: 'cerca-aberta',
        msg:
          `bloco de código aberto na linha ${cercaAberta.linha} (\`${cercaAberta.marca}\`) e nunca ` +
          `fechado — o resto do arquivo foi lido como código, escondendo ${escondidos.length} link(s) ` +
          `da medição (${escondidos.map((l) => `${l.alvo} na linha ${l.linha}`).join(', ')}). Feche a cerca.`,
      });
    }

    for (const link of links) {
      // 3. DENTRO DO REPO — `../` a mais; não funciona em lugar nenhum.
      if (link.destino.startsWith('..')) {
        achados.push({
          level: 'error',
          arquivo: doc.arquivo,
          linha: link.linha,
          alvo: link.alvo,
          causa: 'fora-do-repo',
          msg:
            `\`${link.alvo}\` escapa a raiz do repo (resolve para \`${link.destino}\`) — tem um \`../\` ` +
            `a mais.`,
        });
        continue;
      }

      // 1. RESOLVE.
      if (rastreados.has(link.destino)) continue;

      // 2. RASTREADO — discrimina "não existe" de "existe só no seu disco".
      const noDisco = existeNoDisco(link.destino);
      const sugestao = sugerirCaminho(doc.arquivo, link.alvo, rastreados);
      achados.push({
        level: 'error',
        arquivo: doc.arquivo,
        linha: link.linha,
        alvo: link.alvo,
        causa: noDisco ? 'nao-rastreado' : 'ausente',
        msg:
          `\`${link.alvo}\` resolve para \`${link.destino}\`, que ` +
          (noDisco
            ? `existe no disco mas NÃO está no git — para quem clona o repo (e para o GitHub) o link ` +
              `está quebrado. Commite o arquivo`
            : `não existe`) +
          (sugestao ? `. O caminho a partir DESTE arquivo é \`${sugestao}\`` : '') +
          `.`,
      });
    }
  }

  return achados;
}

/** Todo `.md` rastreado pelo git — ver "Escopo" no cabeçalho. */
export function lerDocsRastreados(): { docs: DocMd[]; rastreados: Set<string> } {
  const todos = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
  const rastreados = new Set(todos);
  const docs = todos
    .filter((p) => p.endsWith('.md'))
    .sort()
    .map((arquivo) => ({ arquivo, texto: readFileSync(arquivo, 'utf8') }));
  return { docs, rastreados };
}

if (import.meta.main) {
  const { docs, rastreados } = lerDocsRastreados();
  const achados = auditarLinks(docs, rastreados);
  if (achados.length === 0) {
    console.log(`docs-links-gate: ✓ ${docs.length} docs — todo link relativo de .md resolve.`);
    process.exit(0);
  }
  for (const a of achados) {
    console.error(`✗ ${a.arquivo}:${a.linha} — ${a.msg}`);
  }
  console.error(`\ndocs-links-gate: ${achados.length} link(s) quebrado(s).`);
  process.exit(1);
}
