/**
 * tokens-sql.ts — o LÉXICO do Postgres para a pergunta "estes dois corpos são o MESMO programa?"
 * (lógica pura, sem dependência além do `md5Exato`).
 *
 * Uma verdade só, dois consumidores:
 *   · o sensor `deriva:corpo:prod` (`deriva-corpo.ts`, onde este scanner nasceu no #2576), que chama
 *     de COSMETICO a deriva que só mexe em comentário/espaço;
 *   · o eixo 5 do gate do pacote (`corpo-esperado.ts`), que re-testa por tokens o que o md5 EXATO
 *     chamou de `DERIVA` (`docs/historico/deriva-so-de-comentario-no-corpo.md`).
 *
 * Mora numa folha porque o gate não pode importar do sensor: o sensor importa o gate
 * (`precondicao-banco.ts`), e o import na outra direção fecharia um ciclo. Segundo léxico para o
 * mesmo critério é o que NÃO se faz aqui: o da 1ª versão do gate (só linhas inteiras de `--`) tinha
 * três P1 reproduzidos pelo Codex — `\r` isolado que encerra comentário, continuação de `E''` que
 * herda o modo de escape, tag de dollar-quote mais longa que a janela — e este scanner responde
 * DIFERENTES nos três.
 */
import { md5Exato } from './migration-objects';

/**
 * O `space` do `scan.l` — `[ \t\n\r\f\v]` — e só ele. O `\s` do JS casa também NBSP, BOM, U+2028 e
 * afins, que para o PG são caracteres de IDENTIFICADOR: medido em prod (2026-10-02),
 * `SELECT <NBSP>x FROM (SELECT 1 AS x) s` → `column " x" does not exist`, e `SELECT\f1`/`SELECT\v1`
 * devolvem 1. Com o `\s`, um NBSP que ABRIA token era engolido e `SELECT <NBSP>x` igualava
 * `SELECT x` — falso "mesmo programa" (achado no auto-challenge do gate do pacote, Caminho B).
 */
const ESPACO_PG = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
/** Os caracteres de operador do PG (`op_chars` do `scan.l`). */
const OP_CHARS = new Set('~!@#^&|`?+-*/%<>=');
/** Com um destes num operador composto, ele PODE terminar em `+`/`-` (regra do `scan.l`). */
const OP_ESPECIAIS = new Set('~!@#^&|`?%');
const INICIO_IDENT = /[A-Za-z_\u0080-\uffff]/;
const CONT_IDENT = /[A-Za-z_0-9$\u0080-\uffff]/;
// Regex PEGAJOSAS (`y`, com `lastIndex`): casar numa fatia de N caracteres deixava uma tag de
// dollar-quote de 130 letras escapar da janela e o conteúdo do literal ser tokenizado (Codex, P2).
// Números como o `scan.l` do PG17 (medido em prod, 2026-10-05, parecer de código do Codex): `_` agrupa
// dígitos, INCLUSIVE no expoente (`1e1_0` = 10¹⁰, ≠ `1e1 _0` = 10 com alias), e não em dobro nem no fim.
const DEC = '[0-9](?:_?[0-9])*';
const NUMERO = new RegExp(
  `(?:0[xX](?:_?[0-9A-Fa-f])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:${DEC}(?:\\.(?!\\.)(?:${DEC})?)?|\\.${DEC})(?:[eE][+-]?${DEC})?)`,
  'y',
);
const TAG_DOLLAR = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z_0-9\u0080-\uffff]*)?\$/y;
const PREFIXO_STRING = /(?:[EeBbXxNn]|[Uu]&)'/y;
const PARAMETRO = /\$[0-9]+/y;
const casarEm = (re: RegExp, s: string, i: number): RegExpExecArray | null => {
  re.lastIndex = i;
  return re.exec(s);
};
/** Marcas entre dois literais de string adjacentes: com quebra de linha o PG CONCATENA; sem, é erro. */
const CONCAT_QUEBRA = '\u2424concat';
const CONCAT_ESPACO = '\u2423adjacente';

