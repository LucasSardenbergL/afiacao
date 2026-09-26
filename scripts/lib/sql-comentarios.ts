// Limpeza de COMENTÁRIO em SQL para gates textuais — a que entende a gramática do Postgres.
//
// Irmã da `src/lib/gates/limpeza-fonte.ts` (eixo `/*` em .ts/.tsx, classe medida em 2026-08-20,
// docs/historico/gates-textuais-cegos.md). Aqui o eixo VIVO é outro: o stripper anterior era
//   sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
// e o segundo `.replace` come de `--` até o fim da linha SEM olhar se está dentro de literal.
//
// A gramática do Postgres pede quatro coisas que regex não sabe fazer:
//  1. `'…'` é literal e `''` é a aspa escapada dentro dele — `--` ali dentro é DADO, não comentário;
//  2. `E'…'` ainda aceita `\'` como escape (as outras formas não, com standard_conforming_strings);
//  3. `$tag$…$tag$` delimita o corpo, e o `--` DENTRO dele ainda é comentário de PL/pgSQL;
//  4. comentário de bloco ANINHA (`/* /* */ */` é UM comentário) — `[\s\S]*?` fecharia no `*/` interno.
//
// CONTRATO: remove comentário de linha e de bloco, e NADA MAIS. O que sai vira ESPAÇO, mas as
// quebras de linha do trecho descartado são preservadas — o resultado tem o mesmo número de linhas
// da entrada, de propósito (gate que casa `^…` multiline ou compara posição segue medindo o mesmo).
//
// DECISÃO — dollar-quote NÃO é tratado como opaco, e isto é deliberado (medido: tratá-lo como
// opaco divergia do stripper anterior em 277/656 migrations, todas por deixar comentário de PL/pgSQL
// entrar no corpo). Um lexer puro pararia no `$tag$`; aqui o CONSUMIDOR é o gate de authz, cuja
// razão de existir é justamente não ser enganado por `-- gate comentado` DENTRO do corpo. Então o
// interior é re-analisado com a mesma gramática. O preço: `$$texto -- com traço$$` usado como DADO
// perderia o traço — igual ao stripper anterior, e irrelevante p/ quem lê estrutura de função.
//
// INVARIANTE: o resultado tem o MESMO comprimento da entrada (comentário vira espaço, `\n` fica).
// É o que mantém `extractFunctions` — que fatia corpo por índice — coerente, e é falsificável.
//
// LIMITE CONHECIDO (deliberado): literal ou dollar-quote que NÃO fecha é lido como caractere comum
// e o walker ressincroniza no próximo caractere — em vez de engolir até o EOF. Comentário de bloco
// que não fecha é o único caso que consome até o fim (é o que um lexer de verdade faz); o alarme
// para isso é `maiorBlocoDescartadoSql`, herdado do sentinela da irmã .ts.

// Um `$` só abre dollar-quote se vier `$tag$` com tag vazia ou identificador (nunca começando com
// dígito) — senão é parâmetro (`$1`) ou operador.
const TAG_DOLLAR = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

// `E'…'`/`e'…'` liga escape de barra invertida; `U&'…'`, `B'…'`, `X'…'` e o literal nu não ligam.
function ligaBarraInvertida(sql: string, aspa: number): boolean {
  const anterior = sql[aspa - 1];
  if (anterior !== 'E' && anterior !== 'e') return false;
  // Só é prefixo se o `E` não for o fim de um identificador — `nome_e'…'` seria lido errado sem isto.
  const antes = sql[aspa - 2];
  return antes === undefined || !/[A-Za-z0-9_$\u0080-\uffff]/.test(antes);
}

