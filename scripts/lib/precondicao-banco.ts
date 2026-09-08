/**
 * precondicao-banco.ts — a PRÉ-CONDIÇÃO de banco de uma leva de edges, como ARTEFATO (lógica pura).
 *
 * Por quê (#2285, `docs/historico/ordem-entre-camadas-do-mesmo-pr.md`): a migration escreveu no
 * próprio cabeçalho *"esta migration PRIMEIRO, o deploy da edge DEPOIS"* — e a edge foi ao ar
 * servindo por **≥2h25** uma RPC que não existia. Ninguém desobedeceu: **ninguém foi perguntado**,
 * porque nada no caminho do deploy lê aquele parágrafo. O doc fechou com a regra:
 *
 *   > a dependência tem de existir como ARTEFATO VERIFICÁVEL, não como parágrafo.
 *
 * O `preflight:rpcs` já sabe QUAIS RPCs uma edge chama (e declara quando a lista está furada, exit
 * 3). O que faltava é o outro lado: MEDIR essas RPCs em prod e **recusar a colagem da edge** quando
 * o banco ainda não as tem. Sem isso, `preflight:rpcs` é a mesma prosa executável do cabeçalho —
 * emite a query e confia que alguém rode.
 *
 * ⚠️ QUATRO eixos fail-closed, e nenhum cobre o outro:
 *   1. `fim` ausente         → saída truncada. Sem o marcador, uma resposta cortada não tem
 *                              ausência NENHUMA e leria como "tudo presente" (o falso verde-mãe).
 *   2. `funcoesPublic === 0` → a query não enxergou o catálogo. Zero aqui é AUSÊNCIA DE DADO, não
 *                              "prod não tem funções" — é o controle positivo que o #2285 exige
 *                              nominalmente ("um zero sem controle é ausência de dado").
 *   3. `indirecoes > 0`      → o extrator SABE que a lista de RPCs está incompleta. Liberar sobre
 *                              lista furada é prometer uma cobertura que não se mediu.
 *   4. `dialetoOk === false` → emissor e parser divergiram. Este eixo nasceu de um defeito REAL
 *                              desta lib (v1 lia `t`/`f`; o cast devolve `true`/`false`) que os
 *                              testes não pegaram porque o fixture FABRICOU o formato em vez de
 *                              medi-lo. Um teste que inventa o dialeto valida a si mesmo.
 *
 * O eixo 2 tem um IRMÃO FINO — `familia`, as RPCs de mesmo prefixo. Ele separa dois "ausente" que
 * pedem AÇÕES OPOSTAS: família povoada ⇒ o domínio existe e falta ESTA migration (aplique-a);
 * família vazia ⇒ o domínio inteiro não está em prod, ou o nome está errado (não cole nada, vá
 * diagnosticar). Um "ausente" sem essa distinção manda reaplicar migration sobre um diagnóstico
 * que ninguém fez.
 *
 * ## O que este gate NÃO mede: a ASSINATURA (declarado, não deduzido)
 *
 * A sonda casa `pg_proc.proname` — o NOME. Ela responde *"foi criada?"* e é CEGA para *"foi
 * alterada?"*: uma RPC antiga, de mesmo nome e assinatura incompatível com a que a edge chama,
 * conta como PRESENTE e o gate libera. O erro sai em runtime, com a mesma cara do #2285
 * (`Could not find the function … in the schema cache`) — só que depois do deploy.
 *
 * Fica declarado, e não corrigido, por PRECISÃO > RECALL (money-path). Conferir assinatura exige
 * saber a assinatura ESPERADA, que só existe no call-site (`db.rpc(nome, { a, b })`) — um segundo
 * extrator, com cegueiras próprias (arg por variável, spread, objeto montado antes), cujo modo de
 * falha é o BLOQUEIO FALSO. E gate de deploy que bloqueia sem razão não é conservador: ele ensina
 * o operador a contorná-lo, e aí não gateia mais nada. O eixo 3 (`indirecoes`) já mostra o preço
 * de extrair do call-site, e ali a resposta errada era só INCERTA.
 *
 * **Gatilho de reentrada** (o mesmo formato do limite "só função, não coluna"): o primeiro
 * incidente em que a RPC EXISTIA e mesmo assim a edge quebrou por contrato — assinatura, tipo de
 * retorno ou overload ambíguo. Até lá, o que cobre este buraco é a ordem canônica, não este gate:
 * DDL primeiro, e a migration que ALTERA uma função em uso declara isso no cabeçalho.
 */

