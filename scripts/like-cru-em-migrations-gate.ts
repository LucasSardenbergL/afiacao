#!/usr/bin/env bun
/**
 * like-cru-em-migrations-gate.ts — fiscal da classe `pattern-like-cru` na camada SQL: pattern de
 * LIKE/ILIKE montado com um valor que devia casar LITERAL, sem escapar os curingas. Não executa SQL.
 *
 *   bun scripts/like-cru-em-migrations-gate.ts          # o repo (pisos, baseline, corpos vivos)
 *   bun scripts/like-cru-em-migrations-gate.ts <dir…>   # corpo arbitrário (sem piso nem baseline — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (piso de denominador furado,
 * literal ou dollar-quote que não fecha, stripper desabando). 2 NUNCA é "passou".
 * Roda no CI pelo vitest (`like-cru-em-migrations-gate.test.ts`); as mutações que provam o dente de
 * cada camada estão em `scripts/mutcheck.d/like-cru-em-migrations.mut`.
 *
 * ## A classe (docs/historico/like-cru-camada-sql.md · docs/agent/database.md §5)
 *
 * O pattern de LIKE/ILIKE é INTERPRETADO: `%` e `_` do termo viram curinga, `\` vira escape, e o termo
 * vazio vira `%%`, que casa tudo. Com o valor vindo de parâmetro ou de coluna que devia casar literal
 * (código de fornecedor, termo de busca, texto-alvo de tarefa), `AB_12` casa `AB-12` e o termo `%`
 * devolve a tabela. A camada supabase-js de src/ tem o ESLint (`no-restricted-syntax`, #2627); esta
 * é a das funções SQL, que o semgrep não lê e o ESLint não vê.
 *
 * ## O que passa
 *
 *   · pattern CONSTANTE — literal, ou literais concatenados (`LIKE 'margem!_faixa!_%' ESCAPE '!'`);
 *   · `[NOT] [I]LIKE private.padrao_like_contem(<termo>) ESCAPE '\'` — o helper escapa `\ % _` e
 *     devolve NULL no termo sem conteúdo útil (o espelho SQL do ilikeContainsPattern de
 *     src/lib/postgrest.ts). Sem o `ESCAPE '\'` explícito, reprova: é a marca do idioma.
 * Todo o resto com valor do lado direito reprova: concatenação, variável/coluna/parâmetro nus,
 * chamada de outra função, `LIKE ANY/ALL` de array não-constante, o operador `~~`/`~~*` (não tem
 * cláusula ESCAPE) e `SIMILAR TO` (tem mais metacaracteres que o helper escapa).
 *
 * ## A leitura — o lexer COMPARTILHADO, não regex local
 *
 * `tokensSql` (scripts/lib/deriva-corpo.ts) segue o scan.l do PG17: comentário sai, literal é um token
 * OPACO (um `LIKE` dentro de `'…'` é texto, não operador — o rótulo do _data_health_compute), e o
 * operador é UM token (`~~*`). O dollar-quote também é opaco lá, e aqui é RE-TOKENIZADO por dentro:
 * é o corpo das funções e dos blocos DO. O operando da direita é lido como o parser o lê — uma cadeia
 * de operandos ligados por operador que não é de comparação (o `||` liga mais forte que o LIKE).
 * `CREATE TABLE t (LIKE outra …)` não é o operador (não tem operando à esquerda) e fica de fora.
 *
 * ## Os universos
 *
 *   · o TEXTO de toda migration: cada ocorrência reprova, salvo a baseline EXATA das definições que
 *     o repo não pode reescrever (migration é imutável) — só encolhe: sítio novo reprova, entrada
 *     que sumiu do texto reprova;
 *   · os corpos VIVOS de função (a última definição de cada identidade, `modelarRepo`): nenhum pode
 *     ter a classe, salvo a allowlist com ÂNCORA — o falso-positivo validado, cuja validação a
 *     montante tem de continuar no corpo. É o que mantém mortas as definições da baseline: apagar a
 *     migration que as supera faz o corpo antigo voltar a ser o vivo, e o universo acusa.
 *
 * ## LIMITES DECLARADOS (quem pega é a varredura da prod por psql-ro — a query do §5 do database.md)
 *   · o que só existe na PROD — função criada pelo SQL Editor, sem CREATE no repo: listar_skus e os
 *     dois expandir_promocao_item viveram assim até 20260929000234;
 *   · SQL montado em string: `EXECUTE 'SELECT … ILIKE ' || …` (dentro de literal) — o dinâmico em
 *     dollar-quote é lido;
 *   · corpo vivo em schema que não é `public` (o `modelarRepo` só modela `public`); o texto de toda
 *     migration, de qualquer schema, é lido;
 *   · o pattern montado ANTES, numa variável (`v_pat := '%' || p || '%'`): reprova no LIKE como
 *     `valor`, mas a baseline guarda o trecho do LIKE, não o da montagem.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type { MigrationLida } from './lib/corpo-esperado';
import { modelarRepoPassos, tokensSql } from './lib/deriva-corpo';
import { drenar, type Passos } from '@/lib/gates/passos';
import { maiorBlocoDescartadoSql } from './lib/sql-comentarios';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como nos irmãos. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

export const PISOS = {
  /** Migrations lidas — zero é leitura quebrada, nunca "repo sem DDL". Eram 743 em 2026-09-29. */
  migrations: 700,
  /** Corpos vivos de função — o denominador do 2º universo. Eram 316. */
  corposVivos: 290,
  /** Operadores LIKE/ILIKE/~~/SIMILAR TO lidos no texto: abrir arquivo não é ler operador. Eram 404. */
  operadores: 300,
} as const;

