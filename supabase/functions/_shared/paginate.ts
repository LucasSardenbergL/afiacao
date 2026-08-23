// Paginação do PostgREST / Supabase Data API.
//
// FOOTGUN (docs/agent/database.md §5; CLAUDE.md → PostgREST): o Data API capa CADA
// resposta em 1000 linhas, em SILÊNCIO — sem erro. Uma leitura `.select()` que
// ultrapasse 1000 linhas devolve só as primeiras 1000 e a cauda some sem aviso.
// Em espelhos/sincronizações isso vira dado stale (o caso que esta função previne).
//
// `fetchAll` lê em páginas de 1000 via `.range()` até a página vir incompleta.
// O call-site DEVE encadear `.order()` numa coluna ESTÁVEL e única no recorte
// (ex.: a PK), senão o `.range()` pode pular/duplicar linhas entre páginas.
//
// ⚠️ PII — o SEGUNDO contrato desta função, e o motivo de ela lançar `FalhaLeituraCritica`
// em vez de `Error`: `error.message` do PostgREST encaminha o MESSAGE do Postgres, que pode
// interpolar valor de LINHA (`RAISE EXCEPTION` com ID/CPF; erro de cast reproduzindo o valor
// inválido). O `catch` do `Deno.serve` das edges devolve `String(err.message)` no CORPO da
// resposta HTTP — então um ``new Error(`${label}: ${error.message}`)`` aqui SAI DA EDGE. É a
// "garantia de privacidade afirmada sem verificar o SINK" que `leitura-critica.ts` documenta,
// e a classe de lá é a resposta: mensagem em domínio FECHADO (nome da fonte, que é constante
// do código, + código sanitizado por allowlist de FORMA), texto original só em `cause`, que a
// resposta HTTP não serializa e que sobrevive nos logs da edge.
//
// A irmã single-shot (`leitura-critica.ts`) e a paginação passam então a lançar a MESMA classe:
// quem trata falha de leitura no money-path ramifica uma vez só, e não por cardinalidade.
import { FalhaLeituraCritica, type ErroPostgrest } from "./leitura-critica.ts";
import { mensagemDeErro } from "./erro-mensagem.ts";

const PAGE = 1000;

// ── Contrato mínimo do PostgREST que a paginação usa ────────────────────────
// Estrutural de propósito: o teste satisfaz com um banco de memória que conta chamadas,
// e o `SupabaseClient` real entra por cast no call-site (`as unknown as BancoPostgrest`)
// — a suíte de edge roda com `--no-remote`, então um módulo testável não pode importar
// `npm:@supabase/supabase-js` nem para tipo.
//
// Mora aqui (e não em `relatorio-mensal.ts`, onde nasceu) porque descreve a forma da
// query que `fetchAll` pagina: é contrato de paginação, não do relatório mensal.

// `error` carrega o `code` do PostgREST (opcional) porque `_shared/leitura-critica.ts`
// decide POR CÓDIGO o que tolerar (`42703` coluna ausente) e o que lançar — e as duas
// famílias, paginação e leitura single-shot, convivem na MESMA query encadeada.
export interface RespostaPostgrest<T> {
  data: T[] | null;
  count?: number | null;
  error: { message: string; code?: string | null; details?: string | null; hint?: string | null } | null;
}

export interface QueryPostgrest<T> extends PromiseLike<RespostaPostgrest<T>> {
  select(colunas: string, opts?: { count?: "exact"; head?: boolean }): QueryPostgrest<T>;
  eq(coluna: string, valor: unknown): QueryPostgrest<T>;
  in(coluna: string, valores: readonly unknown[]): QueryPostgrest<T>;
  gte(coluna: string, valor: unknown): QueryPostgrest<T>;
  /**
   * `>` estrito — o avanço do cursor de `fetchAllKeyset`. Estrito e não `gte` porque a
   * chave é ÚNICA no recorte: com `gte` a última linha de cada página voltaria na página
   * seguinte, duplicada.
   */
  gt(coluna: string, valor: unknown): QueryPostgrest<T>;
  lt(coluna: string, valor: unknown): QueryPostgrest<T>;
  not(coluna: string, operador: string, valor: unknown): QueryPostgrest<T>;
  /**
   * `IS` do PostgREST — na prática, o predicado de soft-delete (`.is('deleted_at', null)`).
   * Entrou quando `carregarPedidosDoMes` passou a aplicar as DUAS metades do contrato do
   * universo de pedidos (denylist de status + `deleted_at IS NULL`): faltava a segunda, e
   * o caller é o do snapshot CONGELADO de positivação, onde um pedido apagado vira receita
   * de um mês que ninguém recalcula.
   */
  is(coluna: string, valor: unknown): QueryPostgrest<T>;
  order(coluna: string, opts?: { ascending?: boolean }): QueryPostgrest<T>;
  range(de: number, ate: number): QueryPostgrest<T>;
  // `limit` é a AMOSTRA deliberada (teto de negócio), não a paginação: quem usa `limit`
  // está dizendo "cabe menos e tudo bem". Continua exigindo `.order()` estável, senão a
  // amostra muda a cada execução e o resultado deixa de ser reprodutível.
  limit(n: number): QueryPostgrest<T>;
  // Termina a cadeia devolvendo UMA linha (ou `null`) em vez de array — mesma resposta
  // `{data,error}`, outro formato de `data`.
  maybeSingle(): PromiseLike<{
    data: T | null;
    error: { message: string; code?: string | null; details?: string | null; hint?: string | null } | null;
  }>;
}