/** Marca de formato que a sonda carimba no marcador de fim; o parser recusa outra. */
export const FORMATO_SONDA = 'precondicao-banco/2';

/**
 * Os tokens que a sonda emite para "existe". EXPLÍCITOS de propósito: a v1 deste arquivo lia
 * `existe::text` esperando `t`/`f` — a representação de EXIBIÇÃO do psql — e o cast devolve
 * `true`/`false`. Resultado medido em prod: **as 5 RPCs de `disparar-pedidos-aprovados` foram
 * dadas como AUSENTES estando todas presentes.** O fail-closed segurou (virou bloqueio, não falso
 * verde), mas a ferramenta teria sido desligada no primeiro uso.
 *
 * O erro real não foi o token: foi o TESTE ter fabricado o formato em vez de medi-lo. Por isso o
 * conserto não é trocar a string — é o `AUTOTESTE` abaixo, que faz a própria sonda provar, a cada
 * execução, que emissor e parser falam o mesmo dialeto.
 */
export const TOKEN_SIM = 'SIM';
export const TOKEN_NAO = 'NAO';

/** Nome de RPC aceitável para interpolar na sonda. Idêntico ao que o extrator literal produz. */
const NOME_RPC = /^[a-z][a-z0-9_]*$/;

/** Uma RPC que a leva chama, e quais edges dependem dela. */
export interface AlvoRpc {
  rpc: string;
  edges: string[];
}

/** O que prod respondeu sobre uma RPC. */
interface MedicaoRpc {
  rpc: string;
  existe: boolean;
  /** Irmãs em `public` com o mesmo prefixo de família — o controle fino do cabeçalho. */
  familia: number;
}

export interface LeituraSonda {
  medicoes: MedicaoRpc[];
  /** Total de funções em `public` — o controle GROSSO: 0 = a query não enxergou o catálogo. */
  funcoesPublic: number;
  /** O marcador de fim apareceu com o formato esperado. */
  fim: boolean;
  /**
   * A sonda provou, nesta execução, que emissor e parser falam o mesmo dialeto — as duas linhas
   * de `autoteste` foram lidas com o valor que elas próprias declaram.
   */
  dialetoOk: boolean;
}

/**
 * Agrupa as RPCs da leva por nome, somando quem chama cada uma.
 *
 * Recebe pares (edge, rpc) porque duas edges da mesma leva podem depender da MESMA migration —
 * e o relatório precisa nomear as duas, senão o operador destrava uma e a outra segue quebrada.
 */
export function agruparAlvos(pares: readonly { edge: string; rpc: string }[]): AlvoRpc[] {
  const porRpc = new Map<string, Set<string>>();
  for (const { edge, rpc } of pares) {
    const s = porRpc.get(rpc) ?? new Set<string>();
    s.add(edge);
    porRpc.set(rpc, s);
  }
  return [...porRpc.entries()]
    .map(([rpc, edges]) => ({ rpc, edges: [...edges].sort((a, b) => a.localeCompare(b, 'en')) }))
    .sort((a, b) => a.rpc.localeCompare(b.rpc, 'en'));
}

/** O prefixo de família de uma RPC: tudo antes do primeiro `_`. */
export function familiaDe(rpc: string): string {
  const i = rpc.indexOf('_');
  return i < 0 ? rpc : rpc.slice(0, i);
}

/**
 * Monta a sonda read-only. Lê o CATÁLOGO (`pg_proc`), nunca INVOCA a função — invocar mente nos
 * dois sentidos e sob `psql-ro` devolveria `permission denied`, que é o REVOKE funcionando se
 * apresentando como falha da migration (`docs/agent/database.md` §2, FU4-E).
 *
 * Recusa nome fora de `NOME_RPC` em vez de escapar: a lista vem de um extrator que só emite
 * literais, então um nome estranho aqui é bug a montante — e interpolar o que não se reconhece é
 * como se constrói injeção.
 */
