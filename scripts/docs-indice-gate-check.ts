#!/usr/bin/env bun
/**
 * docs-indice-gate-check.ts — gate de CI que prova que nenhum doc fica INVISÍVEL no índice.
 * ============================================================================================
 *
 * A classe: diretório de docs cujo `README.md` se declara índice, com o índice mantido À MÃO.
 * Adicionar um `.md` sem a linha correspondente é o bug — e ele é SILENCIOSO por construção: o
 * arquivo existe, o CI fica verde, e o doc simplesmente não é encontrado por quem depende do
 * índice. `docs/historico/README.md` diz de si mesmo "Ao concluir uma entrega, registre aqui" —
 * convenção textual, sem nada que a segure.
 *
 * Por que um gate e não (mais) uma frase no README: medido neste repo. O PR #1658 reconciliou o
 * índice do histórico — **9 arquivos invisíveis, metade do histórico recente**. Horas depois, no
 * mesmo dia, o #1659 (uma PR de FEATURE, que só por acaso escreveu um doc) adicionou
 * `programa-cabreuva-colacor.md` sem linha nenhuma, e o índice voltou a mentir. Uma reconciliação
 * manual conserta o estado; ela não conserta a CLASSE, e a classe reincidiu em horas. É a
 * meta-regra do catálogo de retrabalho: contramedida textual reincide, gate estrutural para.
 *
 * O gate é de PRECISÃO, não de recall (mesma doutrina do `edges:typecheck`): só olha diretório que
 * TEM `README.md`, porque ter um README é a declaração de "aqui existe índice". `docs/agent/` fica
 * de fora de propósito — a tabela que o indexa vive no CLAUDE.md e enumera DOMÍNIOS, não arquivos:
 * `review.md`, `threat-model-template.md` e `csv-governo-br.md` são sub-documentos alcançáveis a um
 * salto (de `money-path.md`/`skills.md`) e seriam três falsos-positivos permanentes. Gate que nasce
 * com exceção é gate que treina a ignorar o vermelho.
 *
 * ## O que conta como "indexado": a 1ª COLUNA da tabela, não o arquivo inteiro
 *
 * A primeira versão deste gate casava links no README INTEIRO. Isso deixava passar exatamente a
 * mentira que ele existe para pegar: um doc **apenas citado dentro do resumo de outra entrada**
 * conta como indexado, sem ter linha própria. Não é hipótese — é o estado real do índice do
 * histórico: `setup-agente.md` é citado no resumo de `melhorias-code-2026-07.md`, então apagar a
 * linha própria dele mantinha o gate VERDE. (Hoje há um segundo caso vivo: a entrada de
 * `prs-parados-2026-08-06.md` cita `faxina-knip-2026-07-07.md` no meio do resumo.)
 *
 * Por isso a entrada é lida da 1ª coluna: é ela que distingue "este doc tem linha própria" de
 * "este doc foi mencionado por outro". A âncora (`](x.md#secao)`) continua aceita — linkar a seção
 * certa de um doc longo é uso NORMAL de markdown, e perder isso criaria o falso-positivo mais
 * provável da regra. Gate que grita errado é gate que treina a ignorar o vermelho.
 *
 * ## As cinco invariantes
 *
 *  1. ÓRFÃO — arquivo existe e o índice não lhe dá linha própria (o bug do #1659/#1212).
 *  2. LINK QUEBRADO — o índice lista e o arquivo não existe (renomeação/remoção pela metade).
 *  3. DUPLICATA — o mesmo doc em duas linhas. Duas worktrees paralelas que dão append do mesmo
 *     arquivo em posições diferentes NÃO conflitam no merge: o git aceita as duas.
 *  4. TEXTO = DESTINO — `[a.md](b.md)` é copiar-colar de outra linha; quem clica esperando `a.md`
 *     cai em `b.md`. Vale só para a 1ª coluna: citar `[faxina knip](faxina-knip-….md)` dentro de um
 *     resumo é prosa legítima.
 *  5. RESUMO REAL — `| [x.md](x.md) | TODO |` satisfaz as quatro invariantes acima e não indexa
 *     nada. O piso é folgado de propósito (a menor célula real do índice tem 44 chars), para que
 *     nenhuma entrada honesta esbarre nele.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DirIndice {
  /** caminho do diretório, relativo à raiz do repo (ex.: 'docs/historico') */
  dir: string;
  /** conteúdo do README.md que serve de índice */
  readme: string;
  /** nomes dos `.md` irmãos, SEM o README.md */
  arquivos: string[];
}

