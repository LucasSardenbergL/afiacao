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
        message: e instanceof Error ? e.message : String(e),
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
    if (rows.length < PAGE) break;
    from += PAGE;
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
        message: e instanceof Error ? e.message : String(e),
      });
    }
    const { data, error } = resposta;
    if (error) throw new FalhaLeituraCritica(label, error);
    // Mesmo fail-closed de `fetchAll`: `data` que não é ARRAY é resposta MALFORMADA, não fim
    // da tabela — devolver o acumulado parcial seria a truncagem silenciosa que o #1581 tirou
    // de 24 call-sites, e `push(...rows)` espalharia uma string em caracteres.
    if (!Array.isArray(data)) throw new FalhaLeituraCritica(label, { code: 'MALFORMADA' });
    const rows = data;
    // Varre a PÁGINA INTEIRA antes de acumular nada. Três violações do contrato do keyset
    // caem aqui, e as três resolveriam em SILÊNCIO sem esta varredura:
    //
    //   chave AUSENTE  — a coluna-chave ficou fora do `.select()`. O `.select()` é uma
    //     string e a interface da linha PROMETE o campo, então o typecheck passa e só o
    //     runtime descobre; o cursor viraria `undefined` e o `.gt()` filtraria o que desse.
    //   ordem DESC     — `.order(chave,{ascending:false})` no call-site. Precisa ser pego
    //     aqui e não na comparação de cursor lá embaixo: sob DESC a 2ª página já volta
    //     curta, o laço encerraria pelo `length < PAGE` e a comparação nunca rodaria.
    //   ordem ARBITRÁRIA — `.limit()` sem `.order()`. Comparar só os extremos da página
    //     deixaria passar a que tem o miolo embaralhado, e aí a última linha não é a maior
    //     chave: o cursor salta e a faixa entre ela e a real nunca é lida.
    //
    // Custa uma comparação por linha (≤1.000 por página) — a leitura em si é uma ida à
    // rede, então isto não aparece no perfil.
    let anterior: K | null = null;
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
        // Igualdade e decrescente são MODOS distintos e têm conserto distinto: chave repetida
        // significa "a coluna não é única no recorte" (troque a chave); decrescente significa
        // "o `.order()` está ao contrário". Fundir os dois em `k <= anterior` sem separar o
        // código manda o leitor caçar um `.order()` que está correto.
        throw new FalhaLeituraCritica(label, {
          code: k === anterior ? 'KEYSET_CHAVE_REPETIDA' : 'KEYSET_FORA_DE_ORDEM',
          message: k === anterior
            ? `chave repetida em ${JSON.stringify(k)} dentro da mesma página — a chave precisa ser ÚNICA no recorte`
            : `página fora de ordem ASCENDENTE (${JSON.stringify(anterior)} → ${JSON.stringify(k)}) — o keyset exige .order() ascendente na MESMA coluna do cursor`,
        });
      }
      anterior = k;
    }
    out.push(...rows);
    if (rows.length < PAGE) break;
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