// Índice logo APÓS a aspa que fecha o literal, ou -1 se não fechar.
function fimDeLiteral(sql: string, ini: number, barraEscapa: boolean): number {
  let i = ini + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (barraEscapa && c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

// Índice logo APÓS a aspa dupla que fecha o identificador quotado (`""` escapa), ou -1.
function fimDeIdentificador(sql: string, ini: number): number {
  let i = ini + 1;
  while (i < sql.length) {
    if (sql[i] === '"') {
      if (sql[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

// Índice logo APÓS o `*/` que fecha o comentário de bloco, contando ANINHAMENTO; -1 se não fechar.
function fechamentoDeBloco(sql: string, ini: number): number {
  let profundidade = 1;
  let i = ini + 2;
  while (i < sql.length && profundidade > 0) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      profundidade++;
      i += 2;
      continue;
    }
    if (sql[i] === '*' && sql[i + 1] === '/') {
      profundidade--;
      i += 2;
      continue;
    }
    i++;
  }
  return profundidade === 0 ? i : -1;
}

// O mesmo, mas o bloco que não fecha consome até o fim — é o que um lexer de verdade faz, e é o
// contrato do `removerComentariosSql` (ver LIMITE CONHECIDO no cabeçalho).
function fimDeBloco(sql: string, ini: number): number {
  const fim = fechamentoDeBloco(sql, ini);
  return fim === -1 ? sql.length : fim;
}

export function removerComentariosSql(sql: string): string {
  const partes: string[] = [];
  const branco = (trecho: string) => trecho.replace(/[^\n]/g, ' ');
  let i = 0;
  let inicioTrecho = 0;
  const n = sql.length;

  const empurrarCodigo = (ate: number) => {
    if (ate > inicioTrecho) partes.push(sql.slice(inicioTrecho, ate));
  };

  while (i < n) {
    const c = sql[i];
    if (c !== '-' && c !== '/' && c !== "'" && c !== '"' && c !== '$') {
      i++;
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') {
      empurrarCodigo(i);
      let j = i;
      while (j < n && sql[j] !== '\n') j++;
      partes.push(branco(sql.slice(i, j)));
      i = j;
      inicioTrecho = i;
      continue;
    }

    if (c === '/' && sql[i + 1] === '*') {
      empurrarCodigo(i);
      const fim = fimDeBloco(sql, i);
      partes.push(branco(sql.slice(i, fim)));
      i = fim;
      inicioTrecho = i;
      continue;
    }

    if (c === "'") {
      const fim = fimDeLiteral(sql, i, ligaBarraInvertida(sql, i));
      i = fim === -1 ? i + 1 : fim; // não fechou ⇒ apóstrofo solto: ressincroniza, não engole
      continue;
    }

    if (c === '"') {
      const fim = fimDeIdentificador(sql, i);
      i = fim === -1 ? i + 1 : fim;
      continue;
    }

    if (c === '$') {
      const m = TAG_DOLLAR.exec(sql.slice(i, i + 128));
      if (m) {
        const tag = m[0];
        const fim = sql.indexOf(tag, i + tag.length);
        if (fim === -1) {
          i += 1; // não fechou ⇒ não era dollar-quote: ressincroniza
          continue;
        }
        empurrarCodigo(i);
        partes.push(tag);
        partes.push(removerComentariosSql(sql.slice(i + tag.length, fim)));
        partes.push(tag);
        i = fim + tag.length;
        inicioTrecho = i;
        continue;
      }
    }

    i++;
  }

  empurrarCodigo(n);
  return partes.join('');
}

// Alarme calibrado do stripper: o maior BLOCO CONTÍGUO de linhas que a limpeza descartou.
//
// Mesma forma (e mesma razão) de `maiorBlocoDescartado` em src/lib/gates/limpeza-fonte.ts: fração
// preservada é grossa demais para separar cabeçalho honesto de estrago; o que separa é a FORMA.
// Linha vazia no ORIGINAL é neutra — não interrompe o bloco.
export function maiorBlocoDescartadoSql(sql: string): number {
  const antes = sql.split('\n');
  const depois = removerComentariosSql(sql).split('\n');
  let maior = 0;
  let atual = 0;
  for (let i = 0; i < antes.length; i++) {
    if (antes[i].trim() === '') continue;
    atual = (depois[i] ?? '').trim() === '' ? atual + 1 : 0;
    if (atual > maior) maior = atual;
  }
  return maior;
}

// A VARIANTE de um corpo de função sem as suas LINHAS INTEIRAS de comentário `--`.
//
// Existe para o eixo de corpo do gate de deploy (`corpo-esperado.ts`). Em prod, 31 funções rodam
// EXATAMENTE o corpo commitado menos essas linhas (medido em 2026-09-26; o apply de mai–jul/2026 as
// tirou, migration inteira por vez). Comparado byte a byte, isso sai `DERIVA`, e o relatório chama de
// "edição manual" o que é a mesma lógica (docs/historico/deriva-so-de-comentario-no-corpo.md).
//
// CONTRATO — diferente do `removerComentariosSql`, e as diferenças são o ponto:
//  1. A entrada é o CORPO de uma função (o que vira `prosrc`), não o arquivo da migration. Aqui
//     dentro, dollar-quote é LITERAL (`EXECUTE $q$…$q$`), então é OPACO: um `--` dentro dele é dado.
//  2. Remove SÓ a transformação medida: a linha inteira (brancos + `--…` + a quebra) cujo `--` está
//     em contexto de CÓDIGO. Comentário no fim de uma linha com código, e comentário de bloco, ficam.
//     Todo o resto sai byte a byte igual.
//  3. Literal, identificador, dollar-quote ou bloco que não fecha ⇒ `undefined` ("não reconheci"),
//     nunca um texto. O `removerComentariosSql` ressincroniza, porque lá o custo de errar é um gate
//     menos preciso; aqui, uma variante errada pode CASAR com prod e virar veredito.
//
// POR QUE NÃO É `removerComentariosSql` + colapso de espaço (achado do Codex, reproduzido): aquele
// recursa em dollar-quote por contrato, então `-- desconto=10` e `-- desconto=90` dentro de um literal
// viram iguais; e o colapso iguala `'a  b'` a `'a b'`. Isso fabrica equivalência entre corpos que
// DIFEREM. Aqui o único byte que some é o de uma linha que o Postgres já descartaria como comentário.
//
// O que ainda NÃO é equivalência total, e fica dito: tirar linhas muda o número de linha que o
// `PG_CONTEXT` reporta, e quem introspecta `prosrc` vê a diferença. Para a lógica executada, não muda.
export function removerLinhasDeComentarioDoCorpo(corpo: string): string | undefined {
  const n = corpo.length;
  const remover: Array<[number, number]> = [];
  let i = 0;
  let inicioDaLinha = 0;
  let soBrancoNaLinha = true;

  // Um trecho opaco (literal, identificador, dollar-quote, bloco) FECHA na linha corrente, que passa a
  // ter conteúdo — então um `--` depois dele, na mesma linha, não é linha inteira. Sem isto, um
  // literal multilinha aberto no início da linha e fechado antes de um `--` levaria a linha junto.
  const pular = (fim: number) => {
    soBrancoNaLinha = false; // o fecho do trecho é conteúdo desta linha
    i = fim;
  };

  while (i < n) {
    const c = corpo[i];
    if (c === '\n') {
      i++;
      inicioDaLinha = i;
      soBrancoNaLinha = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === '-' && corpo[i + 1] === '-') {
      let j = i;
      while (j < n && corpo[j] !== '\n') j++;
      if (soBrancoNaLinha) remover.push([inicioDaLinha, j < n ? j + 1 : j]);
      i = j; // a quebra (se houver) é tratada no topo do laço
      continue;
    }
    if (c === '/' && corpo[i + 1] === '*') {
      const fimBloco = fechamentoDeBloco(corpo, i);
      if (fimBloco === -1) return undefined;
      pular(fimBloco);
      continue;
    }
    if (c === "'") {
      const fimLiteral = fimDeLiteral(corpo, i, ligaBarraInvertida(corpo, i));
      if (fimLiteral === -1) return undefined;
      pular(fimLiteral);
      continue;
    }
    if (c === '"') {
      const fimIdentificador = fimDeIdentificador(corpo, i);
      if (fimIdentificador === -1) return undefined;
      pular(fimIdentificador);
      continue;
    }
    if (c === '$' && !/[A-Za-z0-9_$\u0080-￿]/.test(corpo[i - 1] ?? ' ')) {
      // `$` no meio de identificador (`a$b`) ou parâmetro (`$1`) não abre dollar-quote.
      const m = TAG_DOLLAR.exec(corpo.slice(i, i + 128));
      if (m) {
        const fechamento = corpo.indexOf(m[0], i + m[0].length);
        if (fechamento === -1) return undefined;
        pular(fechamento + m[0].length);
        continue;
      }
    }
    soBrancoNaLinha = false;
    i++;
  }

  let saida = '';
  let desde = 0;
  for (const [ini, fim] of remover) {
    saida += corpo.slice(desde, ini);
    desde = fim;
  }
  return saida + corpo.slice(desde);
}
