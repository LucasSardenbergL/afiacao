/**
 * universo-pedidos-sql.ts — o núcleo PURO do gate da classe "objeto SQL que lê public.sales_orders com
 * OUTRO universo de pedidos" (docs/historico/universo-pedidos-classe-sql.md). Não executa SQL.
 *
 * A autoridade: status NOT IN (STATUS_NAO_VENDA) junto com deleted_at IS NULL — a lista vem de
 * src/lib/farmer/universo-pedidos.ts, lida pelo chamador e passada aqui; o gate não a duplica.
 *
 * O modelo: a ÚLTIMA definição de cada função/view/MV nas migrations (ordem de nome, que carrega o
 * timestamp; dentro do arquivo, ordem de posição). `DROP` aposenta. A leitura é por TOKENS
 * (`tokensSql`, o lexer do scan.l do PG17): comentário sai, literal é opaco — o `so.status NOT IN`
 * dentro de um RAISE/position() de uma postcondição é TEXTO, não predicado — e o corpo
 * dollar-quoted de função é re-tokenizado por dentro.
 *
 * O veredito, por objeto cuja última definição lê sales_orders (FROM/JOIN, com ou sem `public.`):
 *   · registrado (lookup/escritor/propósito/parâmetro) → fora do julgamento, mas a entrada tem de
 *     continuar VERDADEIRA: objeto que sumiu ou deixou de ler sales_orders reprova (registro órfão), e
 *     exceção que virou canônica também (a lista só encolhe);
 *   · senão, CADA leitura precisa do par canônico no SEU alias: `<alias>.status NOT IN (…)` (ou a forma
 *     do deparse, `<> ALL (ARRAY[…])`) com o MESMO conjunto da autoridade, e `<alias>.deleted_at IS
 *     NULL` — contados por alias: duas leituras com `so` exigem dois de cada (a régua tem duas, e pôr o
 *     universo só numa é o defeito parcial que este gate existe para barrar);
 *   · e nenhuma OUTRA comparação de status no alias (allowlist, denylist parcial, IS DISTINCT FROM,
 *     COALESCE(status,'')): ela muda o universo mesmo ao lado do par canônico.
 *
 * LIMITES DECLARADOS (quem pega é a varredura da prod por psql-ro — a query do diário):
 *   · objeto que só existe na PROD (sem CREATE no repo) e SQL aplicado fora de supabase/migrations
 *     (db/*.sql pelo db:aplicar, SQL Editor);
 *   · replace programático (`DO … replace(pg_get_functiondef(…)) … EXECUTE`): o gate lê o último
 *     CREATE literal; e SQL montado em string (EXECUTE de literal);
 *   · identidade por NOME (schema.nome), não por assinatura: sobrecargas da mesma função se fundem;
 *   · o alias é lido no FROM/JOIN imediato; leitura por CTE/subquery que renomeia não se distingue.
 */
import { tokensSql } from './deriva-corpo';
import { drenar, type Passos } from '@/lib/gates/passos';

type TipoRegistro = 'lookup' | 'escritor' | 'proposito' | 'canonico_por_parametro';
export interface EntradaRegistro {
  tipo: TipoRegistro;
  motivo: string;
  /** Só estas leituras (por alias) ficam fora; as demais do objeto seguem julgadas. Ausente = o objeto todo. */
  aliases?: readonly string[];
}
interface Definicao {
  objeto: string;
  migration: string;
  tokens: string[];
}
interface Leitura {
  alias: string; // '' = sem alias (a coluna vem nua ou qualificada por sales_orders)
}
interface Violacao {
  objeto: string;
  migration: string;
  motivo: string;
}

