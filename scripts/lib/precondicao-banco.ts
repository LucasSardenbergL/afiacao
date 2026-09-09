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
 * ⚠️ CINCO eixos fail-closed, e nenhum cobre o outro (o 5º chegou com o #2428, ao fim deste bloco):
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
 *   5. `desatualizadas ≠ []`  → a RPC existe, mas prod roda um corpo que o repo commitou ANTES do
 *                              atual. É o #2428, e é o eixo cuja falha NÃO tem sintoma: sem ele o
 *                              gate diz "satisfeita" enquanto a RPC velha descarta o campo novo
 *                              em silêncio. Detalhe e taxonomia em `corpo-esperado.ts`.
 *
 * O eixo 5 traz dois controles positivos PRÓPRIOS (`inventarioDaRef`, `funcoesConhecidas`), porque
 * os quatro de cima provam que o BANCO respondeu e nenhum prova que o REPO foi lido — foi
 * exatamente por aí que a 1ª versão deste eixo passou verde contra prod: um `git grep -E` com `\b`
 * (que POSIX ERE não conhece) devolveu zero candidatos, o histórico ficou vazio e não havia nada
 * que dissesse "eu não li nada". Todos os testes passavam.
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
 *
 * ## O gatilho disparou (#2428) — e o incidente foi PIOR que o previsto: eixo 5
 *
 * 2026-09-09: este gate declarou "✅ pré-condição satisfeita" com `criar_pedidos_com_itens` em
 * prod na versão ANTERIOR à migration da leva. A edge mandava o desconto apurado; a RPC velha
 * recebia o `jsonb` e **descartava o campo sem erro nenhum**. Não houve
 * `Could not find the function`, não houve 500, não houve sintoma: o sync reportou sucesso e o
 * ledger passou a atestar CONFERE sobre metade de uma entrega. O parágrafo acima previa o dia em
 * que a RPC quebraria por contrato; o que aconteceu foi ela NÃO quebrar.
 *
 * O eixo 5 (`corpo-esperado.ts`) responde a pergunta que a existência não faz: **a migration desta
 * leva foi aplicada?** Ele não compara prod com o repo (divergir é o estado NORMAL: ~210 objetos
 * sem `CREATE` commitado, 11 das 65 RPCs de edge em deriva benigna) — ele procura a evidência
 * POSITIVA de atraso: o corpo vivo ser um corpo que este repo commitou ANTES do atual. Quando é,
 * `BLOQUEADA`. Quando o corpo vivo não é nenhum dos commitados, o eixo diz que não sabe e NÃO
 * bloqueia, porque bloqueio falso ensina o operador a contornar o gate — o mesmo argumento que a
 * seção acima usa para não medir assinatura.
 *
 * O que continua descoberto, agora com nome: uma edição MANUAL em prod que também ignore o campo
 * novo é indistinguível de uma edição manual legítima. Fecha-se commitando a DDL, não aqui.
 */
import {
  classificarCorpo,
  type CorpoVivo,
  irmasDaMigration,
  md5Exato,
  type VersaoDeCorpo,
} from './corpo-esperado';


/** Marca de formato que a sonda carimba no marcador de fim; o parser recusa outra. */
export const FORMATO_SONDA = 'precondicao-banco/3';

/**
 * A amostra que o autoteste manda o BANCO hashear — e que esta lib tem de reproduzir.
 *
 * O eixo de corpo compara `md5(pg_proc.prosrc)` (calculado NO BANCO) com o md5 do corpo lido da
 * migration (calculado AQUI). Duas máquinas, dois hashers, dois encodings: se elas divergirem, o
 * eixo classifica função EM DIA como `DERIVA` em massa — e alarme falso em massa é como um eixo
 * novo nasce desligado. A amostra fecha esse laço a cada execução.
 *
 * Escolhida para exercitar as três coisas que podem divergir: **quebra de linha** (o `\n` tem de
 * ser um LF de verdade nos dois lados, não a sequência `\` + `n`), **espaço repetido** (a receita
 * é EXATA — nada de colapsar whitespace, ver `bodyMd5Exato`) e **acento** (o md5 é sobre BYTES;
 * um lado em latin-1 e outro em utf-8 dá hash diferente para o mesmo texto).
 *
 * Os dois lados são escritos à mão de propósito: gerar o literal SQL a partir do JS faria o teste
 * validar a si mesmo, que foi exatamente o defeito da v1 desta lib (fixture que FABRICOU o
 * dialeto em vez de medi-lo).
 */
export const AMOSTRA_CORPO_JS = '\n á  b ';
/** A MESMA amostra como literal SQL: `E'…'` para que `\n` seja uma quebra de linha de verdade. */
const AMOSTRA_CORPO_SQL = "E'\\n á  b '";

/** O token que a sonda emite quando prod não tem corpo TEXTUAL para comparar. */
export const TOKEN_SEM_CORPO = 'SEM-CORPO';

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
  /**
   * md5 do corpo VIVO de cada RPC, por nome. Lista porque overload existe (16 nomes com mais de
   * uma assinatura em `public`) — o critério é "bate com algum", como na Seção 3 do audit.
   * Nome AUSENTE do mapa, ou com lista vazia, é ausência de dado: `INDECIDIVEL`, nunca verde.
   */
  corpos: Map<string, CorpoVivo>;
  /** Total de funções em `public` — o controle GROSSO: 0 = a query não enxergou o catálogo. */
  funcoesPublic: number;
  /** O marcador de fim apareceu com o formato esperado. */
  fim: boolean;
  /**
   * A sonda provou, nesta execução, que emissor e parser falam o mesmo dialeto — as TRÊS linhas
   * de `autoteste` foram lidas com o valor que elas próprias declaram. A terceira (`md5corpo`) é
   * do #2428: ela prova que a receita de normalização do TS reproduz a do BANCO.
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
  // A receita ESTRITA — `md5(prosrc)` cru, sem normalizar. A do audit colapsa `\s+` em ' ', que
  // iguala `SELECT 'a  b'` e `SELECT 'a b'`: ruído tolerável num inventário, igualdade que MENTE
  // num gate de money-path. Ver `bodyMd5Exato` em `migration-objects.ts`.
  const MD5_CORPO = 'md5(p.prosrc)';
  return [
    `WITH esperadas(nome) AS (VALUES ${valores}), med AS (`,
    `  SELECT e.nome,`,
    `         CASE WHEN EXISTS (SELECT 1 ${EM_PUBLIC} AND p.proname = e.nome)`,
    `              THEN '${TOKEN_SIM}' ELSE '${TOKEN_NAO}' END AS existe,`,
    `         (SELECT count(*) ${EM_PUBLIC} AND p.proname LIKE split_part(e.nome, '_', 1) || '\\_%') AS familia`,
    `  FROM esperadas e), vivos AS (`,
    `  SELECT p.proname,`,
    `         CASE WHEN p.prosqlbody IS NOT NULL OR p.prosrc IS NULL OR p.prosrc = ''`,
    `                OR l.lanname IN ('c', 'internal')`,
    `              THEN '${TOKEN_SEM_CORPO}' ELSE ${MD5_CORPO} END AS corpo,`,
    `         count(*) OVER (PARTITION BY p.proname) AS assinaturas`,
    `    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace`,
    `    JOIN pg_language l ON l.oid = p.prolang`,
    `   WHERE n.nspname = 'public' AND p.prokind = 'f'`,
    `     AND p.proname IN (SELECT nome FROM esperadas))`,
    `SELECT tipo, nome, v1, v2 FROM (`,
    `  SELECT 1 AS ord, 'rpc' AS tipo, nome, existe AS v1, familia::text AS v2 FROM med`,
    `  UNION ALL SELECT 2, 'controle', 'funcoes_public', (SELECT count(*) ${EM_PUBLIC})::text, ''`,
    // O autoteste de dialeto: valores cuja resposta é conhecida ANTES de perguntar. Se o parser
    // não os reproduzir, ele não entende o que o banco fala — e nenhuma outra linha desta saída
    // pode ser acreditada, inclusive as que dizem "presente".
    `  UNION ALL SELECT 3, 'autoteste', 'presente', '${TOKEN_SIM}', ''`,
    `  UNION ALL SELECT 3, 'autoteste', 'ausente', '${TOKEN_NAO}', ''`,
    // O terceiro (#2428): o banco hasheia uma amostra conhecida com a receita do eixo de corpo, e
    // o parser exige que a receita EM TS a reproduza. É o que separa "os corpos divergem" de "os
    // dois hashers divergem" — sem ele, um erro de encoding viraria DERIVA em massa.
    `  UNION ALL SELECT 3, 'autoteste', 'md5corpo', md5(${AMOSTRA_CORPO_SQL}), ''`,
    // O corpo VIVO de cada alvo, uma linha por entrada de `pg_proc` (overload inclusive), com a
    // contagem de assinaturas do nome ao lado — o julgamento CHAMA overload de indecidível em vez
    // de aceitar "bate com algum", e essa contagem é o que o deixa medir isso em vez de supor.
    //
    // `prosqlbody` (LANGUAGE sql moderno: `prosrc` VAZIO) e `LANGUAGE c`/`internal` (`prosrc` é o
    // símbolo, não o código) não têm corpo comparável, e dizem-no com um token próprio — nunca com
    // um md5. `md5('')` é um md5 VÁLIDO (`d41d8cd9…`) e casaria como qualquer outro.
    `  UNION ALL SELECT 4, 'corpo', v.proname, v.corpo, v.assinaturas::text FROM vivos v`,
    `  UNION ALL SELECT 5, 'fim', '${FORMATO_SONDA}', '', ''`,
    `) x ORDER BY ord, nome, v1;`,
  ].join('\n');
}

/**
 * Lê a saída do `psql -A -F '|' -t`. Linha que não casa o formato é IGNORADA aqui e cobrada no
 * julgamento pelos marcadores: um parser que "conserta" o que não entendeu esconde exatamente a
 * truncagem que o eixo 1 existe para pegar.
 */
export function parsearSondaPrecondicao(saida: string): LeituraSonda {
  const medicoes: MedicaoRpc[] = [];
  const corpos = new Map<string, CorpoVivo>();
  let funcoesPublic = 0;
  let fim = false;
  let autoPresente = false;
  let autoAusente = false;
  let autoMd5 = false;
  for (const bruta of saida.split('\n')) {
    const linha = bruta.trim();
    if (linha === '') continue;
    const campos = linha.split('|');
    const [tipo, nome, v1, v2] = campos;
    if (tipo === 'corpo' && campos.length >= 4 && nome !== undefined) {
      const anterior = corpos.get(nome);
      const md5s = [...(anterior?.md5s ?? [])];
      // `SEM-CORPO` entra como ausência, não como valor: a lista fica curta de propósito, e lista
      // vazia é `INDECIDIVEL` no julgamento. Guardar o token como se fosse hash o faria "bater"
      // com outro `SEM-CORPO` — dois desconhecidos declarados iguais.
      if (v1 !== undefined && v1 !== '' && v1 !== TOKEN_SEM_CORPO) md5s.push(v1);
      corpos.set(nome, {
        md5s,
        // O maior visto: a contagem vem repetida em cada linha do mesmo nome, e uma linha
        // truncada não pode ENCOLHER o número que denuncia overload.
        overloads: Math.max(anterior?.overloads ?? 0, Number.parseInt(v2 ?? '', 10) || 0),
      });
      continue;
    }
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
    } else if (tipo === 'autoteste' && nome === 'md5corpo') {
      autoMd5 = v1 === md5Exato(AMOSTRA_CORPO_JS);
    } else if (tipo === 'fim' && nome === FORMATO_SONDA) {
      fim = true;
    }
  }
  return { medicoes, corpos, funcoesPublic, fim, dialetoOk: autoPresente && autoAusente && autoMd5 };
}

