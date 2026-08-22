/**
 * markdown-codigo.ts — o que num markdown é CÓDIGO (e portanto exemplo, não afirmação).
 * =====================================================================================
 *
 * Stripper compartilhado pelos gates que leem doc como TEXTO. Existe em duas camadas porque os
 * consumidores discordam sobre a crase inline — e a discordância é medida, não estética:
 *
 * - `docs-links-gate-check` quer as DUAS: um `[x](y.md)` escrito entre crases é exemplo de link,
 *   não um link a resolver.
 * - `docs-citacoes-gate-check` quer SÓ a cerca: a citação canônica do repo NASCE entre crases
 *   (`` `docs/agent/x.md:94` ``<!--cita: trecho-->). Medido em 2026-08-22 sobre os docs vivos,
 *   passar o texto por `removerCodigo` deixa 0 citações das 22 — o gate ficaria verde por
 *   CEGUEIRA TOTAL, que é a falha de `docs/historico/gates-textuais-cegos.md` de novo.
 *
 * Por isso as duas camadas são nomeadas e exportadas separadamente, em vez de um flag booleano:
 * quem chama escolhe explicitamente, e o teste-sentinela de cada gate prende a escolha.
 *
 * `cercaAberta` sai junto de propósito: uma cerca que nunca fecha engole o resto do arquivo, e um
 * gate que mede o que sobrou fica verde sem ter visto nada. Quem chama decide se aquilo escondeu
 * algo que importa — descartar em silêncio é a cegueira que estes gates existem para não repetir.
 */

/** Uma cerca aberta e nunca fechada — o modo de falha que cegaria a medição. */
export interface CercaAberta {
  linha: number;
  marca: string;
  /** o texto cru que a cerca engoliu (da abertura ao fim do arquivo) — quem julga é quem chama */
  textoEngolido: string;
}

export interface TextoLimpo {
  /** o texto com o código esvaziado, com a MESMA numeração de linha do original */
  texto: string;
  cercaAberta: CercaAberta | null;
}

/**
 * Esvazia só os blocos de CERCA (``` / ~~~), preservando a numeração de linha e deixando a crase
 * inline intacta. É a camada certa para quem mede algo que legitimamente mora entre crases.
 */
export function removerCercas(texto: string): TextoLimpo {
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
    saida.push(cerca ? '' : linha);
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
 * Esvazia TODO código: cerca (```/~~~) e trecho entre crases. Camada para quem mede algo que, se
 * aparecer entre crases, está sendo exibido e não afirmado.
 */
export function removerCodigo(texto: string): TextoLimpo {
  const { texto: semCercas, cercaAberta } = removerCercas(texto);
  return { texto: semCercas.split('\n').map(removerCrasesDaLinha).join('\n'), cercaAberta };
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