const IDENT = /^[a-z_][a-z0-9_$]*$/;
const NAO_ALIAS = new Set([
  'where', 'join', 'left', 'right', 'inner', 'full', 'cross', 'on', 'using', 'group', 'order', 'limit', 'offset',
  'union', 'except', 'intersect', 'having', 'window', 'for', 'natural', 'lateral', 'returning', 'set', 'values',
  'select', 'into', 'and', 'or', 'not', 'when', 'then', 'else', 'end', 'loop', 'fetch',
]);

/** `"public"` → `public`; identificador sem aspas já vem minúsculo do lexer. */
const nomeIdent = (t: string): string => (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t);

/** Lê `[schema .] nome` a partir de i; devolve o nome qualificado (public por default) e o próximo índice. */
function nomeQualificado(toks: readonly string[], i: number): { nome: string; prox: number } | null {
  const a = toks[i];
  if (a === undefined || !(IDENT.test(a) || /^".*"$/.test(a))) return null;
  if (toks[i + 1] === '.' && toks[i + 2] !== undefined) {
    return { nome: `${nomeIdent(a)}.${nomeIdent(toks[i + 2])}`, prox: i + 3 };
  }
  return { nome: `public.${nomeIdent(a)}`, prox: i + 1 };
}

/** O interior de um dollar-quote (`$tag$…$tag$`), ou null se o token não é um. */
function interiorDollar(t: string): string | null {
  const m = /^(\$[A-Za-z_0-9]*\$)([\s\S]*)\1$/.exec(t);
  return m ? m[2] : null;
}

type Evento =
  | { tipo: 'def'; objeto: string; def: Definicao }
  | { tipo: 'drop'; objeto: string }
  | { tipo: 'move'; de: string; para: string };

/**
 * Os eventos de UMA migration, em ordem: CREATE de função/view/MV (a definição), DROP (aposenta) e
 * ALTER … SET SCHEMA / RENAME TO (a definição MUDA DE NOME — sem isto a MV de recência, movida de
 * public para private por 20260629120000, sumia do modelo e o gate ficava verde por cegueira: foi o
 * controle de calibração pré-fix que pegou). O corpo de bloco `DO` é re-tokenizado e lido como
 * statements — é onde aquele SET SCHEMA mora.
 * Função: o corpo é o primeiro dollar-quote depois do CREATE (antes do `;` do statement).
 * View/MV: os tokens depois do `AS` até o `;` de profundidade zero.
 */
export function eventosDaMigration(migration: string, sql: string): Evento[] {
  return eventosDeTokens(migration, tokensSql(sql));
}