/**
 * Teto do maior bloco CONTÍGUO que o stripper compartilhado descarta num arquivo — o sentinela
 * herdado dos irmãos (gates-textuais-cegos.md). Acima dele o stripper provavelmente comeu código.
 * Medido em 2026-09-27: 175 linhas `--` seguidas é o maior comentário de verdade das migrations.
 */
export const TETO_BLOCO_DESCARTADO = 200;

export type Motivo =
  | 'concatenação'
  | 'valor'
  | 'helper sem ESCAPE'
  | 'operador sem ESCAPE'
  | 'SIMILAR TO'
  | 'ANY/ALL';

export interface Sitio {
  arquivo: string;
  /** Onde o operador está: `função <nome>`, `bloco DO`, ou o texto solto do arquivo. */
  contexto: string;
  /** Operador + operando como o lexer os lê (identificador em minúscula, literal verbatim). */
  trecho: string;
  motivo: Motivo;
}

export interface SitioConhecido {
  arquivo: string;
  trecho: string;
  /** Quantas vezes o trecho aparece no arquivo. Muda para MAIS = sítio novo; para MENOS = quitou. */
  n: number;
  motivo: string;
}

export interface VivoPermitido {
  /** `nome(tipos)` como o `modelarRepo` a identifica. */
  identidade: string;
  trecho: string;
  /** SQL cujos tokens têm de aparecer, nesta ordem e contíguos, no corpo vivo. */
  ancora: string;
  motivo: string;
}

const SUPERA = 'superada por 20260929000234_padrao_like_contem_escapa_curinga.sql';
const RADAR_CONTAGEM = 'radar_contagem_por_municipio: p_cnae_prefix validado por ^[0-9]{1,7}$ antes do LIKE';
const ALERTA = 'reposicao_alerta_pedido_minimo_tick: v_fornecedor é o valor da chave _ilike de company_config, pattern por CONTRATO';

/**
 * As definições que as migrations guardam para sempre (varredura de 2026-09-29): 16 trechos, 22
 * ocorrências. Nenhuma é a definição viva, salvo as 3 de VIVOS_PERMITIDOS; o 2º universo garante isso.
 */