/**
 * Tokens de um corpo de função — o critério de "difere só em forma".
 *
 * Por que TOKENS e não "texto sem espaço": o colapso `\s+ → ' '` do audit iguala `SELECT 'a  b'` e
 * `SELECT 'a b'` (não sabe onde começa um literal), e remover espaço de vez iguala `a - -b` e
 * `a--b`. A sequência de tokens é o que o parser do Postgres vê: comentário e espaço fora, literal
 * INTEIRO como um token (conteúdo byte a byte), palavra sem aspas com a caixa ASCII dobrada (o PG
 * em UTF8 não dobra letra acentuada), identificador citado verbatim. Sequências iguais ⇒ o mesmo
 * programa, léxico a léxico.
 *
 * ⚠️ Scanner PRÓPRIO, e não o stripper compartilhado (`removerComentariosSql`) — exceção à regra de
 * `docs/historico/gates-textuais-cegos.md`, e o motivo é de gramática: aquele stripper REANALISA o
 * interior de dollar-quote de propósito (`sql-comentarios.ts:18`, para os gates enxergarem
 * comentário dentro de corpo de função), então `$q$a--x$q$` e `$q$a--y$q$` saem com a MESMA máscara
 * — reproduzido pelo Codex no parecer de desenho. Aqui o dollar-quote é o que o PG diz que ele é:
 * um literal opaco. As regras seguem o `scan.l` do PG17: comentário de bloco aninhado com
 * profundidade, `''`/`""` escapados, E-string com `\\`, fronteira de operador pela regra do `+`/`-`
 * final, `..` do PL/pgSQL, e a concatenação de literais separados por quebra de linha.
 *
 * O que NÃO é igualado de propósito (precisão > recall — alarme falso é revisável, verde falso não):
 * `1.0` × `1.00`, `E'x'` × `'x'`, `$a$x$a$` × `$b$x$b$`, e SQL dinâmico dentro de dollar-quote
 * aninhado, comparado como TEXTO do literal.
 */
function tokensNoModo(corpo: string, scsOff: boolean): string[] {
  const s = corpo;
  const fora: string[] = [];
  let i = 0;
  let ultimoFoiString = false;
  let quebraDesdeUltimo = false;
  /** O modo de escape do último literal: a CONTINUAÇÃO (quebra + outro `'…'`) o herda (Codex, P1). */
  let ultimaComBarra = false;
  const emitir = (t: string, ehString = false): void => {
    if (ehString && ultimoFoiString) fora.push(quebraDesdeUltimo ? CONCAT_QUEBRA : CONCAT_ESPACO);
    fora.push(t);
    ultimoFoiString = ehString;
    quebraDesdeUltimo = false;
  };
  /** Consome um literal '…' a partir de `ini` (a aspa de abertura); `\\` escapa só em E-string. */
  const literal = (ini: number, comBarra: boolean): number => {
    let j = ini + 1;
    while (j < s.length) {
      if (comBarra && s[j] === '\\') j += 2;
      else if (s[j] === "'" && s[j + 1] === "'") j += 2;
      else if (s[j] === "'") return j + 1;
      else j++;
    }
    return s.length;
  };
  while (i < s.length) {
    const c = s[i];
    if (ESPACO_PG.has(c)) {
      if (c === '\n' || c === '\r') quebraDesdeUltimo = true;
      i++;
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      // O comentário de linha termina em LF **ou** CR (`non_newline` do scan.l) — procurar só LF
      // engolia `+ 1` depois de um `\r` (Codex, P1).
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      let prof = 1;
      i += 2;
      while (i < s.length && prof > 0) {
        if (s[i] === '/' && s[i + 1] === '*') {
          prof++;
          i += 2;
        } else if (s[i] === '*' && s[i + 1] === '/') {
          prof--;
          i += 2;
        } else {
          if (s[i] === '\n') quebraDesdeUltimo = true;
          i++;
        }
      }
      // Comentário de BLOCO não entra no `quotecontinue` do scan.l (só espaço e `--` entram): `'a'/*⏎*/'b'`
      // é syntax error no PG17, não `'ab'` (medido em prod). Ele encerra a continuação — e a herança do E''.
      ultimoFoiString = false;
      continue;
    }
    // Literal com prefixo: E'…' (barra escapa), B'…', X'…', N'…', U&'…'. O prefixo é caixa-insensível.
    const prefixo = casarEm(PREFIXO_STRING, s, i);
    if (prefixo !== null) {
      const p = prefixo[0].slice(0, -1).toUpperCase();
      const fim = literal(i + p.length, p === 'E');
      emitir(p + s.slice(i + p.length, fim), true);
      ultimaComBarra = p === 'E';
      i = fim;
      continue;
    }
    if (c === "'") {
      // Com standard_conforming_strings=off TODO literal simples é E'' (barra escapa); senão, só a continuação herda.
      const comBarra = scsOff || (ultimoFoiString && quebraDesdeUltimo && ultimaComBarra);
      const fim = literal(i, comBarra);
      emitir(s.slice(i, fim), true);
      ultimaComBarra = comBarra;
      i = fim;
      continue;
    }
    if (c === '"' || (/[Uu]/.test(c) && s[i + 1] === '&' && s[i + 2] === '"')) {
      const ini = c === '"' ? i : i + 2;
      let j = ini + 1;
      while (j < s.length) {
        if (s[j] === '"' && s[j + 1] === '"') j += 2;
        else if (s[j] === '"') {
          j++;
          break;
        } else j++;
      }
      emitir((ini === i ? '' : 'U&') + s.slice(ini, j));
      i = j;
      continue;
    }
    if (c === '$') {
      const tag = casarEm(TAG_DOLLAR, s, i);
      if (tag !== null) {
        const fim = s.indexOf(tag[0], i + tag[0].length);
        const ate = fim < 0 ? s.length : fim + tag[0].length;
        emitir(s.slice(i, ate));
        i = ate;
        continue;
      }
      const param = casarEm(PARAMETRO, s, i);
      if (param !== null) {
        emitir(param[0]);
        i += param[0].length;
        continue;
      }
    }
    if (INICIO_IDENT.test(c)) {
      let j = i + 1;
      while (j < s.length && CONT_IDENT.test(s[j])) j++;
      emitir(s.slice(i, j).replace(/[A-Z]/g, (l) => l.toLowerCase()));
      i = j;
      continue;
    }
    if (c === '.' && s[i + 1] === '.') {
      emitir('..');
      i += 2;
      continue;
    }
    const numero = casarEm(NUMERO, s, i);
    if (numero !== null) {
      // `trailing junk` do scan.l (`1abc`, `1_`, `0x1Fg`, `1e`): identificador COLADO ao número é erro no
      // PG17 — vira UM token, para nunca igualar o inválido `1abc` ao válido `1 abc` (alias).
      let fim = i + numero[0].length;
      if (fim < s.length && INICIO_IDENT.test(s[fim])) {
        while (fim < s.length && CONT_IDENT.test(s[fim])) fim++;
      }
      emitir(s.slice(i, fim).replace(/[A-Z]/g, (l) => l.toLowerCase()));
      i = fim;
      continue;
    }
    if (c === ':') {
      const dois = s[i + 1] === ':' || s[i + 1] === '=' ? s.slice(i, i + 2) : ':';
      emitir(dois);
      i += dois.length;
      continue;
    }
    if (OP_CHARS.has(c)) {
      let j = i;
      while (j < s.length && OP_CHARS.has(s[j])) j++;
      let op = s.slice(i, j);
      // Um `--` ou `/*` DENTRO da sequência começa comentário ali (o operador termina antes dele).
      const corte = [op.indexOf('--'), op.indexOf('/*')].filter((k) => k > 0);
      if (corte.length > 0) op = op.slice(0, Math.min(...corte));
      // `+`/`-` finais só ficam num operador composto que tenha um caractere "especial".
      if (op.length > 1 && /[+-]$/.test(op) && ![...op.slice(0, -1)].some((x) => OP_ESPECIAIS.has(x))) {
        op = op.replace(/[+-]+$/, '');
        if (op === '') op = s[i];
      }
      emitir(op);
      i += op.length;
      continue;
    }
    emitir(c);
    i++;
  }
  return fora;
}