function eventosDeTokens(migration: string, toks: readonly string[]): Evento[] {
  const eventos: Evento[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === 'do') {
      for (let k = i + 1; k <= i + 3 && k < toks.length; k++) {
        const dentro = interiorDollar(toks[k]);
        if (dentro !== null) { eventos.push(...eventosDeTokens(migration, tokensSql(dentro))); i = k; break; }
      }
      continue;
    }
    if (toks[i] === 'alter') {
      let j = i + 1;
      if (toks[j] === 'materialized') j += 1;
      if (!['view', 'function', 'procedure', 'table'].includes(toks[j] ?? '')) continue;
      j += 1;
      if (toks[j] === 'if' && toks[j + 1] === 'exists') j += 2;
      const q = nomeQualificado(toks, j);
      if (!q) continue;
      const schema = q.nome.split('.')[0];
      for (let k = q.prox; k < toks.length && toks[k] !== ';'; k++) {
        if (toks[k] === 'set' && toks[k + 1] === 'schema' && toks[k + 2]) {
          eventos.push({ tipo: 'move', de: q.nome, para: `${nomeIdent(toks[k + 2])}.${q.nome.split('.')[1]}` });
          break;
        }
        if (toks[k] === 'rename' && toks[k + 1] === 'to' && toks[k + 2]) {
          eventos.push({ tipo: 'move', de: q.nome, para: `${schema}.${nomeIdent(toks[k + 2])}` });
          break;
        }
      }
      continue;
    }
    if (toks[i] === 'create') {
      let j = i + 1;
      if (toks[j] === 'or' && toks[j + 1] === 'replace') j += 2;
      const materializada = toks[j] === 'materialized';
      if (materializada) j += 1;
      if (toks[j] === 'function' || toks[j] === 'procedure') {
        const q = nomeQualificado(toks, j + 1);
        if (!q) continue;
        let k = q.prox;
        let corpo: string | null = null;
        for (; k < toks.length && toks[k] !== ';'; k++) {
          const dentro = interiorDollar(toks[k]);
          if (dentro !== null && corpo === null) corpo = dentro;
        }
        if (corpo !== null) eventos.push({ tipo: 'def', objeto: q.nome, def: { objeto: q.nome, migration, tokens: tokensSql(corpo) } });
        i = k;
      } else if (toks[j] === 'view') {
        let k = j + 1;
        if (toks[k] === 'if' && toks[k + 1] === 'not' && toks[k + 2] === 'exists') k += 3;
        const q = nomeQualificado(toks, k);
        if (!q) continue;
        k = q.prox;
        while (k < toks.length && toks[k] !== 'as' && toks[k] !== ';') k++;
        if (toks[k] !== 'as') continue;
        const corpo: string[] = [];
        let prof = 0;
        for (k = k + 1; k < toks.length; k++) {
          const t = toks[k];
          if (t === '(') prof++;
          if (t === ')') prof--;
          if (t === ';' && prof === 0) break;
          corpo.push(t);
        }
        eventos.push({ tipo: 'def', objeto: q.nome, def: { objeto: q.nome, migration, tokens: corpo } });
        i = k;
      }
    } else if (toks[i] === 'drop') {
      let j = i + 1;
      if (toks[j] === 'materialized') j += 1;
      if (toks[j] !== 'view' && toks[j] !== 'function' && toks[j] !== 'procedure') continue;
      j += 1;
      if (toks[j] === 'if' && toks[j + 1] === 'exists') j += 2;
      const q = nomeQualificado(toks, j);
      if (q) eventos.push({ tipo: 'drop', objeto: q.nome });
    }
  }
  return eventos;
}

/** A última definição viva de cada objeto. Quem chama ORDENA as migrations (lexical do nome). */
export function modelar(migrations: ReadonlyArray<{ nome: string; sql: string }>): Map<string, Definicao> {
  return drenar(modelarPassos(migrations));
}

/** O `modelar` como gerador (`@/lib/gates/passos`): `yield` por migration, onde está o custo (os
 *  eventos de cada uma) — o teste que modela o repo inteiro drena cedendo o event loop do worker do
 *  vitest (o RPC estoura com >60s de bloqueio: docs/historico/rpc-do-vitest-e-o-loop-preso.md). */
export function* modelarPassos(migrations: ReadonlyArray<{ nome: string; sql: string }>): Passos<Map<string, Definicao>> {
  const vivo = new Map<string, Definicao>();
  for (const { nome, sql } of migrations) {
    for (const e of eventosDaMigration(nome, sql)) {
      if (e.tipo === 'def') vivo.set(e.objeto, e.def);
      else if (e.tipo === 'drop') vivo.delete(e.objeto);
      else {
        const d = vivo.get(e.de);
        if (d) { vivo.delete(e.de); vivo.set(e.para, { ...d, objeto: e.para }); }
      }
    }
    yield;
  }
  return vivo;
}

/** Cada FROM/JOIN de sales_orders, com o alias (ou '' se não houver). */
function leiturasDeSalesOrders(toks: readonly string[]): Leitura[] {
  const out: Leitura[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== 'from' && toks[i] !== 'join') continue;
    let j = i + 1;
    if (toks[j] === 'only') j += 1;
    if ((toks[j] === 'public' || toks[j] === '"public"') && toks[j + 1] === '.') j += 2;
    if (nomeIdent(toks[j] ?? '') !== 'sales_orders') continue;
    let k = j + 1;
    if (toks[k] === 'as') k += 1;
    const cand = toks[k];
    const alias = cand !== undefined && IDENT.test(cand) && !NAO_ALIAS.has(cand) ? cand : '';
    out.push({ alias });
  }
  return out;
}

