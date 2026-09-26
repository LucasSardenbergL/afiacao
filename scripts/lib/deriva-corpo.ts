/**
 * deriva-corpo.ts — a lógica pura do sensor `deriva:corpo:prod` (runner: `db/audit-deriva-corpo-prod.ts`).
 *
 * ## Por que existe (medido em 2026-09-26, `docs/historico/deriva-corpo-sem-sensor.md`)
 *
 * `public.cancelar_pedido_sugerido` rodou 18 dias em prod o corpo de uma migration ANTERIOR: a
 * `20260906170000` foi colada no SQL Editor depois da `20260907095841`, e "a última a recriar
 * vence" (`docs/agent/database.md` §2). Nenhum audit viu — os de migration olham EXISTÊNCIA, e o
 * `authz:funcoes:prod` cobre o manifesto de authz. Quem viu foi o eixo de corpo do gate do pacote
 * (`precondicao-banco.ts`), e só porque uma edge do conjunto acoplado foi deployada. Função fora de
 * qualquer leva de deploy não tinha sensor nenhum. Este arquivo é o sensor: TODA função `public`
 * que alguma migration define, a cada execução.
 */
import type { MigrationLida } from './corpo-esperado';
import { balancedParens, declaracoesDeFuncao, md5Exato } from './migration-objects';
import {
  AMOSTRA_CORPO_JS,
  type LeituraSonda,
  montarSondaPrecondicao,
  parsearSondaPrecondicao,
  TOKEN_SEM_CORPO,
  type VereditoPrecondicao,
} from './precondicao-banco';
import { removerComentariosSql } from './sql-comentarios';

/** Os caracteres de operador do PG (`op_chars` do `scan.l`). */
const OP_CHARS = new Set('~!@#^&|`?+-*/%<>=');
/** Com um destes num operador composto, ele PODE terminar em `+`/`-` (regra do `scan.l`). */
const OP_ESPECIAIS = new Set('~!@#^&|`?%');
const INICIO_IDENT = /[A-Za-z_\u0080-\uffff]/;
const CONT_IDENT = /[A-Za-z_0-9$\u0080-\uffff]/;
const NUMERO = /^(?:0[xX][0-9A-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|[0-9][0-9_]*(?:\.(?!\.)[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9]+)?/;
const TAG_DOLLAR = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z_0-9\u0080-\uffff]*)?\$/;
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
export function tokensSql(corpo: string): string[] {
  const s = corpo;
  const fora: string[] = [];
  let i = 0;
  let ultimoFoiString = false;
  let quebraDesdeUltimo = false;
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
    if (/\s/.test(c)) {
      if (c === '\n' || c === '\r') quebraDesdeUltimo = true;
      i++;
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
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
      continue;
    }
    // Literal com prefixo: E'…' (barra escapa), B'…', X'…', N'…', U&'…'. O prefixo é caixa-insensível.
    const prefixo = /^(?:[EeBbXxNn]|[Uu]&)'/.exec(s.slice(i, i + 3));
    if (prefixo !== null) {
      const p = prefixo[0].slice(0, -1).toUpperCase();
      const fim = literal(i + p.length, p === 'E');
      emitir(p + s.slice(i + p.length, fim), true);
      i = fim;
      continue;
    }
    if (c === "'") {
      const fim = literal(i, false);
      emitir(s.slice(i, fim), true);
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
      const tag = TAG_DOLLAR.exec(s.slice(i, i + 128));
      if (tag !== null) {
        const fim = s.indexOf(tag[0], i + tag[0].length);
        const ate = fim < 0 ? s.length : fim + tag[0].length;
        emitir(s.slice(i, ate));
        i = ate;
        continue;
      }
      const param = /^\$[0-9]+/.exec(s.slice(i, i + 32));
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
    const numero = NUMERO.exec(s.slice(i, i + 128));
    if (numero !== null) {
      emitir(numero[0].toLowerCase());
      i += numero[0].length;
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

/** Os dois corpos são o MESMO programa (ver `tokensSql`)? */
export function mesmosTokens(a: string, b: string): boolean {
  const x = tokensSql(a);
  const y = tokensSql(b);
  return x.length === y.length && x.every((t, k) => t === y[k]);
}

/**
 * Divide a lista de argumentos no nível 0 — ciente de `()`, `[]`, `'…'` e `"…"`. O `splitTopLevel`
 * do extrator só conta parêntese: `DEFAULT ARRAY['sayerlack','colacor']` virava 2 argumentos.
 */
function dividirArgumentos(args: string): string[] {
  const fora: string[] = [];
  let prof = 0;
  let atual = '';
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "'" || c === '"') {
      const fim = args.indexOf(c, i + 1);
      const ate = fim < 0 ? args.length : fim + 1;
      atual += args.slice(i, ate);
      i = ate - 1;
      continue;
    }
    if (c === '(' || c === '[') prof++;
    else if (c === ')' || c === ']') prof--;
    if (c === ',' && prof === 0) {
      fora.push(atual);
      atual = '';
    } else {
      atual += c;
    }
  }
  if (atual.trim() !== '') fora.push(atual);
  return fora;
}

/** Os tipos de várias palavras que `format_type` imprime — o destino da canonização. */
const TIPOS_COMPOSTOS = new Set([
  'double precision',
  'character varying',
  'bit varying',
  'timestamp with time zone',
  'timestamp without time zone',
  'time with time zone',
  'time without time zone',
]);

/** Apelido → o nome que `format_type(oid, NULL)` devolve. Typmod já saiu antes de chegar aqui. */
const APELIDOS: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  int2: 'smallint',
  int8: 'bigint',
  bool: 'boolean',
  float8: 'double precision',
  float: 'double precision',
  float4: 'real',
  decimal: 'numeric',
  varchar: 'character varying',
  'char varying': 'character varying',
  char: 'character',
  bpchar: 'character',
  timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  timetz: 'time with time zone',
  time: 'time without time zone',
  varbit: 'bit varying',
};