export interface BancoPostgrest {
  // Genérico (e não `QueryPostgrest<unknown>`) para o call-site declarar a forma da linha
  // que espera de cada tabela — é o que mantém `fetchAll<T>` tipado ponta a ponta.
  from<T>(tabela: string): QueryPostgrest<T>;
  /**
   * Chamada de função SQL. Entrou para `recommend_cluster_agregado`, que faz no BANCO a
   * agregação que o edge fazia sobre uma amostra de 1.000 LINHAS de `order_items`.
   *
   * Não devolve `QueryPostgrest`: esta RPC responde UMA linha já agregada, então não há o que
   * paginar nem o que ordenar. ⚠️ Isso NÃO é dispensa geral do cap — o PostgREST capa `.rpc()`
   * em 1.000 linhas igual a qualquer leitura. É justamente por isso que a função devolve o
   * agregado num `jsonb` de uma linha: linha-por-produto truncaria dois dos três clusters HOJE
   * (957/1.312/1.109 produtos, medido). RPC que devolva LISTA precisa paginar como as outras.
   */
  rpc<T>(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: T[] | null;
    error: { message: string; code?: string | null; details?: string | null; hint?: string | null } | null;
  }>;
}

export async function fetchAll<T>(
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: ErroPostgrest | null }>,
  label: string,
): Promise<T[]> {
  let from = 0;
  const out: T[] = [];
  for (;;) {
    // A página tem TRÊS desfechos de falha, não um. O `await` pode REJEITAR (fetch derrubado,
    // `.throwOnError()` de um caller futuro, erro de programação no callback) — e a rejeição
    // crua atravessava `fetchAll` inteira até o `catch` do `Deno.serve`, pelo mesmo caminho
    // que devolve `.message` no corpo. O wrapper local que este helper substituiu cobria isto
    // com um try/catch; a cobertura tinha de vir junto.
    let resposta: { data: T[] | null; error: ErroPostgrest | null };
    try {
      resposta = await build(from, from + PAGE - 1);
    } catch (e) {
      // Já fechada por um caller que valida a própria página: re-envelopar trocaria o `code`
      // real (57014) por `REJEITADA` e apagaria a fonte de origem.
      if (e instanceof FalhaLeituraCritica) throw e;
      throw new FalhaLeituraCritica(label, {
        code: 'REJEITADA',
        // `mensagemDeErro`, não `e instanceof Error ? e.message : String(e)`: para um objeto
        // sem `message` aquele idiom devolve "[object Object]" — um texto que PARECE
        // diagnóstico e não é (classe #1642, gate `erro-object-object`). Aqui o destino é
        // `cause`, o que torna o lixo ainda mais caro: some no log em vez de gritar.
        message: mensagemDeErro(e) ?? 'rejeição sem mensagem utilizável',
      });
    }
    const { data, error } = resposta;
    // Envelope na ORIGEM, dentro do laço: o `code` do PostgREST (57014 timeout, 42501 RLS) é o
    // que separa "o banco piscou" de "a role não enxerga" na classificação operacional, e ele
    // morreria num envelope aplicado por FORA — lá só chega a `Error` já reduzida a texto.
    if (error) throw new FalhaLeituraCritica(label, error);
    // `data == null` sem `error` é resposta MALFORMADA do PostgREST — não é fim da tabela.
    // O `?? []` de antes a convertia em página vazia → EOF falso → o acumulado PARCIAL
    // voltava como se fosse a tabela inteira (o defeito que fetchAllPages de
    // src/lib/postgrest.ts e buscarTodasPaginas pós-#1564 já rejeitam). Fim LEGÍTIMO é
    // `data: []` — array vazio, que segue adiante e encerra por `length < PAGE`.
    // Mesmo código que `exigirLista` dá à malformada de UMA página: é o mesmo defeito
    // entrando pela porta do lado, e quem lê o log não deveria ter de saber por qual porta.
    //
    // A checagem é `!Array.isArray`, não `== null`: `out.push(...rows)` ESPALHA qualquer
    // iterável, então `{ data: "CPF" }` resolvia `["C","P","F"]` — três "linhas" que o
    // call-site soma como dados do banco. Pior que um erro, é PII picada em caracteres
    // entrando no cálculo com cara de leitura legítima (challenge Codex desta entrega).
    if (!Array.isArray(data)) throw new FalhaLeituraCritica(label, { code: 'MALFORMADA' });
    const rows = data;
    out.push(...rows);
    // EOF é página VAZIA, não página CURTA; e o offset avança pelo que de fato VEIO, não pelo
    // que foi PEDIDO. Os dois juntos desacoplam o helper do `max-rows` do PostgREST.
    //
    // Antes: `PAGE` (1000) era igual ao `max-rows` medido em prod (1000), então pedir o cap
    // inteiro funcionava — por coincidência numérica que nada vigiava. Se o cap baixasse para
    // 500, a 1ª página viria com 500 linhas, `500 < 1000` seria lido como "acabou" e a leitura
    // truncaria EM SILÊNCIO: a classe do #1836 por outra porta. E avançar `from += PAGE` sobre
    // um servidor que devolveu menos PULARIA a diferença — 500 linhas invisíveis por página.
    //
    // Custo: uma requisição a mais por leitura (a que volta vazia). É o preço de o EOF passar a
    // ser um FATO observado em vez de uma inferência a partir de um número que o servidor
    // escolhe e pode mudar sem avisar.
    //
    // Descartada a alternativa registrada antes (baixar `PAGE` para 900): protege só contra caps
    // entre 900 e 999 — com cap 500 o `500 < 900` continua sendo EOF falso — e paga +11% de
    // requisições em TODA leitura, não só uma por laço.
    if (rows.length === 0) break;
    from += rows.length;
  }
  return out;
}