/** Separa a leitura com `standard_conforming_strings=on` da leitura com `off`, quando as duas divergem. */
const MARCA_SCS_OFF = '\u2424scs-off';

/**
 * Os tokens do corpo, válidos sob QUALQUER `standard_conforming_strings` (parecer de código do Codex,
 * 2026-10-05): com `off`, todo literal simples processa barra — `'a\'--desconto=10⏎'` é UM literal (medido
 * em prod com `SET`) —, e com `on` (o padrão de prod, sem função que o sobrescreva) é `'a\'` + comentário.
 * Em vez de supor o modo, lê nos dois: quando as fronteiras coincidem (o caso de quase todo corpo), a
 * saída é a de sempre e o `md5DeTokens` não muda; quando divergem, a leitura `off` vai junto, e "mesmos
 * tokens" passa a exigir os dois modos.
 */
export function tokensSql(corpo: string): string[] {
  const on = tokensNoModo(corpo, false);
  const off = tokensNoModo(corpo, true);
  return on.length === off.length && on.every((t, k) => t === off[k]) ? on : [...on, MARCA_SCS_OFF, ...off];
}

/** Os dois corpos são o MESMO programa (ver `tokensSql`)? */
export function mesmosTokens(a: string, b: string): boolean {
  const x = tokensSql(a);
  const y = tokensSql(b);
  return x.length === y.length && x.every((t, k) => t === y[k]);
}

/** md5 da sequência de tokens — o "mesmo programa" como hash (ver `tokensSql`). */
export function md5DeTokens(texto: string): string {
  return md5Exato(tokensSql(texto).join('\u0000'));
}