/** O qualificador antes de `.status`/`.deleted_at` em i (coluna em i); '' se a coluna vem nua. */
function qualificador(toks: readonly string[], i: number): string {
  return toks[i - 1] === '.' && toks[i - 2] !== undefined ? nomeIdent(toks[i - 2]) : '';
}
const casaAlias = (q: string, alias: string): boolean => q === alias || (alias === '' && (q === '' || q === 'sales_orders'));

/** Os literais de uma lista `( 'a' , 'b' … )` ou `( array [ 'a' :: text , … ] )` a partir de i (no `(`). */
function literaisDaLista(toks: readonly string[], i: number): { lits: string[]; fim: number } | null {
  if (toks[i] !== '(') return null;
  const lits: string[] = [];
  let prof = 0;
  for (let k = i; k < toks.length; k++) {
    const t = toks[k];
    if (t === '(' || t === '[') prof++;
    else if (t === ')' || t === ']') {
      prof--;
      if (prof === 0) return { lits, fim: k };
    } else if (/^'.*'$/.test(t)) lits.push(t.slice(1, -1));
    else if (!['array', ',', '::', 'text', 'character', 'varying'].includes(t)) return { lits: [], fim: k }; // não é lista de literais
  }
  return null;
}

interface ContagemAlias {
  canonicoStatus: number;
  deletedAt: number;
  outrasComparacoes: string[];
}

/** Por alias: quantos predicados canônicos de status, quantos deleted_at IS NULL, e o resto de comparação de status. */
function predicadosPorAlias(toks: readonly string[], aliases: readonly string[], autoridade: ReadonlySet<string>): Map<string, ContagemAlias> {
  const m = new Map<string, ContagemAlias>(aliases.map((a) => [a, { canonicoStatus: 0, deletedAt: 0, outrasComparacoes: [] }]));
  const mesmoConjunto = (lits: string[]): boolean => lits.length === autoridade.size && lits.every((l) => autoridade.has(l)) && new Set(lits).size === lits.length;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t !== 'status' && t !== 'deleted_at') continue;
    // `coalesce(so.status, '')` — o alias está DENTRO do coalesce: é comparação outra, e reprova
    const q = qualificador(toks, i);
    for (const alias of aliases) {
      if (!casaAlias(q, alias)) continue;
      const c = m.get(alias)!;
      if (t === 'deleted_at') {
        if (toks[i + 1] === 'is' && toks[i + 2] === 'null') c.deletedAt++;
        continue;
      }
      const dentroDeCoalesce = toks[i - (q ? 3 : 1)] === '(' && toks[i - (q ? 4 : 2)] === 'coalesce';
      const op = toks[i + 1];
      if (!dentroDeCoalesce && op === 'not' && toks[i + 2] === 'in') {
        const l = literaisDaLista(toks, i + 3);
        if (l && mesmoConjunto(l.lits)) { c.canonicoStatus++; continue; }
      }
      if (!dentroDeCoalesce && op === '<>' && toks[i + 2] === 'all') {
        const l = literaisDaLista(toks, i + 3);
        if (l && mesmoConjunto(l.lits)) { c.canonicoStatus++; continue; }
      }
      if (['not', 'in', '<>', '!=', '=', 'is'].includes(op ?? '') || dentroDeCoalesce) {
        c.outrasComparacoes.push(`${q ? q + '.' : ''}status ${toks.slice(i + 1, i + 4).join(' ')}`);
      }
    }
  }
  return m;
}

