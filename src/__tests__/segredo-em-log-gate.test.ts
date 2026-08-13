import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ── GATE ESTRUTURAL da classe "segredo publicado em log" ────────────────────────────────
//
// Achado na auditoria do G6 (#1623), fora do escopo daquela entrega: o `omie-sync` fazia
//   `console.log(`[Omie API] Payload:`, JSON.stringify(body, null, 2))`
// com `body = { call, app_key, app_secret, param }` — app_key e app_secret INTEIROS, a cada
// invocação, para um log que fica RETIDO e visível no painel do Supabase/Lovable.
//
// A classe já tinha meia-lição registrada no repo: `redigirSegredo` (_shared/omie-falha.ts)
// nasceu porque a faultstring do Omie ECOA a app_key ("Chave de acesso não cadastrada para o
// aplicativo [1503123456]") e ia crua para tabela e toast (money-path §"O MARCADOR mente",
// corolário de privacidade). Aquela entrega fechou o caminho da MENSAGEM DE ERRO e deixou
// aberto o caminho do LOG — que é o mesmo vazamento, por outra porta, e mais barato de
// cometer. Meta-regra do repo: classe com contramedida textual reincide; classe com gate
// estrutural para. Este arquivo é o gate.
//
// Por que TEXTUAL (readFileSync, padrão paginacao-artesanal-gate/edge-money-path-invariants):
// os sites vivem em edges Deno que o vitest não executa e o tsc do app não checa — um teste
// que lê FONTE cobre src/ e supabase/functions/ com um contrato só, e roda no CI `validate`.
//
// CONTRATO: nenhum `console.*` recebe (a) um objeto que carrega credencial, (b) um campo de
// credencial, ou (c) o valor de uma env sensível — a menos que passe por `redigirSegredo`.

const RAIZ = resolve(__dirname, '../..');

// `scripts/` entra por completude (varredura 2026-07-30: zero sites lá).
const DIRS = ['src', 'supabase/functions', 'scripts'];