type Estado = 'LIBERADA' | 'BLOQUEADA' | 'INCERTA';

interface RpcAusente {
  rpc: string;
  edges: string[];
  familia: number;
}

/** Uma função cujo corpo em prod é um corpo que o repo commitou ANTES do atual — o eixo 5. */
interface RpcDesatualizada {
  rpc: string;
  /** Quem depende dela. Vazio quando a função entrou pelo conjunto acoplado da migration. */
  edges: string[];
  /** A migration que este repo diz ser a última a definir a função. */
  esperada: string;
  /** A migration cujo corpo prod está de fato rodando. */
  emProd: string;
}

/** Uma função da leva sobre a qual o eixo 5 NÃO conseguiu afirmar nada. Reportada, não bloqueante. */
interface RpcNaoConferida {
  rpc: string;
  motivo: string;
}

export interface VereditoPrecondicao {
  estado: Estado;
  /** RPCs medidas e ausentes — o que a migration tem de criar ANTES da edge subir. */
  ausentes: RpcAusente[];
  /** Alvos que a sonda não devolveu: ausência de DADO, tratada como bloqueio. */
  naoMedidos: string[];
  /** Por que está INCERTA, quando está. Vazio nos outros estados. */
  motivos: string[];
  /** Eixo 5: prod roda um corpo ANTERIOR ao commitado ⇒ a migration da leva não foi aplicada. */
  desatualizadas: RpcDesatualizada[];
  /**
   * Eixo 5, o outro lado: a COBERTURA declarada. Deriva, overload, corpo não textual, função sem
   * `CREATE` commitado. Não bloqueiam — mas ficam escritas, porque um gate que só mostra o que
   * conseguiu afirmar deixa o operador achar que afirmou sobre tudo.
   */
  naoConferidas: RpcNaoConferida[];
}

