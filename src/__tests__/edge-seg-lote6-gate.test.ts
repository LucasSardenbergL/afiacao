// edge-seg-lote6-gate.test.ts — a LIGAÇÃO das 3 edges do lote 6 do scanner Lovable Security
// (docs/historico/scanner-lovable-rescan-lote6.md), provada por AST.
//
// Os módulos puros têm teste próprio no `test:edges` (Deno): `catalogo-rows_test.ts`,
// `copiloto-prompt_test.ts`, `argumento-helpers_test.ts`. O que eles NÃO provam é que o handler
// usa o módulo. As 3 edges importam SDK por `npm:` e não executam na suíte offline, então a
// ligação se prova lendo o `index.ts`:
//
//   · tint-sync-agent — toda linha que chega ao `bulkInsert` sai de um builder de lista fechada
//     ou de um objeto literal sem spread. Copiar o item do agente deixava ele escolher
//     `created_at`, a chave que decide qual linha de staging vence no preço.
//   · generate-bundle-argument e copilot-analyze — o `system` de toda chamada à Anthropic é
//     texto fixo, ou um template que só interpola nome de uma lista fechada. Nada do body.
//
// Fronteira, dita aqui para ninguém ler mais do que o teste prova: é análise sintática deste
// arquivo. Alias (`const x = customerProfile` seguido de `${x}`), getter e Proxy ficam fora —
// por isso a lista do que pode ser interpolado é FECHADA por nome e a origem de cada nome é
// conferida (import do módulo certo, ou uma declaração só, com o inicializador exato).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const RAIZ = process.cwd();
const ler = (rel: string) => readFileSync(resolve(RAIZ, rel), 'utf8');
const parse = (fonte: string) => ts.createSourceFile('index.ts', fonte, ts.ScriptTarget.ESNext, true);
const junta = (texto: string) => texto.replace(/\s+/g, ' ').trim();

const TINT = 'supabase/functions/tint-sync-agent/index.ts';
const BUNDLE = 'supabase/functions/generate-bundle-argument/index.ts';
const COPILOTO = 'supabase/functions/copilot-analyze/index.ts';
const COPILOTO_PROMPT = 'supabase/functions/copilot-analyze/copiloto-prompt.ts';

function visitar(no: ts.Node, fn: (n: ts.Node) => void): void {
  fn(no);
  ts.forEachChild(no, (filho) => visitar(filho, fn));
}

/** O nome `nome` é importado de `modulo` (import nomeado, sem alias)? */
function importadoDe(sf: ts.SourceFile, nome: string, modulo: string): boolean {
  let achou = false;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.moduleSpecifier.text !== modulo) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.name.text === nome && el.propertyName === undefined) achou = true;
    }
  }
  return achou;
}

/** Todas as declarações `const|let|var <nome> = ...` do arquivo, em qualquer escopo. */
function declaracoesDe(sf: ts.SourceFile, nome: string): ts.VariableDeclaration[] {
  const achadas: ts.VariableDeclaration[] = [];
  visitar(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === nome) achadas.push(n);
  });
  return achadas;
}

// ─── tint-sync-agent: de onde vêm as linhas do bulkInsert ──────────────────────────────────────

const MODULO_CATALOGO = './catalogo-rows.ts';
const BUILDER_CATALOGO = 'montarStagingCatalogoRow';
/** O banco preenche por default; se a edge as escreve, o valor só pode ter vindo do payload. */
const COLUNAS_SO_DO_BANCO = new Set(['id', 'created_at', 'matched_id']);

