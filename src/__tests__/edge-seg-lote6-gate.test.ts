// edge-seg-lote6-gate.test.ts — a LIGAÇÃO das 3 edges do lote 6 do scanner Lovable Security
// (docs/historico/scanner-lovable-rescan-lote6.md), provada por AST.
//
// Os módulos puros têm teste próprio no `test:edges` (Deno): `catalogo-rows_test.ts`,
// `snapshot-relogio_test.ts`, `copiloto-prompt_test.ts`, `argumento-helpers_test.ts`. O que eles
// NÃO provam é que o handler usa o módulo. Aqui a ligação se prova lendo o `index.ts`:
//
//   · tint-sync-agent — toda linha que chega ao `bulkInsert` sai de `separarLoteDeCatalogo`
//     (lista fechada + recusa do item com campo fora dela) ou de um objeto literal sem spread.
//     Copiar o item do agente deixava ele escolher `created_at`, a chave que decide qual linha de
//     staging vence no preço.
//   · generate-bundle-argument e copilot-analyze — o `system` de toda chamada à Anthropic é
//     texto fixo, ou um template que só interpola nome de uma lista fechada. Nada do body. E o que
//     TEM de chegar chega: os 5 campos do request na mensagem do copiloto, o perfil validado e as
//     duas regras nos 2 prompts do bundle.
//
// Fronteira, dita aqui para ninguém ler mais do que o teste prova: é análise SINTÁTICA do
// `index.ts`. O que ela confere: o inicializador de cada variável que vira `system`, mensagem ou
// linha; que essas variáveis são `const`; que o objeto passado ao `messages.create` não tem spread
// e tem um `system` só; e que o lote e as linhas não são tocados entre a montagem e o `bulkInsert`.
// O que fica fora: alias (`const x = customerProfile` seguido de `${x}` — por isso a lista do que
// pode ser interpolado é FECHADA por nome, com a origem de cada nome conferida), getter, Proxy,
// mutação feita dentro de uma função chamada, e tudo o que não é este arquivo. Nome declarado duas
// vezes no arquivo é recusado como ambíguo, em vez de resolvido por posição. Na
// `tint-sync-agent` quem cobre o que sobra é o teste que EXECUTA o handler (`index_test.ts`):
// ele olha o corpo do POST que sai. As duas edges de IA não têm esse teste — importam o SDK da
// Anthropic por `npm:` e não carregam na suíte offline.
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

function ehConst(d: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0;
}

/** O bloco (ou o arquivo) que contém a declaração. */
function blocoDe(decl: ts.VariableDeclaration): ts.Node {
  let bloco: ts.Node = decl;
  while (bloco.parent && !ts.isBlock(bloco) && !ts.isSourceFile(bloco)) bloco = bloco.parent;
  return bloco;
}

/** Os usos de `nome` como VARIÁVEL (não como nome de propriedade) no bloco que o declara, fora a própria declaração. */
function usosNoBloco(decl: ts.VariableDeclaration, nome: string): ts.Identifier[] {
  const usos: ts.Identifier[] = [];
  visitar(blocoDe(decl), (n) => {
    if (!ts.isIdentifier(n) || n.text !== nome || n === decl.name) return;
    const pai = n.parent;
    if (ts.isPropertyAccessExpression(pai) && pai.name === n) return;
    if (ts.isPropertyAssignment(pai) && pai.name === n) return;
    usos.push(n);
  });
  return usos;
}

// ─── tint-sync-agent: de onde vêm as linhas do bulkInsert ──────────────────────────────────────

const MODULO_CATALOGO = './catalogo-rows.ts';
const SEPARADOR = 'separarLoteDeCatalogo';
/** O banco preenche por default; se a edge as escreve, o valor só pode ter vindo do payload. */
const COLUNAS_SO_DO_BANCO = new Set(['id', 'created_at', 'matched_id']);
/** O que a rota pode LER do lote além de `linhas` (que só pode ir ao bulkInsert). */
const LEITURAS_DO_LOTE = new Set(['recusados', 'camposRecusados', 'naoObjetos']);