export const CONHECIDOS: readonly SitioConhecido[] = [
  {
    arquivo: 'supabase/migrations/20260207004220_c9da3993-80f4-4203-b569-142d24c5c814.sql',
    trecho: "like '%' || replace ( replace ( tool_category_name , '_' , '%' ) , 'facas' , 'faca' ) || '%'", n: 1,
    motivo: 'update_user_tools_on_order_complete: 1ª definição do arquivo; a 2ª, sem LIKE, é a de prod (md5 bd068898…)',
  },
  {
    arquivo: 'supabase/migrations/20260207004220_c9da3993-80f4-4203-b569-142d24c5c814.sql',
    trecho: "like '%' || replace ( tool_category_name , '_' , ' ' ) || '%'", n: 1,
    motivo: 'update_user_tools_on_order_complete: 1ª definição do arquivo; a 2ª, sem LIKE, é a de prod',
  },
  {
    arquivo: 'supabase/migrations/20260513005653_ef077490-1563-4287-b6bb-a48d3aadf780.sql',
    trecho: "ilike '%' || p_codigo_fornecedor || '%'", n: 3,
    motivo: `resolver_sku_por_codigo_fornecedor — ${SUPERA}`,
  },
  {
    arquivo: 'supabase/migrations/20260528133000_tarefas_bloco_d.sql',
    trecho: "ilike '%' || t . target_texto || '%'", n: 1,
    motivo: `tarefas_matcher_tick — ${SUPERA}`,
  },
  {
    arquivo: 'supabase/migrations/20260528135000_tarefas_matcher_created_at_floor.sql',
    trecho: "ilike '%' || t . target_texto || '%'", n: 1,
    motivo: `tarefas_matcher_tick — ${SUPERA}`,
  },
  {
    arquivo: 'supabase/migrations/20260609150000_reposicao_alerta_pedido_minimo.sql',
    trecho: 'ilike v_fornecedor', n: 1,
    motivo: `${ALERTA} (definição antiga; a viva é a 20260615210000)`,
  },
  {
    arquivo: 'supabase/migrations/20260610130000_melhorias_canal.sql',
    trecho: "ilike '%' || trim ( p_termo ) || '%'", n: 4,
    motivo: `melhoria_clientes_por_produto e melhoria_produtos_relacionados, 2 cada — ${SUPERA}`,
  },
  {
    arquivo: 'supabase/migrations/20260610150000_reposicao_auto_aprovacao_piloto.sql',
    trecho: 'ilike v_fornecedor', n: 1,
    motivo: `${ALERTA} (definição antiga)`,
  },
  {
    arquivo: 'supabase/migrations/20260611120000_reposicao_fixes_codex_711.sql',
    trecho: 'ilike v_fornecedor', n: 1,
    motivo: `${ALERTA} (definição antiga)`,
  },
  {
    arquivo: 'supabase/migrations/20260611140000_kb_fundacao_casamento.sql',
    trecho: "like '%' || replace ( replace ( replace ( upper ( t ) , '\\' , '\\\\' ) , '%' , '\\%' ) , '_' , '\\_' ) || '%' escape '\\'", n: 1,
    motivo: `buscar_skus_candidatos: escapava o curinga, mas o termo vazio virava %% (match-all) — ${SUPERA}`,
  },
  {
    arquivo: 'supabase/migrations/20260613190000_radar_fatia3.sql',
    trecho: "like '%CNPJ ' || p_cnpj || '%'", n: 1,
    motivo: 'radar_atribuir_tarefa: definição antiga (a viva é a 20260929001651, em VIVOS_PERMITIDOS)',
  },
  {
    arquivo: 'supabase/migrations/20260613190000_radar_fatia3.sql',
    trecho: "like p_cnae_prefix || '%'", n: 1,
    motivo: `${RADAR_CONTAGEM} (definição antiga)`,
  },
  {
    arquivo: 'supabase/migrations/20260614140000_radar_contagem_perf.sql',
    trecho: "like p_cnae_prefix || '%'", n: 1,
    motivo: `${RADAR_CONTAGEM} (a definição viva, em VIVOS_PERMITIDOS)`,
  },
  {
    arquivo: 'supabase/migrations/20260615194500_fix_tarefas_matcher_enum.sql',
    trecho: "ilike '%' || t . target_texto || '%'", n: 1,
    motivo: `tarefas_matcher_tick, a que a prod rodava até 2026-09-28 — ${SUPERA}`,
  },
  {
    arquivo: 'supabase/migrations/20260615210000_reposicao_auto_aprovacao_v2.sql',
    trecho: 'ilike v_fornecedor', n: 1,
    motivo: `${ALERTA} (a definição viva, em VIVOS_PERMITIDOS)`,
  },
  {
    arquivo: 'supabase/migrations/20260905225613_preco_ausente_nao_e_zero.sql',
    trecho: "ilike '%' || trim ( p_termo ) || '%'", n: 2,
    motivo: `melhoria_clientes_por_produto, a que a prod rodava até 2026-09-28 — ${SUPERA}`,
  },
  {
    arquivo: 'supabase/migrations/20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql',
    trecho: "like '%CNPJ ' || p_cnpj || '%'", n: 1,
    motivo: 'radar_atribuir_tarefa: a definição viva (a 20260929001651 só troca o hoje da sessão pelo de SP), '
      + 'em VIVOS_PERMITIDOS (p_cnpj validado por ^[0-9]{14}$)',
  },
];