function problemasDoBulkInsert(fonte: string): string[] {
  const sf = parse(fonte);
  const problemas: string[] = [];
  const chamadas: ts.CallExpression[] = [];
  visitar(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'bulkInsert') chamadas.push(n);
  });
  // Anti-vácuo: sem chamada o laço abaixo não roda e o teste passaria sem olhar nada.
  if (chamadas.length < 2) problemas.push(`esperava ao menos 2 chamadas a bulkInsert, achei ${chamadas.length}`);

  let viaBuilder = 0;
  for (const chamada of chamadas) {
    const [tabela, linhas] = chamada.arguments;
    if (!linhas || !ts.isIdentifier(linhas)) {
      problemas.push(`bulkInsert: o 2º argumento não é um identificador (${junta(linhas?.getText(sf) ?? 'ausente')})`);
      continue;
    }
    const decls = declaracoesDe(sf, linhas.text).filter((d) => d.getStart(sf) < chamada.getStart(sf));
    const decl = decls[decls.length - 1];
    const ini = decl?.initializer;
    if (
      !ini || !ts.isCallExpression(ini) || !ts.isPropertyAccessExpression(ini.expression) ||
      ini.expression.name.text !== 'map' || ini.arguments.length !== 1 || !ts.isArrowFunction(ini.arguments[0])
    ) {
      problemas.push(`bulkInsert(${linhas.text}): as linhas não saem de um .map(arrow) declarado antes da chamada`);
      continue;
    }
    const corpo = ini.arguments[0].body;
    if (ts.isCallExpression(corpo)) {
      if (!ts.isIdentifier(corpo.expression) || corpo.expression.text !== BUILDER_CATALOGO) {
        problemas.push(`bulkInsert(${linhas.text}): a linha sai de ${junta(corpo.expression.getText(sf))}, não do builder de lista fechada`);
        continue;
      }
      viaBuilder += 1;
      const entidade = corpo.arguments[0];
      const esperada = entidade && ts.isIdentifier(entidade) ? `STAGING_CATALOGO[${entidade.text}].tabela` : null;
      if (!esperada || junta(tabela?.getText(sf) ?? '') !== esperada) {
        problemas.push(`bulkInsert(${linhas.text}): a tabela (${junta(tabela?.getText(sf) ?? 'ausente')}) não é a da entidade do builder (${esperada ?? 'entidade não é identificador'})`);
      }
      continue;
    }
    const literal = ts.isParenthesizedExpression(corpo) ? corpo.expression : corpo;
    if (!ts.isObjectLiteralExpression(literal)) {
      problemas.push(`bulkInsert(${linhas.text}): a linha não é chamada de builder nem objeto literal`);
      continue;
    }
    for (const prop of literal.properties) {
      if (ts.isSpreadAssignment(prop)) {
        problemas.push(`bulkInsert(${linhas.text}): spread no objeto da linha (${junta(prop.getText(sf))}) — o payload escolheria coluna`);
      } else if (!ts.isPropertyAssignment(prop) || ts.isComputedPropertyName(prop.name)) {
        problemas.push(`bulkInsert(${linhas.text}): chave de coluna que não é nome fixo (${junta(prop.getText(sf)).slice(0, 60)})`);
      } else if (COLUNAS_SO_DO_BANCO.has(prop.name.getText(sf).replace(/["']/g, ''))) {
        problemas.push(`bulkInsert(${linhas.text}): coluna do servidor com nome fixo no objeto da linha (${prop.name.getText(sf)})`);
      }
    }
  }
  if (viaBuilder !== 1) problemas.push(`esperava 1 bulkInsert alimentado pelo ${BUILDER_CATALOGO}, achei ${viaBuilder}`);
  if (!importadoDe(sf, BUILDER_CATALOGO, MODULO_CATALOGO)) {
    problemas.push(`${BUILDER_CATALOGO} não é o importado de ${MODULO_CATALOGO}`);
  }
  if (!importadoDe(sf, 'STAGING_CATALOGO', MODULO_CATALOGO)) {
    problemas.push(`STAGING_CATALOGO não é o importado de ${MODULO_CATALOGO}`);
  }
  if (declaracoesDe(sf, BUILDER_CATALOGO).length > 0 || declaracoesDe(sf, 'STAGING_CATALOGO').length > 0) {
    problemas.push('o index redeclara o builder ou a lista fechada (sombra do import)');
  }
  return problemas;
}

// ─── edges de IA: o que entra no `system` ──────────────────────────────────────────────────────

interface RegraSystem {
  /** Nomes que um template de system pode interpolar. */
  interpolaveis: ReadonlySet<string>;
  /** Constantes importadas que podem ser o `system` inteiro: nome → módulo. */
  constantes: Readonly<Record<string, string>>;
}

function problemasDoTemplate(expr: ts.Expression, sf: ts.SourceFile, regra: RegraSystem, onde: string): string[] {
  if (ts.isNoSubstitutionTemplateLiteral(expr) || ts.isStringLiteral(expr)) return [];
  if (!ts.isTemplateExpression(expr)) {
    return [`${onde}: o system não é texto fixo nem template (${junta(expr.getText(sf)).slice(0, 60)})`];
  }
  const problemas: string[] = [];
  for (const span of expr.templateSpans) {
    const e = span.expression;
    if (!ts.isIdentifier(e) || !regra.interpolaveis.has(e.text)) {
      problemas.push(`${onde}: o system interpola ${junta(e.getText(sf)).slice(0, 60)}, que não está na lista fechada`);
    }
  }
  return problemas;
}

function problemasDoSystem(fonte: string, regra: RegraSystem): string[] {
  const sf = parse(fonte);
  const problemas: string[] = [];
  let chamadas = 0;
  visitar(sf, (n) => {
    if (!ts.isCallExpression(n) || !/\.messages\.create$/.test(junta(n.expression.getText(sf)))) return;
    chamadas += 1;
    const arg = n.arguments[0];
    const prop = arg && ts.isObjectLiteralExpression(arg)
      ? arg.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'system')
      : undefined;
    if (!prop || !ts.isPropertyAssignment(prop)) {
      problemas.push('messages.create sem `system: <expr>` no objeto literal');
      return;
    }
    const valor = prop.initializer;
    if (!ts.isIdentifier(valor)) {
      problemas.push(...problemasDoTemplate(valor, sf, regra, 'system inline'));
      return;
    }
    const modulo = regra.constantes[valor.text];
    if (modulo !== undefined) {
      if (!importadoDe(sf, valor.text, modulo)) problemas.push(`${valor.text} não é o importado de ${modulo}`);
      if (declaracoesDe(sf, valor.text).length > 0) problemas.push(`${valor.text} é redeclarado no index (sombra do import)`);
      return;
    }
    const decls = declaracoesDe(sf, valor.text);
    if (decls.length === 0) problemas.push(`system: ${valor.text} não tem declaração neste arquivo nem é constante permitida`);
    for (const d of decls) {
      if (!d.initializer) problemas.push(`system: ${valor.text} declarado sem inicializador`);
      else problemas.push(...problemasDoTemplate(d.initializer, sf, regra, `system ${valor.text}`));
    }
  });
  // Anti-vácuo: sem chamada à Anthropic o visitante não confere nada.
  if (chamadas === 0) problemas.push('nenhuma chamada a messages.create encontrada');
  return problemas;
}

const MODULO_HELPERS = './argumento-helpers.ts';
const REGRA_BUNDLE: RegraSystem = {
  interpolaveis: new Set(['perfil', 'REGRA_DADO_AUSENTE', 'REGRA_PERFIL_NAO_INFORMADO']),
  constantes: {},
};

/** `perfil` (o único nome interpolável que não é constante) nasce do validador, uma vez só. */
function problemasDoPerfil(fonte: string): string[] {
  const sf = parse(fonte);
  const problemas: string[] = [];
  const decls = declaracoesDe(sf, 'perfil');
  if (decls.length !== 1) return [`esperava 1 declaração de perfil, achei ${decls.length}`];
  const d = decls[0];
  const lista = d.parent;
  if (!ts.isVariableDeclarationList(lista) || (lista.flags & ts.NodeFlags.Const) === 0) {
    problemas.push('perfil não é const (poderia ser regravado com o valor do body)');
  }
  if (!d.initializer || junta(d.initializer.getText(sf)) !== 'perfilParaPrompt(customerProfile)') {
    problemas.push(`perfil não nasce de perfilParaPrompt(customerProfile): ${junta(d.initializer?.getText(sf) ?? 'sem inicializador')}`);
  }
  for (const nome of ['perfilParaPrompt', 'REGRA_DADO_AUSENTE', 'REGRA_PERFIL_NAO_INFORMADO']) {
    if (!importadoDe(sf, nome, MODULO_HELPERS)) problemas.push(`${nome} não é o importado de ${MODULO_HELPERS}`);
    if (declaracoesDe(sf, nome).length > 0) problemas.push(`${nome} é redeclarado no index (sombra do import)`);
  }
  return problemas;
}

const MODULO_PROMPT = './copiloto-prompt.ts';
const REGRA_COPILOTO: RegraSystem = {
  interpolaveis: new Set<string>(),
  constantes: { SYSTEM_PROMPT_COPILOTO: MODULO_PROMPT },
};

/** A mensagem do usuário do copiloto sai do módulo (é ele que valida o enum e neutraliza o delimitador). */
function problemasDaMensagemDoCopiloto(fonte: string): string[] {
  const sf = parse(fonte);
  const problemas: string[] = [];
  const decls = declaracoesDe(sf, 'mensagemUsuario');
  if (decls.length !== 1) return [`esperava 1 declaração de mensagemUsuario, achei ${decls.length}`];
  const ini = decls[0].initializer;
  if (!ini || !ts.isCallExpression(ini) || !ts.isIdentifier(ini.expression) || ini.expression.text !== 'montarMensagemCopiloto') {
    problemas.push('mensagemUsuario não nasce de montarMensagemCopiloto(...)');
  }
  if (!importadoDe(sf, 'montarMensagemCopiloto', MODULO_PROMPT)) {
    problemas.push(`montarMensagemCopiloto não é o importado de ${MODULO_PROMPT}`);
  }
  let conteudos = 0;
  visitar(sf, (n) => {
    if (!ts.isPropertyAssignment(n) || !ts.isIdentifier(n.name) || n.name.text !== 'content') return;
    conteudos += 1;
    if (!ts.isIdentifier(n.initializer) || n.initializer.text !== 'mensagemUsuario') {
      problemas.push(`content da mensagem não é mensagemUsuario: ${junta(n.initializer.getText(sf)).slice(0, 60)}`);
    }
  });
  if (conteudos !== 1) problemas.push(`esperava 1 \`content:\` no index do copiloto, achei ${conteudos}`);
  return problemas;
}

/** A constante do módulo não tem interpolação nenhuma. */
function problemasDaConstanteDoSystem(fonteDoModulo: string): string[] {
  const sf = parse(fonteDoModulo);
  const decls = declaracoesDe(sf, 'SYSTEM_PROMPT_COPILOTO');
  if (decls.length !== 1) return [`esperava 1 declaração de SYSTEM_PROMPT_COPILOTO, achei ${decls.length}`];
  const ini = decls[0].initializer;
  if (!ini || !(ts.isNoSubstitutionTemplateLiteral(ini) || ts.isStringLiteral(ini))) {
    return ['SYSTEM_PROMPT_COPILOTO não é texto fixo (tem interpolação ou é expressão)'];
  }
  return [];
}

/** Troca `de` por `para` UMA vez; lança se `de` não existir (mutante que não muta é teatro). */
function mutar(fonte: string, de: string, para: string): string {
  const i = fonte.indexOf(de);
  if (i < 0) throw new Error(`mutante sem alvo: ${de.slice(0, 70)}`);
  return fonte.slice(0, i) + para + fonte.slice(i + de.length);
}

describe('lote 6 do scanner — tint-sync-agent: a linha de staging não sai do payload cru', () => {
  const fonte = ler(TINT);

  it('toda linha do bulkInsert vem do builder de lista fechada ou de objeto literal sem spread', () => {
    expect(problemasDoBulkInsert(fonte)).toEqual([]);
  });

  it('a cópia genérica do item (o furo) não existe mais no index', () => {
    expect(fonte).not.toMatch(/Object\.entries\(\s*item\s*\)/);
  });

  it.each([
    ['spread do item no lugar do builder', 'montarStagingCatalogoRow(entityType, item, runId, agent.account, agent.storeCode)', '({ ...item, sync_run_id: runId })', 'spread no objeto da linha'],
    ['outro construtor no lugar do builder', 'montarStagingCatalogoRow(entityType, item, runId, agent.account, agent.storeCode)', 'copiarTudo(entityType, item)', 'não do builder de lista fechada'],
    ['tabela fixa, descasada da entidade', 'STAGING_CATALOGO[entityType].tabela, rows', '"tint_staging_corantes", rows', 'não é a da entidade do builder'],
    ['spread no objeto de precos_base', 'cod_produto: item.cod_produto ?? null,', '...item,', 'spread no objeto da linha'],
    ['chave computada no objeto de precos_base', 'cod_produto: item.cod_produto ?? null,', '[chave]: item.cod_produto,', 'não é nome fixo'],
    ['created_at com nome fixo no objeto de precos_base', 'cod_produto: item.cod_produto ?? null,', 'created_at: item.created_at, cod_produto: item.cod_produto ?? null,', 'coluna do servidor com nome fixo'],
    ['builder vindo de outro módulo', 'from "./catalogo-rows.ts";', 'from "./outro-modulo.ts";', `não é o importado de ${MODULO_CATALOGO}`],
    ['os itens crus do payload no lugar das linhas', 'tabela, rows, 500', 'tabela, items, 500', 'não saem de um .map(arrow)'],
    ['linhas como expressão, sem variável', 'tabela, rows, 500', 'tabela, items as never, 500', 'não é um identificador'],
  ])('mutante: %s → vermelho', (_nome, de, para, marca) => {
    const problemas = problemasDoBulkInsert(mutar(fonte, de, para));
    expect(problemas.join('\n')).toContain(marca);
  });
});

describe('lote 6 do scanner — generate-bundle-argument: o system só interpola lista fechada', () => {
  const fonte = ler(BUNDLE);

  it('os system prompts (2 modos) só interpolam perfil validado e constantes do módulo', () => {
    expect(problemasDoSystem(fonte, REGRA_BUNDLE)).toEqual([]);
    expect(problemasDoPerfil(fonte)).toEqual([]);
  });

  it('há 2 chamadas à Anthropic e as duas foram conferidas', () => {
    expect(fonte.match(/\.messages\.create\(/g)?.length).toBe(2);
    expect(fonte).not.toContain('${customerProfile}');
  });

  it.each([
    ['perfil cru do body no system', 'PERFIL DO CLIENTE: ${perfil}', 'PERFIL DO CLIENTE: ${customerProfile}', 'interpola customerProfile'],
    ['campo do cliente no system', 'PERFIL DO CLIENTE: ${perfil}', 'PERFIL DO CLIENTE: ${customer.name}', 'interpola customer.name'],
    ['system concatenado com dado do body', 'system: systemPrompt,', 'system: systemPrompt + String(customer.name),', 'não é texto fixo nem template'],
  ])('mutante: %s → vermelho', (_nome, de, para, marca) => {
    expect(problemasDoSystem(mutar(fonte, de, para), REGRA_BUNDLE).join('\n')).toContain(marca);
  });

  it.each([
    ['perfil sem validar', 'const perfil = perfilParaPrompt(customerProfile);', 'const perfil = customerProfile;', 'não nasce de perfilParaPrompt'],
    ['perfil regravável', 'const perfil = perfilParaPrompt(customerProfile);', 'let perfil = perfilParaPrompt(customerProfile);', 'não é const'],
    ['validador de outro módulo', '} from "./argumento-helpers.ts";', '} from "./outro-modulo.ts";', `não é o importado de ${MODULO_HELPERS}`],
  ])('mutante: %s → vermelho', (_nome, de, para, marca) => {
    expect(problemasDoPerfil(mutar(fonte, de, para)).join('\n')).toContain(marca);
  });
});

describe('lote 6 do scanner — copilot-analyze: system fixo, dado do request na mensagem', () => {
  const fonte = ler(COPILOTO);
  const modulo = ler(COPILOTO_PROMPT);

  it('o system é a constante do módulo, e a constante não tem interpolação', () => {
    expect(problemasDoSystem(fonte, REGRA_COPILOTO)).toEqual([]);
    expect(problemasDaConstanteDoSystem(modulo)).toEqual([]);
  });

  it('a mensagem do usuário sai de montarMensagemCopiloto', () => {
    expect(problemasDaMensagemDoCopiloto(fonte)).toEqual([]);
  });

  it('nada do body é interpolado em template no index', () => {
    for (const campo of ['customerContext', 'bundleContext', 'currentPhase', 'currentIntent', 'transcript']) {
      expect(fonte).not.toContain('${' + campo);
    }
  });

  it.each([
    ['system com o contexto do cliente', 'system: SYSTEM_PROMPT_COPILOTO,', 'system: `Contexto: ${customerContext}`,', 'interpola customerContext'],
    ['system montado por função', 'system: SYSTEM_PROMPT_COPILOTO,', 'system: montarSystem(customerContext),', 'não é texto fixo nem template'],
    ['constante vinda de outro módulo', 'SYSTEM_PROMPT_COPILOTO } from "./copiloto-prompt.ts";', 'SYSTEM_PROMPT_COPILOTO } from "./outro-modulo.ts";', `não é o importado de ${MODULO_PROMPT}`],
  ])('mutante: %s → vermelho', (_nome, de, para, marca) => {
    expect(problemasDoSystem(mutar(fonte, de, para), REGRA_COPILOTO).join('\n')).toContain(marca);
  });

  it.each([
    ['transcrição crua na mensagem', "content: mensagemUsuario }", "content: `Transcrição recente:\\n${transcript}` }", 'content da mensagem não é mensagemUsuario'],
    ['mensagem montada sem o módulo', 'const mensagemUsuario = montarMensagemCopiloto({', 'const mensagemUsuario = JSON.stringify({', 'não nasce de montarMensagemCopiloto'],
  ])('mutante: %s → vermelho', (_nome, de, para, marca) => {
    expect(problemasDaMensagemDoCopiloto(mutar(fonte, de, para)).join('\n')).toContain(marca);
  });

  it('mutante: interpolação dentro da constante do system → vermelho', () => {
    const mutado = mutar(modulo, 'Analise a transcrição da conversa e preencha:', 'Analise ${"x"} e preencha:');
    expect(problemasDaConstanteDoSystem(mutado).join('\n')).toContain('não é texto fixo');
  });
});
