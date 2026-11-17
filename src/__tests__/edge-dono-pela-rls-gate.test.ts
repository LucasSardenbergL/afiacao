// Guardrail de LIGAÇÃO do gate de dono (scanner Lovable Security, deep scan 2026-11-17, lote 5).
//
// O gate em si (`supabase/functions/_shared/dono-pela-rls.ts`) é provado EXECUTANDO: os ramos na
// suíte Deno (`dono-pela-rls_test.ts`) e o oráculo no banco (`db/test-seg-lote5-dono-pela-rls.sh`).
// Nenhuma das duas vê o `index.ts` das edges — elas importam SDKs (`npm:openai`, `npm:pdf-parse`,
// `npm:@anthropic-ai/sdk`) que a suíte offline não resolve. O que sobra para provar aqui é a
// LIGAÇÃO: o gate certo, com a decisão CONSUMIDA, DOMINANDO todo efeito do handler, sobre o MESMO
// registro que o resto do handler processa. Um primitivo perfeito que a edge chama e ignora deixa
// o furo aberto com todo teste dele verde.
//
// Por AST (parser do TypeScript), não regex: a pergunta é "esta instrução roda em TODA requisição,
// antes de qualquer efeito?", e contagem de chaves no texto quebra em template literal — as duas
// edges são feitas de prompt. Mesma razão de `src/lib/gates/authz-dominante.ts`.
//
// Cada exigência tem um MUTANTE abaixo: a fonte real é sabotada em memória e o detector tem de
// devolver a marca daquele ramo. Detector que passa mutante é detector cego.
//
// O limite, declarado: isto NÃO é análise geral de JavaScript. Getter, Proxy e alias arbitrário de
// objeto do servidor ficam fora. O que ele trava é a forma do handler e a identidade dos nomes que
// carregam a decisão (o gate, a autenticação, o principal, o request e o id do registro).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const RAIZ = process.cwd();
const ler = (rel: string) => readFileSync(resolve(RAIZ, rel), 'utf8');

type Alvo = {
  arquivo: string;
  /** Literal da tabela no gate — nunca vem do body. */
  tabela: string;
  /** O identificador escalar do id: o MESMO no gate e em todo `.eq("id", …)` do arquivo. */
  id: string;
  /** A instrução do topo do handler que declara o id, com `const`. */
  declaracaoDoId: string;
};

const KB: Alvo = {
  arquivo: 'supabase/functions/kb-ingest-document/index.ts',
  tabela: 'kb_documents',
  id: 'documentId',
  declaracaoDoId: 'const documentId = body.documentId;',
};
const SINAIS: Alvo = {
  arquivo: 'supabase/functions/extrair-sinais-ligacao/index.ts',
  tabela: 'farmer_calls',
  id: 'callId',
  declaracaoDoId: 'const { callId, transcript } = body ?? {};',
};

/**
 * O que pode ser CHAMADO antes do gate de dono: autenticação, leitura de env, parse do body, a
 * sonda de versão e a montagem de respostas. Lista fechada — qualquer outra chamada antes do gate
 * (cliente service-role, SDK pago, `.from`, `fetch`, `Object.assign`) reprova. Chamada nova aqui é
 * decisão de PR.
 */
const PERMITIDAS_ANTES_DO_GATE = new Set([
  'authorizeCronOrStaff',
  'Deno.env.get',
  'JSON.stringify',
  'req.json',
  'req.json().catch',
  'classificarSonda',
  'erroSondaAmbigua',
  'respostaSonda',
  'new Response',
]);

/** De onde têm de vir as duas funções que decidem. Homônimo local não é a mesma função. */
const ORIGEM = {
  authorizeCronOrStaff: '../_shared/auth.ts',
  exigirDonoPelaRls: '../_shared/dono-pela-rls.ts',
} as const;

const junta = (texto: string) => texto.replace(/\s+/g, ' ').trim();