/**
 * Paginação por KEYSET — para leitura que precisa sobreviver a escrita CONCORRENTE.
 *
 * `fetchAll` pagina por OFFSET: N requests independentes, cada um sua própria transação.
 * O `.order()` numa coluna estável resolve a instabilidade de ORDEM numa tabela parada,
 * mas não cria snapshot. Um INSERT antes do offset corrente desloca as páginas seguintes
 * (uma linha pode ser lida DUAS VEZES); um DELETE desloca no outro sentido (uma linha pode
 * ser PULADA).
 *
 * O keyset (`WHERE chave > cursor ORDER BY chave LIMIT n`) elimina a classe inteira do
 * deslocamento por offset. Não dá snapshot transacional — para isso só uma RPC, como o
 * `omie_sync_identity_snapshot` de `omie-vendas-sync` — mas nenhuma linha some ou repete
 * por causa da posição.
 *
 * QUANDO USAR, e não "sempre": o que desloca uma paginação não é o VOLUME de escrita da
 * tabela, é a escrita que atravessa a FRONTEIRA DO RECORTE — INSERT e DELETE sempre
 * atravessam, UPDATE só se tocar a coluna do `.order()` ou do `WHERE`. `product_costs`
 * leva 8,0M de updates e zero deletes: offset basta. `omie_products` leva 86 inserts e
 * zero deletes e ainda assim exige keyset, porque o `.eq('ativo',true)` do leitor é
 * exatamente o que o cron de status reescreve. A medição está em
 * `docs/historico/paginacao-offset-janela.md`; o precedente de deixar offset onde o custo
 * não se paga, em `fin-valor-cockpit/index.ts:490`.
 *
 * CONTRATO: `chave` tem de ser ÚNICA no recorte e o call-site tem de `.order()` por ela
 * — e o `.select()` precisa TRAZER a coluna (o `.range()` não exigia isso). Chave repetida
 * faria `.gt()` pular as empatadas; o caso patológico (cursor que não avança) é detectado
 * aqui e LANÇA, em vez de girar para sempre.
 */