/** O que o eixo 5 recebe do repo: o histórico commitado + o controle de que ele foi mesmo lido. */
export interface CorposEsperados {
  /** Histórico ordenado por `schema.nome` — ver `corpo-esperado.ts`. */
  historico: ReadonlyMap<string, readonly VersaoDeCorpo[]>;
  /**
   * Quantas migrations a ref TEM. ZERO é mecânica quebrada (git falhou, caminho errado), nunca "o
   * repo não tem DDL" — é o irmão do `funcoesPublic === 0` no eixo novo. Sem ele, um inventário
   * vazio devolveria "nada a conferir" e liberaria a leva.
   */
  inventarioDaRef: number;
  /**
   * Quantas dessas o filtro trouxe para extração. ZERO aqui é legítimo (nenhuma migration menciona
   * nenhuma RPC da leva — dois dos 65 alvos medidos estão nesse caso, sem `CREATE` commitado), e
   * por isso NÃO é o controle: ele é o denominador que dá sentido ao próximo campo.
   */
  migrationsLidas: number;
  /**
   * Quantas funções o histórico conhece. O controle FINO: arquivos lidos e ZERO funções extraídas
   * é o extrator quebrado — contagem de arquivo não prova extração, do mesmo jeito que
   * `funcoesPublic > 0` prova acesso ao catálogo e não prova comparação (achado do Codex).
   */
  funcoesConhecidas: number;
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
  corpos: CorposEsperados,
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