/** Falso-positivo VIVO: a validação a montante que o torna seguro tem de continuar no corpo. */
export const VIVOS_PERMITIDOS: readonly VivoPermitido[] = [
  {
    identidade: 'radar_atribuir_tarefa(text,integer)',
    trecho: "like '%CNPJ ' || p_cnpj || '%'",
    ancora: "p_cnpj !~ '^[0-9]{14}$'",
    motivo: 'o LIKE é o dedupe da tarefa por CNPJ, e p_cnpj passa por ^[0-9]{14}$ (RAISE) antes — não chega curinga',
  },
  {
    identidade: 'radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)',
    trecho: "like p_cnae_prefix || '%'",
    ancora: "p_cnae_prefix !~ '^[0-9]{1,7}$'",
    motivo: 'prefixo de CNAE: p_cnae_prefix passa por ^[0-9]{1,7}$ (RAISE) antes — só dígito, e o vazio também cai',
  },
  {
    identidade: 'reposicao_alerta_pedido_minimo_tick()',
    trecho: 'ilike v_fornecedor',
    ancora: "key = 'reposicao_alerta_pedido_fornecedor_ilike'",
    motivo: 'o valor da chave _ilike é um PATTERN por contrato (%SAYERLACK% em prod), escrito só por master',
  },
];