export async function fetchAllKeyset<T, K extends string | number>(
  build: (
    cursor: K | null,
    limite: number,
  ) => PromiseLike<{ data: T[] | null; error: ErroPostgrest | null }>,
  chave: (linha: T) => K,
  label: string,
): Promise<T[]> {
  let cursor: K | null = null;
  const out: T[] = [];
  for (;;) {
    // Mesmo envelope do irmão `fetchAll`, pelos mesmos três desfechos e pelo mesmo motivo: o
    // `catch` do `Deno.serve` devolve `.message` no CORPO da resposta HTTP, e o MESSAGE do
    // Postgres interpola valor de LINHA. Ver o cabeçalho deste módulo.
    let resposta: { data: T[] | null; error: ErroPostgrest | null };
    try {
      resposta = await build(cursor, PAGE);
    } catch (e) {
      if (e instanceof FalhaLeituraCritica) throw e;
      throw new FalhaLeituraCritica(label, {
        code: 'REJEITADA',
        // `mensagemDeErro`, não `e instanceof Error ? e.message : String(e)`: para um objeto
        // sem `message` aquele idiom devolve "[object Object]" — um texto que PARECE
        // diagnóstico e não é (classe #1642, gate `erro-object-object`). Aqui o destino é
        // `cause`, o que torna o lixo ainda mais caro: some no log em vez de gritar.
        message: mensagemDeErro(e) ?? 'rejeição sem mensagem utilizável',
      });
    }
    const { data, error } = resposta;
    if (error) throw new FalhaLeituraCritica(label, error);
    // Mesmo fail-closed de `fetchAll`: `data` que não é ARRAY é resposta MALFORMADA, não fim
    // da tabela — devolver o acumulado parcial seria a truncagem silenciosa que o #1581 tirou
    // de 24 call-sites, e `push(...rows)` espalharia uma string em caracteres.
    if (!Array.isArray(data)) throw new FalhaLeituraCritica(label, { code: 'MALFORMADA' });
    const rows = data;
    // Varre a PÁGINA INTEIRA antes de acumular nada. Quatro violações do contrato do keyset
    // caem aqui, e as quatro resolveriam em SILÊNCIO sem esta varredura:
    //
    //   chave AUSENTE  — a coluna-chave ficou fora do `.select()`. O `.select()` é uma
    //     string e a interface da linha PROMETE o campo, então o typecheck passa e só o
    //     runtime descobre; o cursor viraria `undefined` e o `.gt()` filtraria o que desse.
    //   ordem DESC     — `.order(chave,{ascending:false})` no call-site. Precisa ser pego
    //     aqui e não na comparação de cursor lá embaixo: aquela só olha a ÚLTIMA linha, que
    //     sob DESC é a MENOR da página — o diagnóstico sairia como "cursor recuou", que
    //     descreve o sintoma e manda o leitor caçar tudo menos o `.order()` invertido.
    //   ordem ARBITRÁRIA — `.limit()` sem `.order()`. Comparar só os extremos da página
    //     deixaria passar a que tem o miolo embaralhado, e aí a última linha não é a maior
    //     chave: o cursor salta e a faixa entre ela e a real nunca é lida.
    //   página SOBREPOSTA — a página recomeça ATRÁS do cursor: linha já lida voltando no
    //     começo da próxima. É por isso que `anterior` começa em `cursor` e não em `null`.
    //     A primeira linha da página é a ÚNICA que a checagem de cursor lá embaixo não
    //     alcança, porque aquela compara só a última. Violação SISTEMÁTICA (`.gte` no lugar
    //     de `.gt`) ela até pega — mas só na página TERMINAL, com a tabela inteira já lida e
    //     uma duplicata por página no acumulado. Violação PONTUAL (retry com cursor velho,
    //     lag de réplica, ramo do call-site que tira o cursor de outra coluna) ela não pega
    //     NUNCA: a página está ascendente, então esta varredura passava; a última linha
    //     avançou, então a checagem de cursor passava; e a leitura RESOLVIA com duplicata.
    //     Medido antes deste fix, com sobreposição de 10 linhas sobre 2.300: devolvia 2.310
    //     linhas e 10 duplicadas, em silêncio — exatamente o desfecho que este helper existe
    //     para tornar impossível.
    //
    // Custa uma comparação por linha (≤1.000 por página) — a leitura em si é uma ida à
    // rede, então isto não aparece no perfil.
    let anterior: K | null = cursor;
    let primeira = true;
    for (const linha of rows) {
      const k = chave(linha);
      if (k === null || k === undefined) {
        throw new FalhaLeituraCritica(label, {
          code: 'KEYSET_CHAVE_AUSENTE',
          message: 'chave do keyset ausente numa linha — a coluna do cursor precisa estar no .select()',
        });
      }
      if (anterior !== null && k <= anterior) {
        // O VALOR das chaves ia na mensagem por `JSON.stringify` — e a chave é uma COLUNA da
        // linha (PK, código de cliente). O modo da violação é constante do código e fica
        // público; os valores vão para `cause`, com o resto do diagnóstico.
        // Os MODOS são distintos e têm conserto distinto: chave repetida significa "a coluna
        // não é única no recorte" (troque a chave); decrescente significa "o `.order()` está
        // ao contrário"; sobreposta significa "o filtro do cursor não bate com a chave".
        // Fundir tudo em `k <= anterior` sem separar o código manda o leitor caçar um
        // `.order()` que está correto.
        // A fronteira precisa de código PRÓPRIO e não pode reusar CHAVE_REPETIDA: com `.gte`
        // no call-site, `k === cursor` é uma linha REPETIDA ENTRE PÁGINAS, não uma chave
        // não-única — o conserto é o operador do filtro, não a escolha da coluna, e mandar o
        // leitor trocar uma chave que já é única é o diagnóstico que parece diagnóstico e
        // não é.
        const atravessaPagina = primeira && cursor !== null;
        throw new FalhaLeituraCritica(label, {
          code: atravessaPagina
            ? 'KEYSET_PAGINA_SOBREPOSTA'
            : k === anterior
            ? 'KEYSET_CHAVE_REPETIDA'
            : 'KEYSET_FORA_DE_ORDEM',
          message: atravessaPagina
            ? `página recomeçou em ${JSON.stringify(k)}, atrás do cursor ${JSON.stringify(cursor)} — a linha já foi lida; o call-site precisa filtrar .gt(cursor), não .gte, e na MESMA coluna de que sai a chave`
            : k === anterior
            ? `chave repetida em ${JSON.stringify(k)} dentro da mesma página — a chave precisa ser ÚNICA no recorte`
            : `página fora de ordem ASCENDENTE (${JSON.stringify(anterior)} → ${JSON.stringify(k)}) — o keyset exige .order() ascendente na MESMA coluna do cursor`,
        });
      }
      anterior = k;
      primeira = false;
    }
    out.push(...rows);
    // Mesma razão do `fetchAll`: página CURTA não é fim, é o `max-rows` podendo ser menor que
    // `PAGE`. Aqui não há offset a corrigir — o cursor já avança pela última linha REAL —, mas o
    // critério de parada tinha o mesmo acoplamento.
    if (rows.length === 0) break;
    const proximo = chave(rows[rows.length - 1]);
    // O cursor tem de avançar ESTRITAMENTE. Os dois modos de violar o contrato falham aqui,
    // e nenhum dos dois se denuncia sozinho:
    //   PARADO  — chave repetida (não é única no recorte): o laço pediria a mesma página
    //             para sempre e a edge morreria no timeout, sintoma que não se parece nada
    //             com a causa.
    //   PARA TRÁS — o call-site ordenou DESC. `fetchAllKeyset` só recebe `build`, então não
    //             enxerga o `.order()`: com `.gt(cursor)` sobre página decrescente o cursor
    //             recua, a página seguinte reserve quase tudo e o resto do recorte nunca é
    //             lido. Sem esta guarda a leitura RESOLVE, com duplicata em massa e cauda
    //             faltando — em silêncio, que é o pior desfecho possível aqui.
    if (cursor !== null && proximo <= cursor) {
      const modo = proximo === cursor
        ? `chave repetida em ${JSON.stringify(proximo)} — a chave precisa ser ÚNICA no recorte`
        : `cursor RECUOU (${JSON.stringify(cursor)} → ${JSON.stringify(proximo)}) — o keyset exige .order() ASCENDENTE na mesma coluna`;
      // Idem: o modo classifica, os valores ficam em `cause`.
      throw new FalhaLeituraCritica(label, {
        code: proximo === cursor ? 'KEYSET_CHAVE_REPETIDA' : 'KEYSET_FORA_DE_ORDEM',
        message: `cursor não avançou: ${modo}`,
      });
    }
    cursor = proximo;
  }
  return out;
}