/** As linhas vêm de `<lote>.linhas`, com `<lote>` nascido do separador e intocado até o bulkInsert. */
function problemasDoLote(
  sf: ts.SourceFile,
  chamada: ts.CallExpression,
  acesso: ts.PropertyAccessExpression,
  tabela: ts.Expression | undefined,
): string[] {
  const problemas: string[] = [];
  if (!ts.isIdentifier(acesso.expression) || acesso.name.text !== 'linhas') {
    return [`bulkInsert: o 2º argumento não é <lote>.linhas nem um identificador (${junta(acesso.getText(sf)).slice(0, 60)})`];
  }
  const nome = acesso.expression.text;
  // Uma declaração SÓ no arquivo. Com duas (a 2ª num bloco morto, por exemplo) a análise escolheria
  // uma por posição textual e olharia os usos do bloco errado — a linha poderia ser tocada no bloco
  // de verdade com tudo verde.
  const todas = declaracoesDe(sf, nome);
  if (todas.length !== 1) return [`bulkInsert(${nome}.linhas): ${todas.length} declarações de ${nome} no arquivo (ambíguo)`];
  const decl = todas[0];
  const ini = decl.initializer;
  if (decl.getStart(sf) > chamada.getStart(sf) || !ini || !ts.isCallExpression(ini) || !ts.isIdentifier(ini.expression) || ini.expression.text !== SEPARADOR) {
    return [`bulkInsert(${nome}.linhas): ${nome} não nasce de ${SEPARADOR}(...)`];
  }
  if (!ehConst(decl)) problemas.push(`bulkInsert(${nome}.linhas): ${nome} não é const`);
  const entidade = ini.arguments[0];
  const esperada = entidade && ts.isIdentifier(entidade) ? `STAGING_CATALOGO[${entidade.text}].tabela` : null;
  if (!esperada || junta(tabela?.getText(sf) ?? '') !== esperada) {
    problemas.push(`bulkInsert(${nome}.linhas): a tabela (${junta(tabela?.getText(sf) ?? 'ausente')}) não é a da entidade do lote (${esperada ?? 'entidade não é identificador'})`);
  }
  // Cada uso do lote tem de ser: `.linhas` como argumento DESTE bulkInsert, uma leitura das
  // contagens, ou o lote inteiro entregue a `mensagemDeRecusa`. Qualquer outro é a linha sendo
  // tocada depois do separador (`lote.linhas.forEach((l) => { l.created_at = ... })`).
  for (const uso of usosNoBloco(decl, nome)) {
    const pai = uso.parent;
    if (ts.isPropertyAccessExpression(pai) && pai.expression === uso) {
      const avo = pai.parent;
      const ehEscrita = ts.isBinaryExpression(avo) && avo.left === pai &&
        avo.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && avo.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const ehCadeia = (ts.isPropertyAccessExpression(avo) || ts.isElementAccessExpression(avo)) && avo.expression === pai;
      if (pai.name.text === 'linhas' && pai === acesso && !ehEscrita) continue;
      if (LEITURAS_DO_LOTE.has(pai.name.text) && !ehEscrita && !(ehCadeia && pai.name.text !== 'camposRecusados')) continue;
    } else if (ts.isCallExpression(pai) && ts.isIdentifier(pai.expression) && pai.expression.text === 'mensagemDeRecusa' && pai.arguments[0] === uso) {
      continue;
    }
    problemas.push(`bulkInsert(${nome}.linhas): uso do lote fora do permitido (${junta(pai.getText(sf)).slice(0, 70)})`);
  }
  return problemas;
}