/** Um tipo (sem nome de parâmetro) no formato de `format_type`, ou null se não for um tipo. */
function tipoCanonico(texto: string): string | null {
  let t = texto.trim();
  let colchetes = '';
  while (t.endsWith('[]')) {
    colchetes += '[]';
    t = t.slice(0, -2).trim();
  }
  if (t.startsWith('"')) return /^"[^"]+"$/.test(t) ? t + colchetes : null;
  t = t.replace(/^(?:public|pg_catalog)\./, '');
  if (TIPOS_COMPOSTOS.has(t)) return t + colchetes;
  if (APELIDOS[t] !== undefined) return APELIDOS[t] + colchetes;
  return /^[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?$/.test(t) ? t + colchetes : null;
}

/**
 * A identidade de uma lista de argumentos — os tipos de ENTRADA (IN, INOUT, VARIADIC; OUT fica de
 * fora, como em `proargtypes`) no formato de `format_type`, separados por `,`.
 *
 * `null` quando algum argumento não se resolve estaticamente (`tabela.col%TYPE`, sintaxe estranha)
 * — e null é "não sei", nunca um palpite: quem chama trata a declaração como não mensurável.
 */
export function identidadeDosArgumentos(args: string): string | null {
  const tipos: string[] = [];
  for (const bruto of dividirArgumentos(args)) {
    // DEFAULT/`=` no nível 0 encerra o tipo; typmod (`(10,2)`) não entra na identidade de função.
    const semDefault = bruto.replace(/\s+default\s[\s\S]*$/i, '').replace(/\s*=[\s\S]*$/, '');
    const semTypmod = semDefault.replace(/\(\s*[0-9\s,]*\)/g, ' ');
    if (/%type/i.test(semTypmod)) return null;
    const palavras = semTypmod
      .trim()
      .split(/\s+/)
      .map((p) => (p.startsWith('"') ? p : p.toLowerCase()));
    if (palavras.length === 0 || palavras[0] === '') return null;
    const modo = ['in', 'out', 'inout', 'variadic'].includes(palavras[0]) ? palavras.shift() : undefined;
    if (modo === 'out') continue;
    const inteiro = tipoCanonico(palavras.join(' '));
    const semNome = palavras.length > 1 ? tipoCanonico(palavras.slice(1).join(' ')) : null;
    const tipo = inteiro ?? semNome;
    if (tipo === null) return null;
    tipos.push(tipo);
  }
  return tipos.join(',');
}

/** Uma identidade que a migration tira de `public`. `identidade` ausente = sem lista ⇒ TODAS do nome. */
export interface Remocao {
  nome: string;
  /** `null` quando a lista existe e não se resolve (ver `identidadeDosArgumentos`). */
  identidade?: string | null;
  /** Índice do `DROP`/`ALTER` no arquivo — ordena contra os CREATE do MESMO arquivo. */
  posicao: number;
}

/** `[schema.]nome` — com ou sem aspas —, e a posição logo depois dele. */
const NOME_QUALIFICADO = /^\s*(?:"?([A-Za-z_][\w$]*)"?\s*\.\s*)?"?([A-Za-z_][\w$]*)"?\s*/;

/** Lê `nome(args)` a partir de `i` no texto mascarado; devolve a remoção (se em public) e o fim. */
function lerAlvo(m: string, i: number, posicao: number): { remocao?: Remocao; fim: number } | null {
  const item = NOME_QUALIFICADO.exec(m.slice(i));
  if (item === null) return null;
  let fim = i + item[0].length;
  let args: string | undefined;
  if (m[fim] === '(') {
    args = balancedParens(m, fim);
    fim += args.length + 2;
  }
  if ((item[1] ?? 'public').toLowerCase() !== 'public') return { fim };
  const nome = item[2].toLowerCase();
  const remocao: Remocao = args === undefined ? { nome, posicao } : { nome, identidade: identidadeDosArgumentos(args), posicao };
  return { remocao, fim };
}

/**
 * O que a migration tira de `public`: `DROP FUNCTION` (inclusive em lista) e `ALTER FUNCTION … SET
 * SCHEMA`/`RENAME TO`. `ALTER` de atributo (`SET search_path`, `OWNER TO`) não remove nada.
 *
 * O comentário sai pelo stripper compartilhado — aqui ele é o certo: é leitura de DDL (DROP dentro
 * de rollback comentado não conta), não comparação de corpo. DDL dinâmica (`EXECUTE format('DROP
 * FUNCTION %s', …)`) não tem alvo legível e não entra: a função segue esperada, e a ausência dela
 * em prod vira achado em vez de ser "explicada" por um palpite.
 */
export function remocoesDe(sql: string): Remocao[] {
  const m = removerComentariosSql(sql);
  const fora: Remocao[] = [];
  for (const d of m.matchAll(/\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?/gi)) {
    let i = (d.index ?? 0) + d[0].length;
    for (;;) {
      const alvo = lerAlvo(m, i, d.index ?? 0);
      if (alvo === null) break;
      if (alvo.remocao !== undefined) fora.push(alvo.remocao);
      const virgula = /^\s*,/.exec(m.slice(alvo.fim));
      if (virgula === null) break;
      i = alvo.fim + virgula[0].length;
    }
  }
  for (const a of m.matchAll(/\bALTER\s+FUNCTION\s+/gi)) {
    const alvo = lerAlvo(m, (a.index ?? 0) + a[0].length, a.index ?? 0);
    if (alvo?.remocao === undefined) continue;
    if (/^\s*(?:SET\s+SCHEMA|RENAME\s+TO)\b/i.test(m.slice(alvo.fim))) fora.push(alvo.remocao);
  }
  return fora;
}