/** Uma linha de dados da tabela do índice — uma entrada própria, não uma citação em prosa. */
export interface Entrada {
  /** nome do arquivo irmão apontado, já sem `./` e sem a âncora (`x.md`) */
  arquivo: string;
  /** o texto visível do link, cru (`[ISTO](x.md)`) */
  texto: string;
  /** tudo o que vem depois da 1ª coluna, com os `|` internos preservados */
  resumo: string;
  /** linha 1-based no README, para o erro ser clicável no editor */
  line: number;
}

export interface Achado {
  level: 'error';
  dir: string;
  arquivo: string;
  /** linha 1-based da entrada culpada; 0 quando o problema é a AUSÊNCIA de linha (órfão) */
  line: number;
  msg: string;
}

/**
 * Piso de tamanho do resumo. Barra a entrada-fantasma (`| [x.md](x.md) | TODO |`), que satisfaz o
 * gate e não informa nada. 30 é folgado de propósito: a menor célula real do índice tem 44 chars,
 * então nenhuma entrada honesta esbarra nisso.
 */
export const RESUMO_MIN_CHARS = 30;

const README = 'README.md';

/**
 * A 1ª coluna precisa ser EXATAMENTE o link do arquivo irmão — nada antes, nada depois.
 *
 * Não casa `](../agent/x.md)` nem `](https://…)` de propósito (a classe do nome não inclui `/`): o
 * índice de um diretório só responde pelos arquivos dele, e link para fora não indexa nada aqui.
 * A âncora opcional (`#secao`) é o que impede o falso-positivo mais provável desta regra.
 */