// ── o lexer compartilhado, e as formas de token que ele devolve ────────────────────────────────
const TAG_DOLLAR = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z_0-9\u0080-\uffff]*)?\$/;
const ehDollar = (t: string) => TAG_DOLLAR.test(t);
const ehLiteral = (t: string) => /^(?:[EBXN]|U&)?'/.test(t);
const ehMarcaConcat = (t: string) => t === '\u2424concat' || t === '\u2423adjacente';
const ehIdent = (t: string | undefined) => t !== undefined && (/^[a-z_\u0080-\uffff][a-z0-9_$\u0080-\uffff]*$/.test(t) || /^(?:U&)?"/.test(t));
const ehNumero = (t: string) => /^(?:[0-9]|\.[0-9])/.test(t);
const ehOperador = (t: string | undefined) => t !== undefined && /^[~!@#^&|`?+\-*/%<>=]+$/.test(t);
/** Comparação liga MAIS FRACO que o LIKE: termina o operando da direita. */
const COMPARACAO = new Set(['=', '<>', '!=', '<', '>', '<=', '>=']);
/** Palavras que seguem um tipo de várias palavras depois de `::` (character varying, timestamp with time zone…). */
const CONT_TIPO = new Set(['varying', 'precision', 'with', 'without', 'time', 'zone']);
/** O que pode aparecer num array/argumento CONSTANTE, além de literal e número. */
const NEUTRO_CONSTANTE = new Set([',', '(', ')', '[', ']', '::', 'array', 'text', 'varchar', 'character', 'varying']);

function fechar(t: readonly string[], i: number, abre: string, fecha: string): number {
  let prof = 0;
  for (let k = i; k < t.length; k++) {
    if (t[k] === abre) prof++;
    else if (t[k] === fecha && --prof === 0) return k;
  }
  return t.length - 1;
}

function fecharCase(t: readonly string[], i: number): number {
  let prof = 0;
  for (let k = i; k < t.length; k++) {
    if (t[k] === 'case') prof++;
    else if (t[k] === 'end' && --prof === 0) return k + 1;
  }
  return t.length;
}

const todosConstantes = (t: readonly string[]) =>
  t.every((x) => ehLiteral(x) || ehMarcaConcat(x) || ehNumero(x) || NEUTRO_CONSTANTE.has(x));

function pularTipo(t: readonly string[], i: number): number {
  let k = i;
  if (ehIdent(t[k])) k++;
  while (t[k] === '.' && ehIdent(t[k + 1])) k += 2;
  while (CONT_TIPO.has(t[k] ?? '')) k++;
  if (t[k] === '(') k = fechar(t, k, '(', ')') + 1;
  while (t[k] === '[' && t[k + 1] === ']') k += 2;
  return k;
}

type Tipo = 'literal' | 'helper' | 'valor';

/**
 * Um operando: o que vem até o próximo operador binário (casts e subscritos incluídos). `concat` diz se
 * há `||` DENTRO dele (um grupo) — `('%' || p || '%')` é concatenação, não valor opaco.
 */
function lerOperando(t: readonly string[], i: number): { fim: number; tipo: Tipo; concat: boolean } {
  let k = i;
  let tipo: Tipo;
  let concat = false;
  const x = t[k];
  if (x === undefined) return { fim: k, tipo: 'valor', concat };
  if (x === '+' || x === '-') return lerOperando(t, k + 1);
  if (ehLiteral(x) || ehDollar(x) || ehNumero(x)) {
    k++;
    while (ehMarcaConcat(t[k] ?? '') && t[k + 1] !== undefined && ehLiteral(t[k + 1])) k += 2;
    tipo = 'literal';
  } else if (x === '(') {
    const f = fechar(t, k, '(', ')');
    const dentro = classificarCadeia(t.slice(k + 1, f), 0);
    tipo = dentro.completa ? dentro.tipo : 'valor';
    concat = dentro.concat;
    k = f + 1;
  } else if (x === 'array' && t[k + 1] === '[') {
    const f = fechar(t, k + 1, '[', ']');
    tipo = todosConstantes(t.slice(k + 2, f)) ? 'literal' : 'valor';
    k = f + 1;
  } else if (x === 'case') {
    k = fecharCase(t, k);
    tipo = 'valor';
  } else if (ehIdent(x)) {
    const nome = [x];
    k++;
    while (t[k] === '.' && ehIdent(t[k + 1])) {
      nome.push(t[k + 1]);
      k += 2;
    }
    if (t[k] === '(') {
      const f = fechar(t, k, '(', ')');
      if (nome.join('.') === 'private.padrao_like_contem') tipo = 'helper';
      else tipo = todosConstantes(t.slice(k + 1, f)) ? 'literal' : 'valor';
      k = f + 1;
    } else {
      tipo = 'valor';
    }
    while (t[k] === '[') {
      k = fechar(t, k, '[', ']') + 1;
      tipo = 'valor';
    }
  } else {
    return { fim: k + 1, tipo: 'valor', concat };
  }
  while (t[k] === '::') k = pularTipo(t, k + 1);
  return { fim: k, tipo, concat };
}

/** O operando da direita inteiro: operando (operador-não-de-comparação operando)*. */
function classificarCadeia(t: readonly string[], i: number): { fim: number; tipo: Tipo; concat: boolean; completa: boolean } {
  const tipos: Tipo[] = [];
  let concat = false;
  let r = lerOperando(t, i);
  tipos.push(r.tipo);
  if (r.concat) concat = true;
  let k = r.fim;
  while (ehOperador(t[k]) && !COMPARACAO.has(t[k])) {
    if (t[k] === '||') concat = true;
    r = lerOperando(t, k + 1);
    tipos.push(r.tipo);
    if (r.concat) concat = true;
    k = r.fim;
  }
  const tipo: Tipo = tipos.every((x) => x === 'literal') ? 'literal' : tipos.length === 1 && tipos[0] === 'helper' ? 'helper' : 'valor';
  return { fim: k, tipo, concat, completa: k >= t.length };
}

/** `função <schema.nome>` quando o dollar-quote em `i` é corpo de função; `bloco DO`; ou null. */
function contextoDoDollar(t: readonly string[], i: number): string | null {
  if (t[i - 1] === 'do') return 'bloco DO';
  for (let k = i - 1; k >= 0 && k >= i - 600; k--) {
    if (t[k] === ';') return null;
    if (t[k] === 'function' || t[k] === 'procedure') {
      const partes = [t[k + 1]];
      if (t[k + 2] === '.' && t[k + 3] !== undefined) partes.push(t[k + 3]);
      return `função ${partes.join('.')}`;
    }
  }
  return null;
}

export interface Leitura {
  sitios: Sitio[];
  /** Operadores LIKE/ILIKE/~~/SIMILAR TO lidos — o denominador do "leu de verdade". */
  operadores: number;
  alarmes: string[];
}

function lerTokens(t: readonly string[], arquivo: string, contexto: string, acc: Leitura): void {
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (ehDollar(x)) {
      const tag = x.match(TAG_DOLLAR)![0];
      if (x.length < 2 * tag.length || !x.endsWith(tag)) {
        acc.alarmes.push(`${arquivo}: dollar-quote ${tag} que não fecha — o resto do arquivo não foi lido como código`);
        continue;
      }
      lerTokens(tokensSql(x.slice(tag.length, x.length - tag.length)), arquivo, contextoDoDollar(t, i) ?? contexto, acc);
      continue;
    }
    if (ehLiteral(x) && (x.length < 2 || !x.endsWith("'") || /^(?:[EBXN]|U&)?'$/.test(x))) {
      acc.alarmes.push(`${arquivo}: literal que não fecha — o resto do arquivo foi lido como texto`);
      continue;
    }
    let op = '';
    let j = i + 1;
    if (x === 'like' || x === 'ilike') op = x;
    else if (x === 'similar' && t[i + 1] === 'to') {
      op = 'similar to';
      j = i + 2;
    } else if (/^!?~~\*?$/.test(x)) op = x;
    if (!op) continue;
    const antes = t[i - 1] === 'not' ? t[i - 2] : t[i - 1];
    if (op === 'like' && (antes === '(' || antes === ',')) continue; // CREATE TABLE t (LIKE outra …)
    acc.operadores++;
    let motivo: Motivo | null = null;
    let fim: number;
    if ((t[j] === 'any' || t[j] === 'all' || t[j] === 'some') && t[j + 1] === '(') {
      const f = fechar(t, j + 1, '(', ')');
      fim = f + 1;
      if (!todosConstantes(t.slice(j + 2, f))) motivo = 'ANY/ALL';
    } else {
      const c = classificarCadeia(t, j);
      fim = c.fim;
      if (c.tipo === 'literal') motivo = null;
      else if (op === 'similar to') motivo = 'SIMILAR TO';
      else if (op.includes('~~')) motivo = 'operador sem ESCAPE';
      else if (c.tipo === 'helper') motivo = t[fim] === 'escape' && t[fim + 1] === "'\\'" ? null : 'helper sem ESCAPE';
      else motivo = c.concat ? 'concatenação' : 'valor';
    }
    if (motivo === null) continue;
    if (t[fim] === 'escape' && t[fim + 1] !== undefined) fim += 2;
    acc.sitios.push({ arquivo, contexto, trecho: [op, ...t.slice(j, fim)].join(' '), motivo });
  }
}

/**
 * Memo por (texto, arquivo, contexto). A leitura é função pura dos três, e o teste re-analisa as
 * mesmas ~740 migrations em ~9 cenários — o mutcheck repete a suíte a cada mutação, e sem o memo o
 * contrato deste gate era o maior acréscimo ao teto do job `mutation-check` (2–4 min, 2026-09-30).
 * O texto é a chave de fora (o V8 guarda o hash na própria string, que é a mesma entre chamadas);
 * arquivo+contexto, a de dentro: o mesmo SQL com outro caminho gera sítios com outro `arquivo`.
 * Quem recebe a Leitura só a LÊ (analisar copia os sítios para a própria lista).
 */
const memo = new Map<string, Map<string, Leitura>>();

/** Os sítios num texto SQL (migration, corpo de função ou fixture). */
export function lerSql(arquivo: string, sql: string, contexto = 'texto'): Leitura {
  let porTexto = memo.get(sql);
  if (porTexto === undefined) {
    porTexto = new Map();
    memo.set(sql, porTexto);
  }
  const chave = `${arquivo}\u0000${contexto}`;
  const pronta = porTexto.get(chave);
  if (pronta !== undefined) return pronta;
  const acc: Leitura = { sitios: [], operadores: 0, alarmes: [] };
  lerTokens(tokensSql(sql), arquivo, contexto, acc);
  porTexto.set(chave, acc);
  return acc;
}

/** Os tokens da âncora aparecem, contíguos e nesta ordem, no corpo? */
export function temAncora(corpo: string, ancora: string): boolean {
  const c = tokensSql(corpo);
  const a = tokensSql(ancora);
  if (a.length === 0) return false;
  for (let i = 0; i + a.length <= c.length; i++) if (a.every((x, k) => c[i + k] === x)) return true;
  return false;
}

export interface Arquivo {
  /** Caminho relativo à raiz, com `/` — é a chave da baseline. */
  caminho: string;
  fonte: string;
}

export interface Analise {
  arquivos: number;
  migrations: number;
  corposVivos: number;
  operadores: number;
  violacoes: Sitio[];
  /** Por `arquivo · trecho`, quantas vezes cada sítio apareceu — o que se confronta com a baseline. */
  contagem: Map<string, number>;
  /** Corpos vivos com a classe que a allowlist não cobre: `nome(tipos) — trecho (motivo)`. */
  corposVivosComSitio: string[];
  /** Allowlist cuja âncora sumiu do corpo, ou cujo sítio sumiu (ou a função). */
  permitidosInvalidos: string[];
  alarmes: string[];
}

/** O sentinela do stripper é função pura do texto: memo pelo mesmo motivo do `lerSql`. */
const memoBloco = new Map<string, number>();
function blocoDescartado(fonte: string): number {
  let n = memoBloco.get(fonte);
  if (n === undefined) {
    n = maiorBlocoDescartadoSql(fonte);
    memoBloco.set(fonte, n);
  }
  return n;
}

export function analisar(
  arquivos: readonly Arquivo[],
  corpos: ReadonlyMap<string, string> = new Map(),
  permitidos: readonly VivoPermitido[] = [],
): Analise {
  return drenar(analisarPassos(arquivos, corpos, permitidos));
}

/** A análise como gerador (`@/lib/gates/passos`): `yield` por arquivo e por corpo vivo — o teste
 *  que varre o repo inteiro drena cedendo o event loop do worker do vitest (o RPC estoura com >60s
 *  de bloqueio: docs/historico/rpc-do-vitest-e-o-loop-preso.md). */
export function* analisarPassos(
  arquivos: readonly Arquivo[],
  corpos: ReadonlyMap<string, string> = new Map(),
  permitidos: readonly VivoPermitido[] = [],
): Passos<Analise> {
  const r: Analise = {
    arquivos: arquivos.length, migrations: 0, corposVivos: corpos.size, operadores: 0,
    violacoes: [], contagem: new Map(), corposVivosComSitio: [], permitidosInvalidos: [], alarmes: [],
  };
  for (const a of arquivos) {
    if (a.caminho.startsWith('supabase/migrations/')) r.migrations++;
    const bloco = blocoDescartado(a.fonte);
    if (bloco > TETO_BLOCO_DESCARTADO) {
      r.alarmes.push(`${a.caminho}: o stripper descartou ${bloco} linhas seguidas (teto ${TETO_BLOCO_DESCARTADO}) — comeu código?`);
    }
    const l = lerSql(a.caminho, a.fonte);
    r.operadores += l.operadores;
    r.alarmes.push(...l.alarmes);
    for (const s of l.sitios) {
      r.violacoes.push(s);
      const k = `${s.arquivo} · ${s.trecho}`;
      r.contagem.set(k, (r.contagem.get(k) ?? 0) + 1);
    }
    yield;
  }
  const vistos = new Set<string>();
  for (const [alvo, corpo] of corpos) {
    const l = lerSql(alvo, corpo, 'corpo vivo');
    r.alarmes.push(...l.alarmes);
    for (const s of l.sitios) {
      const p = permitidos.find((x) => x.identidade === alvo && x.trecho === s.trecho);
      if (p === undefined) {
        r.corposVivosComSitio.push(`${alvo} — ${s.trecho} (${s.motivo})`);
      } else if (!temAncora(corpo, p.ancora)) {
        r.permitidosInvalidos.push(`${alvo}: a âncora [${p.ancora}] sumiu do corpo — o LIKE [${s.trecho}] perdeu a validação que o tornava seguro`);
      } else {
        vistos.add(`${p.identidade} · ${p.trecho}`);
      }
    }
    yield;
  }
  if (corpos.size > 0) {
    for (const p of permitidos) {
      if (!vistos.has(`${p.identidade} · ${p.trecho}`) && !r.permitidosInvalidos.some((x) => x.startsWith(`${p.identidade}:`))) {
        r.permitidosInvalidos.push(`${p.identidade}: o sítio [${p.trecho}] não está mais no corpo vivo — QUITADO (tire de VIVOS_PERMITIDOS)`);
      }
    }
  }
  return r;
}

/** Diferença entre o que a varredura achou e a baseline: o que é NOVO e o que foi QUITADO. */
export function confrontar(contagem: ReadonlyMap<string, number>, conhecidos: readonly SitioConhecido[]) {
  const esperado = new Map(conhecidos.map((c) => [`${c.arquivo} · ${c.trecho}`, c.n]));
  const novos: string[] = [];
  const quitados: string[] = [];
  for (const [k, n] of contagem) if ((esperado.get(k) ?? 0) < n) novos.push(`${k} (${n}× no texto, baseline ${esperado.get(k) ?? 0})`);
  for (const [k, n] of esperado) if ((contagem.get(k) ?? 0) < n) quitados.push(`${k} (baseline ${n}, texto ${contagem.get(k) ?? 0})`);
  return { novos, quitados };
}

export function veredito(r: Analise, comPisos: boolean): { codigo: 0 | 1 | 2; linhas: string[] } {
  const furos = r.alarmes.map((a) => `leitura — ${a}`);
  if (r.arquivos === 0) furos.push('nenhum arquivo lido');
  if (comPisos) {
    if (r.migrations < PISOS.migrations) furos.push(`${r.migrations} migration(s) lida(s) < piso ${PISOS.migrations}`);
    if (r.corposVivos < PISOS.corposVivos) furos.push(`${r.corposVivos} corpo(s) vivo(s) < piso ${PISOS.corposVivos}`);
    if (r.operadores < PISOS.operadores) furos.push(`${r.operadores} operador(es) LIKE lido(s) < piso ${PISOS.operadores} — abriu arquivo, mas não leu operador?`);
  }
  if (furos.length > 0) {
    return { codigo: 2, linhas: ['❌ INDETERMINADO — o fiscal não conseguiu medir (isto NÃO é "limpo"):', ...furos.map((f) => `  · ${f}`)] };
  }
  // Com baseline, só o que ela não conhece reprova; sem ela (fixture), todo sítio reprova.
  const { novos, quitados } = comPisos
    ? confrontar(r.contagem, CONHECIDOS)
    : { novos: r.violacoes.map((s) => `${s.arquivo} · ${s.trecho} [${s.contexto}] (${s.motivo})`), quitados: [] };
  if (novos.length + quitados.length + r.corposVivosComSitio.length + r.permitidosInvalidos.length > 0) {
    const onde = (n: string) => {
      const v = r.violacoes.find((s) => n.startsWith(`${s.arquivo} · ${s.trecho}`));
      return v ? `  [${v.contexto}] (${v.motivo})` : '';
    };
    return {
      codigo: 1,
      linhas: [
        '❌ pattern de LIKE montado com valor, sem o idioma que escapa o curinga:',
        ...novos.map((n) => `  NOVO ${n}${comPisos ? onde(n) : ''}`),
        ...quitados.map((q) => `  QUITADO (tire da baseline CONHECIDOS) ${q}`),
        ...r.corposVivosComSitio.map((c) => `  CORPO VIVO ${c}`),
        ...r.permitidosInvalidos.map((p) => `  PERMITIDO ${p}`),
        '',
        '  `%`, `_` e `\\` do termo viram curinga/escape, e o termo vazio vira %% (casa tudo).',
        "  Conserto: <col> ILIKE private.padrao_like_contem(<termo>) ESCAPE '\\' — o pattern de \"contém\"",
        '  escapado, ou NULL (não casa nada) quando o termo não tem conteúdo útil.',
        '  Pattern CONSTANTE (literal) passa. Valor que é pattern POR CONTRATO, ou validado a montante,',
        '  entra em VIVOS_PERMITIDOS com a âncora que o prova.',
        '  docs/historico/like-cru-camada-sql.md · docs/agent/database.md §5',
      ],
    };
  }
  const censo = comPisos
    ? ` (${r.migrations} migrations com ${r.operadores} operadores LIKE, ${r.corposVivos} corpos vivos; ${CONHECIDOS.length} sítios mortos conhecidos, ${VIVOS_PERMITIDOS.length} vivos permitidos com âncora)`
    : ` (${r.arquivos} arquivo(s), ${r.operadores} operador(es))`;
  return { codigo: 0, linhas: [`✅ pattern de LIKE em migrations${censo}: nenhum montado com valor fora do idioma.`] };
}

function andar(dir: string, ok: (p: string) => boolean, acc: string[] = []): string[] {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) andar(p, ok, acc);
    else if (ok(p)) acc.push(p);
  }
  return acc;
}