  // Eixo 5 — os DOIS controles positivos do caminho novo. Nenhum dos quatro acima os cobre:
  // eles provam que o BANCO respondeu, e nada prova que o REPO foi lido.
  if (corpos.inventarioDaRef === 0) {
    motivos.push(
      'eixo de corpo CEGO: a ref não tem migration NENHUMA — é git/caminho quebrado, não um repo ' +
        'sem DDL; sem histórico, "o corpo em prod é o esperado" seria opinião',
    );
  } else if (corpos.migrationsLidas > 0 && corpos.funcoesConhecidas === 0) {
    motivos.push(
      `eixo de corpo CEGO: ${corpos.migrationsLidas} migration(s) lida(s) e NENHUMA função ` +
        'extraída — arquivo lido não é corpo extraído, e a contagem de arquivos esconde um ' +
        'extrator quebrado',
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

  // O eixo 5 propriamente. Só olha o que EXISTE: uma RPC ausente já é bloqueio pelo eixo antigo, e
  // classificar corpo de função que não está lá seria ruído sobre um veredito já fechado.
  const ausenteOuNaoMedida = new Set([...ausentes.map((a) => a.rpc), ...naoMedidos]);
  const edgesPorRpc = new Map(alvos.map((a) => [a.rpc, a.edges]));
  const desatualizadas: RpcDesatualizada[] = [];
  const naoConferidas: RpcNaoConferida[] = [];
  for (const rpc of alvosDeCorpo(alvos, corpos.historico)) {
    if (ausenteOuNaoMedida.has(rpc)) continue;
    const v = classificarCorpo(
      corpos.historico.get(`public.${rpc}`),
      leitura.corpos.get(rpc) ?? { md5s: [], overloads: 0 },
    );
    if (v.classificacao === 'EM_DIA') continue;
    if (v.classificacao === 'CORPO_ANTERIOR' && v.esperada !== undefined && v.emProd !== undefined) {
      desatualizadas.push({
        rpc,
        edges: edgesPorRpc.get(rpc) ?? [],
        esperada: v.esperada,
        emProd: v.emProd,
      });
      continue;
    }
    naoConferidas.push({
      rpc,
      motivo:
        v.classificacao === 'DERIVA'
          ? `corpo em prod não bate com nenhuma das ${v.versoes} versão(ões) commitadas — edição manual (não é "falta colar")`
          : (v.motivo ?? 'sem corpo comparável'),
    });
  }

  if (motivos.length > 0 || naoMedidos.length > 0) {
    return { estado: 'INCERTA', ausentes, naoMedidos, motivos, desatualizadas, naoConferidas };
  }
  return {
    estado: ausentes.length > 0 || desatualizadas.length > 0 ? 'BLOQUEADA' : 'LIBERADA',
    ausentes,
    naoMedidos,
    motivos,
    desatualizadas,
    naoConferidas,
  };
}

/**
 * As funções que o eixo 5 confere: as RPCs da leva **mais as irmãs da migration de cada uma**.
 *
 * As irmãs entram porque a unidade de APPLY é a migration, não a função — e o incidente é o
 * exemplo: `20260908215704` recria os TRÊS escritores de `order_items`, que só funcionam juntos,
 * mas são chamados por edges diferentes (`omie-vendas-sync` chama dois, `sync-reprocess` o
 * terceiro). Conferir só o que a leva chama deixaria passar uma leva de `omie-vendas-sync` com
 * `reconciliar_pedidos_omie` velha — e o desconto nasceria para morrer no primeiro
 * reprocessamento (achado do Codex).
 *
 * Só entram irmãs em `public` — é o único schema que a sonda mede, e afirmar sobre um schema não
 * medido seria fabricar veredito.
 */
export function alvosDeCorpo(
  alvos: readonly AlvoRpc[],
  historico: ReadonlyMap<string, readonly VersaoDeCorpo[]>,
): string[] {
  const fora = new Set(alvos.map((a) => a.rpc));
  for (const alvo of alvos) {
    const versoes = historico.get(`public.${alvo.rpc}`);
    if (versoes === undefined || versoes.length === 0) continue;
    for (const chave of irmasDaMigration(historico, versoes[versoes.length - 1].migration)) {
      if (chave.startsWith('public.')) fora.add(chave.slice('public.'.length));
    }
  }
  return [...fora].sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * O texto do veredito. Nomeia a AÇÃO por família — povoada ⇒ falta esta migration; vazia ⇒ o
 * domínio não está lá, e reaplicar migration sobre isso seria consertar o diagnóstico errado.
 */
export function relatarPrecondicao(v: VereditoPrecondicao): string {
  // A cobertura vai junto do VERDE também: o texto antigo dizia "todas as RPCs da leva existem em
  // prod", e existir era tudo o que ele media — foi essa frase que absolveu a leva do #2428.
  // Dizer sobre o que NÃO se afirmou é o que impede o verde de ser lido como mais largo do que é.
  const rodape = v.naoConferidas.length === 0 ? [] : [
    `ℹ️  ${v.naoConferidas.length} função(ões) fora do alcance do eixo de corpo — o gate NÃO afirma sobre elas:`,
    ...v.naoConferidas.map((n) => `  · \`${n.rpc}\`: ${n.motivo}`),
  ];
  if (v.estado === 'LIBERADA') {
    return [
      '✅ pré-condição de banco satisfeita — as RPCs da leva existem em prod E rodam o corpo da',
      '   última migration que este repo commitou para elas',
      ...rodape,
    ].join('\n');
  }
  const linhas: string[] = [];
  if (v.estado === 'INCERTA') {
    linhas.push('⛔ pré-condição NÃO MEDIDA — não libere a edge sobre ausência de dado:');
    for (const m of v.motivos) linhas.push(`  · ${m}`);
    for (const n of v.naoMedidos) linhas.push(`  · \`${n}\`: a sonda não devolveu linha para esta RPC`);
  } else {
    linhas.push('⛔ pré-condição de banco AUSENTE — a migration tem de ser aplicada ANTES da edge:');
  }
  for (const d of v.desatualizadas) {
    const quem = d.edges.length > 0
      ? d.edges.map((e) => `\`${e}\``).join(', ')
      : '(nenhuma edge da leva a chama — ela entrou pelo conjunto ACOPLADO da mesma migration)';
    linhas.push(`  · \`${d.rpc}\` ← ${quem}`);
    linhas.push(`    EXISTE em prod, mas rodando o corpo de \`${d.emProd}\``);
    linhas.push(`    o repo já commitou \`${d.esperada}\` depois dela ⇒ APLIQUE essa migration`);
    linhas.push(
      '    ⚠️  não espere erro: a RPC velha aceita o payload novo e DESCARTA o campo em silêncio',
    );
  }
  for (const a of v.ausentes) {
    const acao =
      a.familia > 0
        ? `família \`${familiaDe(a.rpc)}_*\` tem ${a.familia} função(ões) em prod ⇒ o domínio existe e falta ESTA migration`
        : `família \`${familiaDe(a.rpc)}_*\` VAZIA em prod ⇒ o domínio inteiro não está lá (ou o nome mudou) — diagnostique, não reaplique`;
    linhas.push(`  · \`${a.rpc}\` ← ${a.edges.map((e) => `\`${e}\``).join(', ')}`);
    linhas.push(`    ${acao}`);
  }
  return [...linhas, ...rodape].join('\n');
}