/**
 * As funções que uma migration de PATCH POR ÂNCORA pode ter reescrito: a que lê o corpo vivo
 * (`pg_get_functiondef`), troca texto (`replace`/`regexp_replace`/`overlay`) e re-EXECUTA.
 *
 * É CANDIDATO, não prova (achado do Codex): a mesma migration costuma CITAR outras funções num
 * guard, num GRANT ou na postcondição (medido: `has_role` e `pode_ver_carteira_completa` aparecem
 * assim em patches de 2026-07). Por isso o sensor não conclui nada sozinho — exige que cada par
 * (função, patch) posterior ao último CREATE esteja CONCILIADO na baseline ("altera" ou "só cita").
 */
export function alvosDePatch(sql: string): string[] {
  const m = removerComentariosSql(sql);
  if (!/pg_get_functiondef/i.test(m) || !/\bEXECUTE\b/i.test(m) || !/(?:replace|overlay)\s*\(/i.test(m)) return [];
  const nomes = new Set<string>();
  for (const x of m.matchAll(/'(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)) nomes.add(x[1].toLowerCase());
  for (const x of m.matchAll(/'public\.([a-z_][a-z0-9_]*)'\s*::\s*regproc/gi)) nomes.add(x[1].toLowerCase());
  for (const x of m.matchAll(/proname\s*=\s*'([a-z_][a-z0-9_]*)'/gi)) nomes.add(x[1].toLowerCase());
  return [...nomes].sort((a, b) => a.localeCompare(b, 'en'));
}

/** Uma versão do corpo de uma identidade, como uma migration a declarou. */
interface VersaoDeIdentidade {
  migration: string;
  /** Ausente quando a declaração não tem corpo dollar-quoted — e aí NADA a substitui. */
  corpo?: string;
  md5Exato?: string;
}

/** O que o repo diz sobre UMA identidade (`nome(tipos)`) ao fim da sequência de migrations. */
interface EstadoDeIdentidade {
  nome: string;
  /** Os tipos de entrada no formato de `format_type` (ver `identidadeDosArgumentos`). */
  identidade: string;
  versoes: VersaoDeIdentidade[];
  /** A migration que a tirou de `public` DEPOIS do último CREATE; ausente = viva. */
  aposentadaPor?: string;
  /** Migrations de patch por âncora que a CITAM depois do último CREATE — exigem conciliação. */
  patchesDepois: string[];
}

export interface ModeloDoRepo {
  /** Por `nome(identidade)`. */
  identidades: Map<string, EstadoDeIdentidade>;
  /** O universo: todo nome que alguma migration cria em `public`. */
  nomes: Set<string>;
  /** Controle positivo: quantas migrations foram lidas. ZERO é leitura quebrada, nunca "repo sem DDL". */
  migrations: number;
  /** Controle positivo: quantas declarações `public` saíram. ZERO com migrations lidas = extrator cego. */
  declaracoes: number;
  /** Controle INDEPENDENTE: nomes que um CREATE mais solto (aspas, espaço no ponto) vê e o extrator não. */
  perdidas: string[];
  /** Nomes com alguma declaração cuja assinatura não se resolve — o sensor não afirma nada sobre eles. */
  ilegiveis: string[];
}

const chaveIdentidade = (nome: string, identidade: string): string => `${nome}(${identidade})`;

/** O CREATE "solto": identificador citado e espaço em volta do ponto, que o extrator estrito não aceita. */
const CREATE_SOLTO = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?\s*\(/gi;

/**
 * O estado TERMINAL de cada identidade `public`, aplicando as migrations na ordem dada (quem chama
 * ordena — lexical do nome, que carrega o timestamp) e, dentro de cada arquivo, pela POSIÇÃO: um
 * `DROP FUNCTION f(int); CREATE FUNCTION f(int)` termina VIVO.
 *
 * Por identidade e não por nome (achados do Codex, 2026-09-26): `f(int)` redefinida não aposenta
 * `f(text)`; `DROP f(int)` não aposenta `f(text)`; e a função aposentada que alguém recria à mão
 * com o último corpo commitado tem de acusar, não sair "em dia".
 *
 * Uma declaração sem corpo dollar-quoted ENTRA como versão sem corpo — nunca deixa a anterior
 * assumir o posto de última (era o falso-verde reproduzido pelo Codex no `historicoDeCorpos`).
 */
export function modelarRepo(migrations: readonly MigrationLida[]): ModeloDoRepo {
  const identidades = new Map<string, EstadoDeIdentidade>();
  const nomes = new Set<string>();
  const ilegiveis = new Set<string>();
  const soltas = new Set<string>();
  let declaracoes = 0;
  for (const { nome: migration, sql } of migrations) {
    const eventos: { posicao: number; aplicar: () => void }[] = [];
    let semCorpos = removerComentariosSql(sql);
    for (const d of declaracoesDeFuncao(sql)) {
      // O corpo extraído sai do texto do controle solto: um CREATE escrito como TEXTO lá dentro não
      // é declaração (o extrator já o pula) e não pode virar "perda".
      if (d.corpo !== undefined) {
        const ini = sql.indexOf(d.corpo, d.posicao);
        if (ini >= 0) semCorpos = semCorpos.slice(0, ini) + ' '.repeat(d.corpo.length) + semCorpos.slice(ini + d.corpo.length);
      }
      if (d.schema !== 'public') continue;
      declaracoes++;
      const identidade = identidadeDosArgumentos(d.argumentos);
      eventos.push({
        posicao: d.posicao,
        aplicar: () => {
          nomes.add(d.nome);
          if (identidade === null) {
            ilegiveis.add(d.nome);
            return;
          }
          const k = chaveIdentidade(d.nome, identidade);
          const e = identidades.get(k) ?? { nome: d.nome, identidade, versoes: [], patchesDepois: [] };
          e.versoes.push(d.corpo === undefined ? { migration } : { migration, corpo: d.corpo, md5Exato: d.md5Exato });
          e.aposentadaPor = undefined;
          e.patchesDepois = [];
          identidades.set(k, e);
        },
      });
    }
    for (const r of remocoesDe(sql)) {
      eventos.push({
        posicao: r.posicao,
        aplicar: () => {
          for (const e of identidades.values()) {
            if (e.nome !== r.nome || e.aposentadaPor !== undefined) continue;
            // Sem lista (ou lista ilegível) ⇒ todas as do nome: o PG exige nome único nesse caso.
            if (r.identidade === undefined || r.identidade === null || r.identidade === e.identidade) {
              e.aposentadaPor = migration;
            }
          }
        },
      });
    }
    for (const ev of eventos.sort((a, b) => a.posicao - b.posicao)) ev.aplicar();
    // O patch reescreve o que ESTÁ em prod quando roda: conta como evento do fim do arquivo. Não
    // pendura na função que o PRÓPRIO arquivo acabou de criar (medido: 9 falsos candidatos — a
    // migration cria `f` e patcheia OUTRAS, e o nome de `f` aparece no texto). Se ela de fato
    // reescrevesse `f` depois do CREATE, prod ≠ último CREATE e o sensor acusa SEM_PAR mesmo assim.
    for (const alvo of alvosDePatch(sql)) {
      for (const e of identidades.values()) {
        if (e.nome !== alvo || e.aposentadaPor !== undefined) continue;
        if (e.versoes.at(-1)?.migration !== migration) e.patchesDepois.push(migration);
      }
    }
    for (const x of semCorpos.matchAll(CREATE_SOLTO)) {
      if ((x[1] ?? 'public').toLowerCase() === 'public') soltas.add(x[2].toLowerCase());
    }
  }
  return {
    identidades,
    nomes,
    migrations: migrations.length,
    declaracoes,
    perdidas: [...soltas].filter((n) => !nomes.has(n)).sort((a, b) => a.localeCompare(b, 'en')),
    ilegiveis: [...ilegiveis].sort((a, b) => a.localeCompare(b, 'en')),
  };
}

/** Marca de formato do detalhe; o parser recusa outra. */
const FORMATO_DERIVA = 'deriva-corpo/1';
/** A resposta CONHECIDA do autoteste de identidade: format_type de int4, text, timestamptz, varchar. */
const IDENTIDADE_AMOSTRA = 'integer,text,timestamp with time zone,character varying';

/**
 * A sonda read-only completa: a do gate do pacote (`montarSondaPrecondicao` — existência, controle
 * positivo, autoteste de dialeto e de md5, marcador) e o DETALHE por overload, as duas dentro de
 * UMA transação `REPEATABLE READ READ ONLY`.
 *
 * Uma transação só (achado P2 do Codex): em duas leituras soltas, `f` pode estar certa na 1ª, `g`
 * na 2ª, e o veredito aprovaria um estado que nunca existiu num mesmo instante.
 *
 * O detalhe traz, por overload: a identidade (`format_type` de `proargtypes` — os tipos de entrada,
 * como `identidadeDosArgumentos` a reconstrói do repo), o `xmin` (agrupa colagens), o md5 do
 * `prosrc` CALCULADO NO BANCO e o próprio `prosrc` em hex — o texto que a comparação por tokens
 * precisa, e que o parser só aceita se reproduzir aquele md5.
 */
export function montarSondaDeriva(nomes: readonly string[]): string {
  const sonda = montarSondaPrecondicao(nomes); // valida os nomes (alfabeto `[a-z0-9_]`) antes de interpolar
  const valores = [...new Set(nomes)].sort((a, b) => a.localeCompare(b, 'en')).map((n) => `('${n}')`).join(', ');
  const semCorpo = "p.prosqlbody IS NOT NULL OR p.prosrc IS NULL OR p.prosrc = '' OR l.lanname IN ('c', 'internal')";
  const detalhe = [
    `WITH alvo(nome) AS (VALUES ${valores})`,
    `SELECT tipo, a, b, c, d, e FROM (`,
    `  SELECT 1 AS ord, 'fn' AS tipo, p.proname::text AS a,`,
    `         coalesce((SELECT string_agg(format_type(t, NULL), ',' ORDER BY i)`,
    `                     FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS x(t, i)), '') AS b,`,
    `         p.xmin::text AS c,`,
    `         CASE WHEN ${semCorpo} THEN '${TOKEN_SEM_CORPO}' ELSE md5(p.prosrc) END AS d,`,
    `         CASE WHEN ${semCorpo} THEN '' ELSE encode(convert_to(p.prosrc, 'UTF8'), 'hex') END AS e`,
    `    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang`,
    `   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN (SELECT nome FROM alvo)`,
    // Autotestes do CANAL: respostas conhecidas antes de perguntar. O hex tem de voltar à amostra
    // do gate; a identidade tem de sair no formato que o repo reconstrói.
    `  UNION ALL SELECT 2, 'autoteste-hex', encode(convert_to(E'\\n á  b ', 'UTF8'), 'hex'), '', '', '', ''`,
    `  UNION ALL SELECT 2, 'autoteste-id', (SELECT string_agg(format_type(t, NULL), ',' ORDER BY i)`,
    `                     FROM unnest('{23,25,1184,1043}'::oid[]) WITH ORDINALITY AS x(t, i)), '', '', '', ''`,
    `  UNION ALL SELECT 2, 'agora', (now() AT TIME ZONE 'UTC')::text, '', '', '', ''`,
    `  UNION ALL SELECT 3, 'fim-deriva', '${FORMATO_DERIVA}', '', '', '', ''`,
    `) x ORDER BY ord, a, b;`,
  ].join('\n');
  return ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', sonda, detalhe, 'COMMIT;'].join('\n');
}

/** Um overload VIVO em prod. */
interface OverloadVivo {
  nome: string;
  /** Tipos de entrada, formato `format_type`. */
  identidade: string;
  xmin: number;
  /** md5 do `prosrc` calculado NO BANCO; ausente = sem corpo textual (prosqlbody, LANGUAGE c). */
  md5?: string;
  /** O `prosrc` — só presente quando reproduz o md5 do banco. */
  texto?: string;
}

export interface LeituraDeriva {
  /** A leitura da sonda reaproveitada — é ela que o `julgarPrecondicao` consome. */
  sonda: LeituraSonda;
  overloads: OverloadVivo[];
  fim: boolean;
  autotesteHex: boolean;
  autotesteIdentidade: boolean;
  agora?: string;
  /** Desacordos DENTRO da própria resposta (hex × md5, sonda × detalhe): cada um é "não sei". */
  incoerencias: string[];
}

/**
 * Lê a saída de `psql -tA -F '|'`. Linha que não casa o formato é ignorada aqui e cobrada pelos
 * marcadores — um parser que "conserta" o que não entendeu esconde a truncagem.
 */
export function parsearSondaDeriva(saida: string): LeituraDeriva {
  const overloads: OverloadVivo[] = [];
  const incoerencias: string[] = [];
  let fim = false;
  let autotesteHex = false;
  let autotesteIdentidade = false;
  let agora: string | undefined;
  for (const bruta of saida.split('\n')) {
    const c = bruta.trim().split('|');
    if (c[0] === 'fn' && c.length === 6) {
      const [, nome, identidade, xmin, md5, hexa] = c;
      const vivo: OverloadVivo = { nome, identidade, xmin: Number.parseInt(xmin, 10) };
      if (md5 !== TOKEN_SEM_CORPO && md5 !== '') {
        vivo.md5 = md5;
        const texto = Buffer.from(hexa, 'hex').toString('utf8');
        if (md5Exato(texto) === md5) vivo.texto = texto;
        else incoerencias.push(`${nome}(${identidade}): o texto recebido não reproduz o md5 do banco`);
      }
      overloads.push(vivo);
    } else if (c[0] === 'autoteste-hex') {
      autotesteHex = Buffer.from(c[1] ?? '', 'hex').toString('utf8') === AMOSTRA_CORPO_JS;
    } else if (c[0] === 'autoteste-id') {
      autotesteIdentidade = c[1] === IDENTIDADE_AMOSTRA;
    } else if (c[0] === 'agora') {
      agora = c[1];
    } else if (c[0] === 'fim-deriva' && c[1] === FORMATO_DERIVA) {
      fim = true;
    }
  }
  const sonda = parsearSondaPrecondicao(saida);
  // As duas leituras vêm do MESMO retrato: têm de concordar por nome em contagem e em md5.
  for (const [nome, vivo] of sonda.corpos) {
    const doDetalhe = overloads.filter((o) => o.nome === nome);
    if (doDetalhe.length !== vivo.overloads) {
      incoerencias.push(`${nome}: a sonda contou ${vivo.overloads} overload(s) e o detalhe trouxe ${doDetalhe.length}`);
      continue;
    }
    const a = [...vivo.md5s].sort().join();
    const b = doDetalhe.flatMap((o) => (o.md5 === undefined ? [] : [o.md5])).sort().join();
    if (a !== b) incoerencias.push(`${nome}: md5 da sonda e do detalhe divergem`);
  }
  return { sonda, overloads, fim, autotesteHex, autotesteIdentidade, agora, incoerencias };
}

// ── baseline de deriva ACEITA ───────────────────────────────────────────────────────────────────

const FORMATO_BASELINE = 'deriva-corpo-baseline/1';
const CLASSES = ['EDICAO_MANUAL', 'PATCH', 'NAO_MENSURAVEL', 'OVERLOAD_FORA_DO_REPO'] as const;
type ClasseBaseline = (typeof CLASSES)[number];

/**
 * Uma deriva que alguém OLHOU e aceitou — o contrato deste audit (vai no fingerprint do carimbo).
 *
 * - `EDICAO_MANUAL`: prod roda um corpo que o repo nunca commitou. Vale enquanto a última
 *   declaração do repo for `esperadaNoAceite` — redefinir a função vence a entrada.
 * - `PATCH`: a conciliação de UM par (função, migration de patch por âncora) posterior ao último
 *   CREATE. `ALTERA` = o patch reescreveu a função (o último `ALTERA` traz o corpo aceito);
 *   `SO_CITA` = só a menciona (guard, GRANT, postcondição). Sem conciliação, nada fica verde.
 * - `NAO_MENSURAVEL`: a última versão não tem corpo comparável (prosqlbody, `RETURN` do SQL
 *   padrão) — declarado, para que "não medi" nunca vire silêncio.
 * - `OVERLOAD_FORA_DO_REPO`: overload vivo em prod que nenhuma migration declara.
 *
 * O aceite compara por md5 do BANCO **ou** por md5 dos tokens (achado P2 do Codex): um comentário
 * novo no corpo aceito não pode reabrir o alarme — mas qualquer mudança de token reabre.
 */
export interface EntradaBaseline {
  funcao: string;
  identidade: string;
  classe: ClasseBaseline;
  esperadaNoAceite?: string;
  patch?: string;
  efeito?: 'ALTERA' | 'SO_CITA';
  md5?: string;
  md5Tokens?: string;
  motivo: string;
  desde: string;
}

/** md5 da sequência de tokens — o "mesmo programa" como hash (ver `tokensSql`). */
export function md5DeTokens(texto: string): string {
  return md5Exato(tokensSql(texto).join('\u0000'));
}

const MD5 = /^[0-9a-f]{32}$/;

/** Lê e VALIDA a baseline. Qualquer desvio lança — baseline torta é "não consegui medir", nunca vazia. */
export function lerBaseline(texto: string): EntradaBaseline[] {
  let obj: unknown;
  try {
    obj = JSON.parse(texto);
  } catch {
    throw new Error('baseline: não é JSON');
  }
  const b = obj as { formato?: unknown; entradas?: unknown };
  if (b.formato !== FORMATO_BASELINE) throw new Error(`baseline: formato ${String(b.formato)} ≠ ${FORMATO_BASELINE}`);
  if (!Array.isArray(b.entradas)) throw new Error('baseline: sem `entradas`');
  const vistas = new Set<string>();
  return b.entradas.map((cru: unknown, i: number) => {
    const e = cru as Partial<EntradaBaseline>;
    const onde = `baseline: entrada ${i} (${String(e.funcao)})`;
    if (typeof e.funcao !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(e.funcao)) throw new Error(`${onde}: funcao inválida`);
    if (typeof e.identidade !== 'string') throw new Error(`${onde}: identidade ausente`);
    if (!CLASSES.includes(e.classe as ClasseBaseline)) throw new Error(`${onde}: classe ${String(e.classe)} desconhecida`);
    if (typeof e.motivo !== 'string' || e.motivo.trim() === '') throw new Error(`${onde}: sem motivo`);
    if (typeof e.desde !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.desde)) throw new Error(`${onde}: desde inválido`);
    const temCorpo = typeof e.md5 === 'string' && MD5.test(e.md5) && typeof e.md5Tokens === 'string' && MD5.test(e.md5Tokens);
    if (e.classe === 'EDICAO_MANUAL' && (!temCorpo || typeof e.esperadaNoAceite !== 'string')) {
      throw new Error(`${onde}: EDICAO_MANUAL exige esperadaNoAceite, md5 e md5Tokens`);
    }
    if (e.classe === 'OVERLOAD_FORA_DO_REPO' && !temCorpo) throw new Error(`${onde}: OVERLOAD_FORA_DO_REPO exige md5 e md5Tokens`);
    if (e.classe === 'PATCH' && (typeof e.patch !== 'string' || (e.efeito !== 'ALTERA' && e.efeito !== 'SO_CITA'))) {
      throw new Error(`${onde}: PATCH exige patch e efeito ALTERA|SO_CITA`);
    }
    const chave = [e.funcao, e.identidade, e.classe, e.patch ?? ''].join('|');
    if (vistas.has(chave)) throw new Error(`${onde}: entrada duplicada`);
    vistas.add(chave);
    return e as EntradaBaseline;
  });
}

// ── julgamento ──────────────────────────────────────────────────────────────────────────────────

/** Estados que NÃO falham o audit. */
const OK = ['EM_DIA', 'COSMETICO', 'ACEITA', 'AUSENTE_EXPLICADA', 'NAO_MENSURAVEL_DECLARADA', 'BASELINE_OBSOLETA'] as const;
/** Estados que falham (exit 1). */
const FALHA = [
  'CORPO_ANTERIOR',
  'SEM_PAR',
  'PATCH_NAO_CONCILIADO',
  'PATCH_AUSENTE',
  'AUSENTE',
  'RESSUSCITADA',
  'SEM_CORPO_TEXTUAL',
  'OVERLOAD_FORA_DO_REPO',
] as const;
type CodigoDeriva = (typeof OK)[number] | (typeof FALHA)[number];

interface AchadoDeriva {
  codigo: CodigoDeriva;
  /** `nome(identidade)`. */
  alvo: string;
  falha: boolean;
  detalhe: string;
  xmin?: number;
}

export interface EntradaJulgamento {
  modelo: ModeloDoRepo;
  leitura: LeituraDeriva;
  baseline: readonly EntradaBaseline[];
  /** O veredito do gate do pacote sobre a MESMA sonda — reaproveitado pelos controles fail-closed. */
  controles: VereditoPrecondicao;
}

export interface ResultadoDeriva {
  exit: 0 | 1 | 2;
  achados: AchadoDeriva[];
  /** Por que a medição não fecha — cada linha é "não sei", e qualquer uma leva a exit 2. */
  incertezas: string[];
}

const achado = (codigo: CodigoDeriva, alvo: string, detalhe: string, xmin?: number): AchadoDeriva => ({
  codigo,
  alvo,
  falha: (FALHA as readonly string[]).includes(codigo),
  detalhe,
  ...(xmin === undefined ? {} : { xmin }),
});

/** O corpo vivo casa com uma versão (md5 do banco, ou mesmos tokens)? */
const casaVersao = (o: OverloadVivo, v: VersaoDeIdentidade): boolean =>
  (v.md5Exato !== undefined && o.md5 === v.md5Exato) ||
  (o.texto !== undefined && v.corpo !== undefined && mesmosTokens(o.texto, v.corpo));

/** O corpo vivo casa com um corpo aceito na baseline? */
const casaAceite = (o: OverloadVivo, b: EntradaBaseline): boolean =>
  (b.md5 !== undefined && o.md5 === b.md5) || (o.texto !== undefined && b.md5Tokens !== undefined && md5DeTokens(o.texto) === b.md5Tokens);

/**
 * O veredito. Precedência: qualquer incerteza ⇒ 2 (medição incompleta NUNCA sai 0, e não vira 1
 * com cara de resultado); senão, qualquer achado de falha ⇒ 1; senão 0.
 */
export function julgarDeriva({ modelo, leitura, baseline, controles }: EntradaJulgamento): ResultadoDeriva {
  const incertezas: string[] = [];
  if (controles.estado === 'INCERTA') {
    incertezas.push(...controles.motivos, ...controles.naoMedidos.map((n) => `a sonda não devolveu linha para \`${n}\``));
  }
  if (!leitura.fim) incertezas.push(`o detalhe não trouxe o marcador \`${FORMATO_DERIVA}\` — saída truncada`);
  if (!leitura.autotesteHex) incertezas.push('autoteste do canal hex falhou — o texto dos corpos não é confiável');
  if (!leitura.autotesteIdentidade) incertezas.push('autoteste de identidade falhou — format_type não fala o formato esperado');
  incertezas.push(...leitura.incoerencias);
  if (modelo.migrations === 0) incertezas.push('nenhuma migration lida — é git/caminho quebrado, não um repo sem DDL');
  else if (modelo.declaracoes === 0) incertezas.push('migrations lidas e NENHUMA declaração extraída — extrator cego');
  for (const n of modelo.perdidas) incertezas.push(`\`${n}\`: um CREATE que o extrator não reconheceu (citado/qualificado) — extração incompleta`);
  for (const n of modelo.ilegiveis) incertezas.push(`\`${n}\`: assinatura que não se resolve estaticamente — não afirmo nada sobre ela`);

  const achados: AchadoDeriva[] = [];
  const notas: AchadoDeriva[] = [];
  const usadas = new Set<EntradaBaseline>();
  const daBaseline = (e: EstadoDeIdentidade, classe: ClasseBaseline) =>
    baseline.filter((b) => b.classe === classe && b.funcao === e.nome && b.identidade === e.identidade);

  for (const e of modelo.identidades.values()) {
    const alvo = chaveIdentidade(e.nome, e.identidade);
    const o = leitura.overloads.find((x) => x.nome === e.nome && x.identidade === e.identidade);
    if (e.aposentadaPor !== undefined) {
      achados.push(
        o === undefined
          ? achado('AUSENTE_EXPLICADA', alvo, `aposentada por ${e.aposentadaPor}`)
          : achado('RESSUSCITADA', alvo, `aposentada por ${e.aposentadaPor}, mas EXISTE em prod`, o.xmin),
      );
      continue;
    }
    const ult = e.versoes[e.versoes.length - 1];
    if (ult.corpo === undefined) {
      const decl = daBaseline(e, 'NAO_MENSURAVEL');
      decl.forEach((b) => usadas.add(b));
      if (decl.length > 0) achados.push(achado('NAO_MENSURAVEL_DECLARADA', alvo, `${ult.migration} sem corpo dollar-quoted`));
      else incertezas.push(`\`${alvo}\`: a última versão (${ult.migration}) não tem corpo comparável e a baseline não a declara NAO_MENSURAVEL`);
      continue;
    }
    if (o === undefined) {
      achados.push(achado('AUSENTE', alvo, `viva no repo (último CREATE: ${ult.migration}) e ausente em prod — migration não aplicada ou DROP manual`));
      continue;
    }
    if (o.md5 === undefined) {
      achados.push(achado('SEM_CORPO_TEXTUAL', alvo, `prod sem corpo textual (prosqlbody/LANGUAGE c) e o repo declara corpo em ${ult.migration}`, o.xmin));
      continue;
    }

    // Patches por âncora posteriores ao último CREATE: sem conciliação, nada fica verde.
    if (e.patchesDepois.length > 0) {
      const conciliados = e.patchesDepois.map((p) => daBaseline(e, 'PATCH').find((b) => b.patch === p));
      conciliados.forEach((b) => b !== undefined && usadas.add(b));
      const faltam = e.patchesDepois.filter((_p, i) => conciliados[i] === undefined);
      if (faltam.length > 0) {
        achados.push(
          achado(
            'PATCH_NAO_CONCILIADO',
            alvo,
            `patch(es) por âncora posterior(es) ao último CREATE (${ult.migration}) sem conciliação na baseline: ${faltam.join(', ')} — confira se ALTERA (aceite o md5 de prod) ou SO_CITA`,
            o.xmin,
          ),
        );
        continue;
      }
      const alteras = conciliados.filter((b): b is EntradaBaseline => b?.efeito === 'ALTERA');
      const final = alteras[alteras.length - 1];
      if (final !== undefined) {
        if (final.md5 === undefined || final.md5Tokens === undefined) {
          incertezas.push(`baseline: o último patch ALTERA de \`${alvo}\` (${final.patch}) não traz md5/md5Tokens`);
        } else if (casaAceite(o, final)) {
          achados.push(achado('ACEITA', alvo, `patch ${final.patch} conciliado (ALTERA)`, o.xmin));
        } else if (casaVersao(o, ult) || alteras.slice(0, -1).some((b) => casaAceite(o, b))) {
          achados.push(achado('PATCH_AUSENTE', alvo, `prod roda um estado ANTERIOR ao patch ${final.patch} — o patch não pegou ou foi revertido`, o.xmin));
        } else {
          achados.push(achado('SEM_PAR', alvo, `corpo que nem o último CREATE (${ult.migration}) nem o patch aceito (${final.patch}) explicam`, o.xmin));
        }
        continue;
      }
    }

    const manuais = daBaseline(e, 'EDICAO_MANUAL');
    const vigentes = manuais.filter((b) => b.esperadaNoAceite === ult.migration);
    manuais.filter((b) => b.esperadaNoAceite !== ult.migration).forEach((b) => {
      usadas.add(b);
      notas.push(achado('BASELINE_OBSOLETA', alvo, `EDICAO_MANUAL aceita sobre ${b.esperadaNoAceite}, mas o repo redefiniu em ${ult.migration} — a entrada não vale mais; remova`));
    });
    vigentes.forEach((b) => usadas.add(b));
    if (o.md5 === ult.md5Exato || casaVersao(o, ult)) {
      achados.push(achado(o.md5 === ult.md5Exato ? 'EM_DIA' : 'COSMETICO', alvo, ult.migration, o.xmin));
      if (vigentes.length > 0) notas.push(achado('BASELINE_OBSOLETA', alvo, 'prod voltou ao corpo do repo — a EDICAO_MANUAL aceita pode sair da baseline'));
      continue;
    }
    if (vigentes.some((b) => casaAceite(o, b))) {
      achados.push(achado('ACEITA', alvo, `EDICAO_MANUAL aceita sobre ${ult.migration}`, o.xmin));
      continue;
    }
    const anterior = e.versoes.slice(0, -1).reverse().find((v) => casaVersao(o, v));
    achados.push(
      anterior !== undefined
        ? achado('CORPO_ANTERIOR', alvo, `prod roda o corpo de ${anterior.migration}; o repo commitou ${ult.migration} depois — revert por ordem de colagem, ou migration mergeada e não aplicada`, o.xmin)
        : achado('SEM_PAR', alvo, `corpo que nenhuma das ${e.versoes.length} versão(ões) commitadas explica (edição manual) — último CREATE: ${ult.migration}`, o.xmin),
    );
  }

  // Overload vivo que o repo nunca declarou (para nomes do universo).
  for (const o of leitura.overloads) {
    if (!modelo.nomes.has(o.nome) || modelo.ilegiveis.includes(o.nome)) continue;
    if (modelo.identidades.has(chaveIdentidade(o.nome, o.identidade))) continue;
    const alvo = chaveIdentidade(o.nome, o.identidade);
    const aceite = baseline.find((b) => b.classe === 'OVERLOAD_FORA_DO_REPO' && b.funcao === o.nome && b.identidade === o.identidade);
    if (aceite !== undefined) usadas.add(aceite);
    achados.push(
      aceite !== undefined && casaAceite(o, aceite)
        ? achado('ACEITA', alvo, 'overload fora do repo aceito', o.xmin)
        : achado('OVERLOAD_FORA_DO_REPO', alvo, 'overload vivo em prod que nenhuma migration declara', o.xmin),
    );
  }

  for (const b of baseline) {
    if (!usadas.has(b)) {
      notas.push(achado('BASELINE_OBSOLETA', chaveIdentidade(b.funcao, b.identidade), `entrada ${b.classe}${b.patch ? ` (${b.patch})` : ''} sem alvo vigente no repo — remova`));
    }
  }

  const todos = [...achados, ...notas];
  const exit = incertezas.length > 0 ? 2 : todos.some((a) => a.falha) ? 1 : 0;
  return { exit, achados: todos, incertezas };
}

/** O contexto da medição que o relatório carimba no denominador. */
export interface ContextoRelatorio {
  /** O SHA da `origin/main` de onde as expectativas saíram. */
  sha: string;
  /** Houve `git fetch` antes de medir? Sem ele a ref pode estar velha (achado P1 do Codex). */
  fetch: boolean;
  /** O relógio do BANCO no retrato (UTC). */
  agora?: string;
}

/**
 * O texto do veredito, no contrato que o carimbo lê (`db/authz-carimbo-gravar.ts`): a 1ª linha
 * `🔎` é o denominador; cada `❌ [COD] alvo: …` vira um achado com id estável (`idFinding` lê só
 * `[COD] alvo`, por isso o `xmin` vem DEPOIS dos dois-pontos); o último `✅` é o resumo — e só
 * existe no exit 0. No exit 2 nenhuma linha começa com `✅`: "não medi" não pode virar resumo verde.
 */
export function relatarDeriva(r: ResultadoDeriva, ctx: ContextoRelatorio): { saida: string[]; erro: string[] } {
  const conta = (c: CodigoDeriva) => r.achados.filter((a) => a.codigo === c).length;
  const vivas = r.achados.filter((a) => a.codigo !== 'AUSENTE_EXPLICADA' && a.codigo !== 'BASELINE_OBSOLETA').length;
  const saida = [
    `🔎 deriva-corpo — ${vivas} identidade(s) conferida(s) · ${conta('AUSENTE_EXPLICADA')} aposentada(s) · ` +
      `ref origin/main@${ctx.sha.slice(0, 9)} (${ctx.fetch ? 'fetch ok' : 'SEM fetch — a ref pode estar velha'})` +
      (ctx.agora === undefined ? '' : ` · prod ${ctx.agora}Z`),
  ];
  const erro: string[] = [];
  for (const a of r.achados) {
    const xmin = a.xmin === undefined ? '' : ` (xmin ${a.xmin})`;
    if (a.falha) erro.push(`❌ [${a.codigo}] ${a.alvo}: ${a.detalhe}${xmin}`);
    else if (a.codigo === 'BASELINE_OBSOLETA') saida.push(`⚠️ [${a.codigo}] ${a.alvo}: ${a.detalhe}`);
  }
  // Colagens: achados de falha com o MESMO xmin vieram da mesma transação.
  const porXmin = new Map<number, string[]>();
  for (const a of r.achados) if (a.falha && a.xmin !== undefined) porXmin.set(a.xmin, [...(porXmin.get(a.xmin) ?? []), a.alvo]);
  for (const [x, alvos] of porXmin) if (alvos.length > 1) saida.push(`ℹ️ mesma transação (xmin ${x}): ${alvos.join(', ')}`);
  saida.push(
    `ℹ️ EM_DIA=${conta('EM_DIA')} · COSMETICO=${conta('COSMETICO')} · ACEITA=${conta('ACEITA')} · ` +
      `NAO_MENSURAVEL_DECLARADA=${conta('NAO_MENSURAVEL_DECLARADA')} · AUSENTE_EXPLICADA=${conta('AUSENTE_EXPLICADA')}`,
  );
  if (r.exit === 2) {
    for (const i of r.incertezas) erro.push(`⛔ [INCERTO] ${i}`);
    erro.push(`⛔ deriva-corpo — medição INCOMPLETA (${r.incertezas.length} motivo(s)): nada acima é veredito sobre prod`);
  } else if (r.exit === 1) {
    const falhas = r.achados.filter((a) => a.falha);
    const porCodigo = [...new Set(falhas.map((a) => a.codigo))].map((c) => `${falhas.filter((a) => a.codigo === c).length} ${c}`);
    erro.push(`deriva-corpo — ${falhas.length} divergência(s) em prod (${porCodigo.join(', ')}) — ver as linhas ❌`);
  } else {
    saida.push(
      `✅ deriva-corpo — ${vivas} identidade(s) batem com o repo (${conta('EM_DIA')} em dia, ${conta('COSMETICO')} só cosméticas, ` +
        `${conta('ACEITA')} aceitas na baseline) e ${conta('AUSENTE_EXPLICADA')} aposentada(s) estão ausentes`,
    );
  }
  return { saida, erro };
}