const CELULA_LINK = /^\[([^\]]*)\]\(\.?\/?([A-Za-z0-9._-]+\.md)(?:#[^)]*)?\)$/;

/** Texto e destino se comparam sem o ruído de forma (`./` e âncora), que não muda para onde se vai. */
function normalizar(alvo: string): string {
  return alvo
    .trim()
    .replace(/^\.\//, '')
    .replace(/#.*$/, '');
}

/**
 * Extrai as entradas da tabela do índice. Só a PRIMEIRA COLUNA conta — ver o cabeçalho do arquivo:
 * é isso que separa "tem linha própria" de "foi citado no resumo alheio", que uma busca solta por
 * `(nome.md)` no README inteiro confunde, devolvendo verde para um doc invisível.
 */
export function parseEntradas(readme: string): Entrada[] {
  const entradas: Entrada[] = [];

  readme.split('\n').forEach((linha, i) => {
    if (!linha.trimStart().startsWith('|')) return;

    // A célula de resumo pode conter `|` (código inline, tabela citada): separo a 1ª coluna e
    // devolvo o RESTO junto, em vez de assumir contagem de colunas.
    const partes = linha.split('|');
    if (partes.length < 3) return;
    if (partes[partes.length - 1].trim() === '') partes.pop(); // borda direita `… |`

    const m = CELULA_LINK.exec(partes[1].trim());
    if (!m) return; // cabeçalho, separador `| --- |`, ou 1ª coluna que não é link de irmão

    entradas.push({
      texto: m[1],
      arquivo: m[2],
      resumo: partes.slice(2).join('|').trim(),
      line: i + 1,
    });
  });

  return entradas;
}

export function auditarIndices(dirs: DirIndice[]): Achado[] {
  const achados: Achado[] = [];

  for (const { dir, readme, arquivos } of dirs) {
    const entradas = parseEntradas(readme);
    const porArquivo = new Map<string, Entrada[]>();
    for (const e of entradas) {
      const lista = porArquivo.get(e.arquivo) ?? [];
      lista.push(e);
      porArquivo.set(e.arquivo, lista);
    }

    // 1. ÓRFÃO — arquivo existe e não tem LINHA PRÓPRIA (ser citado no resumo alheio não vale).
    for (const arquivo of arquivos) {
      if (porArquivo.has(arquivo)) continue;
      achados.push({
        level: 'error',
        dir,
        arquivo,
        line: 0,
        msg:
          `${dir}/${arquivo} existe e NÃO tem linha própria no índice ${dir}/README.md — o doc fica ` +
          `invisível para quem procura pelo índice (o CI passa, e ninguém acha o arquivo). Ser citado ` +
          `dentro do resumo de outra entrada NÃO conta. Acrescente ` +
          `\`| [${arquivo}](${arquivo}) | <resumo com os PRs/números da entrega> |\` à tabela.`,
      });
    }

    // 2. LINK QUEBRADO — a direção oposta da mesma mentira.
    for (const e of entradas) {
      if (arquivos.includes(e.arquivo) || e.arquivo === README) continue;
      achados.push({
        level: 'error',
        dir,
        arquivo: e.arquivo,
        line: e.line,
        msg:
          `${dir}/README.md aponta para ${e.arquivo}, que NÃO existe — renomeação ou remoção feita ` +
          `pela metade. Corrija o link ou remova a linha.`,
      });
    }

    // 3. DUPLICATA — o git aceita o merge de dois appends do mesmo arquivo, sem conflito.
    for (const [arquivo, lista] of porArquivo) {
      if (lista.length < 2) continue;
      achados.push({
        level: 'error',
        dir,
        arquivo,
        line: lista[1].line,
        msg:
          `${dir}/README.md tem ${lista.length} entradas para ${arquivo} (linhas ` +
          `${lista.map((e) => e.line).join(', ')}) — duas sessões deram append do mesmo doc e o merge ` +
          `não conflitou. Mantenha uma só.`,
      });
    }

    for (const e of entradas) {
      // 4. TEXTO = DESTINO.
      if (normalizar(e.texto) !== e.arquivo) {
        achados.push({
          level: 'error',
          dir,
          arquivo: e.arquivo,
          line: e.line,
          msg:
            `${dir}/README.md: o texto do link (\`${e.texto}\`) diverge do destino (\`${e.arquivo}\`) ` +
            `— provável copiar-colar de outra linha; na 1ª coluna os dois têm que ser o nome do arquivo.`,
        });
      }

      // 5. RESUMO REAL — sem isto, `| [x.md](x.md) | TODO |` passa e não indexa nada.
      if (e.resumo.length < RESUMO_MIN_CHARS) {
        achados.push({
          level: 'error',
          dir,
          arquivo: e.arquivo,
          line: e.line,
          msg:
            `${dir}/README.md: o resumo de ${e.arquivo} tem ${e.resumo.length} chars (mínimo ` +
            `${RESUMO_MIN_CHARS}) — o índice existe para dizer O QUE tem no doc; cite os PRs/números ` +
            `concretos da entrega.`,
        });
      }
    }
  }

  return achados;
}

/** Descobre todo subdiretório de `docs/` que tenha `README.md` — ter README É a declaração de "aqui há índice". */
export function lerDiretoriosIndexados(raiz = 'docs'): DirIndice[] {
  if (!existsSync(raiz)) return [];
  return readdirSync(raiz, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(raiz, e.name))
    .filter((dir) => existsSync(join(dir, README)))
    .map((dir) => ({
      dir,
      readme: readFileSync(join(dir, README), 'utf8'),
      arquivos: readdirSync(dir)
        .filter((f) => f.endsWith('.md') && f !== README)
        .sort(),
    }));
}

if (import.meta.main) {
  const achados = auditarIndices(lerDiretoriosIndexados());
  if (achados.length === 0) {
    console.log('docs-indice-gate: ✓ todo doc de diretório indexado tem linha própria no índice.');
    process.exit(0);
  }
  for (const a of achados) {
    console.error(`✗ ${a.dir}/README.md${a.line ? `:${a.line}` : ''} — ${a.msg}`);
  }
  console.error(`\ndocs-indice-gate: ${achados.length} problema(s).`);
  process.exit(1);
}