/** As linhas vêm de uma variável `const x = itens.map((item) => ({ chaves fixas }))`, usada só no bulkInsert. */
function problemasDoLiteral(sf: ts.SourceFile, chamada: ts.CallExpression, linhas: ts.Identifier): string[] {
  const problemas: string[] = [];
  const todas = declaracoesDe(sf, linhas.text);
  if (todas.length !== 1) return [`bulkInsert(${linhas.text}): ${todas.length} declarações de ${linhas.text} no arquivo (ambíguo)`];
  const decl = todas[0];
  const ini = decl.initializer;
  if (
    decl.getStart(sf) > chamada.getStart(sf) || !ini || !ts.isCallExpression(ini) || !ts.isPropertyAccessExpression(ini.expression) ||
    ini.expression.name.text !== 'map' || ini.arguments.length !== 1 || !ts.isArrowFunction(ini.arguments[0])
  ) {
    return [`bulkInsert(${linhas.text}): as linhas não saem de um .map(arrow) declarado antes da chamada`];
  }
  if (!ehConst(decl)) problemas.push(`bulkInsert(${linhas.text}): a variável das linhas não é const`);
  const usos = usosNoBloco(decl, linhas.text).length;
  if (usos !== 1) problemas.push(`bulkInsert(${linhas.text}): a variável das linhas é usada além do bulkInsert (${usos} usos)`);
  const corpo = ini.arguments[0].body;
  const literal = ts.isParenthesizedExpression(corpo) ? corpo.expression : corpo;
  if (!ts.isObjectLiteralExpression(literal)) {
    return [...problemas, `bulkInsert(${linhas.text}): a linha não é objeto literal`];
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
  return problemas;
}

function problemasDoBulkInsert(fonte: string): string[] {
  const sf = parse(fonte);
  const problemas: string[] = [];
  const chamadas: ts.CallExpression[] = [];
  visitar(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'bulkInsert') chamadas.push(n);
  });
  // Anti-vácuo: sem chamada o laço abaixo não roda e o teste passaria sem olhar nada.
  if (chamadas.length < 2) problemas.push(`esperava ao menos 2 chamadas a bulkInsert, achei ${chamadas.length}`);

  let viaLote = 0;
  for (const chamada of chamadas) {
    const [tabela, linhas] = chamada.arguments;
    if (linhas && ts.isPropertyAccessExpression(linhas)) {
      viaLote += 1;
      problemas.push(...problemasDoLote(sf, chamada, linhas, tabela));
    } else if (linhas && ts.isIdentifier(linhas)) {
      problemas.push(...problemasDoLiteral(sf, chamada, linhas));
    } else {
      problemas.push(`bulkInsert: o 2º argumento não é <lote>.linhas nem um identificador (${junta(linhas?.getText(sf) ?? 'ausente').slice(0, 60)})`);
    }
  }
  if (viaLote !== 1) problemas.push(`esperava 1 bulkInsert alimentado por <lote>.linhas, achei ${viaLote}`);
  for (const nome of [SEPARADOR, 'STAGING_CATALOGO', 'mensagemDeRecusa', 'erroDeFormaDoLote']) {
    if (!importadoDe(sf, nome, MODULO_CATALOGO)) problemas.push(`${nome} não é o importado de ${MODULO_CATALOGO}`);
    if (declaracoesDe(sf, nome).length > 0) problemas.push(`${nome} é redeclarado no index (sombra do import)`);
  }
  return problemas;
}

// ─── edges de IA: o que entra no `system` ──────────────────────────────────────────────────────

interface RegraSystem {
  /** Nomes que um template de system pode interpolar. */
  interpolaveis: ReadonlySet<string>;
  /** Nomes que CADA template de system tem de interpolar exatamente uma vez. */
  obrigatorios: readonly string[];
  /** Constantes importadas que podem ser o `system` inteiro: nome → módulo. */
  constantes: Readonly<Record<string, string>>;
}

