import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { ehFalhaDePagina, fetchAllPages } from '@/lib/postgrest';
import { erroComCausa, mensagemDeErro } from '@/lib/erro-mensagem';
import { captureException } from '@/lib/analytics';
import {
  avaliarCompletude,
  INSUMOS_OBRIGATORIOS_CROSS_SELL,
  type InsumosSnapshot,
} from '@/lib/farmer/completude-snapshot';
import { lerHeadVigente, registrarGeracaoFarmer } from '@/lib/farmer/registrar-geracao';
import { indexarCatalogoAtivo, resolverItemNoCatalogo } from '@/lib/farmer/identidade-item';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import {
  campoDeLinha,
  compararCandidatosUpSell,
  mesmaLinha,
  posicoesDecididasPorSinal,
  PISO_RAZAO_UP_SELL,
  VAGAS_UP_SELL,
  type ChaveUpSell,
  type LinhaDeProduto,
} from '@/lib/farmer/upsell-ordem';
import { acumularContaDeCompra, medirCoberturaContaDaOferta, ofertaNaContaDoCliente } from '@/lib/farmer/cobertura-conta-oferta';
import { toast } from 'sonner';

// ─── Types ───────────────────────────────────────────────────────────
export interface Recommendation {
  id?: string;
  customerId: string;
  customerName: string;
  type: 'cross_sell' | 'up_sell';
  productId: string;
  productName: string;
  currentProductId?: string;
  currentProductName?: string;
  pij: number;          // Probabilidade de conversão (0–100, já em %)
  /**
   * Score de AFINIDADE — adimensional, NÃO é dinheiro. Ordena a lista; não promete lucro.
   *
   * Era `lie` ("Expected Incremental Profit") = pij × mij × complexityFactor, com
   * `mij = margem × volume`. Sem custo no browser não há margem, e o produto todo caiu junto.
   *
   * Hoje é `pij` puro. `complexityFactor` fica fora porque desde o #1514 ele é a CONSTANTE
   * `FATOR_COMPLEXIDADE = 1.0` — igual para todo candidato, logo incapaz de mudar ORDEM.
   * (Antes de #1514 ele vinha de `farmer_category_conversion`, e aí havia motivo mais forte
   * ainda: a tabela é global e o browser faz upsert direto nela, então um employee escrevia o
   * fator e escolhia o próprio ranking. Se um dia voltar a ser aprendido, precisa nascer
   * server-owned, finito e limitado — e com a fórmula corrigida: a de updateConversionStats é
   * invertida, maior lucro/hora produz fator MENOR.)
   *
   * ⚠️ Nunca formatar como R$. `clusterVolume` também ficou FORA: ele já entra em `pij` via
   * `relevance`, e multiplicar de novo favoreceria produto popular contra associação de nicho —
   * que é o único sinal personalizado por cliente.
   */
  affinityScore: number;
  complexityFactor: number;
  clusterVolume: number;
  estoque: number | null; // Stock quantity from omie_products
  status: 'pendente' | 'ofertado' | 'aceito' | 'rejeitado' | 'expirado';
}

export interface CustomerRecommendations {
  customerId: string;
  customerName: string;
  healthScore: number;
  crossSell: Recommendation[];
  upSell: Recommendation[];
}

// ─── Row types ─────────────────────────────────────────────────────
interface ClientScoreRow {
  customer_user_id: string;
  health_score: number | string | null;
  answer_rate_60d: number | string | null;
  whatsapp_reply_rate_60d: number | string | null;
}

interface ProductRow {
  id: string;
  codigo: string | null;
  descricao: string;
  valor_unitario: number | string | null;
  metadata: unknown;
  ativo: boolean | null;
  omie_codigo_produto: number | string | null;
  estoque: number | null;
  /** Metade da chave de identidade do SKU (`UNIQUE (omie_codigo_produto, account)`). */
  account: string | null;
  /**
   * A LINHA do SKU — o recorte que torna "linha superior" verificável no up-sell.
   * Colunas DEDICADAS, não a cópia em `metadata->>'descricao_familia'`: divergência é zero
   * em prod hoje, mas a coluna é a autoridade. Ver `@/lib/farmer/upsell-ordem`.
   */
  familia: string | null;
  unidade: string | null;
}

interface SalesOrderItem {
  product_id?: string;
  omie_codigo_produto?: number | string;
  quantity?: number | string;
  quantidade?: number | string;
  unit_price?: number | string;
  valor_unitario?: number | string;
}

interface SalesOrderRow {
  customer_user_id: string;
  items: SalesOrderItem[] | unknown;
  total: number | string | null;
  created_at: string;
  /** A conta do PEDIDO — o lado do par que qualifica a resolução de cada item. */
  account: string | null;
}

interface AssocRuleRow {
  antecedent_product_ids: string[] | null;
  consequent_product_ids: string[] | null;
  confidence: number | string | null;
  lift: number | string | null;
  support: number | string | null;
}

interface ProfileRow {
  user_id: string;
  name: string | null;
  customer_type: string | null;
  cnae: string | null;
}