export function montarSondaPrecondicao(rpcs: readonly string[]): string {
  if (rpcs.length === 0) {
    throw new Error('montarSondaPrecondicao: lista vazia — sem RPC não há pré-condição a medir');
  }
  const ruins = rpcs.filter((r) => !NOME_RPC.test(r));
  if (ruins.length > 0) {
    throw new Error(
      `montarSondaPrecondicao: nome de RPC fora do formato literal: ${ruins.join(', ')} — ` +
        'o extrator só emite literais, então isto é bug a montante, não caso a escapar',
    );
  }
  const valores = [...new Set(rpcs)]
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((r) => `('${r}')`)
    .join(', ');
  const EM_PUBLIC = "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'";
  return [
    `WITH esperadas(nome) AS (VALUES ${valores}), med AS (`,
    `  SELECT e.nome,`,
    `         CASE WHEN EXISTS (SELECT 1 ${EM_PUBLIC} AND p.proname = e.nome)`,
    `              THEN '${TOKEN_SIM}' ELSE '${TOKEN_NAO}' END AS existe,`,
    `         (SELECT count(*) ${EM_PUBLIC} AND p.proname LIKE split_part(e.nome, '_', 1) || '\\_%') AS familia`,
    `  FROM esperadas e)`,
    `SELECT tipo, nome, v1, v2 FROM (`,
    `  SELECT 1 AS ord, 'rpc' AS tipo, nome, existe AS v1, familia::text AS v2 FROM med`,
    `  UNION ALL SELECT 2, 'controle', 'funcoes_public', (SELECT count(*) ${EM_PUBLIC})::text, ''`,
    // O autoteste de dialeto: dois valores cuja resposta é conhecida ANTES de perguntar. Se o
    // parser não os reproduzir, ele não entende o que o banco fala — e nenhuma outra linha desta
    // saída pode ser acreditada, inclusive as que dizem "presente".
    `  UNION ALL SELECT 3, 'autoteste', 'presente', '${TOKEN_SIM}', ''`,
    `  UNION ALL SELECT 3, 'autoteste', 'ausente', '${TOKEN_NAO}', ''`,
    `  UNION ALL SELECT 4, 'fim', '${FORMATO_SONDA}', '', ''`,
    `) x ORDER BY ord, nome;`,
  ].join('\n');
}

/**
 * Lê a saída do `psql -A -F '|' -t`. Linha que não casa o formato é IGNORADA aqui e cobrada no
 * julgamento pelos marcadores: um parser que "conserta" o que não entendeu esconde exatamente a
 * truncagem que o eixo 1 existe para pegar.
 */
export function parsearSondaPrecondicao(saida: string): LeituraSonda {
  const medicoes: MedicaoRpc[] = [];
  let funcoesPublic = 0;
  let fim = false;
  let autoPresente = false;
  let autoAusente = false;
  for (const bruta of saida.split('\n')) {
    const linha = bruta.trim();
    if (linha === '') continue;
    const campos = linha.split('|');
    const [tipo, nome, v1, v2] = campos;
    if (tipo === 'rpc' && campos.length >= 4 && nome !== undefined) {
      // `=== TOKEN_SIM` e não `!== TOKEN_NAO`: campo truncado, vazio ou desconhecido vira
      // AUSENTE, nunca presente. A assimetria manda no default — fail-closed no lado que dói.
      medicoes.push({
        rpc: nome,
        existe: v1 === TOKEN_SIM,
        familia: Number.parseInt(v2 ?? '', 10) || 0,
      });
    } else if (tipo === 'controle' && nome === 'funcoes_public') {
      funcoesPublic = Number.parseInt(v1 ?? '', 10) || 0;
    } else if (tipo === 'autoteste' && nome === 'presente') {
      autoPresente = v1 === TOKEN_SIM;
    } else if (tipo === 'autoteste' && nome === 'ausente') {
      autoAusente = v1 === TOKEN_NAO;
    } else if (tipo === 'fim' && nome === FORMATO_SONDA) {
      fim = true;
    }
  }
  return { medicoes, funcoesPublic, fim, dialetoOk: autoPresente && autoAusente };
}

type Estado = 'LIBERADA' | 'BLOQUEADA' | 'INCERTA';

interface RpcAusente {
  rpc: string;
  edges: string[];
  familia: number;
}

export interface VereditoPrecondicao {
  estado: Estado;
  /** RPCs medidas e ausentes — o que a migration tem de criar ANTES da edge subir. */
  ausentes: RpcAusente[];
  /** Alvos que a sonda não devolveu: ausência de DADO, tratada como bloqueio. */
  naoMedidos: string[];
  /** Por que está INCERTA, quando está. Vazio nos outros estados. */
  motivos: string[];
}