function handlerDoServe(sf: ts.SourceFile): { corpo: ts.Block; parametros: string[] } | null {
  const achados: { corpo: ts.Block; parametros: string[] }[] = [];
  let chamadas = 0;
  const visitar = (no: ts.Node) => {
    if (ts.isCallExpression(no) && junta(no.expression.getText(sf)) === 'Deno.serve') {
      chamadas++;
      const [arg] = no.arguments;
      if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && ts.isBlock(arg.body)) {
        achados.push({ corpo: arg.body, parametros: arg.parameters.map((p) => junta(p.name.getText(sf))) });
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return chamadas === 1 && achados.length === 1 ? achados[0] : null;
}

/** Nomes de tudo que é CHAMADO (ou instanciado) dentro do nó, inclusive em função aninhada. */
function chamadasEm(no: ts.Node, sf: ts.SourceFile): string[] {
  const nomes: string[] = [];
  const visitar = (n: ts.Node) => {
    if (ts.isCallExpression(n)) nomes.push(junta(n.expression.getText(sf)));
    if (ts.isNewExpression(n)) nomes.push(`new ${junta(n.expression.getText(sf))}`);
    // Template etiquetado (sql`...`) executa a função da etiqueta: conta como chamada.
    if (ts.isTaggedTemplateExpression(n)) nomes.push(`etiqueta ${junta(n.tag.getText(sf))}`);
    ts.forEachChild(n, visitar);
  };
  visitar(no);
  return nomes;
}

/** `=`, `+=`, `??=`… — todo operador que GRAVA no lado esquerdo. */
const ehAtribuicao = (kind: ts.SyntaxKind) =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

/**
 * Quantas vezes cada nome é DECLARADO no arquivo, em qualquer escopo e por qualquer forma: import,
 * `const`/`let`/`var` (inclusive por destructuring), função, classe, parâmetro e variável de catch.
 * Um nome protegido declarado 2× é sombra: o uso mais abaixo pode se referir à outra declaração.
 */
function declaracoesPorNome(sf: ts.SourceFile): Map<string, number> {
  const contagem = new Map<string, number>();
  const conta = (nome: ts.Node | undefined) => {
    if (!nome) return;
    if (ts.isIdentifier(nome)) {
      contagem.set(nome.text, (contagem.get(nome.text) ?? 0) + 1);
    } else if (ts.isObjectBindingPattern(nome) || ts.isArrayBindingPattern(nome)) {
      for (const el of nome.elements) if (ts.isBindingElement(el)) conta(el.name);
    }
  };
  const visitar = (no: ts.Node) => {
    if (ts.isVariableDeclaration(no) || ts.isParameter(no)) conta(no.name);
    if (ts.isFunctionDeclaration(no) || ts.isClassDeclaration(no) || ts.isFunctionExpression(no)) conta(no.name);
    if (ts.isCatchClause(no)) conta(no.variableDeclaration?.name);
    if (ts.isImportClause(no)) conta(no.name);
    if (ts.isImportSpecifier(no) || ts.isNamespaceImport(no)) conta(no.name);
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return contagem;
}

/** O nome é importado, sem apelido, exatamente do módulo esperado? */
function importadoDe(sf: ts.SourceFile, nome: string, modulo: string): boolean {
  return sf.statements.some((st) =>
    ts.isImportDeclaration(st)
    && ts.isStringLiteral(st.moduleSpecifier)
    && st.moduleSpecifier.text === modulo
    && !!st.importClause?.namedBindings
    && ts.isNamedImports(st.importClause.namedBindings)
    && st.importClause.namedBindings.elements.some((el) => el.name.text === nome && !el.propertyName));
}

/**
 * Problemas de ligação do gate de dono na fonte de uma edge. Lista vazia = ligado certo.
 * Cada código é a MARCA de um ramo (os mutantes abaixo casam por ela).
 */
function problemasDaLigacao(fonte: string, alvo: Alvo): string[] {
  const sf = ts.createSourceFile('index.ts', fonte, ts.ScriptTarget.ESNext, true);
  const handler = handlerDoServe(sf);
  if (!handler) return ['HANDLER_NAO_ENCONTRADO'];
  const { corpo } = handler;
  const instrucoes = corpo.statements.map((s) => junta(s.getText(sf)));
  const problemas: string[] = [];

  // 1. A autenticação segue no topo do handler, na forma da casa.
  const iAuth = instrucoes.indexOf('const auth = await authorizeCronOrStaff(req);');
  if (iAuth < 0 || instrucoes[iAuth + 1] !== 'if (!auth.ok) return auth.response;') {
    problemas.push('AUTH_FORA_DA_FORMA');
  }

  // 2. O gate de dono: instrução do TOPO do handler (fora de if/try/laço/helper), com await, na
  //    tabela certa e no id certo — e a instrução SEGUINTE consome a decisão com return.
  const totalDeChamadas = chamadasEm(sf, sf).filter((n) => n === 'exigirDonoPelaRls').length;
  const formaDoGate = `const dono = await exigirDonoPelaRls(req, auth, "${alvo.tabela}", ${alvo.id});`;
  const iDono = instrucoes.indexOf(formaDoGate);
  if (totalDeChamadas === 0) {
    problemas.push('DONO_AUSENTE');
  } else if (iDono < 0) {
    problemas.push('DONO_FORA_DA_FORMA');
  } else {
    if (totalDeChamadas !== 1) problemas.push('DONO_DUPLICADO');
    if (instrucoes[iDono + 1] !== 'if (!dono.ok) return dono.response;') {
      problemas.push('DONO_DECISAO_IGNORADA');
    }
    if (iAuth < 0 || iDono < iAuth + 2) problemas.push('DONO_ANTES_DA_AUTENTICACAO');
    // 3. Nada além da lista fechada roda antes do gate.
    for (const instrucao of corpo.statements.slice(0, iDono)) {
      for (const nome of chamadasEm(instrucao, sf)) {
        if (!PERMITIDAS_ANTES_DO_GATE.has(nome)) problemas.push(`EFEITO_ANTES_DO_GATE:${nome}`);
      }
    }
    // 4. O id é um escalar `const` declarado no topo do handler, ANTES do gate.
    const iId = instrucoes.indexOf(alvo.declaracaoDoId);
    if (iId < 0 || iId > iDono) problemas.push('ALVO_NAO_E_CONST_DO_TOPO');
  }

  // 5. As duas funções que decidem são as IMPORTADAS dos módulos compartilhados, e os nomes que
  //    carregam a decisão têm UMA declaração só no arquivo — sem sombra em bloco aninhado, sem
  //    homônimo local, sem destructuring que troque a função.
  const declaracoes = declaracoesPorNome(sf);
  for (const [nome, modulo] of Object.entries(ORIGEM)) {
    if (!importadoDe(sf, nome, modulo) || declaracoes.get(nome) !== 1) problemas.push(`GATE_SOMBREADO:${nome}`);
  }
  if (handler.parametros.length !== 1 || handler.parametros[0] !== 'req') problemas.push('HANDLER_SEM_REQ');
  for (const nome of ['req', 'auth', 'dono', alvo.id]) {
    if (declaracoes.get(nome) !== 1) problemas.push(`NOME_SOMBREADO:${nome}`);
  }

  // 6. Ninguém regrava o principal, o request nem o id (`auth.via = "cron"` antes do gate o abriria).
  const protegidos = new Set(['auth', 'req', alvo.id]);
  const raizDe = (no: ts.Node): string => {
    // Desembrulha acesso, `!`, parênteses e cast: `(auth as X).via = …` grava em `auth` do mesmo jeito.
    let atual = no;
    while (
      ts.isPropertyAccessExpression(atual) || ts.isElementAccessExpression(atual) || ts.isNonNullExpression(atual)
      || ts.isParenthesizedExpression(atual) || ts.isAsExpression(atual) || ts.isTypeAssertionExpression(atual)
      || ts.isSatisfiesExpression(atual)
    ) {
      atual = atual.expression;
    }
    return junta(atual.getText(sf));
  };
  const procuraAtribuicao = (no: ts.Node) => {
    if (ts.isBinaryExpression(no) && ehAtribuicao(no.operatorToken.kind) && protegidos.has(raizDe(no.left))) {
      problemas.push('PRINCIPAL_OU_ALVO_REATRIBUIDO');
    }
    if ((ts.isPrefixUnaryExpression(no) || ts.isPostfixUnaryExpression(no)) && protegidos.has(raizDe(no.operand))
      && (no.operator === ts.SyntaxKind.PlusPlusToken || no.operator === ts.SyntaxKind.MinusMinusToken)) {
      problemas.push('PRINCIPAL_OU_ALVO_REATRIBUIDO');
    }
    if (ts.isDeleteExpression(no) && protegidos.has(raizDe(no.expression))) {
      problemas.push('PRINCIPAL_OU_ALVO_REATRIBUIDO');
    }
    ts.forEachChild(no, procuraAtribuicao);
  };
  procuraAtribuicao(corpo);

  // 7. O registro PROCESSADO é o registro AUTORIZADO: todo `.eq("id", …)` usa o id do gate.
  const visitar = (no: ts.Node) => {
    if (ts.isCallExpression(no) && ts.isPropertyAccessExpression(no.expression) && no.expression.name.text === 'eq') {
      const [coluna, valor] = no.arguments;
      if (coluna && ts.isStringLiteralLike(coluna) && coluna.text === 'id' && valor) {
        if (junta(valor.getText(sf)) !== alvo.id) problemas.push('ALVO_DIFERENTE_DO_GATE');
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(corpo);

  return problemas;
}

/** Identificadores usados em algum lugar da fonte (comentário e string não contam). */
function identificadoresUsados(fonte: string): Set<string> {
  const sf = ts.createSourceFile('index.ts', fonte, ts.ScriptTarget.ESNext, true);
  const nomes = new Set<string>();
  const visitar = (no: ts.Node) => {
    if (ts.isIdentifier(no)) nomes.add(no.text);
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return nomes;
}

/** Inicializador (texto) de cada propriedade `nome: <expr>` de objeto literal na fonte. */
function inicializadoresDe(fonte: string, nome: string): string[] {
  const sf = ts.createSourceFile('index.ts', fonte, ts.ScriptTarget.ESNext, true);
  const achados: string[] = [];
  const visitar = (no: ts.Node) => {
    if (ts.isPropertyAssignment(no) && junta(no.name.getText(sf)) === nome) {
      achados.push(junta(no.initializer.getText(sf)));
    }
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return achados;
}

/** Troca exatamente UMA ocorrência; se o padrão sumiu da fonte, o mutante não prova nada. */
function mutar(fonte: string, de: string, para: string): string {
  const partes = fonte.split(de);
  if (partes.length !== 2) throw new Error(`mutante sem alvo único (${partes.length - 1} ocorrências): ${de}`);
  return partes.join(para);
}

describe.each([KB, SINAIS])('gate de dono LIGADO em $arquivo', (alvo) => {
  const fonte = ler(alvo.arquivo);
  const gate = `  const dono = await exigirDonoPelaRls(req, auth, "${alvo.tabela}", ${alvo.id});\n`;
  const decisao = '  if (!dono.ok) return dono.response;\n';
  const inicioDoTry = '\n  try {\n';

  it('a fonte real passa: gate no topo do handler, decisão consumida, nenhum efeito antes', () => {
    expect(problemasDaLigacao(fonte, alvo)).toEqual([]);
  });

  it('o cliente service-role só nasce DEPOIS do gate', () => {
    expect(fonte.indexOf(gate)).toBeGreaterThan(-1);
    expect(fonte.indexOf('createClient(')).toBeGreaterThan(fonte.indexOf(gate));
  });

  it('mutante: gate removido → DONO_AUSENTE', () => {
    const m = mutar(mutar(fonte, gate, ''), decisao, '');
    expect(problemasDaLigacao(m, alvo)).toContain('DONO_AUSENTE');
  });

  it('mutante: decisão sem `return` → DONO_DECISAO_IGNORADA', () => {
    const m = mutar(fonte, decisao, '  if (!dono.ok) dono.response;\n');
    expect(problemasDaLigacao(m, alvo)).toContain('DONO_DECISAO_IGNORADA');
  });

  it('mutante: condição invertida (`if (dono.ok) return`) → DONO_DECISAO_IGNORADA', () => {
    const m = mutar(fonte, decisao, '  if (dono.ok) return dono.response;\n');
    expect(problemasDaLigacao(m, alvo)).toContain('DONO_DECISAO_IGNORADA');
  });

  it('mutante: decisão apagada → DONO_DECISAO_IGNORADA', () => {
    expect(problemasDaLigacao(mutar(fonte, decisao, ''), alvo)).toContain('DONO_DECISAO_IGNORADA');
  });

  it('mutante: gate sem `await` (a Promise é sempre truthy) → DONO_FORA_DA_FORMA', () => {
    const m = mutar(fonte, gate, gate.replace('await ', ''));
    expect(problemasDaLigacao(m, alvo)).toContain('DONO_FORA_DA_FORMA');
  });

  it('mutante: gate dentro de um ramo (`if (auth.via === "staff")`) → DONO_FORA_DA_FORMA', () => {
    const m = mutar(fonte, gate + decisao, `  if (auth.via === "staff") {\n  ${gate}  ${decisao}  }\n`);
    expect(problemasDaLigacao(m, alvo)).toContain('DONO_FORA_DA_FORMA');
  });

  it('mutante: gate dentro de try (o catch viraria escrita de erro) → DONO_FORA_DA_FORMA', () => {
    const m = mutar(fonte, gate + decisao, `  try {\n  ${gate}  ${decisao}  } catch { /* segue */ }\n`);
    expect(problemasDaLigacao(m, alvo)).toContain('DONO_FORA_DA_FORMA');
  });

  it('mutante: tabela trocada → DONO_FORA_DA_FORMA', () => {
    const m = mutar(fonte, gate, gate.replace(`"${alvo.tabela}"`, '"profiles"'));
    expect(problemasDaLigacao(m, alvo)).toContain('DONO_FORA_DA_FORMA');
  });

  it('mutante: gate autoriza OUTRO id → DONO_FORA_DA_FORMA', () => {
    const m = mutar(fonte, gate, gate.replace(`${alvo.id});`, 'body.outroId);'));
    expect(problemasDaLigacao(m, alvo)).toContain('DONO_FORA_DA_FORMA');
  });

  it('mutante: principal literal no gate (`{ via: "cron" }`) → DONO_FORA_DA_FORMA', () => {
    const m = mutar(fonte, gate, gate.replace('(req, auth,', '(req, { via: "cron" },'));
    expect(problemasDaLigacao(m, alvo)).toContain('DONO_FORA_DA_FORMA');
  });

  it('mutante: cliente service-role criado ANTES do gate → EFEITO_ANTES_DO_GATE:createClient', () => {
    const m = mutar(fonte, gate, `  const cedo = createClient("u", "k");\n${gate}`);
    expect(problemasDaLigacao(m, alvo)).toContain('EFEITO_ANTES_DO_GATE:createClient');
  });

  it('mutante: escrita por service-role ANTES do gate, dentro de helper → EFEITO_ANTES_DO_GATE', () => {
    const helper =
      '  async function cedo() { await createClient("u", "k").from("x").update({ a: 1 }).eq("k", "v"); }\n';
    const m = mutar(fonte, gate, `${helper}${gate}`);
    expect(problemasDaLigacao(m, alvo).some((p) => p.startsWith('EFEITO_ANTES_DO_GATE:'))).toBe(true);
  });

  it('mutante: gate DEPOIS de processar (movido para o fim do handler) → EFEITO_ANTES_DO_GATE', () => {
    const semGate = mutar(mutar(fonte, gate, ''), decisao, '');
    const fim = semGate.lastIndexOf('});');
    const m = `${semGate.slice(0, fim)}${gate}${decisao}  return new Response("ok");\n${semGate.slice(fim)}`;
    expect(problemasDaLigacao(m, alvo).some((p) => p.startsWith('EFEITO_ANTES_DO_GATE:'))).toBe(true);
  });

  it('mutante: efeito por template etiquetado antes do gate → EFEITO_ANTES_DO_GATE', () => {
    const m = mutar(fonte, gate, `  await sql\`update kb_documents set status = 'error'\`;\n${gate}`);
    expect(problemasDaLigacao(m, alvo)).toContain('EFEITO_ANTES_DO_GATE:etiqueta sql');
  });

  it('mutante: `await import()` antes do gate → EFEITO_ANTES_DO_GATE:import', () => {
    const m = mutar(fonte, gate, `  await import("npm:openai");\n${gate}`);
    expect(problemasDaLigacao(m, alvo)).toContain('EFEITO_ANTES_DO_GATE:import');
  });

  it('mutante: `Object.assign(auth, { via: "cron" })` antes do gate → EFEITO_ANTES_DO_GATE:Object.assign', () => {
    const m = mutar(fonte, gate, `  Object.assign(auth, { via: "cron" });\n${gate}`);
    expect(problemasDaLigacao(m, alvo)).toContain('EFEITO_ANTES_DO_GATE:Object.assign');
  });

  it('mutante: gate duplicado → DONO_DUPLICADO', () => {
    const m = mutar(fonte, decisao, `${decisao}  await exigirDonoPelaRls(req, auth, "${alvo.tabela}", "x");\n`);
    expect(problemasDaLigacao(m, alvo)).toContain('DONO_DUPLICADO');
  });

  it('mutante: principal forjado antes do gate (`auth.via = "cron"`, cru e com cast) → PRINCIPAL_OU_ALVO_REATRIBUIDO', () => {
    const cru = mutar(fonte, gate, `  auth.via = "cron";\n${gate}`);
    expect(problemasDaLigacao(cru, alvo)).toContain('PRINCIPAL_OU_ALVO_REATRIBUIDO');
    // Com cast a raiz fica embrulhada — o detector desembrulha parênteses e `as`.
    const comCast = mutar(fonte, gate, `  (auth as { via: string }).via = "cron";\n${gate}`);
    expect(problemasDaLigacao(comCast, alvo)).toContain('PRINCIPAL_OU_ALVO_REATRIBUIDO');
  });

  it('mutante: id regravado depois do gate → PRINCIPAL_OU_ALVO_REATRIBUIDO', () => {
    const m = mutar(fonte, decisao, `${decisao}  (${alvo.id} as string) = "outro";\n`);
    expect(problemasDaLigacao(m, alvo)).toContain('PRINCIPAL_OU_ALVO_REATRIBUIDO');
  });

  it('mutante: id declarado com `let` (regravável) → ALVO_NAO_E_CONST_DO_TOPO', () => {
    const m = mutar(fonte, `  ${alvo.declaracaoDoId}\n`, `  ${alvo.declaracaoDoId.replace('const ', 'let ')}\n`);
    expect(problemasDaLigacao(m, alvo)).toContain('ALVO_NAO_E_CONST_DO_TOPO');
  });

  it('mutante: id SOMBREADO dentro do try (os filtros passam a olhar outro registro) → NOME_SOMBREADO', () => {
    const m = mutar(fonte, inicioDoTry, `${inicioDoTry}    const ${alvo.id} = "id-de-outro-registro";\n`);
    expect(problemasDaLigacao(m, alvo)).toContain(`NOME_SOMBREADO:${alvo.id}`);
  });

  it('mutante: id sombreado por destructuring ou por parâmetro de helper → NOME_SOMBREADO', () => {
    const porDestructuring = mutar(fonte, inicioDoTry, `${inicioDoTry}    const { ${alvo.id} } = { ${alvo.id}: "outro" };\n`);
    expect(problemasDaLigacao(porDestructuring, alvo)).toContain(`NOME_SOMBREADO:${alvo.id}`);
    const porParametro = mutar(fonte, decisao, `${decisao}  const grava = async (${alvo.id}: string) => ${alvo.id};\n`);
    expect(problemasDaLigacao(porParametro, alvo)).toContain(`NOME_SOMBREADO:${alvo.id}`);
  });

  it('mutante: `auth` sombreado num bloco aninhado → NOME_SOMBREADO:auth', () => {
    const m = mutar(fonte, inicioDoTry, `${inicioDoTry}    const auth = { ok: true, via: "cron" };\n`);
    expect(problemasDaLigacao(m, alvo)).toContain('NOME_SOMBREADO:auth');
  });

  it('mutante: gate homônimo local (função içada, sem o import) → GATE_SOMBREADO:exigirDonoPelaRls', () => {
    const semImport = mutar(fonte, 'import { exigirDonoPelaRls } from "../_shared/dono-pela-rls.ts";\n', '');
    const m = `${semImport}\nasync function exigirDonoPelaRls(..._a: unknown[]) { return { ok: true as const, response: new Response() }; }\n`;
    expect(problemasDaLigacao(m, alvo)).toContain('GATE_SOMBREADO:exigirDonoPelaRls');
  });

  it('mutante: gate trocado por destructuring de um objeto permissivo → GATE_SOMBREADO:exigirDonoPelaRls', () => {
    const semImport = mutar(fonte, 'import { exigirDonoPelaRls } from "../_shared/dono-pela-rls.ts";\n', '');
    const m = `${semImport}\nconst { exigirDonoPelaRls } = { exigirDonoPelaRls: async (..._a: unknown[]) => ({ ok: true as const, response: new Response() }) };\n`;
    expect(problemasDaLigacao(m, alvo)).toContain('GATE_SOMBREADO:exigirDonoPelaRls');
  });

  it('mutante: gate importado de OUTRO módulo → GATE_SOMBREADO:exigirDonoPelaRls', () => {
    const m = mutar(fonte, 'from "../_shared/dono-pela-rls.ts";', 'from "./dono-de-mentira.ts";');
    expect(problemasDaLigacao(m, alvo)).toContain('GATE_SOMBREADO:exigirDonoPelaRls');
  });

  it('mutante: `authorizeCronOrStaff` local içada que devolve via "cron" → GATE_SOMBREADO:authorizeCronOrStaff', () => {
    const m = `${fonte}\nfunction authorizeCronOrStaff(_r: Request) { return { ok: true as const, via: "cron" as const }; }\n`;
    expect(problemasDaLigacao(m, alvo)).toContain('GATE_SOMBREADO:authorizeCronOrStaff');
  });

  it('mutante: uma escrita mira OUTRO id que não o autorizado → ALVO_DIFERENTE_DO_GATE', () => {
    const alvoDaEscrita = `.eq("id", ${alvo.id})`;
    const i = fonte.lastIndexOf(alvoDaEscrita);
    expect(i).toBeGreaterThan(-1);
    const m = `${fonte.slice(0, i)}.eq("id", body.outroId)${fonte.slice(i + alvoDaEscrita.length)}`;
    expect(problemasDaLigacao(m, alvo)).toContain('ALVO_DIFERENTE_DO_GATE');
  });
});

describe('kb-ingest-document: os chunks entram no documento AUTORIZADO', () => {
  const fonte = ler(KB.arquivo);

  it('`document_id` dos chunks é o id do gate, e o handler não volta a ler `body.documentId` depois de capturá-lo', () => {
    expect(inicializadoresDe(fonte, 'document_id')).toEqual(['documentId']);
    // 2 leituras: a validação (`if (!body.documentId)`) e a captura no escalar.
    expect(fonte.split('body.documentId').length - 1).toBe(2);
  });

  it('mutante: chunk gravado no id do body → o detector acusa', () => {
    const m = mutar(fonte, 'document_id: documentId,', 'document_id: body.documentId,');
    expect(inicializadoresDe(m, 'document_id')).not.toEqual(['documentId']);
  });
});

describe('extrair-sinais-ligacao: a identidade do envelope sai da LINHA, não do body', () => {
  const fonte = ler(SINAIS.arquivo);

  it('o handler não lê `customerUserId`/`farmerId` do body', () => {
    const usados = identificadoresUsados(fonte);
    expect(usados.has('customerUserId')).toBe(false);
    expect(usados.has('farmerId')).toBe(false);
  });

  it('`customer_user_id` e `farmer_id` do envelope vêm de `ligacao.*`', () => {
    expect(inicializadoresDe(fonte, 'customer_user_id')).toEqual(['ligacao.customer_user_id ?? null']);
    expect(inicializadoresDe(fonte, 'farmer_id')).toEqual(['ligacao.farmer_id ?? null']);
  });

  it('a leitura da ligação separa ERRO de ausência, e as duas saem antes do LLM', () => {
    const iLeitura = fonte.indexOf('.select("sinais_ligacao, customer_user_id, farmer_id")');
    const iErro = fonte.indexOf('if (leituraErro) {');
    const iAusente = fonte.indexOf('if (!ligacao) {');
    const iLlm = fonte.indexOf('new Anthropic(');
    expect(iLeitura).toBeGreaterThan(-1);
    expect(iErro).toBeGreaterThan(iLeitura);
    expect(iAusente).toBeGreaterThan(iErro);
    expect(iLlm).toBeGreaterThan(iAusente);
  });

  it('mutante: envelope volta a usar o id do body → o detector acusa', () => {
    const m = mutar(fonte, 'customer_user_id: ligacao.customer_user_id ?? null,', 'customer_user_id: body.customerUserId ?? null,');
    expect(inicializadoresDe(m, 'customer_user_id')).not.toEqual(['ligacao.customer_user_id ?? null']);
    expect(identificadoresUsados(m).has('customerUserId')).toBe(true);
  });
});

describe('o gate compartilhado nunca fala com o banco como service-role', () => {
  const fonte = ler('supabase/functions/_shared/dono-pela-rls.ts');

  it('não lê SUPABASE_SERVICE_ROLE_KEY (com ela a sonda diria "pode" para qualquer um)', () => {
    expect(fonte).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(fonte).toContain('Deno.env.get("SUPABASE_ANON_KEY")');
  });

  it('só `cron` e `service_role` dispensam a sonda, por lista explícita', () => {
    expect(fonte).toContain('if (principal.via === "cron" || principal.via === "service_role") return { ok: true, por: "servidor" };');
    expect(fonte).not.toMatch(/via\s*!==\s*"staff"\)\s*return\s*\{\s*ok:\s*true/);
  });
});