// ─── Premissas do LIE (NÃO são aprendidas) ───────────────────────────
// Constantes ARBITRADAS, não medições. Até 2026-07-21 o hook lia
// `farmer_category_conversion` e caía nestes mesmos valores quando não achava a
// linha — o que sugeria um "aprendizado histórico por categoria" que nunca
// existiu: a tabela tem 0 linhas desde que nasceu (fev/2026, `n_tup_ins = 0`),
// porque o único writer ficava atrás de `markAsAccepted`, que nenhuma UI jamais
// chamou. As 3.659 linhas de `farmer_recommendations` seguem 100% `pendente`,
// sem um único desfecho registrado. Ler a tabela vazia era teatro: quem decidia
// era sempre o default.
//
// Como são idênticas para TODO produto, funcionam como fator de ESCALA do LIE: o
// RANKING não depende delas (0,15·X vs 0,15·Y ordena igual a X vs Y). O que elas
// contaminam é o VALOR ABSOLUTO em R$ exibido na tela — que por isso é rotulado
// como estimativa não calibrada. Para virarem dado de verdade é preciso o loop de
// feedback inteiro (UI de desfecho + margem realizada + tempo gasto):
// ver docs/historico/farmer-aprendizado-conversao.md.
const TAXA_CONVERSAO_CROSS_SELL = 0.15;
const TAXA_CONVERSAO_UP_SELL = 0.10;
const FATOR_COMPLEXIDADE = 1.0;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ─── Main Hook ───────────────────────────────────────────────────────
export const useCrossSellEngine = () => {
  // Lente "Ver como": id efetivo = ALVO na lente (lê/recalcula as recomendações DELE
  // pra inspeção), próprio usuário fora. Na lente a persistência é PULADA (igual
  // useFarmerScoring): o master inspeciona, não regrava a carteira do alvo. Fora da
  // lente effectiveUserId === user.id (byte-equivalente, zero regressão).
  const { effectiveUserId, isImpersonating } = useImpersonation();
  const [recommendations, setRecommendations] = useState<CustomerRecommendations[]>([]);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);
  // A falha era ENGOLIDA: o `catch` só fazia `console.error` e o estado voltava a "pronto", com
  // `recommendations` mantendo o resultado do ÚLTIMO cálculo bem-sucedido. A tela ficava
  // idêntica a um recálculo que deu certo — o vendedor clicava "Recalcular", via a lista se
  // acomodar, e seguia decidindo sobre números velhos. Sem isto no contrato, nenhum consumidor
  // *podia* ser honesto: a correção do money-path só termina na tela.
  const [erro, setErro] = useState<Error | null>(null);
  const [desatualizado, setDesatualizado] = useState(false);
  // Espelha `recommendations` para o `catch` ler o valor ATUAL. Ler o state aqui devolveria o
  // do render em que o callback foi criado (`recommendations` não está nas deps do useCallback).
  const recomendacoesRef = useRef<CustomerRecommendations[]>([]);

  const aplicarRecomendacoes = useCallback((recs: CustomerRecommendations[]) => {
    recomendacoesRef.current = recs;
    setRecommendations(recs);
  }, []);

  const calculateRecommendations = useCallback(async () => {
    if (!effectiveUserId) return;
    setCalculating(true);
    setLoading(true);
    setErro(null);
    setDesatualizado(false);
    // Discrimina "a falha veio ANTES de produzir resultado" (a tela segue com o cálculo
    // anterior = desatualizada) de "veio DEPOIS" (falha ao persistir: os números na tela são
    // desta execução, e chamá-los de desatualizados mentiria na direção oposta).
    let resultadoDestaExecucao = false;
    // Ver `useBundleEngine`: sem isto, falha na gravação DEPOIS de calcular grava
    // `vazio`+`completo` — falha de persistência virando licença para expirar a carteira.
    let linhasProduzidas = false;

    // Snapshot dos insumos DESTA execução: por insumo, se a leitura deu certo e quantas
    // linhas vieram. É o que permite ao head declarar a completude — e, mais importante,
    // é a EVIDÊNCIA que deixa auditar a declaração em vez de confiar no rótulo.
    const insumos: InsumosSnapshot = {};
    // O head que esta execução VIU antes de calcular (lado "compare" do CAS do head).
    // `undefined` = não consegui ler → o registro é PULADO, nunca feito às cegas: `null`
    // significa "não há head" e faria o CAS passar como primeira execução, sobrescrevendo
    // um head que existe.
    let headVisto: string | null | undefined;
    const runId = crypto.randomUUID();

    /**
     * Registra a geração VAZIA (ou degradada) — os caminhos que não chamam a RPC de
     * substituição. Fail-open por dentro: nunca derruba a tela.
     */
    // Uma gravação de head por execução: o `catch` também registra agora.
    let jaRegistrou = false;
    // O alerta de head ilegível sai UMA vez por execução — `registrarVazio` tem vários
    // call-sites e o mesmo cálculo emitiria o mesmo alarme repetido.
    let alertouHeadIlegivel = false;
    const registrarVazio = async () => {
      if (isImpersonating) return;
      if (headVisto === undefined) {
        // Pular às cegas é correto; pular em SILÊNCIO é o defeito — "nenhum registro novo"
        // passaria a significar tanto vazio legítimo quanto sensor cego.
        if (alertouHeadIlegivel) return;
        alertouHeadIlegivel = true;
        captureException(new Error('[farmer/head] head ilegível — registro de cross-sell pulado'), {
          origem: 'farmer/head',
          motor: 'cross_sell',
          runId,
        });
        return;
      }
      if (jaRegistrou) return;
      const { completude, motivo } = avaliarCompletude(insumos, INSUMOS_OBRIGATORIOS_CROSS_SELL);
      const desfecho = await registrarGeracaoFarmer({
        motor: 'cross_sell',
        farmerId: effectiveUserId,
        runId,
        resultado: 'vazio',
        linhasGeradas: 0,
        completude,
        motivo,
        insumos,
        headVisto,
      });
      // `falha_rpc` NÃO trava o slot: travar antes de saber o desfecho faria uma tentativa
      // falha suprimir uma posterior que daria certo — o sensor se calaria por causa do
      // próprio erro que precisava registrar.
      if (desfecho.registrado || desfecho.motivo !== 'falha_rpc') jaRegistrou = true;
    };

    try {
      // 0. Identidade desta EXECUÇÃO + a geração que ela está substituindo.
      //
      // Lido ANTES do snapshot de propósito: reivindicar depois deixa a corrida aberta
      // pela porta de trás (money-path §10). `geracaoVista` é o lado "compare" do
      // compare-and-swap da RPC — se outro recálculo gravar entre esta leitura e a
      // escrita lá embaixo, a RPC recusa com FG006 em vez de sobrescrever o resultado
      // mais NOVO com o meu, que leu dado mais velho. Não depende de relógio nenhum
      // (nem do browser, nem do servidor).
      //
      // Na lente "Ver como" a persistência é pulada, então nem lemos.
      let geracaoVista: string | null = null;
      if (!isImpersonating) {
        // O head do motor, lido na MESMA janela que a geração vigente e pelo mesmo motivo.
        headVisto = await lerHeadVigente('cross_sell', effectiveUserId);
        // Mesma ordem que a RPC usa para eleger a geração vigente (created_at desc, id desc):
        // divergir aqui faria o compare-and-swap comparar com outra linha e recusar sempre.
        const { data: vigente, error: erroVigente } = await supabase
          .from('farmer_recommendations')
          .select('run_id')
          .eq('farmer_id', effectiveUserId)
          .eq('status', 'pendente')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(1);
        // FAIL-CLOSED: sem saber qual é a geração vigente não dá para substituí-la com
        // segurança. Degradar para `null` afirmaria "não há geração nenhuma" e faria a
        // RPC recusar (ou, pior num desenho sem guard, expirar em cima de dado incerto).
        if (erroVigente) {
          throw new Error(
            mensagemDeErro(erroVigente) ??
              'Não consegui ler a geração vigente de recomendações — nada foi recalculado.',
          );
        }
        geracaoVista = vigente?.[0]?.run_id ?? null;
      }

      // 1. Load client scores with pagination. Era um loop MANUAL com o mesmo defeito que o
      // #1545 tirou do `fetchAllPages` — mas por não CHAMAR o helper, ficou de fora daquele
      // grep: descartava o `error` (`const { data } = await q`), tratava `data: null` como fim
      // da tabela e não pedia `.order()`, então a ordem entre páginas era indefinida (o
      // Postgres pode repetir e pular linha). `customer_user_id` é UNIQUE na tabela.
      //
      // Aqui a página perdida era pior que um total truncado: o caller abaixo interpreta lista
      // vazia como "este farmer não tem carteira, deve ser super_admin" e RECARREGA SEM FILTRO
      // de farmer_id — uma falha de transporte trocava o escopo do cálculo.
      const fetchAllScores = (filterFarmerId?: string): Promise<ClientScoreRow[]> =>
        fetchAllPages<ClientScoreRow>(
          (de, ate) => {
            let q = supabase.from('farmer_client_scores').select('*');
            if (filterFarmerId) q = q.eq('farmer_id', filterFarmerId);
            return q.order('customer_user_id', { ascending: true }).range(de, ate) as unknown as
              PromiseLike<{ data: ClientScoreRow[] | null; error: unknown }>;
          },
          'farmer_client_scores/cross-sell',
        );

      // Try farmer-specific first, fallback to all (for super_admin). Na lente NÃO cai
      // no fallback de "todos os scores" — escopa estritamente ao alvo (degradação
      // honesta: alvo sem score → lista vazia, nunca a carteira de todo mundo).
      let clientScores = await fetchAllScores(effectiveUserId);
      if (!clientScores.length && !isImpersonating) {
        clientScores = await fetchAllScores();
      }

      // `fetchAllPages` LANÇA em falha de página (#1545), então chegar aqui já significa
      // leitura íntegra — `ok: true`. O que ainda pode ser zero é o CONTEÚDO, e é essa a
      // diferença que o head passa a registrar.
      insumos.scores = { ok: true, n: clientScores.length };

      if (!clientScores?.length) {
        aplicarRecomendacoes([]);
        resultadoDestaExecucao = true;
        // Este `return` era MUDO: o recálculo saía por aqui sem gravar linha, sem
        // registrar execução e sem toast — e era por isso que a frequência do zero não
        // tinha como ser medida. Agora ele move o head declarando POR QUE deu zero
        // (`degradado`: carteira sem score é dado faltando a montante, não "nada a ofertar").
        await registrarVazio();
        return;
      }

      // 2. Catálogo ativo, paginado (3.108 SKUs contra a capa de 1.000 do PostgREST).
      const products = await fetchAllPages<ProductRow>((de, ate) =>
        supabase
          .from('omie_products')
          .select('id, codigo, descricao, valor_unitario, metadata, ativo, omie_codigo_produto, estoque, account, familia, unidade')
          .eq('ativo', true)
          .order('id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: ProductRow[] | null; error: unknown }>,
        'omie_products/cross-sell',
      );

      // 2b. Quais SKUs são VENDÁVEIS (margem canônica > 0). O browser não vê mais custo:
      // `public.get_skus_margem_positiva()` responde só o conjunto, sem parâmetro e sem ordem
      // (a versão que recebia pesos e devolvia ranking era régua graduada — ver o cabeçalho da
      // migration 20260725120000). SKU sem custo conhecido não entra: ausente≠zero (#1466).
      //
      // FAIL-CLOSED: falha na RPC → NÃO recomenda. Degradar para "recomenda tudo" poria produto
      // de PREJUÍZO no topo da lista da vendedora, que é o pior desfecho possível aqui.
      //
      // PAGINADA, com `.order` estável ANTES do `.range`: a RPC devolve 2.462 linhas em prod e
      // o PostgREST capa em 1.000 — o cap vale para `.rpc()` como vale para `.from()`. Aqui o
      // truncamento era pior que no bundle: `insumos.vendaveis` abaixo declarava `ok: true` com
      // `n` já cortado, ou seja, um head **completo** apoiado em dado incompleto — exatamente o
      // que NÃO pode autorizar expiração. E como a função não tem `ORDER BY` próprio, paginar
      // sem ordem total deixaria o plano escolher a ordem de cada página, pulando linhas.
      const vendaveisResult = await fetchAllPages<{ product_id: string }>(
        (de, ate) =>
          supabase
            .rpc('get_skus_margem_positiva')
            .order('product_id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: { product_id: string }[] | null; error: unknown }>,
        'get_skus_margem_positiva/cross-sell',
      ).then(
        (data) => ({ ok: true as const, data }),
        // NÃO relança aqui, e a distinção NÃO é sobre agir ou não agir: o fail-closed vale para
        // QUALQUER falha na leitura de vendáveis — inclusive bug de código. O que `esperada`
        // discrimina é só o DIAGNÓSTICO: qual erro chega à tela e ao plantão.
        //
        // O handler anterior (`error => ({ data: null, error })`) engolia QUALQUER rejeição e a
        // rotulava com a mensagem de negócio. Não é hipotético: no #1782 mocks devolvendo
        // Promise crua produziram `supabase.rpc(...).order is not a function`, e este `.then`
        // converteu o TypeError em "vendáveis indisponíveis" — um defeito de CÓDIGO chegando
        // disfarçado de INDISPONIBILIDADE DE DADO, que manda o plantão para o lado errado.
        (error: unknown) => ({ ok: false as const, error, falha: ehFalhaDePagina(error) ? error : null }),
      );
      insumos.catalogo = { ok: true, n: products.length };
      if (!vendaveisResult.ok) {
        console.error('get_skus_margem_positiva falhou — sem recomendação (fail-closed):', vendaveisResult.error);
        // `ok: false` — não é "veio vazio", é "não consegui ler". A distinção é o produto
        // desta entrega: um head `degradado` por aqui NUNCA poderá autorizar expiração.
        insumos.vendaveis = { ok: false, n: 0 };
        await registrarVazio();
        // Fail-closed E DECLARADO. Só limpar a lista e sair repetiria, num caminho NOVO, o defeito
        // que o #1606 tirou deste hook: a tela mostrava fila vazia e o operador não distinguia
        // "não há o que recomendar" de "não consegui calcular" — e ia embora achando que era a
        // primeira coisa. Este `return` mudo nem passava pelo `catch` honesto lá embaixo.
        //
        // Limpa ANTES de lançar, e não depois: manter as recomendações anteriores na tela
        // contrariaria o próprio fail-closed (elas podem conter SKU que o servidor já não confirma
        // como rentável). Com a lista zerada e `resultadoDestaExecucao` marcado, o `catch` conclui
        // INDISPONÍVEL em vez de DESATUALIZADO — que é a leitura verdadeira aqui.
        //
        // ⚠️ Este bloco roda para TODA falha da leitura de vendáveis, inclusive bug de código.
        // Deixar o TypeError subir cru DAQUI (sem limpar a lista) foi o desenho que o Codex
        // gpt-5.6-sol reprovou como [P1]: a tela concluiria DESATUALIZADO e seguiria exibindo
        // recomendações da execução anterior — que podem conter SKU cuja margem já não é
        // positiva. "Desatualizado" não é sinônimo de "seguro de usar", e o gate de
        // RENTABILIDADE não pode degradar mais fraco só porque a falha foi de outra natureza.
        aplicarRecomendacoes([]);
        resultadoDestaExecucao = true;
        // O que a natureza da falha decide é SÓ o erro que sobe:
        //  • não-esperada (bug: builder quebrado, TypeError) → relança o objeto ORIGINAL, com a
        //    stack e a mensagem verdadeiras. Traduzi-lo para a frase de negócio apagaria o
        //    único rastro que aponta para a linha defeituosa;
        //  • esperada (página com `error`, `data: null` malformado) → mensagem do SERVIDOR, com
        //    o erro assinado preso em `cause` para o plantão.
        if (!vendaveisResult.falha) throw vendaveisResult.error;
        // A mensagem sai da CAUSA, não do erro assinado: a dele é `fetchAllPages: página 0
        // (0-999) falhou` — jargão de helper, que diz à vendedora menos do que o servidor já
        // tinha dito. É o defeito que `mensagemDeErro` existe para evitar ("a mensagem
        // acionável existe, o servidor a mandou, e ela morre na fronteira"), reaparecendo uma
        // camada acima. Em `data_null_sem_error` não há causa e o fallback de domínio é o certo.
        throw erroComCausa(
          mensagemDeErro(vendaveisResult.falha.cause) ??
            'Não consegui confirmar quais SKUs são rentáveis — nenhuma recomendação foi gerada.',
          vendaveisResult.error,
        );
      }
      const vendaveis = new Set(vendaveisResult.data.map((r) => r.product_id));
      insumos.vendaveis = { ok: true, n: vendaveis.size };

      // 3. Load ALL sales history (avoid huge .in() URL with 3598 IDs)
      // Mesmo defeito do loop manual acima — e aqui a perda é do HISTÓRICO que alimenta as
      // regras de associação: menos pedidos = menos coocorrência = recomendação mais pobre,
      // sem nada na tela indicando que o universo encolheu. `.order('id')` (PK) é a ordem
      // estável; a coluna não precisa estar no `select`.
      const salesOrders = await fetchAllPages<SalesOrderRow>(
        (de, ate) =>
          supabase
            .from('sales_orders')
            .select('customer_user_id, items, total, created_at, account')
            // DENYLIST + `deleted_at IS NULL`: o MESMO universo de
            // `private.margem_cliente_agregada()` e do `useFarmerScoring` (#1738). A allowlist que
            // estava aqui citava DOIS status que nunca existiram nesta tabela (`confirmado`,
            // `entregue`) e resolvia para só `faturado`: 10.281 pedidos reais — `importado` 5.455,
            // `separacao` 2.817, `enviado` 2.009 — ficavam fora da coocorrência que gera a recomendação. Ver
            // `@/lib/farmer/universo-pedidos` (inclusive o efeito no denominador do support).
            .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
            .is('deleted_at', null)
            .order('id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: SalesOrderRow[] | null; error: unknown }>,
        'sales_orders/cross-sell',
      );

      // Build set of customer IDs that have orders
      const customerIdsWithOrders = new Set<string>();
      (salesOrders || []).forEach((o) => customerIdsWithOrders.add(o.customer_user_id));

      // Filter clientScores to only those with orders (avoid processing 3598 empty clients)
      const activeClientScores = clientScores.filter((c) => customerIdsWithOrders.has(c.customer_user_id));
      const customerIds = activeClientScores.map((c) => c.customer_user_id);
      // Dois insumos distintos de propósito: `pedidos` é global (a base tem histórico?) e
      // `carteira_ativa` é o universo REAL deste cálculo (a carteira DESTE farmer tem?).
      insumos.pedidos = { ok: true, n: customerIdsWithOrders.size };
      insumos.carteira_ativa = { ok: true, n: customerIds.length };

      if (!customerIds.length) {
        aplicarRecomendacoes([]);
        resultadoDestaExecucao = true;
        // Outro `return` que era MUDO. Degrada (não "completo"): sem nenhum cliente com
        // histórico não há coocorrência de onde tirar recomendação, então o zero não julga
        // o portfólio — e um zero que não julga o portfólio não pode virar licença para
        // expirar a carteira.
        await registrarVazio();
        return;
      }

      // 4. Load association rules for personalized recommendations
      //
      // O `error` é CAPTURADO, e a falha LANÇA. Antes o cast declarava só `{ data }` e
      // apagava o `error` do tipo: uma leitura falha virava `assocRules || []` → mapa de
      // associação VAZIO → só o sinal de popularidade sobrava, e o cálculo seguia como se
      // a base não tivesse padrão nenhum.
      //
      // Isso era ruim quando o resultado apenas se somava ao que já existia; virou GRAVE
      // agora que a persistência SUBSTITUI: um snapshot degradado por falha de transporte
      // expiraria a carteira inteira do farmer e apagaria cross-sells legítimos de todos os
      // clientes dele. Expirar por farmer só é seguro se o snapshot for COMPLETO — então a
      // completude precisa ser verificada, não presumida (achado do challenge Codex xhigh).
      const { data: assocRules, error: erroAssoc } = (await supabase
        .from('farmer_association_rules')
        .select('antecedent_product_ids, consequent_product_ids, confidence, lift, support')
        .gte('confidence', 0.05)
        .gte('lift', 1.0)) as unknown as { data: AssocRuleRow[] | null; error: unknown };
      if (erroAssoc) {
        // NÃO move o head: este caminho lança SEM limpar a tela, então a execução não
        // concluiu e o que o operador vê segue sendo o resultado anterior. O head registra
        // execução CONCLUÍDA — mover aqui afirmaria um desfecho que não houve.
        throw new Error(
          mensagemDeErro(erroAssoc) ??
            'Não consegui ler as regras de associação — o cálculo seria parcial e substituiria as recomendações atuais, então nada foi alterado.',
        );
      }
      // `regras` NÃO é obrigatório-não-vazio: base sem padrão de coocorrência é estado
      // legítimo e o motor ainda recomenda por popularidade. Mas `ok: false` acima degrada,
      // porque aí o universo foi lido pela metade.
      insumos.regras = { ok: true, n: (assocRules || []).length };

      // Build map: antecedent product -> consequent products with scores
      const assocMap = new Map<string, { productId: string; confidence: number; lift: number; support: number }[]>();
      for (const rule of assocRules || []) {
        for (const ant of rule.antecedent_product_ids || []) {
          if (!assocMap.has(ant)) assocMap.set(ant, []);
          for (const cons of rule.consequent_product_ids || []) {
            assocMap.get(ant)!.push({
              productId: cons,
              confidence: Number(rule.confidence),
              lift: Number(rule.lift),
              support: Number(rule.support),
            });
          }
        }
      }

      // 5. Load customer profiles for active clients only
      // Split into batches of 100 (URL-limit safety) e dispara TODAS em paralelo.
      // Antes era sequencial: com 3598 clientes ativos = 36 roundtrips serial = 5–15s
      // bloqueando a thread de cálculo. Promise.all → 1 RTT efetivo (Supabase paraleliza).
      const batches: string[][] = [];
      for (let i = 0; i < customerIds.length; i += 100) {
        batches.push(customerIds.slice(i, i + 100));
      }
      const batchResults = await Promise.all(
        batches.map((batch) =>
          supabase
            .from('profiles')
            .select('user_id, name, customer_type, cnae')
            // O cast declarava só `{ data }` e APAGAVA o `error` do tipo — o compilador
            // deixava de cobrar a checagem, e um lote que falhasse virava "estes clientes
            // não têm perfil" no cross-sell (segmento/CNAE ausentes = recomendação errada).
            .in('user_id', batch) as unknown as Promise<{ data: ProfileRow[] | null; error: { message?: string } | null }>,
        ),
      );
      const loteComFalha = batchResults.findIndex((r) => r.error);
      if (loteComFalha >= 0) {
        throw new Error(`cross-sell: lote ${loteComFalha + 1}/${batchResults.length} de profiles falhou — perfis incompletos, recomendação não calculada`);
      }
      const allProfiles: ProfileRow[] = batchResults.flatMap((r) => r.data || []);
      const profileMap = new Map<string, ProfileRow>();
      allProfiles.forEach((p) => profileMap.set(p.user_id, p));

      // COBERTURA de perfil, não só contagem (achado do challenge Codex xhigh). Mais
      // abaixo o motor faz `if (!profile) continue`: cliente sem perfil é PULADO em
      // silêncio, e a base tem 1.633 usuários `@placeholder.local` sem `profiles` (aliases
      // fiscais — ver database.md §5). Um farmer cujos clientes ativos caiam todos nesse
      // grupo produziria zero com todos os insumos "não-vazios" — `completo` sem ser.
      // Medir o universo global (`n > 0`) não pega isso; medir a INTERSEÇÃO pega.
      insumos.clientes_com_profile = {
        ok: true,
        n: customerIds.filter((id) => profileMap.has(id)).length,
        // `n > 0` aceitava 1 perfil para 101 clientes: o motor pula os outros 100 em silêncio e
        // o zero resultante sairia `completo`. O universo é a carteira do cálculo.
        // `esperado` é EVIDÊNCIA, SEM piso — decisão medida, não omissão. Distribuição real
        // (psql-ro, 19/08/2026, 3 farmers com carteira ativa): 2 em 100% de cobertura e 1 em
        // 85,96%; NENHUM abaixo de 50%. Qualquer piso plausível ou é inerte no regime atual ou
        // degrada o farmer de 86% já no primeiro recálculo. Fixar um número seria inventar o
        // limiar (money-path §5); o `n`/`esperado` ficam no head para calibrá-lo quando houver
        // farmers suficientes para que ele signifique algo.
        esperado: customerIds.length,
      };

      // 6. Índice ACCOUNT-AWARE do catálogo ativo — o par `(omie_codigo_produto, account)`, que é
      // a chave que `omie_products` declara única. O `Map<number, string>` global que estava
      // aqui assumia unicidade do código sozinho: onde o schema permite duas linhas, o Map
      // guardava uma, e o vencedor era a ordem da paginação.
      // Ver `src/lib/farmer/identidade-item.ts` para a medição e o racional.
      const indiceCatalogo = indexarCatalogoAtivo(products || []);

      // 7. Build per-customer purchase history. Sem `cost`: o custo não chega mais ao browser.
      const customerProducts = new Map<string, Map<string, { qty: number; price: number }>>();
      // Contas em que cada cliente EFETIVAMENTE comprou — o lado "histórico" do sensor
      // `oferta_conta_do_cliente`. Sai de `sales_orders.account`, a mesma coluna que
      // qualifica o item, e é montado neste loop porque ele já varre todos os pedidos.
      const contasDeCompraPorCliente = new Map<string, Set<string | null>>();
      let itensResolvidos = 0;
      let itensContaDivergente = 0;

      for (const order of salesOrders || []) {
        const cid = order.customer_user_id;
        if (!customerProducts.has(cid)) customerProducts.set(cid, new Map());
        const cp = customerProducts.get(cid)!;
        // ANTES do parse dos itens de propósito: a conta do cliente é fato do PEDIDO, e vale
        // mesmo quando nenhum item dele resolve para SKU ativo (39,9% dos itens em prod).
        acumularContaDeCompra(contasDeCompraPorCliente, cid, order.account);

        const items: SalesOrderItem[] = Array.isArray(order.items) ? (order.items as SalesOrderItem[]) : [];
        for (const item of items) {
          // Resolução qualificada pela conta DO PEDIDO. `product_id` deixou de entrar direto:
          // é confrontado com o catálogo ativo e com a conta, como o código sempre foi.
          const r = resolverItemNoCatalogo(item, order.account, indiceCatalogo);
          if (!r.ok) {
            // Contador que torna o guard auditável — ver o insumo `itens_identidade_conforme`.
            if (r.motivo === 'conta_divergente') itensContaDivergente++;
            continue;
          }
          const productId = r.productId;
          itensResolvidos++;

          const existing = cp.get(productId) || { qty: 0, price: 0 };
          existing.qty += Number(item.quantity || item.quantidade || 1);
          existing.price = Number(item.unit_price || item.valor_unitario || 0);
          cp.set(productId, existing);
        }
      }

      // COBERTURA de HISTÓRICO, o par de `clientes_com_profile` — e o pré-requisito que o
      // §7.5 do design deixou declarado como limitação. `carteira_ativa` conta cliente com
      // PEDIDO; o insumo do cálculo é item que RESOLVE. O loop acima acabou de descartar em
      // silêncio (`if (!r.ok) continue`) todo item cujo `omie_codigo_produto` não bate num SKU
      // ATIVO — e em prod (18/08/2026) isso é 39,9% dos 47.735 itens, deixando 107 dos 861
      // clientes com pedido e ZERO histórico utilizável. Medido de novo em 20/08/2026: os
      // 19.060 descartes são 100% SKU INATIVO da PRÓPRIA conta (zero código órfão, zero
      // cross-account), então a qualificação por conta não mexeu neste número.
      //
      // Sai de graça: `customerProducts` já foi construído, então isto é um filtro sobre
      // memória, não uma varredura nova — era esse custo suposto que barrou a instrumentação
      // no design. Interseção com a CARTEIRA, como o insumo de perfil: contar itens
      // resolvidos no universo global não distinguiria o farmer cujos clientes são todos
      // desses 107.
      insumos.carteira_com_historico_utilizavel = {
        ok: true,
        n: customerIds.filter((id) => (customerProducts.get(id)?.size ?? 0) > 0).length,
        // Mesma correção de `clientes_com_profile`: `n > 0` aceitaria 1 cliente com histórico
        // para 101 na carteira — o motor opinaria sobre 1% dela e o head diria `completo`.
        // `esperado` é EVIDÊNCIA, SEM piso — decisão medida, não omissão. Distribuição real
        // (psql-ro, 19/08/2026, 3 farmers com carteira ativa): 2 em 100% de cobertura e 1 em
        // 85,96%; NENHUM abaixo de 50%. Qualquer piso plausível ou é inerte no regime atual ou
        // degrada o farmer de 86% já no primeiro recálculo. Fixar um número seria inventar o
        // limiar (money-path §5); o `n`/`esperado` ficam no head para calibrá-lo quando houver
        // farmers suficientes para que ele signifique algo.
        esperado: customerIds.length,
      };

      // SENSOR da identidade account-aware (par `(omie_codigo_produto, account)`). `n` são os
      // itens que resolveram; `esperado` soma a esses SÓ os que saíram por DIVERGÊNCIA DE
      // CONTA. Item de SKU inativo fica fora do denominador de propósito: são 39,9% em prod
      // (regime normal, já auditado por `carteira_com_historico_utilizavel`), e diluir a
      // divergência neles daria um número farto que nunca chamaria atenção.
      //
      // Hoje `n === esperado` em produção (0 de 47.798 itens divergem, psql-ro 20/08/2026).
      // SEM piso: não muda veredicto. `n < esperado` é o gatilho para reabrir o achado.
      insumos.itens_identidade_conforme = {
        ok: true,
        n: itensResolvidos,
        esperado: itensResolvidos + itensContaDivergente,
      };

      // ADERÊNCIA AO CLUSTER — as duas pontas no MESMO universo, que é a carteira do cálculo.
      //
      // O que havia aqui dividia OCORRÊNCIAS DE ITEM (contadas dentro do laço de itens de
      // TODOS os pedidos da base, universo global) por `customerIds.length` (a carteira DESTE
      // farmer, universo local). Um cliente que comprasse o mesmo SKU em 10 pedidos contava
      // 10, e o quociente não era fração de coisa nenhuma — embora o comentário da linha o
      // chamasse de "total customers who bought". O `clamp(…, 0, 1)` não corrigia: ele
      // ESCONDIA, saturando em 1,0 todo SKU de volume alto.
      //
      // O estrago é de RANKING, e foi medido antes de escolher (psql-ro + simulação do motor
      // sobre os 3 farmers com carteira ativa, 20/08/2026):
      //   · 829 dos 1.052 clientes tinham o top-3 em EMPATE TOTAL de score — três SKUs
      //     saturados em 1,0 com `assocBoost` 0 dão `relevance` 0,4 idêntico, e quem escolhia
      //     a oferta era a ordem de `.order('id')` do catálogo. Depois: ZERO empates.
      //   · 98,5% do top-3 caía em `oben` contra 1,5% `colacor`; depois, 63,2% `colacor` —
      //     coerente com a disponibilidade (71% dos vendáveis são `colacor`). É o mesmo viés
      //     que o #1823 mediu em prod (934 dos 939 cross-sell vivos `oben`) e descartou como
      //     "não é o gate de popularidade": não era a ADMISSÃO no gate, era a SATURAÇÃO.
      //   · A inflação é ANTI-correlacionada com o tamanho da carteira (numerador global sobre
      //     denominador local): o farmer de 269 clientes tinha 587 SKUs acima do gate de 3%,
      //     224 deles SEM UM ÚNICO comprador na própria carteira.
      //
      // A alternativa era global nas duas pontas (clientes distintos da BASE ÷ 1.073 clientes
      // com histórico). Ela também conserta a escala, mas foi DESCARTADA pelo dado: produz o
      // mesmo conjunto de 80 SKUs para os três farmers — um termo que não distingue carteira
      // nenhuma, o oposto do que "aderência do CLUSTER" promete. A local varia (112/103/26) e
      // é o universo que o resto do arquivo já declara medir (`clientes_com_profile`,
      // `carteira_com_historico_utilizavel`).
      //
      // Custo do aperto, medido: NENHUM. O volume de recomendação é idêntico (3.156 = 3.156):
      // o gate corta candidato de sobra, nunca os 3 do topo — nenhum farmer seca. O que muda é
      // a ORDEM (top-3 diferente em 1.026 dos 1.052 clientes; top-1 em 532) e o equilíbrio com
      // o `assocBoost`, que sai de decidir 1,0% dos topos para 12,8% — ele é o ÚNICO termo
      // personalizado por cliente, e estava afogado pela saturação.
      const clientesQueCompraram = new Map<string, number>(); // product_id -> clientes DISTINTOS da carteira
      for (const cid of customerIds) {
        // `keys()` do histórico já é o conjunto de SKUs distintos DAQUELE cliente: cada
        // cliente entra no máximo UMA vez por SKU, quantos pedidos tenha feito.
        for (const productId of (customerProducts.get(cid) ?? new Map()).keys()) {
          clientesQueCompraram.set(productId, (clientesQueCompraram.get(productId) ?? 0) + 1);
        }
      }
      // O denominador é quem PODERIA estar no numerador. Cliente da carteira sem histórico
      // utilizável (pedido só de SKU inativo) nunca pode ser contado como comprador de nada,
      // então incluí-lo diluiria a fração por um universo incapaz de contribuir — o mesmo
      // defeito de escala, de grau menor. Em prod são 45/51/58 clientes por farmer.
      const carteiraComHistorico = Math.max(
        customerIds.filter((id) => (customerProducts.get(id)?.size ?? 0) > 0).length,
        1,
      );
      const productList = products || [];

      // 7. Calculate recommendations per client
      const allRecs: CustomerRecommendations[] = [];
      // Os CANDIDATOS que sobreviveram a todos os gates — o denominador que separa
      // "a carteira é assim" de "o ranking prefere assim". Ver `candidatos_conta_do_cliente`.
      let candidatosElegiveis = 0;
      let candidatosNaContaDoCliente = 0;
      // O par do `upsell_ordem_decidida`: quantas posições de up-sell chegaram ao vendedor e
      // quantas delas o SINAL decidiu (ver `posicoesDecididasPorSinal`).
      let upSellPosicoesEmitidas = 0;
      let upSellPosicoesDecididas = 0;

      // `productList` indexado por id. Existia como `productList.find(...)` DENTRO do laço de
      // candidatos do up-sell (O(catálogo) por oferta, com o catálogo em 3.140 SKUs); agora o
      // item comprado também precisa ser resolvido para dar a LINHA, o que faria o `find`
      // rodar por CANDIDATO em vez de por oferta.
      const indiceProdutos = new Map(productList.map((p) => [p.id, p]));

      for (const score of activeClientScores) {
        const cid = score.customer_user_id;
        const profile = profileMap.get(cid);
        if (!profile) continue;

        const healthScore = Math.max(Number(score.health_score || 0), 10); // min 10 to avoid zero
        const customerPurchased = customerProducts.get(cid) || new Map();
        const purchasedIds = new Set(customerPurchased.keys());

        // Engagement factor: based on answer rate and responsiveness
        const answerRate = Number(score.answer_rate_60d || 0) / 100;
        const whatsappRate = Number(score.whatsapp_reply_rate_60d || 0) / 100;
        const engagementFactor = clamp(0.3 + 0.5 * answerRate + 0.2 * whatsappRate, 0.1, 1.0);

        const crossSellRecs: Recommendation[] = [];
        const upSellRecs: Recommendation[] = [];

        // ─── CROSS-SELL: Products not purchased, personalized by association rules ───
        // Build association boost map for this customer's purchased products
        const assocBoostMap = new Map<string, number>(); // productId -> max association score
        for (const purchasedId of purchasedIds) {
          const rules = assocMap.get(purchasedId);
          if (!rules) continue;
          for (const rule of rules) {
            if (purchasedIds.has(rule.productId)) continue; // already bought
            const assocScore = rule.confidence * Math.min(rule.lift, 5) / 5; // normalize lift
            const current = assocBoostMap.get(rule.productId) || 0;
            assocBoostMap.set(rule.productId, Math.max(current, assocScore));
          }
        }

        for (const product of productList) {
          if (purchasedIds.has(product.id)) continue;

          // O custo decide EXCLUSÃO, nunca ORDEM: o SKU só entra se a RPC o listou como vendável
          // (margem canônica > 0). Custo desconhecido não entra — ausente≠zero (#1466).
          if (!vendaveis.has(product.id)) continue;

          // Aderência do cluster: QUANTOS CLIENTES da carteira compraram isto — não quantas
          // vezes foi comprado. O numerador é subconjunto do denominador por construção, então
          // o quociente já é uma fração ≤ 1: o `clamp` fica como rede, não como disfarce.
          const buyerCount = clientesQueCompraram.get(product.id) || 0;
          const clusterAdherence = clamp(buyerCount / carteiraComHistorico, 0, 1);

          // Association boost: personalized score based on what THIS customer bought
          const assocBoost = assocBoostMap.get(product.id) || 0;

          // Skip if neither popular in cluster nor associated with customer's basket
          if (clusterAdherence < 0.03 && assocBoost === 0) continue;

          // Historical conversion rate for this product
          // P_ij = TaxaArbitrada × (HealthScore/100) × Engagement × (ClusterAdherence + AssocBoost)
          const relevance = clamp(clusterAdherence * 0.4 + assocBoost * 0.6, 0.01, 1.0);
          const pij = TAXA_CONVERSAO_CROSS_SELL * (healthScore / 100) * engagementFactor * relevance;

          // Estimativa de volume do cluster: preservada como CONTEXTO da recomendação, mas fora
          // do score (ela já entra em `pij` via `relevance` — remultiplicar afogaria o assocBoost).
          // Segue a MESMA fração — senão volta a afirmar volume que a carteira não comporta:
          // com o numerador em ocorrências ele chegava a 40 numa carteira de 211 (medido), e
          // este número é PERSISTIDO em `cluster_volume_estimate`.
          const clusterVolume = Math.max(1, Math.round(buyerCount / carteiraComHistorico * 12));

          // Constante desde o #1514 (ver bloco de premissas). Persistida como dado, mas NÃO
          // multiplica o score: sendo 1.0 e igual para todo candidato, ela não muda ORDEM.
          const complexityFactor = FATOR_COMPLEXIDADE;

          // Afinidade pura. Sem custo não existe "lucro esperado" — existe "próxima melhor oferta".
          const affinityScore = pij;

          if (affinityScore > 0) {
            candidatosElegiveis++;
            if (ofertaNaContaDoCliente(product.id, contasDeCompraPorCliente.get(cid), indiceCatalogo.contaDoProduto)) {
              candidatosNaContaDoCliente++;
            }
            crossSellRecs.push({
              customerId: cid,
              customerName: profile.name ?? '',
              type: 'cross_sell',
              productId: product.id,
              productName: product.descricao,
              pij: Math.round(pij * 1000) / 10,
              affinityScore: Math.round(affinityScore * 10000) / 10000,
              complexityFactor,
              clusterVolume,
              estoque: product.estoque ?? null,
              status: 'pendente',
            });
          }
        }

        // ─── UP-SELL: a LINHA superior do item já comprado ───
        //
        // Os dois testes de margem que existiam aqui ("margem atual < 35%" e "margem premium
        // > 120% da atual") não sobrevivem à saída do custo: `get_skus_margem_positiva()`
        // responde "este SKU é vendável?", não compara a rentabilidade de DOIS SKUs. Isso
        // segue valendo — o conserto abaixo NÃO reintroduz custo no browser.
        //
        // O que o motor tinha de errado é a ORDEM, e ela era invisível: `affinityScore = pij`
        // não contém nenhum termo do produto, então todos os candidatos do cliente empatavam,
        // o `sort` (estável) preservava a inserção e o `slice` entregava os 2 primeiros da
        // varredura do `productList` — a ordem de uuid do `.order('id')`. Em prod isso são 2
        // escolhidos entre uma MEDIANA de 2.068 elegíveis, e as 422 ofertas vivas cabem em 15
        // SKUs. Agora quem decide são dois atributos observados, na ordem lexicográfica de
        // `compararCandidatosUpSell`: menor RAZÃO de preço, e popularidade como desempate.
        // O porquê de cada peça (e por que `affinityScore` NÃO carrega a ordem) está em
        // `@/lib/farmer/upsell-ordem`.
        //
        // DEDUPLICADO por produto: o laço externo percorre os itens JÁ COMPRADOS, então o
        // mesmo candidato aparece uma vez por item que ele supera. Sem dedup, um único SKU
        // podia ocupar as DUAS vagas com `currentProductId` diferentes — a tela repetiria o
        // produto (e usa `productId` como key React), e o WhatsApp deduplicaria depois SEM
        // repor a vaga perdida, virando 2 ofertas em 1. Não é hipótese: em prod há 37 pares
        // `(cliente, SKU)` duplicados nas ofertas vivas de hoje (achado do challenge Codex).
        // Fica o MELHOR salto de cada candidato.
        const upSellPorProduto = new Map<string, { rec: Recommendation; chave: ChaveUpSell }>();
        for (const [purchasedId, purchaseData] of customerPurchased.entries()) {
          if (purchaseData.price <= 0) continue;

          // Hoisted: era um `productList.find` DENTRO do laço de candidatos, e agora também
          // decide a elegibilidade, não só o nome exibido.
          const currentProduct = indiceProdutos.get(purchasedId);
          const linhaAtual: LinhaDeProduto = {
            familia: campoDeLinha(currentProduct?.familia),
            unidade: campoDeLinha(currentProduct?.unidade),
          };

          for (const product of productList) {
            if (product.id === purchasedId) continue;
            if (purchasedIds.has(product.id)) continue;
            if (!vendaveis.has(product.id)) continue;

            // O gate de LINHA. Sem ele "premium" é qualquer SKU mais caro do catálogo inteiro,
            // e nenhuma ordenação transforma isso em up-sell. `unidade` entra junto porque 19
            // das 81 famílias misturam unidades (1.080 SKUs, 34% do catálogo): comparar preço
            // entre unidades diferentes é comparar preço-por-litro com preço-por-caixa.
            if (!mesmaLinha(linhaAtual, { familia: campoDeLinha(product.familia), unidade: campoDeLinha(product.unidade) })) continue;

            const premiumPrice = Number(product.valor_unitario || 0);
            if (premiumPrice <= purchaseData.price * PISO_RAZAO_UP_SELL) continue;

            // P_ij for up-sell. Segue sendo a propensão do CLIENTE — constante entre
            // candidatos, agora por desenho DECLARADO e não por defeito escondido. A tela
            // mostra este número como "% de conversão", então ele não pode ser dobrado por
            // fator de ranking nenhum: isso seria fabricar evidência.
            const pij = TAXA_CONVERSAO_UP_SELL * (healthScore / 100) * engagementFactor * 0.8; // 0.8 = up-sell is harder

            const complexityFactor = FATOR_COMPLEXIDADE;
            const affinityScore = pij;
            if (affinityScore <= 0) continue;

            const chave: ChaveUpSell = {
              razaoPreco: premiumPrice / purchaseData.price,
              popularidade: allProductPurchases.get(product.id) || 0,
            };

            const anterior = upSellPorProduto.get(product.id);
            if (anterior && compararCandidatosUpSell(anterior.chave, chave) <= 0) continue;

            // Contado uma vez por candidato DISTINTO — `candidatos_conta_do_cliente` compara
            // sua fração com a das EMITIDAS, e emitida é sempre um SKU único: contar o mesmo
            // produto uma vez por item comprado inflaria só o denominador e enviesaria o par.
            if (!anterior) {
              candidatosElegiveis++;
              if (ofertaNaContaDoCliente(product.id, contasDeCompraPorCliente.get(cid), indiceCatalogo.contaDoProduto)) {
                candidatosNaContaDoCliente++;
              }
            }

            upSellPorProduto.set(product.id, {
              chave,
              rec: {
                customerId: cid,
                customerName: profile.name ?? '',
                type: 'up_sell',
                productId: product.id,
                productName: product.descricao,
                currentProductId: purchasedId,
                currentProductName: currentProduct?.descricao || 'Produto atual',
                pij: Math.round(pij * 1000) / 10,
                affinityScore: Math.round(affinityScore * 10000) / 10000,
                complexityFactor,
                clusterVolume: purchaseData.qty,
                estoque: product.estoque ?? null,
                status: 'pendente',
              },
            });
          }
        }

        const upSellOrdenado = [...upSellPorProduto.values()].sort((a, b) =>
          compararCandidatosUpSell(a.chave, b.chave),
        );
        upSellRecs.push(...upSellOrdenado.map((c) => c.rec));

        // Cross-sell ordena por AFINIDADE (desc) — lá o `pij` carrega `relevance`, que é
        // termo do PRODUTO, então o score realmente discrimina candidatos.
        crossSellRecs.sort((a, b) => b.affinityScore - a.affinityScore);

        // Up-sell NÃO reordena aqui, e a ausência é o conserto: `upSellRecs` já chega
        // ordenado por `compararCandidatosUpSell`. Um `sort` por afinidade seria um no-op
        // (as chaves são todas iguais — é o bug) que ainda por cima DECLARARIA que a
        // afinidade decide. Foi essa declaração falsa que escondeu o defeito até aqui.
        const topCross = crossSellRecs.slice(0, 3);
        const topUp = upSellRecs.slice(0, VAGAS_UP_SELL);

        // SENSOR da ordem do up-sell — o entregável mínimo quando o sinal não decide.
        // Uma posição só conta como decidida se nenhum candidato DESCARTADO tem a chave
        // idêntica; empate que não cruza o corte não custou vaga a ninguém e não entra.
        // Em prod: 8,3% dos 1.033 clientes que descartam algum candidato empatam na vaga 2.
        // Sem isto o empate voltaria a ser invisível — que é o defeito original com outra
        // roupa, e a razão de o head existir.
        upSellPosicoesEmitidas += topUp.length;
        upSellPosicoesDecididas += posicoesDecididasPorSinal(
          upSellOrdenado.map((c) => c.chave),
          VAGAS_UP_SELL,
        );

        if (topCross.length > 0 || topUp.length > 0) {
          allRecs.push({
            customerId: cid,
            customerName: profile.name ?? '',
            healthScore,
            crossSell: topCross,
            upSell: topUp,
          });
        }
      }

      // Ordena clientes pela MELHOR afinidade da carteira, não pela soma.
      // Somar scores de cross-sell e up-sell tratava-os como valores comensuráveis — eles não
      // são (o `pij` do up-sell já carrega o fator 0,8 e sai de outra base histórica). A soma
      // também premiava quem tem MAIS itens na lista, não quem tem a melhor oferta.
      const melhorAfinidade = (c: CustomerRecommendations) =>
        Math.max(0, ...[...c.crossSell, ...c.upSell].map((r) => r.affinityScore));
      allRecs.sort((a, b) => melhorAfinidade(b) - melhorAfinidade(a));

      // SENSOR da conta da OFERTA — o par do `itens_identidade_conforme`, que governa o item
      // do HISTÓRICO. `n` são as ofertas emitidas cuja conta o cliente já compra; `esperado`
      // são todas as emitidas. Medido em prod (psql-ro, 20/08/2026): 946 de 1.361 = 69,5%.
      //
      // SEM piso e FORA de `INSUMOS_OBRIGATORIOS_CROSS_SELL`: ofertar cross-empresa é legítimo
      // (47,4% dos clientes compram pelas duas), então degradar a completude por causa dele
      // transformaria um fato comercial em defeito. O que ele existe para expor é a DERIVA —
      // hoje 934 dos 939 cross-sell vivos são `oben`, e os 106 clientes 100% `colacor` recebem
      // ZERO oferta `colacor` tendo 495 candidatos elegíveis. Ver `cobertura-conta-oferta.ts`.
      //
      // Contado sobre `allRecs` (o top-3 + top-2 que CHEGA ao farmer), não sobre os candidatos
      // considerados: o candidato descartado no ranking nunca virou oferta, e somá-lo mediria
      // o que o motor pensou em vez do que ele entregou.
      insumos.oferta_conta_do_cliente = {
        ok: true,
        ...medirCoberturaContaDaOferta(
          allRecs.flatMap((cr) => [...cr.crossSell, ...cr.upSell].map((r) => ({ customerId: r.customerId, productId: r.productId }))),
          contasDeCompraPorCliente,
          indiceCatalogo.contaDoProduto,
        ),
      };

      // O DENOMINADOR do sensor acima, e a resposta ao "69,5% confunde composição da carteira
      // com preferência do ranking" (challenge Codex). Sozinho, `oferta_conta_do_cliente` não
      // distingue "a carteira só tem candidato de fora" de "havia candidato da conta e o
      // ranking preferiu o de fora" — e as duas leituras pedem ações opostas. Este insumo mede
      // a MESMA regra sobre os candidatos que passaram todos os gates, antes do top-3/top-2:
      // comparar as duas frações é o que torna o desvio do ranking visível.
      //
      // Em prod (psql-ro, 20/08/2026) a diferença é gritante e é o achado desta entrega: os
      // 106 clientes que só compram `colacor` têm, em média, 495 candidatos `colacor`
      // elegíveis contra 332 `oben` — e as 342 ofertas de cross-sell que recebem são 100%
      // `oben`. A disponibilidade favorece `colacor`; o que entrega só `oben` é a ordenação.
      // (Candidatos remedidos sobre o universo do #1819 — a allowlist antiga dava 349/299.)
      insumos.candidatos_conta_do_cliente = {
        ok: true,
        n: candidatosNaContaDoCliente,
        esperado: candidatosElegiveis,
      };

      // A ordem do up-sell é decidida por SINAL? `n` são as posições emitidas em que nenhum
      // candidato descartado tinha chave idêntica; `esperado` são todas as emitidas.
      //
      // SEM piso e FORA de `INSUMOS_OBRIGATORIOS_CROSS_SELL`: empate é fato do catálogo (dois
      // SKUs da mesma linha, mesmo preço, mesma popularidade existem), não defeito de leitura
      // — degradar a completude por causa dele transformaria um fato em falha.
      //
      // Ele existe porque até esta entrega o top-2 do up-sell era 100% arbitrário e NADA na
      // tela ou no head dizia isso. Trocar um sorteio invisível por um ranking com 8,3% de
      // empate residual só é honesto se os 8,3% forem VISÍVEIS — senão a próxima sessão lê
      // "o motor ordena por mérito" e acredita, como esta leu.
      insumos.upsell_ordem_decidida = {
        ok: true,
        n: upSellPosicoesDecididas,
        esperado: upSellPosicoesEmitidas,
      };

      aplicarRecomendacoes(allRecs);
      linhasProduzidas = allRecs.length > 0;
      resultadoDestaExecucao = true;

      // Persist recommendations — via RPC que SUBSTITUI a geração anterior.
      //
      // Era `.upsert(recRows)` SEM `onConflict` e sem `id` no payload: como a única chave
      // é o uuid DEFAULT, nada nunca colidia e o "upsert" era um INSERT. Cada recálculo
      // EMPILHAVA, e como os leitores pegam `status='pendente'` ordenado por afinidade
      // desc com `.limit(1)`, uma recomendação ANTIGA de score maior seguia sendo o topo
      // para sempre — o operador via uma oferta que o motor já não escolheria. Medido em
      // prod (2026-08-14): 197 de 473 grupos (farmer,cliente) com ≥2 gerações vivas, e
      // 18 grupos cujo topo vinha de uma geração de até 70 DIAS antes.
      //
      // Vai por RPC porque expirar-e-inserir são DUAS operações: em duas chamadas
      // PostgREST são duas transações, e falhar entre elas deixaria o farmer com ZERO
      // oferta pendente. Mesmo motivo que levou `farmer_association_rules_substituir` a
      // existir. `m_ij`/`lie` saem do payload de vez — a RPC os fixa em NULL, então o
      // browser não tem mais como fabricar dinheiro de volta nessas colunas.
      // Provada em db/test-farmer-geracao-vigente.sh (31 asserts + 4 falsificações).
      const recRows = allRecs.flatMap((cr) =>
        [...cr.crossSell, ...cr.upSell].map((rec) => ({
          customer_user_id: rec.customerId,
          recommendation_type: rec.type,
          product_id: rec.productId,
          current_product_id: rec.currentProductId || null,
          p_ij: rec.pij,
          affinity_score: rec.affinityScore,
          complexity_factor: rec.complexityFactor,
          cluster_volume_estimate: rec.clusterVolume,
        })),
      );
      // Persistência PULADA na lente "Ver como" (somente leitura: o master inspeciona
      // as recomendações do alvo sem regravar a carteira dele).
      //
      // `length > 0` continua sendo o guard, e continua NÃO expirando: lote vazio pode ser
      // dado faltando a montante, e expirar a carteira por causa disso deixaria a vendedora
      // sem NENHUMA oferta. A RPC recusa o lote vazio de qualquer jeito (FG003).
      //
      // O que MUDOU: o vazio deixou de ser silencioso. Ele move o HEAD, declarando se o
      // snapshot estava íntegro. Chegar aqui com `recRows` vazio e todos os insumos
      // completos é o "ZERO DE VERDADE" — o cálculo concluiu que não deve haver
      // recomendação nenhuma — e é o único sinal que autoriza a fase 2 a ligar a
      // expiração. Até esta entrega esse estado não tinha COMO ser registrado, e é por
      // isso que a frequência dele era desconhecida.
      const { completude, motivo } = avaliarCompletude(insumos, INSUMOS_OBRIGATORIOS_CROSS_SELL);
      if (!isImpersonating && recRows.length === 0) {
        await registrarVazio();
      }
      if (!isImpersonating && recRows.length > 0) {
        // O `error` é CAPTURADO. O supabase-js NÃO lança em erro de banco — resolve normal
        // com `error` preenchido — então o `await` solto devolveria sucesso SEM ter gravado.
        // Sem `throw`: o cálculo em memória é válido e já foi exibido — quem falhou foi só a
        // persistência, e derrubar a tela seria pior. Espelha o useBundleEngine (#1594).
        const { error: erroPersistencia } = await supabase.rpc(
          'farmer_recomendacoes_substituir' as never,
          {
            p_farmer_id: effectiveUserId,
            p_run_id: runId,
            p_geracao_vista: geracaoVista,
            p_linhas: recRows,
            // O head é movido pela própria RPC, na MESMA transação: head e linhas em
            // transações separadas divergiriam, e head divergente é medição corrompida.
            p_completude: completude,
            p_motivo: motivo,
            p_insumos: insumos,
            // O head que ESTA execução viu, lido antes do cálculo. Sem ele a RPC compararia
            // o head consigo mesmo e um run vazio mais NOVO seria sobrescrito por este, que
            // leu snapshot mais velho (achado do challenge Codex xhigh).
            p_head_visto: headVisto ?? null,
          } as never,
        );
        if (erroPersistencia) {
          console.error('Falha ao substituir farmer_recommendations:', erroPersistencia);
          // FG006 = outro recálculo gravou no meio do meu. Não é falha: é a recusa
          // funcionando, e o dado na tabela é MAIS novo que o meu. Dizer "não foi
          // gravado, as telas seguem com as anteriores" mentiria na direção oposta —
          // as telas seguem com algo mais RECENTE do que isto aqui.
          const codigo = (erroPersistencia as { code?: string } | null)?.code;
          if (codigo === 'FG006') {
            toast.warning(
              'Outro recálculo mais recente já gravou enquanto este rodava — o dele valeu, e as telas de oferta estão com o resultado mais novo.',
            );
          } else if (codigo === 'FG005') {
            // Advisory lock: há OUTRO recálculo deste farmer em voo agora. Distinto do
            // FG006 (que já terminou e venceu) — aqui o desfecho ainda não existe.
            toast.warning(
              'Já há um recálculo deste vendedor em andamento — este não foi gravado. Espere ele terminar e veja o resultado.',
            );
          } else {
            toast.error(
              `${recRows.length} recomendação(ões) NÃO foram gravadas — as telas de oferta seguem com as anteriores. ${mensagemDeErro(erroPersistencia) ?? ''}`.trim(),
            );
          }
        }
      }
    } catch (error) {
      console.error('Error calculating recommendations:', error);
      // O head também se move aqui: falha paginada em scores, catálogo, perfis ou pedidos
      // LANÇA e caía neste `catch` sem mover nada — deixando vigente um head `completo`
      // gravado quando a base estava sã, que é o único rótulo capaz de autorizar expiração.
      // Se a gravação de linhas já moveu o head, o CAS recusa com FG106: desfecho certo.
      if (!linhasProduzidas) await registrarVazio();
      setErro(
        error instanceof Error
          ? error
          : new Error(mensagemDeErro(error) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.'),
      );
      // Só é "desatualizado" se a tela está exibindo o resultado de uma execução ANTERIOR.
      // Sem nada na mão o estado é indisponível — textos diferentes, e prometer um dado que
      // não existe seria trocar uma mentira por outra.
      setDesatualizado(!resultadoDestaExecucao && recomendacoesRef.current.length > 0);
    } finally {
      setCalculating(false);
      setLoading(false);
    }
  }, [effectiveUserId, isImpersonating, aplicarRecomendacoes]);

  // ─── Actions ─────────────────────────────────────────────────────────
  // `markAsOffered` / `markAsAccepted` / `markAsRejected` e o `updateConversionStats`
  // que gravava `farmer_category_conversion` foram removidos em 2026-07-21: nenhum
  // componente os importava (só `calculateRecommendations` era consumido), então o
  // desfecho de uma recomendação nunca chegou a ser registrado — daí as 3.659 linhas
  // 100% `pendente`. Construir o loop de feedback é decisão de produto e exige mais
  // que estes métodos (UI de desfecho, margem realizada, `onConflict` correto no
  // upsert). Desenho preservado em docs/historico/farmer-aprendizado-conversao.md.

  return {
    recommendations,
    loading,
    calculating,
    calculateRecommendations,
    /** Falha da ÚLTIMA execução (`null` = correu bem). O consumidor decide o que exibir. */
    erro,
    /** `true` = o que está em `recommendations` veio de uma execução ANTERIOR à que falhou. */
    desatualizado,
  };
};
