#!/usr/bin/env bun
// gerar-canaria-fixture.ts — emite o SQL das canárias PELO GERADOR DESTE DISCO, para a prova
// executada `db/test-canaria-veredito.sh`.
//
// ## Por que existe (o defeito que ele fecha)
//
// A prova gera o SQL em vez de conferir um retrato commitado — é isso que a faz envelhecer junto
// com o gerador. Mas a CLI (`bun scripts/sonda-versao-sql.ts --canaria`) tem um guard de sincronia
// fail-CLOSED: ela RECUSA emitir se a "fatia da verdade" do disco diferir de `origin/main`. Num PR
// essa fatia diverge POR CONSTRUÇÃO — `sonda:bump` obriga a bumpar o `versao.ts` e
// `sonda:fingerprint` obriga a regravar o mapa. Os três gates são mutuamente impossíveis (#2414).
//
// A primeira saída tentada (#2405) foi rodar a CLI num worktree de `origin/main`. Destravou o CI, e
// custou a prova inteira: MEDIDO em 2026-09-09, com o gerador do disco sabotado
// (`WHEN ca.corpo ->> 'ok' = 'false'` → `WHEN false`, o ramo que dá nome à CANARIA VERMELHA), a
// suíte saiu **19 ok / 0 fail**. Ela julgava o gerador da main, então nenhuma mudança do PR podia
// reprová-la — verde por CEGUEIRA, na única classe de PR que ela existe para pegar.
//
// Aqui o SQL sai do gerador DESTE disco, e o guard não entra porque este caminho não emite SQL
// operacional: ele emite uma FIXTURE. O guard segue intocado no caminho que importa — a CLI —, e as
// cinco recusas dele continuam provadas onde já estavam, em `scripts/sonda-versao-sql.test.ts`
// (código 1 **e** stdout de zero bytes, um teste por porta), no job `testes`.
//
// ## Por que o artefato não pode ser colado em produção
//
// "Está em `db/` e chama-se fixture" não é fronteira: é um comando executável que escreve SQL. E um
// aviso em comentário é o que se lê e ignora — foi assim que nasceu o veredito falso de 2026-09-05.
// Então o SQL emitido é INERTE por construção: ele inteiro vira o valor de uma variável `text`
// dentro de um único bloco `DO`, e o bloco só faz `RAISE EXCEPTION`. Declarar não executa.
//
// A escolha é do parecer Codex (2026-09-09) e corrige a versão que eu tinha proposto — um
// `RAISE EXCEPTION` avulso NO TOPO seguido do SQL de verdade. Ela não segura: `psql -f` sem
// `ON_ERROR_STOP` (o default) segue para os comandos SEGUINTES depois do erro, e o disparo sairia
// igual. Envelopado, não há comando seguinte: até apagar o `RAISE` deixa o conteúdo inerte, porque
// ele continua sendo um literal de texto.
//
// O teste extrai o bloco de leitura por `awk` de dentro do `format($sonda$…$sonda$` — as linhas do
// payload são copiadas VERBATIM, então o envelope não interfere na extração.
//
// Uso:
//   bun db/lib/gerar-canaria-fixture.ts <canaria> [<canaria> ...]   # SQL na stdout
import { join } from 'node:path';

import { lerCanariasDoRepo } from '../../scripts/canaria-leitor-do-repo';
import { gerarSqlDasCanarias, recusarCanariasRepetidas } from '../../scripts/sonda-versao-sql';

/** Delimitadores do envelope. Distintos entre si e do `$sonda$` que o SQL gerado já usa. */
const TAG_BLOCO = '$fixture_inerte$';
const TAG_PAYLOAD = '$fixture_payload$';

/** O que o `RAISE` diz a quem colou isto onde não devia. Casado pela prova executada. */
export const GRITO_FIXTURE = 'ARTEFATO DE FIXTURE — este SQL NAO dispara nada';