const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.test\.|_test\.|\.d\.ts$|__tests__|\.stories\.)/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    const abs = resolve(RAIZ, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listarFontes(rel, acc);
    } else if (EXT.test(nome) && !IGNORAR.test(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

// Comentário de linha inteira e bloco saem antes dos padrões — senão a prosa que DESCREVE o
// defeito (o cabeçalho do omie-sync corrigido cita `app_key`/`app_secret` de propósito)
// dispararia o gate (lição #1472/#1488: comentário que dispara o fiscal é falso sinal).
function semComentarios(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

// Apaga o TEXTO das strings e PRESERVA o interior de `${…}` dos templates. É o que separa
// `console.warn("app_key desconhecido:", x)` — rótulo, inofensivo — de `console.warn(x.appKey)`,
// que é o vazamento. Sem isto, todo log que NOMEIA a credencial no rótulo ficaria vermelho, e
// falso-vermelho tem uma saída natural péssima: afrouxar a regra (§#1483).
function semTextoDeString(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const aspas = c;
      i++;
      while (i < s.length && s[i] !== aspas) {
        if (s[i] === '\\') i++;
        if (s[i] === '\n') break;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    if (c === '`') {
      i++;
      out += '`';
      let prof = 0;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (prof === 0 && s[i] === '`') { i++; break; }
        if (prof === 0 && s[i] === '$' && s[i + 1] === '{') { prof = 1; out += '${'; i += 2; continue; }
        if (prof > 0) {
          if (s[i] === '{') prof++;
          if (s[i] === '}') { prof--; out += '}'; i++; continue; }
          out += s[i];
          i++;
          continue;
        }
        i++;
      }
      out += '`';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Extrai os argumentos de cada `console.*` com parênteses BALANCEADOS. */
function argumentosDeConsole(fonte: string): Array<{ pos: number; args: string }> {
  const res: Array<{ pos: number; args: string }> = [];
  const re = /console\.(log|info|warn|error|debug|trace)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fonte)) !== null) {
    let i = m.index + m[0].length;
    const ini = i;
    let prof = 1;
    while (i < fonte.length && prof > 0) {
      if (fonte[i] === '(') prof++;
      else if (fonte[i] === ')') prof--;
      i++;
    }
    res.push({ pos: m.index, args: fonte.slice(ini, i - 1) });
  }
  return res;
}

// Remove as chamadas `redigirSegredo(…)` (balanceadas) do texto antes de julgar. É assim que a
// SAÍDA CORRETA fica verde: `redigirSegredo(String(payload.appKey))` some, e o que sobra é o que
// vaza. Gate que proíbe a menção sem oferecer saída empurra o autor a apagar o log — perder o
// diagnóstico não era o objetivo.
function semRedacao(s: string): string {
  let out = s;
  for (;;) {
    const i = out.indexOf('redigirSegredo(');
    if (i === -1) return out;
    let j = i + 'redigirSegredo('.length;
    let prof = 1;
    while (j < out.length && prof > 0) {
      if (out[j] === '(') prof++;
      else if (out[j] === ')') prof--;
      j++;
    }
    out = out.slice(0, i) + out.slice(j);
  }
}

// Campos que TORNAM um objeto credencial. Ancorados (`\b`) e específicos de propósito: `token`
// solto casaria `MAX_TOKENS` e `usage.input_tokens` do LLM, e `secret` solto casaria `secretsOk`
// — os três medidos no repo como falso positivo da 1ª versão da assinatura. Dívida falsa ensina
// a ignorar a lista, então o detector nasce sem elas.
const CAMPO_CRED = /\b(app_?key|app_?secret|api_?key|client_?secret|access_?token|refresh_?token|service_?role_?key|authorization|bearer|senha|password)\b/i;

/** Nomes de variáveis atribuídas a um objeto literal que contém campo de credencial. */
function varsComCredencial(fonte: string): Set<string> {
  const nomes = new Set<string>();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,120})?=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fonte)) !== null) {
    let i = m.index + m[0].length;
    const ini = i;
    let prof = 1;
    while (i < fonte.length && prof > 0) {
      if (fonte[i] === '{') prof++;
      else if (fonte[i] === '}') prof--;
      i++;
    }
    const corpo = fonte.slice(ini, i - 1);
    // Campo de credencial como PROPRIEDADE do literal (`app_key: X` ou shorthand `app_key,`).
    if (/(^|[\s,{])(app_?key|app_?secret|api_?key|client_?secret|access_?token|refresh_?token|authorization)\s*[:,]/i.test(corpo)) {
      nomes.add(m[1]);
    }
  }
  return nomes;
}

// ── S1: objeto que CARREGA credencial indo INTEIRO para o log ─────────────────────────
// A forma-mãe (controle: omie-sync pré-fix). `body` sozinho vaza tudo; `body.param` é o campo
// sem credencial e NÃO pode ficar vermelho — é a correção. Daí a regra ser "o nome NÃO seguido
// de `.`": acesso a campo é julgado pelo S2, que sabe quais campos são credencial.
// O `...` vira espaço antes do teste para o spread (`{...body}`) não escapar pelo lookbehind.
function sitesS1(fonte: string): string[] {
  const vars = varsComCredencial(fonte);
  if (vars.size === 0) return [];
  const achados: string[] = [];
  for (const { args } of argumentosDeConsole(fonte)) {
    const alvo = semRedacao(args).replace(/\.\.\./g, ' ');
    for (const v of vars) {
      if (new RegExp(`(?<![\\w$.])${v}(?![\\w$])(?!\\s*\\.)`).test(alvo)) {
        achados.push(v);
        break;
      }
    }
  }
  return achados;
}

// ── S2: campo de credencial na EXPRESSÃO do log ───────────────────────────────────────
// Controle: omie-webhook pré-fix (`console.warn("[auth] app_key desconhecido:", payload.appKey)`
// — o rótulo em string é inofensivo, a expressão é o vazamento). Cobre também o objeto literal
// montado DENTRO do console (`console.log({ app_key: k })`), forma que o S1 não vê por não ter
// nome de variável.
function sitesS2(fonte: string): string[] {
  const achados: string[] = [];
  for (const { args } of argumentosDeConsole(fonte)) {
    const expr = semRedacao(args).replace(/""/g, '');
    const m = CAMPO_CRED.exec(expr);
    if (m) achados.push(m[1]);
  }
  return achados;
}