/** Os motivos por ALIAS de leitura (todo alias que lê sales_orders aparece, mesmo sem motivo). */
function motivosPorAlias(def: Definicao, autoridade: ReadonlySet<string>): Map<string, string[]> {
  const porAlias = new Map<string, number>();
  for (const l of leiturasDeSalesOrders(def.tokens)) porAlias.set(l.alias, (porAlias.get(l.alias) ?? 0) + 1);
  const contagem = predicadosPorAlias(def.tokens, [...porAlias.keys()], autoridade);
  const saida = new Map<string, string[]>();
  for (const [alias, n] of porAlias) {
    const c = contagem.get(alias)!;
    const rotulo = alias || '(sem alias)';
    const m: string[] = [];
    if (c.canonicoStatus < n) m.push(`${n} leitura(s) de sales_orders com alias ${rotulo}, ${c.canonicoStatus} com a denylist canônica de status`);
    if (c.deletedAt < n) m.push(`${n} leitura(s) de sales_orders com alias ${rotulo}, ${c.deletedAt} com deleted_at IS NULL`);
    if (c.outrasComparacoes.length) m.push(`outra comparação de status no alias ${rotulo}: ${c.outrasComparacoes.join(' | ')}`);
    saida.set(alias, m);
  }
  return saida;
}

/** O julgamento de UMA definição: [] se canônica, senão os motivos. */
export function julgarDefinicao(def: Definicao, autoridade: ReadonlySet<string>): string[] {
  return [...motivosPorAlias(def, autoridade).values()].flat();
}

export function julgar(
  modelo: ReadonlyMap<string, Definicao>,
  registro: Readonly<Record<string, EntradaRegistro>>,
  autoridade: ReadonlySet<string>,
): { violacoes: Violacao[]; leitores: string[] } {
  const violacoes: Violacao[] = [];
  const leitores: string[] = [];
  for (const [objeto, def] of modelo) {
    const porAlias = motivosPorAlias(def, autoridade);
    if (porAlias.size === 0) continue;
    leitores.push(objeto);
    const reg = registro[objeto];
    const v = (motivo: string) => violacoes.push({ objeto, migration: def.migration, motivo });
    if (reg && !reg.aliases) {
      if ([...porAlias.values()].every((m) => m.length === 0)) {
        v(`registrado como '${reg.tipo}' mas a definição viva é CANÔNICA — tire do registro (a lista só encolhe)`);
      }
      continue;
    }
    // Isenção por ALIAS: só aquelas leituras saem do julgamento; as outras do MESMO objeto seguem
    // julgadas (o sensor de gêmeos lê canônico no alias principal e busca o gêmeo por identidade).
    const isentos = new Set(reg?.aliases ?? []);
    for (const a of isentos) {
      if (!porAlias.has(a)) v(`alias '${a}' registrado como '${reg!.tipo}' não lê mais sales_orders — registro órfão`);
      else if (porAlias.get(a)!.length === 0) v(`alias '${a}' registrado como '${reg!.tipo}' mas é CANÔNICO — tire do registro (a lista só encolhe)`);
    }
    for (const [a, motivos] of porAlias) if (!isentos.has(a)) for (const m of motivos) v(m);
  }
  for (const objeto of Object.keys(registro)) {
    if (!leitores.includes(objeto)) {
      violacoes.push({ objeto, migration: '-', motivo: 'registro órfão: o objeto não existe nas migrations ou deixou de ler sales_orders' });
    }
  }
  return { violacoes, leitores: leitores.sort() };
}

/** A autoridade, lida do TS: os literais do array STATUS_NAO_VENDA. */
export function lerAutoridade(fonteTs: string): Set<string> {
  const m = /export const STATUS_NAO_VENDA\b[^=]*=\s*\[([\s\S]*?)\]/.exec(fonteTs);
  if (!m) throw new Error('autoridade ilegível: STATUS_NAO_VENDA não encontrado');
  const lits = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (lits.length === 0) throw new Error('autoridade ilegível: STATUS_NAO_VENDA vazio');
  return new Set(lits);
}