/**
 * Envelopa o SQL de modo que executar o arquivo inteiro não produza efeito nenhum, ou LANÇA.
 *
 * Fail-CLOSED nas duas portas que tornariam o envelope uma ilusão:
 *  1. payload vazio ⇒ o arquivo seria um `DO` decorativo e a suíte julgaria SQL nenhum;
 *  2. payload contendo um dos delimitadores ⇒ o dollar-quoting fecharia CEDO e o resto do SQL
 *     voltaria a ser comando executável — exatamente o que o envelope existe para impedir.
 */
export function envelopeInerte(sql: string): string {
  if (sql.trim() === '') {
    throw new Error('gerador devolveu SQL vazio — fixture vazia viraria suíte verde sobre nada.');
  }
  const colisao = [TAG_BLOCO, TAG_PAYLOAD].filter((t) => sql.includes(t));
  if (colisao.length > 0) {
    throw new Error(
      `o SQL gerado contém o delimitador ${colisao.join(' e ')} — o dollar-quoting fecharia cedo e ` +
        'o resto voltaria a ser comando EXECUTÁVEL. Troque a tag do envelope.',
    );
  }
  return (
    `-- ⚠️ ${GRITO_FIXTURE}.\n` +
    '-- Gerado por db/lib/gerar-canaria-fixture.ts para db/test-canaria-veredito.sh. O SQL abaixo é\n' +
    '-- o valor de uma VARIÁVEL: o bloco declara e aborta, então colar isto num SQL Editor não\n' +
    '-- dispara canária nenhuma. Para o artefato OPERACIONAL (que dispara), use a CLI, que confere\n' +
    '-- a sincronia com a origin/main antes de emitir:\n' +
    '--   bun run sonda:sql --canaria <canaria> ...\n' +
    `DO ${TAG_BLOCO}\n` +
    'DECLARE\n' +
    `  sql_da_canaria CONSTANT text := ${TAG_PAYLOAD}\n` +
    `${sql}\n` +
    `${TAG_PAYLOAD};\n` +
    'BEGIN\n' +
    `  RAISE EXCEPTION '${GRITO_FIXTURE} (% bytes inertes).', length(sql_da_canaria);\n` +
    'END\n' +
    `${TAG_BLOCO};\n`
  );
}

/**
 * Separa `--janela <n>` dos nomes de canária. LANÇA se a flag vier sem valor.
 *
 * A janela precisa existir AQUI, e não só na CLI, para que `EQUIVALENCIA_CANARIA` possa comparar
 * essa dimensão: enquanto o executável não a aceitava, a igualdade só cobria o default, e uma
 * divergência no tratamento de `--janela` entre os dois caminhos passaria sem sensor — que é o
 * defeito inteiro que aquela asserção existe para fechar.
 *
 * O VALOR não é validado aqui de propósito: quem recusa fora de 1..120 é o `validarJanela` do
 * gerador, o MESMO que a CLI usa. Validar de novo aqui seria uma segunda régua para divergir.
 */
export function separarJanela(argv: readonly string[]): {
  nomes: string[];
  janelaMin: number | undefined;
} {
  const nomes: string[] = [];
  let janelaMin: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--janela') {
      nomes.push(argv[i]);
      continue;
    }
    const valor = argv[i + 1];
    if (valor === undefined) throw new Error('--janela sem valor (use `--janela <minutos>`).');
    janelaMin = Number(valor);
    i++;
  }
  return { nomes, janelaMin };
}

if (import.meta.main) {
  const raiz = join(import.meta.dirname, '..', '..');
  try {
    const { nomes, janelaMin } = separarJanela(process.argv.slice(2));
    if (nomes.length === 0) {
      throw new Error('uso: bun db/lib/gerar-canaria-fixture.ts <canaria> [...] [--janela <min>]');
    }
    // A MESMA recusa da CLI, pela MESMA função: esta é a segunda fronteira que pede uma leva, e
    // enquanto a checagem viveu só no `parsearArgs` a fixture emitia o que a CLI recusa emitir.
    recusarCanariasRepetidas(nomes);
    process.stdout.write(
      envelopeInerte(gerarSqlDasCanarias({ raiz, nomes, janelaMin, ler: lerCanariasDoRepo })),
    );
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
}