/**
 * O julgamento. Fail-closed nos três eixos do cabeçalho — e `INCERTA` é um estado SEPARADO de
 * `BLOQUEADA` de propósito: "a migration falta" e "eu não consegui medir" pedem ações diferentes,
 * e colapsá-las ensinaria o operador a ler o bloqueio como ruído.
 */
export function julgarPrecondicao(
  alvos: readonly AlvoRpc[],
  leitura: LeituraSonda,
  indirecoes: number,
): VereditoPrecondicao {
  const motivos: string[] = [];
  if (!leitura.fim) {
    motivos.push(
      `a sonda não trouxe o marcador \`${FORMATO_SONDA}\` — saída truncada ou de outro formato; ` +
        'sem o fim, "nenhuma ausente" é indistinguível de "a resposta acabou antes"',
    );
  }
  if (leitura.funcoesPublic === 0) {
    motivos.push(
      'controle positivo ZERO: a sonda não enxergou nenhuma função em `public` — é a mecânica ' +
        'quebrada (papel, schema, conexão), não um banco sem funções',
    );
  }
  if (!leitura.dialetoOk) {
    motivos.push(
      'a sonda não confirmou o DIALETO (linhas `autoteste`): o parser não reproduziu valores cuja ' +
        'resposta era conhecida de antemão ⇒ nenhuma outra linha desta saída pode ser acreditada, ' +
        'inclusive as que dizem "presente" (foi assim que a v1 deu 5 RPCs presentes como ausentes)',
    );
  }
  if (indirecoes > 0) {
    motivos.push(
      `${indirecoes} chamada(s) de RPC por indireção: o extrator declara a lista INCOMPLETA ` +
        '(`preflight:rpcs` exit 3) — liberar aqui prometeria uma cobertura que não se mediu',
    );
  }

  const porNome = new Map(leitura.medicoes.map((m) => [m.rpc, m]));
  const ausentes: RpcAusente[] = [];
  const naoMedidos: string[] = [];
  for (const alvo of alvos) {
    const m = porNome.get(alvo.rpc);
    if (m === undefined) {
      naoMedidos.push(alvo.rpc);
    } else if (!m.existe) {
      ausentes.push({ rpc: alvo.rpc, edges: alvo.edges, familia: m.familia });
    }
  }

  if (motivos.length > 0 || naoMedidos.length > 0) {
    return { estado: 'INCERTA', ausentes, naoMedidos, motivos };
  }
  return {
    estado: ausentes.length > 0 ? 'BLOQUEADA' : 'LIBERADA',
    ausentes,
    naoMedidos,
    motivos,
  };
}

/**
 * O texto do veredito. Nomeia a AÇÃO por família — povoada ⇒ falta esta migration; vazia ⇒ o
 * domínio não está lá, e reaplicar migration sobre isso seria consertar o diagnóstico errado.
 */
export function relatarPrecondicao(v: VereditoPrecondicao): string {
  if (v.estado === 'LIBERADA') {
    return '✅ pré-condição de banco satisfeita — todas as RPCs da leva existem em prod';
  }
  const linhas: string[] = [];
  if (v.estado === 'INCERTA') {
    linhas.push('⛔ pré-condição NÃO MEDIDA — não libere a edge sobre ausência de dado:');
    for (const m of v.motivos) linhas.push(`  · ${m}`);
    for (const n of v.naoMedidos) linhas.push(`  · \`${n}\`: a sonda não devolveu linha para esta RPC`);
  } else {
    linhas.push('⛔ pré-condição de banco AUSENTE — a migration tem de ser aplicada ANTES da edge:');
  }
  for (const a of v.ausentes) {
    const acao =
      a.familia > 0
        ? `família \`${familiaDe(a.rpc)}_*\` tem ${a.familia} função(ões) em prod ⇒ o domínio existe e falta ESTA migration`
        : `família \`${familiaDe(a.rpc)}_*\` VAZIA em prod ⇒ o domínio inteiro não está lá (ou o nome mudou) — diagnostique, não reaplique`;
    linhas.push(`  · \`${a.rpc}\` ← ${a.edges.map((e) => `\`${e}\``).join(', ')}`);
    linhas.push(`    ${acao}`);
  }
  return linhas.join('\n');
}