function problemasDoTemplate(expr: ts.Expression, sf: ts.SourceFile, regra: RegraSystem, onde: string): string[] {
  const problemas: string[] = [];
  const nomes: string[] = [];
  if (ts.isTemplateExpression(expr)) {
    for (const span of expr.templateSpans) {
      const e = span.expression;
      if (!ts.isIdentifier(e) || !regra.interpolaveis.has(e.text)) {
        problemas.push(`${onde}: o system interpola ${junta(e.getText(sf)).slice(0, 60)}, que não está na lista fechada`);
      } else {
        nomes.push(e.text);
      }
    }
  } else if (!ts.isNoSubstitutionTemplateLiteral(expr) && !ts.isStringLiteral(expr)) {
    return [`${onde}: o system não é texto fixo nem template (${junta(expr.getText(sf)).slice(0, 60)})`];
  }
  for (const obrigatorio of regra.obrigatorios) {
    const vezes = nomes.filter((n) => n === obrigatorio).length;
    if (vezes !== 1) problemas.push(`${onde}: não interpola ${obrigatorio} exatamente 1 vez (${vezes})`);
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
    if (!arg || !ts.isObjectLiteralExpression(arg) || !prop || !ts.isPropertyAssignment(prop)) {
      problemas.push('messages.create sem `system: <expr>` no objeto literal');
      return;
    }
    // Um `...{ system: x }` depois, ou um 2º `system:`, sobrescreveria o que foi conferido.
    if (arg.properties.some((p) => ts.isSpreadAssignment(p))) {
      problemas.push('spread no objeto do messages.create — poderia sobrescrever o system');
    }
    const quantos = arg.properties.filter((p) => p.name?.getText(sf).replace(/["']/g, '') === 'system').length;
    if (quantos !== 1) problemas.push(`mais de um \`system\` no objeto do messages.create (${quantos})`);
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
      if (!ehConst(d)) problemas.push(`system: ${valor.text} não é const (poderia ser regravado com dado do body)`);
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
  obrigatorios: ['perfil', 'REGRA_DADO_AUSENTE', 'REGRA_PERFIL_NAO_INFORMADO'],
  constantes: {},
};

/** `perfil` (o único nome interpolável que não é constante) nasce do validador, uma vez só. */
function problemasDoPerfil(fonte: string): string[] {
  const sf = parse(fonte);
  const problemas: string[] = [];
  const decls = declaracoesDe(sf, 'perfil');
  if (decls.length !== 1) return [`esperava 1 declaração de perfil, achei ${decls.length}`];
  const d = decls[0];
  if (!ehConst(d)) problemas.push('perfil não é const (poderia ser regravado com o valor do body)');
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
  obrigatorios: [],
  constantes: { SYSTEM_PROMPT_COPILOTO: MODULO_PROMPT },
};
/** O que vinha do body e ia para o system: tem de chegar INTEIRO ao módulo que monta a mensagem. */
const CAMPOS_DA_MENSAGEM = ['bundleContext', 'currentIntent', 'currentPhase', 'customerContext', 'transcript'];

/** A mensagem do usuário do copiloto sai do módulo (é ele que valida o enum e neutraliza o delimitador). */
function problemasDaMensagemDoCopiloto(fonte: string): string[] {
  const sf = parse(fonte);
  const problemas: string[] = [];
  const decls = declaracoesDe(sf, 'mensagemUsuario');
  if (decls.length !== 1) return [`esperava 1 declaração de mensagemUsuario, achei ${decls.length}`];
  const ini = decls[0].initializer;
  if (!ini || !ts.isCallExpression(ini) || !ts.isIdentifier(ini.expression) || ini.expression.text !== 'montarMensagemCopiloto') {
    problemas.push('mensagemUsuario não nasce de montarMensagemCopiloto(...)');
  } else {
    // Ligação POSITIVA: os 5 campos do body, cada um com o próprio nome (shorthand). Tirar um, ou
    // passar `currentPhase: currentIntent`, deixaria o copiloto sem contexto com tudo verde.
    const arg = ini.arguments[0];
    const nomes = ini.arguments.length === 1 && arg && ts.isObjectLiteralExpression(arg) &&
        arg.properties.every((p) => ts.isShorthandPropertyAssignment(p))
      ? arg.properties.map((p) => (p as ts.ShorthandPropertyAssignment).name.text).sort()
      : null;
    if (!nomes || nomes.join(',') !== CAMPOS_DA_MENSAGEM.join(',')) {
      problemas.push(`montarMensagemCopiloto não leva os 5 campos do body pelo próprio nome (${nomes?.join(',') ?? junta(arg?.getText(sf) ?? 'sem argumento').slice(0, 60)})`);
    }
  }
  if (!ehConst(decls[0])) problemas.push('mensagemUsuario não é const');
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
  const LOTE = 'separarLoteDeCatalogo(entityType, items, runId, agent.account, agent.storeCode)';
  const CHAMADA = 'const { insertedCount } = await bulkInsert(STAGING_CATALOGO[entityType].tabela, lote.linhas, 500,';

  it('toda linha do bulkInsert vem do separador de lista fechada ou de objeto literal sem spread', () => {
    expect(problemasDoBulkInsert(fonte)).toEqual([]);
  });

  it('a cópia genérica do item (o furo) não existe mais no index', () => {
    expect(fonte).not.toMatch(/Object\.entries\(\s*item\s*\)/);
  });

  it.each([
    ['a rota volta a copiar o item', LOTE, '{ linhas: (items as Record<string, unknown>[]).map((item) => ({ ...item })), recusados: 0, camposRecusados: [] as string[], naoObjetos: 0 }', `não nasce de ${SEPARADOR}`],
    ['outro separador no lugar', LOTE, 'separarSemRecusar(entityType, items)', `não nasce de ${SEPARADOR}`],
    ['os itens crus do payload no lugar das linhas', 'tabela, lote.linhas, 500', 'tabela, items, 500', 'não saem de um .map(arrow)'],
    ['linhas reescritas na própria chamada', 'tabela, lote.linhas, 500', 'tabela, lote.linhas.map((l) => ({ ...l, created_at: "2099-01-01" })), 500', 'não é <lote>.linhas nem um identificador'],
    ['linha tocada DEPOIS do separador', CHAMADA, `lote.linhas.forEach((l) => { l.created_at = "2099-01-01"; }); ${CHAMADA}`, 'uso do lote fora do permitido'],
    ['linhas do lote trocadas por atribuição', CHAMADA, `lote.linhas = items as never; ${CHAMADA}`, 'uso do lote fora do permitido'],
    ['lote regravável', 'const lote = separarLoteDeCatalogo(', 'let lote = separarLoteDeCatalogo(', 'lote não é const'],
    ['declaração homônima num bloco morto + linha tocada no bloco de verdade', CHAMADA, `if (false) { const lote = ${LOTE}; void lote; } if (lote.linhas.length) lote.linhas[0].created_at = "2099-01-01T00:00:00Z"; ${CHAMADA}`, '2 declarações de lote no arquivo (ambíguo)'],
    ['tabela fixa, descasada da entidade', 'STAGING_CATALOGO[entityType].tabela, lote.linhas', '"tint_staging_corantes", lote.linhas', 'não é a da entidade do lote'],
    ['separador vindo de outro módulo', '} from "./catalogo-rows.ts";', '} from "./outro-modulo.ts";', `não é o importado de ${MODULO_CATALOGO}`],
    ['spread no objeto de precos_base', 'cod_produto: item.cod_produto ?? null,', '...item,', 'spread no objeto da linha'],
    ['chave computada no objeto de precos_base', 'cod_produto: item.cod_produto ?? null,', '[chave]: item.cod_produto,', 'não é nome fixo'],
    ['created_at com nome fixo no objeto de precos_base', 'cod_produto: item.cod_produto ?? null,', 'created_at: item.created_at, cod_produto: item.cod_produto ?? null,', 'coluna do servidor com nome fixo'],
    ['linhas de precos_base em variável regravável', 'const precosRows: Record<string, unknown>[] = precosBaseItems.map(', 'let precosRows: Record<string, unknown>[] = precosBaseItems.map(', 'não é const'],
    ['linhas de precos_base tocadas depois', 'const { insertedCount: precosInserted } = await bulkInsert(', 'precosRows.forEach((l) => { l.created_at = "x"; }); const { insertedCount: precosInserted } = await bulkInsert(', 'usada além do bulkInsert (2 usos)'],
  ])('mutante: %s → vermelho', (_nome, de, para, marca) => {
    const problemas = problemasDoBulkInsert(mutar(fonte, de, para));
    expect(problemas.join('\n')).toContain(marca);
  });
});

describe('lote 6 do scanner — generate-bundle-argument: o system só interpola lista fechada', () => {
  const fonte = ler(BUNDLE);

  it('os system prompts (2 modos) interpolam o perfil validado e as duas regras, e só isso', () => {
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
    ['system regravável', 'const systemPrompt = `Você é um consultor especialista em venda consultiva', 'let systemPrompt = `Você é um consultor especialista em venda consultiva', 'não é const'],
    ['spread sobrescrevendo o system', 'system: systemPrompt,', 'system: systemPrompt, ...{ system: String(customerProfile) },', 'spread no objeto do messages.create'],
    ['segundo system no mesmo objeto', 'system: systemPrompt,', 'system: systemPrompt, system: String(customerProfile),', 'mais de um `system`'],
    ['perfil fora do prompt', 'PERFIL DO CLIENTE: ${perfil}', 'PERFIL DO CLIENTE: misto', 'não interpola perfil exatamente 1 vez (0)'],
    ['regra do não informado fora do prompt', '${REGRA_PERFIL_NAO_INFORMADO}\n', '', 'não interpola REGRA_PERFIL_NAO_INFORMADO exatamente 1 vez (0)'],
    ['regra do dado ausente fora do prompt', '${REGRA_DADO_AUSENTE}\n', '', 'não interpola REGRA_DADO_AUSENTE exatamente 1 vez (0)'],
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

  it('a mensagem do usuário sai de montarMensagemCopiloto, com os 5 campos do body', () => {
    expect(problemasDaMensagemDoCopiloto(fonte)).toEqual([]);
  });

  it('nada do body é interpolado em template no index', () => {
    for (const campo of CAMPOS_DA_MENSAGEM) {
      expect(fonte).not.toContain('${' + campo);
    }
  });

  it.each([
    ['system com o contexto do cliente', 'system: SYSTEM_PROMPT_COPILOTO,', 'system: `Contexto: ${customerContext}`,', 'interpola customerContext'],
    ['system montado por função', 'system: SYSTEM_PROMPT_COPILOTO,', 'system: montarSystem(customerContext),', 'não é texto fixo nem template'],
    ['spread sobrescrevendo o system', 'system: SYSTEM_PROMPT_COPILOTO,', 'system: SYSTEM_PROMPT_COPILOTO, ...{ system: transcript },', 'spread no objeto do messages.create'],
    ['segundo system no mesmo objeto', 'system: SYSTEM_PROMPT_COPILOTO,', 'system: SYSTEM_PROMPT_COPILOTO, system: transcript,', 'mais de um `system`'],
    ['constante vinda de outro módulo', 'SYSTEM_PROMPT_COPILOTO } from "./copiloto-prompt.ts";', 'SYSTEM_PROMPT_COPILOTO } from "./outro-modulo.ts";', `não é o importado de ${MODULO_PROMPT}`],
  ])('mutante: %s → vermelho', (_nome, de, para, marca) => {
    expect(problemasDoSystem(mutar(fonte, de, para), REGRA_COPILOTO).join('\n')).toContain(marca);
  });

  it.each([
    ['transcrição crua na mensagem', "content: mensagemUsuario }", "content: `Transcrição recente:\\n${transcript}` }", 'content da mensagem não é mensagemUsuario'],
    ['mensagem montada sem o módulo', 'const mensagemUsuario = montarMensagemCopiloto({', 'const mensagemUsuario = JSON.stringify({', 'não nasce de montarMensagemCopiloto'],
    ['mensagem regravável', 'const mensagemUsuario = montarMensagemCopiloto({', 'let mensagemUsuario = montarMensagemCopiloto({', 'mensagemUsuario não é const'],
    ['bundle fora da mensagem', '      bundleContext,\n      currentPhase,', '      currentPhase,', 'não leva os 5 campos'],
    ['contexto do cliente fora da mensagem', '      customerContext,\n      bundleContext,', '      bundleContext,', 'não leva os 5 campos'],
    ['fase trocada pela intenção', '      currentPhase,\n', '      currentPhase: currentIntent,\n', 'não leva os 5 campos'],
    ['transcrição fixa', '      transcript,\n      customerContext,', "      transcript: 'oi',\n      customerContext,", 'não leva os 5 campos'],
  ])('mutante: %s → vermelho', (_nome, de, para, marca) => {
    expect(problemasDaMensagemDoCopiloto(mutar(fonte, de, para)).join('\n')).toContain(marca);
  });

  it('mutante: interpolação dentro da constante do system → vermelho', () => {
    const mutado = mutar(modulo, 'Analise a transcrição da conversa e preencha:', 'Analise ${"x"} e preencha:');
    expect(problemasDaConstanteDoSystem(mutado).join('\n')).toContain('não é texto fixo');
  });
});