// ── S3: valor de env sensível lido DENTRO do log ──────────────────────────────────────
// `console.log(Deno.env.get("OMIE_COLACOR_APP_KEY"))` não passa por variável nenhuma e não tem
// campo de objeto — escapa de S1 e S2. Aqui o nome vive numa STRING, então este é o único
// detector que roda sobre a fonte com as strings INTACTAS.
function sitesS3(fonte: string): string[] {
  const achados: string[] = [];
  // `!!Deno.env.get(X)` / `Boolean(Deno.env.get(X))` logam a PRESENÇA, não o valor — é a forma
  // correta, e barrá-la deixaria o gate proibindo o padrão que ele quer promover.
  const re = /(!\s*|Boolean\s*\(\s*)?(?:Deno\.env\.get|process\.env)\s*[(.[]\s*["'`]?([A-Z0-9_]*(?:KEY|SECRET|TOKEN|SENHA|PASSWORD))/g;
  for (const { args } of argumentosDeConsole(fonte)) {
    for (const m of semRedacao(args).matchAll(re)) {
      if (m[1]) continue;
      achados.push(m[2]);
    }
  }
  return achados;
}

// LIMITAÇÃO CONHECIDA (registrada, não é descuido — a versão completa exigiria AST/dataflow):
//  · log INDIRETO escapa — `const msg = JSON.stringify(body); console.log(msg)`. Não existe no
//    repo hoje (medido); a forma direta, que é a barata de cometer, é a que o gate barra.
//  · S1 só reconhece objeto literal atribuído a `const/let/var`. Objeto montado inline no
//    `fetch({ body: JSON.stringify({ app_key … }) })` não tem nome — mas também não tem como
//    ser logado por nome, e se for montado dentro do console o S2 o pega.

function medir(detector: (fonte: string) => string[]): Map<string, string[]> {
  const mapa = new Map<string, string[]>();
  for (const dir of DIRS) {
    for (const arquivo of listarFontes(dir)) {
      const bruto = semComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      // S3 precisa das strings; S1/S2 precisam delas apagadas. O detector recebe a fonte já
      // preparada por ele mesmo — aqui passamos a versão com strings, e S1/S2 apagam.
      const achados = detector(bruto);
      if (achados.length > 0) mapa.set(arquivo, achados);
    }
  }
  return mapa;
}

const semStrings = (f: string) => semTextoDeString(f);

function formatar(m: Map<string, string[]>): string[] {
  return [...m].map(([a, v]) => `${a} (${v.join(', ')})`);
}

describe('gate estrutural: segredo publicado em log (classe do omie-sync, achada no G6/#1623)', () => {
  it('sentinela: o walker anda de verdade (glob quebrado = verde eterno, ausência de sinal ≠ aprovação)', () => {
    const fontes = DIRS.flatMap((d) => listarFontes(d));
    expect(fontes.length, 'walker listou fontes de menos — glob/recursão quebrada').toBeGreaterThan(500);
    expect(fontes, 'a edge do achado sumiu da varredura').toContain('supabase/functions/omie-sync/index.ts');
    expect(fontes, 'a edge do webhook sumiu da varredura').toContain('supabase/functions/omie-webhook/index.ts');
  });

  it('sentinela de COBERTURA: o detector ENXERGA as edges que carregam credencial', () => {
    // O jeito deste gate mentir não é ficar vermelho à toa — é medir ZERO por cegueira e passar
    // por auditoria (§"O DETECTOR mente"). Um zero de S1 só significa "ninguém loga o objeto" se
    // o detector de fato reconhece o objeto: 19 edges montam `const body = { …app_key… }`
    // (medido 2026-07-30) e só o omie-sync o mandava ao console. Se este piso cair, o zero de S1
    // virou vácuo e a varredura precisa ser refeita ANTES de confiar no verde.
    const comCredencial = DIRS.flatMap((d) => listarFontes(d)).filter(
      (a) => varsComCredencial(semStrings(semComentarios(readFileSync(resolve(RAIZ, a), 'utf8')))).size > 0,
    );
    expect(
      comCredencial.length,
      'o detector deixou de reconhecer o objeto-com-credencial — o zero de S1 passou a ser cegueira, não limpeza',
    ).toBeGreaterThanOrEqual(15);
    // As irmãs do achado, nomeadas: elas construem o body com credencial E não o logam. É essa
    // dupla afirmação que faz da varredura uma prova, e não uma amostra.
    for (const irma of [
      'supabase/functions/omie-analytics-sync/index.ts',
      'supabase/functions/omie-vendas-sync/index.ts',
      'supabase/functions/omie-cliente/index.ts',
      'supabase/functions/process-nfe/index.ts',
      'supabase/functions/verify-employee/index.ts',
    ]) {
      expect(comCredencial, `o detector parou de enxergar a credencial em ${irma}`).toContain(irma);
    }
  });

  it('S1: nenhum objeto com credencial vai inteiro para console.*', () => {
    const medido = medir((f) => sitesS1(semStrings(f)));
    expect(
      formatar(medido),
      'VAZAMENTO: objeto que carrega app_key/app_secret indo INTEIRO para o log da edge — o log ' +
        'fica retido e visível no painel. Logue os campos não-sensíveis (`call`, `endpoint`, ' +
        '`body.param`) ou passe por `redigirSegredo` (_shared/omie-falha.ts). Arquivos:',
    ).toEqual([]);
  });

  it('S2: nenhum campo de credencial na expressão de um console.*', () => {
    const medido = medir((f) => sitesS2(semStrings(f)));
    expect(
      formatar(medido),
      'VAZAMENTO: campo de credencial avaliado dentro de um log (o rótulo em string é permitido; ' +
        'o VALOR não). Passe por `redigirSegredo` (_shared/omie-falha.ts). Arquivos:',
    ).toEqual([]);
  });

  it('S3: nenhum valor de env sensível lido dentro de um console.*', () => {
    const medido = medir(sitesS3);
    expect(
      formatar(medido),
      'VAZAMENTO: `Deno.env.get("…KEY/SECRET/TOKEN")` avaliado dentro de um log. Logue a ' +
        'PRESENÇA (`!!Deno.env.get(...)`), nunca o valor. Arquivos:',
    ).toEqual([]);
  });

  it('S1 (controle de calibração): a forma pré-fix do omie-sync é detectada; a pós-fix não', () => {
    // Trecho REAL removido por este PR. Se o S1 não casar isto, o gate perdeu o dente e todo
    // verde dele é vácuo.
    const preFix = semStrings(`
  const body = {
    call,
    app_key: OMIE_APP_KEY,
    app_secret: OMIE_APP_SECRET,
    param: [params],
  };
  console.log(\`[Omie API] Payload:\`, JSON.stringify(body, null, 2));`);
    expect(sitesS1(preFix), 'S1 deixou de casar o controle pré-fix do omie-sync').toEqual(['body']);

    // O pós-fix REAL: só o `param`, que não tem credencial. Ficar vermelho aqui seria
    // falso-vermelho sobre a própria correção — e a saída natural disso é afrouxar a regra.
    const posFix = semStrings(`
  const body = {
    call,
    app_key: OMIE_APP_KEY,
    app_secret: OMIE_APP_SECRET,
    param: [params],
  };
  console.log(\`[Omie API] Param:\`, JSON.stringify(body.param, null, 2));`);
    expect(sitesS1(posFix), 'S1 casa o pós-fix — falso positivo de calibração').toEqual([]);

    // Spread não pode ser rota de fuga: `{...body}` vaza os mesmos campos que `body`.
    const spread = semStrings(`
  const body = { call, app_key: K, app_secret: S, param: [p] };
  console.log("payload", { ...body });`);
    expect(sitesS1(spread), 'S1 deixou o spread escapar — `{...body}` vaza igual').toEqual(['body']);

    // Template literal: o interior de \${…} é expressão, e é onde o objeto entraria.
    const template = semStrings(`
  const body = { call, app_key: K, app_secret: S };
  console.log(\`payload=\${JSON.stringify(body)}\`);`);
    expect(sitesS1(template), 'S1 não enxerga dentro de ${…} do template').toEqual(['body']);

    // Objeto SEM credencial não entra no gate — senão todo log de payload de negócio (o
    // `osParams` do omie-sync, o `payload` do PedidoVenda) ficaria vermelho sem vazar nada.
    const semCredencial = semStrings(`
  const osParams = { Cabecalho: c, Observacoes: o };
  console.log("[Omie] Payload OS:", JSON.stringify(osParams, null, 2));`);
    expect(sitesS1(semCredencial), 'S1 alcançou objeto de negócio sem credencial').toEqual([]);
  });

  it('S2 (controle de calibração): a forma pré-fix do omie-webhook é detectada; a redigida não', () => {
    const preFix = semStrings(
      '      console.warn("[auth] app_key desconhecido:", payload.appKey || payload.author);',
    );
    expect(sitesS2(preFix), 'S2 deixou de casar o controle pré-fix do omie-webhook').toEqual(['appKey']);

    const posFix = semStrings(`
      console.warn(
        "[auth] app_key desconhecido:",
        redigirSegredo(String(payload.appKey || payload.author || "")),
      );`);
    expect(sitesS2(posFix), 'S2 casa a saída REDIGIDA — o gate estaria proibindo a correção').toEqual([]);

    // O rótulo em string nomeia a credencial e é inofensivo. Sem esta distinção o gate seria
    // falso-vermelho em todo log honesto que diz DE QUE credencial está falando.
    const soRotulo = semStrings('    console.error("CEP_ABERTO_TOKEN ausente — defina a secret no Supabase.");');
    expect(sitesS2(soRotulo), 'S2 confundiu rótulo em string com valor').toEqual([]);

    // Objeto literal montado DENTRO do console — o S1 não vê (não tem nome), o S2 tem de ver.
    const inline = semStrings('    console.log("req", { call, app_key: k, app_secret: s });');
    expect(sitesS2(inline), 'S2 deixou passar o literal montado dentro do console').toEqual(['app_key']);

    // Falsos positivos MEDIDOS no repo com a 1ª assinatura (token/secret soltos): os três têm de
    // continuar verdes, senão a baseline nasce com dívida falsa.
    for (const inocente of [
      '    console.log(`max_tokens=${MAX_TOKENS}`);',
      '    console.log(`in=${usage.input_tokens} out=${usage.output_tokens}`);',
      '    console.log(`secrets=${secretsOk}`);',
    ]) {
      expect(sitesS2(semStrings(inocente)), `S2 falso-positivo em: ${inocente.trim()}`).toEqual([]);
    }
  });

  it('S3 (controle de calibração): env sensível no log é detectada; a checagem de presença não', () => {
    const vaza = '    console.log("key:", Deno.env.get("OMIE_COLACOR_APP_KEY"));';
    expect(sitesS3(vaza), 'S3 deixou de casar a env sensível dentro do log').toEqual(['OMIE_COLACOR_APP_KEY']);

    // Logar a PRESENÇA é o padrão correto e tem de passar — é a forma que o repo já usa para
    // dizer "secret não configurado" sem publicar o valor.
    const presenca = '    console.log("configurado:", !!Deno.env.get("OMIE_COLACOR_APP_KEY"));';
    expect(sitesS3(presenca), 'S3 barrou a checagem de PRESENÇA — a saída correta ficaria vermelha').toEqual([]);

    const naoSensivel = '    console.log("url:", Deno.env.get("SUPABASE_URL"));';
    expect(sitesS3(naoSensivel), 'S3 alcançou env não sensível').toEqual([]);
  });
});