const ler = (base: string, p: string): Arquivo => ({ caminho: relative(base, p).split('\\').join('/'), fonte: readFileSync(p, 'utf8') });

/** A última definição viva de cada função `public` que as migrations dão ("a última a recriar vence"). */
export function corposVivosDe(arquivos: readonly Arquivo[]): Map<string, string> {
  return drenar(corposVivosDePassos(arquivos));
}

/** O fold do repo como gerador: as cessões são as do `modelarRepoPassos`, uma por migration. */
export function* corposVivosDePassos(arquivos: readonly Arquivo[]): Passos<Map<string, string>> {
  const lidas: MigrationLida[] = arquivos
    .filter((a) => a.caminho.startsWith('supabase/migrations/'))
    .map((a) => ({ nome: a.caminho.split('/').pop() ?? a.caminho, sql: a.fonte }));
  const corpos = new Map<string, string>();
  const modelo = yield* modelarRepoPassos(lidas);
  for (const [alvo, estado] of modelo.identidades) {
    const ultima = estado.versoes[estado.versoes.length - 1];
    if (!estado.aposentadaPor && ultima?.corpo) corpos.set(alvo, ultima.corpo);
  }
  return corpos;
}

/** O repo: as migrations e os corpos vivos que elas definem. */
export function lerRepo(raiz: string): { arquivos: Arquivo[]; corpos: Map<string, string> } {
  const migrations = andar(join(raiz, 'supabase', 'migrations'), (p) => p.endsWith('.sql')).map((p) => ler(raiz, p));
  return { arquivos: migrations, corpos: corposVivosDe(migrations) };
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    const { arquivos, corpos } = lerRepo(raizDoRepo());
    const { codigo, linhas } = veredito(analisar(arquivos, corpos, VIVOS_PERMITIDOS), true);
    (codigo === 0 ? console.log : console.error)(linhas.join('\n'));
    return codigo;
  }
  const base = process.cwd();
  const arquivos = argv.flatMap((d) => andar(resolve(base, d), (p) => p.endsWith('.sql'))).map((p) => ler(base, p));
  const { codigo, linhas } = veredito(analisar(arquivos), false);
  (codigo === 0 ? console.log : console.error)(linhas.join('\n'));
  return codigo;
}

if (import.meta.main) process.exit(main());
