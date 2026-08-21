import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { toast } from 'sonner';
import { margemConhecida } from '@/lib/scoring/margin';
import { ehFalhaDePagina, fetchAllPages } from '@/lib/postgrest';
import { erroComCausa, mensagemDeErro } from '@/lib/erro-mensagem';
import { captureException } from '@/lib/analytics';
import {
  avaliarCompletude,
  INSUMOS_OBRIGATORIOS_BUNDLE,
  type InsumosSnapshot,
} from '@/lib/farmer/completude-snapshot';
import { lerHeadVigente, registrarGeracaoFarmer } from '@/lib/farmer/registrar-geracao';
import { indexarCatalogoAtivo, resolverItemNoCatalogo } from '@/lib/farmer/identidade-item';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { medirBundlesDeContaUnica } from '@/lib/farmer/cobertura-conta-oferta';

// ─── Types ───────────────────────────────────────────────────────────
export interface AssociationRule {
  antecedent: string[];
  consequent: string[];
  antecedentNames: string[];
  consequentNames: string[];
  support: number;
  confidence: number;
  lift: number;
  type: 'association' | 'sequential';
}

export interface BundleRecommendation {
  id?: string;
  customerId: string;
  customerName: string;
  /** Sem `cost`/`margin`: o custo não chega mais ao browser, e `price` é público (o cliente o vê). */
  products: { id: string; name: string; price: number }[];
  support: number;
  confidence: number;
  lift: number;
  pBundle: number;
  /**
   * Score de AFINIDADE do bundle — adimensional, NÃO é dinheiro. Ver `Recommendation.affinityScore`
   * em useCrossSellEngine para o racional completo (custo fora do browser → não existe mais
   * "lucro esperado"; `complexityFactor` fica fora do score porque a fórmula é invertida e a
   * tabela que o alimenta é escrivível por employee).
   *
   * ⚠️ Nunca formatar como R$. E NÃO comparar com `Recommendation.affinityScore` do motor
   * individual: `pBundle` multiplica por `lift/2` e não é limitado a 1, então as duas escalas
   * não são comensuráveis (apontado pelo Codex na rodada 3).
   */
  affinityBundle: number;
  complexityFactor: number;
  status: string;
}

// Não exportado: os consumidores falam em `ComparacaoIndividual` (a união), e só alcançam
// isto pelo ramo `encontrado`. Export sem consumidor externo reprova no knip — que roda no
// health stack, não no `bun run test` (mesma armadilha anotada em completude-snapshot.ts).
interface IndividualComparison {
  productId: string;
  productName: string;
  /**
   * Score de AFINIDADE (adimensional) da melhor recomendação individual — NÃO é dinheiro.
   * Era `lie: number` lendo `farmer_recommendations.lie`, que agora é sempre NULL: `Number(null)`
   * daria 0 e fabricaria "nenhuma afinidade" onde o certo é "não medida" (money-path §2).
   */
  affinity: number | null;
  type: 'cross_sell' | 'up_sell';
}

/**
 * O resultado da comparação com o melhor produto individual — TRÊS estados, não dois.
 *
 * `IndividualComparison | null` colapsava "li e não existe" com "não consegui ler", e o
 * conjunto UI+filtro transformava o colapso numa AFIRMAÇÃO: a tela renderizava
 * `bestIndividual?.productName ?? '—'` e, pior, o cliente sem bundle próprio era OMITIDO da
 * lista inteira (`if (topBundles.length > 0 || bestIndividual)`). O traço não fabricava
 * número, mas a dupla fabricava o rótulo "não há rota individual para este cliente" — é o
 * §2 do money-path (ausente ≠ zero) na forma de rótulo, o mesmo defeito que o #1800 tirou
 * do `error` descartado e que sobrevivia um passo adiante, no tipo.
 *
 * `indisponivel` existe porque a leitura é ACESSÓRIA e não derruba a carteira: ela não entra
 * em `p_linhas`, então falhar nela não pode custar os bundles já descobertos — mas também não
 * pode desaparecer.
 */
export type ComparacaoIndividual =
  | { status: 'encontrado'; value: IndividualComparison }
  | { status: 'nenhum' }
  | {
      status: 'indisponivel';
      /**
       * `leitura_falhou` — a RPC não respondeu; vale para a carteira inteira.
       * `produto_nao_resolve` — a RPC respondeu, mas o SKU eleito não está no catálogo ATIVO
       *   (ou veio sem `product_id`, que é nullable no schema). Antes isto caía em
       *   `productName: prod?.descricao || 'Produto'` e a tela afirmava ter encontrado o
       *   melhor individual exibindo um nome INVENTADO — a mesma fabricação de rótulo que esta
       *   união veio matar, um nível abaixo. Medido em prod (20/08/2026): 0 de 671 pendentes
       *   com score caem aqui hoje, mas `product_id` é nullable e o SKU pode ser desativado
       *   DEPOIS da geração. (Achado 3 do challenge Codex.)
       */
      motivo: 'leitura_falhou' | 'produto_nao_resolve';
    };

export interface CustomerBundles {
  customerId: string;
  customerName: string;
  healthScore: number;
  bundles: BundleRecommendation[];
  bestIndividual: ComparacaoIndividual;
  avgMonthlySpend: number;
  /** `null` = margem não apurada. NÃO trocar por 0: 0 classifica o cliente como "sensível a
   *  preço" via `classifyCustomerProfile`, um veredito que a ausência de dado não sustenta. */
  grossMarginPct: number | null;
  categoryCount: number;
  daysSinceLastPurchase: number;
  cnae: string;
  customerType: string;
  recentProducts: string[];
}

// ─── Row types ─────────────────────────────────────────────────────
interface ClientScoreRow {
  customer_user_id: string;
  health_score: number | string | null;
  answer_rate_60d: number | string | null;
  whatsapp_reply_rate_60d: number | string | null;
  avg_monthly_spend_180d: number | string | null;
  gross_margin_pct: number | string | null;
  category_count: number | string | null;
  days_since_last_purchase: number | string | null;
}

interface ProductRow {
  id: string;
  codigo: string | null;
  descricao: string;
  valor_unitario: number | string | null;
  metadata: unknown;
  ativo: boolean | null;
  omie_codigo_produto: number | string | null;
  /** Metade da chave de identidade do SKU (`UNIQUE (omie_codigo_produto, account)`). */
  account: string | null;
}

interface ProfileRow {
  user_id: string;
  name: string | null;
  customer_type: string | null;
  cnae: string | null;
}

interface SalesOrderItem {
  product_id?: string;
  omie_codigo_produto?: number | string;
}

interface SalesOrderRow {
  customer_user_id: string;
  items: SalesOrderItem[] | unknown;
  total: number | string | null;
  created_at: string;
  /** A conta do PEDIDO — o lado do par que qualifica a resolução de cada item. */
  account: string | null;
}

/** Uma linha da RPC `farmer_melhor_individual_por_cliente` — já é O melhor do cliente. */
interface MelhorIndividualRow {
  customer_user_id: string;
  /**
   * NULLABLE no schema (`information_schema`, conferido 21/08/2026) — e o tipo dizia `string`.
   * Era uma mentira BARATA de manter enquanto ninguém media: `productMap.get(null)` só dá miss
   * e cai no mesmo ramo do SKU inativo. Com o sensor de resolução abaixo os dois passam a
   * CONTAR, e um tipo que esconde uma das portas faz o número nascer torto. (Achado do
   * challenge Codex gpt-5.6-sol/xhigh, 21/08.)
   */
  product_id: string | null;
  affinity_score: number | string | null;
  recommendation_type: 'cross_sell' | 'up_sell';
  /** Geração a que a linha pertence. Todas deveriam trazer a MESMA — ver o aviso no toast. */
  run_id: string | null;
}

// ─── Premissa do LIE do bundle (NÃO é aprendida) ─────────────────────
// Constante ARBITRADA, não medição. Até 2026-07-21 o hook lia
// `farmer_category_conversion` para derivar um fator por produto e caía neste
// mesmo 1.0 quando não achava a linha — sugerindo um "aprendizado histórico" que
// nunca existiu: a tabela tem 0 linhas desde fev/2026 (`n_tup_ins = 0`), porque o
// único writer ficava atrás de `markBundleAccepted`, que nenhuma UI chamou.
// Como é idêntica para todo bundle, é fator de ESCALA: não altera o RANKING, só o
// valor absoluto em R$ — rotulado na tela como estimativa não calibrada.
// Ver docs/historico/farmer-aprendizado-conversao.md.
const FATOR_COMPLEXIDADE = 1.0;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ─── Configuration ──────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  minSupport: 0.01,      // 1% — was 5%, too restrictive with many products
  minLift: 1.05,         // was 1.2, lowered to capture more meaningful rules
  sequentialWindowDays: 90,
  bundleSizeMin: 2,
  bundleSizeMax: 3,
};

// ─── Main Hook ───────────────────────────────────────────────────────
export const useBundleEngine = () => {
  // Lente "Ver como": id efetivo = ALVO na lente (lê/recalcula os bundles DELE pra
  // inspeção), próprio usuário fora. Na lente a persistência (regras + recomendações)
  // é PULADA (igual useCrossSellEngine/useFarmerScoring): o master inspeciona, não
  // regrava a carteira do alvo. Fora da lente effectiveUserId === user.id (byte-
  // equivalente, zero regressão).
  const { effectiveUserId, isImpersonating } = useImpersonation();
  const [customerBundles, setCustomerBundles] = useState<CustomerBundles[]>([]);
  const [rules, setRules] = useState<AssociationRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);
  // Espelha `useCrossSellEngine`: a falha precisa CHEGAR à tela. Sem estado de erro a
  // `FarmerBundles` só sabia dizer "Clique em Calcular" — o mesmo texto de quem nunca calculou.
  const [erro, setErro] = useState<Error | null>(null);
  const [desatualizado, setDesatualizado] = useState(false);
  /**
   * "A execução mais recente chegou a PUBLICAR um resultado (mesmo vazio) na tela?"
   *
   * Dois estados dependiam disso e não tinham como perguntar (challenge Codex do #1791):
   *  - a lista vazia de um cálculo CONCLUÍDO ficava idêntica à de quem nunca clicou em
   *    Calcular — "não há oportunidade nesta carteira" apresentado como "não comecei";
   *  - sob `erro`, a tela culpava a LEITURA mesmo quando a leitura foi perfeita e o que
   *    falhou foi a GRAVAÇÃO (a RPC roda DEPOIS de `aplicarBundles`), desacreditando
   *    bundles válidos e desta execução.
   *
   * Descreve a ÚLTIMA execução, não a sessão: um recálculo que morre na leitura volta o
   * flag a `false`, senão o veredicto velho responderia por um cálculo que não existiu.
   *
   * ⚠️ Marcado nos pontos de CONCLUSÃO, nunca dentro de `aplicarBundles`. O fail-closed de
   * `vendaveis` também chama `aplicarBundles([])` — para limpar a lista antes de lançar — e
   * ali NADA foi calculado: marcar junto da publicação faria esse caminho anunciar "o cálculo
   * terminou, só não salvou", que é exatamente a mentira que este flag existe para desfazer.
   */
  const [calculado, setCalculado] = useState(false);

  // A ref existe para o `catch` saber se sobrou resultado de uma execução ANTERIOR na tela:
  // ler `customerBundles` de dentro do `useCallback` pegaria a closure velha.
  const bundlesRef = useRef<CustomerBundles[]>([]);
  const aplicarBundles = useCallback((bs: CustomerBundles[]) => {
    bundlesRef.current = bs;
    setCustomerBundles(bs);
  }, []);

  const calculateBundles = useCallback(async (config = DEFAULT_CONFIG) => {
    if (!effectiveUserId) return;
    setCalculating(true);
    setLoading(true);
    setErro(null);
    setDesatualizado(false);
    setCalculado(false);
    // "Esta execução produziu o que está na tela?" — separa INDISPONÍVEL de DESATUALIZADO.
    let resultadoDestaExecucao = false;
    // "Este cálculo chegou a PRODUZIR linhas?" — trava o registro de `vazio` no `catch`.
    // Sem isto, uma falha na RPC de substituição (que roda DEPOIS de o resultado já estar na
    // tela) grava `resultado='vazio'`; e como a gravação não commitou, o head no banco não
    // mudou e o compare-and-swap ACEITA. Com os insumos todos lidos, sai `vazio` + `completo`:
    // o sinal exato que autorizaria a fase 2 a expirar a carteira por causa de uma falha de
    // PERSISTÊNCIA. O CAS só protege quando a gravação commitou — e aí a recusa vem como
    // FG107 (linhas do mesmo run_id), antes mesmo do FG106.
    let linhasProduzidas = false;

    // Snapshot dos insumos DESTA execução (ver useCrossSellEngine para o racional): o head
    // precisa declarar se o zero veio de um snapshot íntegro, e isso não se infere do
    // resultado — só o produtor sabe.
    const insumos: InsumosSnapshot = {};
    // `undefined` = não consegui ler o head → registro PULADO, nunca às cegas.
    let headVisto: string | null | undefined;
    const runId = crypto.randomUUID();

    // O head é gravado UMA vez por execução: o `catch` também registra agora, e sem isto uma
    // falha depois de um `registrarVazio()` já feito gravaria a mesma execução duas vezes.
    let jaRegistrou = false;
    // O alerta de head ilegível sai UMA vez por execução — `registrarVazio` tem vários
    // call-sites e o mesmo cálculo emitiria o mesmo alarme repetido.
    let alertouHeadIlegivel = false;
    const registrarVazio = async () => {
      if (isImpersonating) return;
      if (headVisto === undefined) {
        // Pular às cegas é correto (sobrescrever um head existente seria pior), mas pular em
        // SILÊNCIO é o defeito: "nenhum registro novo" passa a significar duas coisas opostas.
        if (alertouHeadIlegivel) return;
        alertouHeadIlegivel = true;
        captureException(new Error('[farmer/head] head ilegível — registro de bundle pulado'), {
          origem: 'farmer/head',
          motor: 'bundle',
          runId,
        });
        return;
      }
      if (jaRegistrou) return;
      const { completude, motivo } = avaliarCompletude(insumos, INSUMOS_OBRIGATORIOS_BUNDLE);
      const desfecho = await registrarGeracaoFarmer({
        motor: 'bundle',
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
      // 0. Identidade desta EXECUÇÃO + a geração de bundles que ela substitui.
      // Lido ANTES do snapshot (money-path §10: reivindicar depois deixa a corrida
      // aberta pela porta de trás). Espelha useCrossSellEngine — ver o racional lá.
      let geracaoVista: string | null = null;
      if (!isImpersonating) {
        headVisto = await lerHeadVigente('bundle', effectiveUserId);
        // Mesma ordem que a RPC usa para eleger a geração vigente (created_at desc, id desc).
        const { data: vigente, error: erroVigente } = await supabase
          .from('farmer_bundle_recommendations')
          .select('run_id')
          .eq('farmer_id', effectiveUserId)
          .eq('status', 'pendente')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(1);
        if (erroVigente) {
          throw new Error(
            mensagemDeErro(erroVigente) ??
              'Não consegui ler a geração vigente de bundles — nada foi recalculado.',
          );
        }
        geracaoVista = vigente?.[0]?.run_id ?? null;
      }

      // 1. Load data with fallback for super_admin
      // Loop MANUAL com o mesmo defeito que o #1545 tirou do `fetchAllPages` — por não CHAMAR
      // o helper, ficou de fora daquele grep: descartava o `error`, tratava `data: null` como
      // fim da tabela e não pedia `.order()` (ordem indefinida entre páginas pula e repete
      // linha). `customer_user_id` é UNIQUE na tabela.
      //
      // E a página perdida trocava o ESCOPO: o caller abaixo lê lista vazia como "não tem
      // carteira, deve ser super_admin" e recarrega SEM filtro de farmer_id.
      const fetchAllScores = (filterFarmerId?: string): Promise<ClientScoreRow[]> =>
        fetchAllPages<ClientScoreRow>(
          (de, ate) => {
            let q = supabase.from('farmer_client_scores').select('*');
            if (filterFarmerId) q = q.eq('farmer_id', filterFarmerId);
            return q.order('customer_user_id', { ascending: true }).range(de, ate) as unknown as
              PromiseLike<{ data: ClientScoreRow[] | null; error: unknown }>;
          },
          'farmer_client_scores/bundle',
        );

      // ESCOPO ESTRITO: a carteira DESTE farmer, sempre. Aqui havia um fallback
      // ("try farmer-specific first, fallback to all — super_admin") que, ao ver a primeira
      // leitura vazia, recarregava a base INTEIRA e a gravava com `p_farmer_id:
      // effectiveUserId`. A condição nunca perguntou se o usuário é super_admin: perguntou
      // se a leitura veio vazia. Racional completo e os números de prod em
      // `useCrossSellEngine` — o defeito era literalmente o mesmo nos dois motores, e a
      // gêmea deste bundle deixou 12 linhas de março sob um farmer que não era o dono de
      // nenhum dos 4 clientes. Carteira vazia → lista vazia (tratada logo abaixo).
      const clientScores = await fetchAllScores(effectiveUserId);

      // As duas paginadas estouram a capa de 1.000 do PostgREST (3.108 SKUs ativos, 5.668
      // perfis) e vinham truncadas em silêncio: o profileMap deixava a maioria dos clientes sem
      // perfil — e sem perfil o cliente é pulado (`if (!profile) continue`), ou seja, nunca
      // recebia bundle. A terceira leitura era `product_costs`, que saiu: o custo não chega mais
      // ao browser (a RPC abaixo responde só "este SKU é vendável?").
      const [products, profiles, vendaveisResult] = await Promise.all([
        fetchAllPages<ProductRow>((de, ate) =>
          supabase
            .from('omie_products')
            .select('id, codigo, descricao, valor_unitario, metadata, ativo, omie_codigo_produto, account')
            .eq('ativo', true)
            .order('id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: ProductRow[] | null; error: unknown }>,
          'omie_products/bundle',
        ),
        fetchAllPages<ProfileRow>((de, ate) =>
          supabase
            .from('profiles')
            .select('user_id, name, customer_type, cnae')
            .order('user_id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: ProfileRow[] | null; error: unknown }>,
          'profiles/bundle',
        ),
        // Quais SKUs são VENDÁVEIS (margem canônica > 0) — o browser não vê mais custo.
        //
        // PAGINADA como as duas leituras acima: a RPC devolve 2.462 linhas em prod e vinha
        // capada nas 1.000 do PostgREST, então todo SKU vendável da cauda era tratado como
        // NÃO-vendável pelo gate lá embaixo. Isso não encolhia a oferta, CONGELAVA a tabela:
        // sem um PAR de consequentes vendáveis o lote sai vazio, e lote vazio pula a RPC de
        // gravação de propósito — nenhuma escrita, nenhum erro, nenhum toast. Era o único
        // insumo do engine fora do `fetchAllPages` (#1520 criou a RPC; a correção do
        // truncamento silencioso de `omie_products`/`profiles` não a alcançou).
        //
        // A rejeição vira `{ data: null, error }` para PRESERVAR o fail-closed explícito
        // abaixo (`insumos.vendaveis.ok = false` + `registrarVazio()`): deixar `fetchAllPages`
        // lançar aqui trocaria esse desfecho registrado por um throw genérico, e o head
        // degradado passaria a poder autorizar expiração.
        fetchAllPages<{ product_id: string }>(
          (de, ate) =>
            supabase
              .rpc('get_skus_margem_positiva')
              // `.order` ESTÁVEL antes do `.range`: a função não tem `ORDER BY` (é um
              // `RETURN QUERY SELECT p.id FROM omie_products JOIN product_costs`), e paginar
              // sem ordem total deixa o plano decidir a ordem de cada página — o que PULA e
              // repete linhas entre elas. Repetir é inócuo (o destino é um Set); pular
              // reintroduziria em menor escala o próprio bug que este trecho corrige, e de
              // forma intermitente. `product_id` é a PK do catálogo: ordem total.
              .order('product_id', { ascending: true })
              .range(de, ate) as unknown as PromiseLike<{ data: { product_id: string }[] | null; error: unknown }>,
          'get_skus_margem_positiva/bundle',
        ).then(
          (data) => ({ ok: true as const, data }),
          // NÃO relança aqui, e a distinção NÃO é sobre agir ou não agir: o fail-closed vale
          // para QUALQUER falha na leitura de vendáveis — inclusive bug de código. O que
          // `esperada` discrimina é só o DIAGNÓSTICO: qual erro chega à tela e ao plantão.
          //
          // O handler anterior (`error => ({ data: null, error })`) engolia QUALQUER rejeição e
          // a rotulava com a mensagem de negócio. Não é hipotético: no #1782 mocks devolvendo
          // Promise crua produziram `supabase.rpc(...).order is not a function`, e este `.then`
          // converteu o TypeError em "vendáveis indisponíveis" — um defeito de CÓDIGO chegando
          // disfarçado de INDISPONIBILIDADE DE DADO, que manda o plantão para o lado errado.
          (error: unknown) => ({ ok: false as const, error, falha: ehFalhaDePagina(error) ? error : null }),
        ),
      ]);

      // `fetchAllPages` LANÇA em falha de página, então chegar aqui já significa leitura
      // íntegra — `ok: true`. O que ainda pode ser zero é o CONTEÚDO.
      insumos.catalogo = { ok: true, n: (products || []).length };
      insumos.scores = { ok: true, n: clientScores.length };

      // FAIL-CLOSED: falha na RPC → NENHUM bundle. Degradar para "monta bundle com tudo" poria
      // produto de PREJUÍZO na oferta combinada, que é o pior desfecho possível aqui.
      if (!vendaveisResult.ok) {
        console.error('get_skus_margem_positiva falhou — sem bundles (fail-closed):', vendaveisResult.error);
        // `ok: false` = "não consegui ler", não "veio vazio". Um head degradado por aqui
        // nunca poderá autorizar expiração.
        insumos.vendaveis = { ok: false, n: 0 };
        await registrarVazio();
        // Fail-closed E DECLARADO — alinhado ao `useCrossSellEngine` (#1606). O `return` mudo
        // daqui não passava pelo `catch`, não emitia toast e não deixava nada na tela: para o
        // operador era idêntico a um cálculo que concluiu "esta carteira não tem bundle", e ele
        // ia embora achando que era a primeira coisa.
        //
        // Limpa ANTES de lançar: manter bundles anteriores contrariaria o fail-closed (podem
        // conter SKU que o servidor já não confirma como rentável). Com a lista zerada e
        // `resultadoDestaExecucao` marcado, a tela conclui INDISPONÍVEL, não DESATUALIZADO.
        //
        // ⚠️ Este bloco roda para TODA falha da leitura de vendáveis, inclusive bug de código.
        // Deixar o TypeError subir cru DAQUI (sem limpar a lista) foi o desenho que o Codex
        // gpt-5.6-sol reprovou como [P1]: a tela concluiria DESATUALIZADO e seguiria exibindo
        // bundles da execução anterior — que podem conter SKU cuja margem já não é positiva.
        // "Desatualizado" não é sinônimo de "seguro de usar", e o gate de RENTABILIDADE não
        // pode ser o insumo que degrada mais fraco só porque a falha foi de outra natureza.
        aplicarBundles([]);
        resultadoDestaExecucao = true;
        // O que a natureza da falha decide é SÓ o erro que sobe:
        //  • não-esperada (bug: builder quebrado, TypeError) → relança o objeto ORIGINAL, com a
        //    stack e a mensagem verdadeiras. Traduzi-lo para a frase de negócio apagaria o
        //    único rastro que aponta para a linha defeituosa;
        //  • esperada (página com `error`, `data: null` malformado) → mensagem do SERVIDOR, com
        //    o erro assinado preso em `cause` para o plantão.
        if (!vendaveisResult.falha) throw vendaveisResult.error;
        // A mensagem sai da CAUSA, não do erro assinado: a dele é `fetchAllPages: página 0
        // (0-999) falhou` — jargão de helper, que diz ao vendedor menos do que o servidor já
        // tinha dito. É o defeito que `mensagemDeErro` existe para evitar ("a mensagem
        // acionável existe, o servidor a mandou, e ela morre na fronteira"), reaparecendo uma
        // camada acima. Em `data_null_sem_error` não há causa e o fallback de domínio é o certo.
        throw erroComCausa(
          mensagemDeErro(vendaveisResult.falha.cause) ??
            'Não consegui confirmar quais SKUs são rentáveis — nenhum bundle foi gerado.',
          vendaveisResult.error,
        );
      }
      const vendaveis = new Set(vendaveisResult.data.map((r) => r.product_id));
      insumos.vendaveis = { ok: true, n: vendaveis.size };

      if (!clientScores?.length) {
        aplicarBundles([]);
        // CONCLUIU: "esta carteira não tem cliente com score" é um veredicto do motor, não uma
        // falha — e a tela precisa dizer isso em vez de "clique em Calcular".
        setCalculado(true);
        // Era um `return` MUDO — a razão de a frequência do zero nunca ter sido mensurável.
        await registrarVazio();
        return;
      }

      // Load ALL sales orders (avoid huge .in() URL)
      // Mesmo defeito do loop manual acima — aqui a perda é do HISTÓRICO que alimenta as regras
      // de associação do bundle. `.order('id')` (PK) é a ordem estável; a coluna não precisa
      // estar no `select`.
      const salesOrders = await fetchAllPages<SalesOrderRow>(
        (de, ate) =>
          supabase
            .from('sales_orders')
            .select('customer_user_id, items, total, created_at, account')
            // DENYLIST + `deleted_at IS NULL`: o MESMO universo de
            // `private.margem_cliente_agregada()` e do `useFarmerScoring` (#1738). A allowlist que
            // estava aqui citava DOIS status que nunca existiram nesta tabela (`confirmado`,
            // `entregue`) e resolvia para só `faturado`: 10.281 pedidos reais — `importado` 5.455,
            // `separacao` 2.817, `enviado` 2.009 — ficavam fora das cestas que alimentam o Apriori. Ver
            // `@/lib/farmer/universo-pedidos` (inclusive o efeito no denominador do support).
            .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
            .is('deleted_at', null)
            .order('id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: SalesOrderRow[] | null; error: unknown }>,
        'sales_orders/bundle',
      );

      // Build maps
      const productMap = new Map<string, ProductRow>();
      (products || []).forEach((p) => productMap.set(p.id, p));
      // Índice ACCOUNT-AWARE do catálogo ativo. O `Map<number, string>` global que estava aqui
      // assumia que `omie_codigo_produto` é único — mas o banco declara
      // `UNIQUE (omie_codigo_produto, account)`, e onde o schema permite duas linhas o Map
      // guarda uma: a última que a paginação escreveu. Ver `src/lib/farmer/identidade-item.ts`.
      const indiceCatalogo = indexarCatalogoAtivo(products || []);
      const profileMap = new Map<string, ProfileRow>();
      (profiles || []).forEach((p) => profileMap.set(p.user_id, p));

      // Dois insumos distintos: `pedidos` é global (a base tem histórico?) e
      // `carteira_ativa` é o universo REAL deste cálculo (a carteira DESTE farmer tem?).
      const clientesComPedido = new Set((salesOrders || []).map((o) => o.customer_user_id));
      insumos.pedidos = { ok: true, n: clientesComPedido.size };
      const ativos = clientScores.filter((c) => clientesComPedido.has(c.customer_user_id));
      insumos.carteira_ativa = { ok: true, n: ativos.length };
      // COBERTURA de perfil: o motor faz `if (!profile) continue` mais abaixo — cliente sem
      // perfil é pulado em silêncio (ver useCrossSellEngine para o racional completo).
      insumos.clientes_com_profile = {
        ok: true,
        n: ativos.filter((c) => profileMap.has(c.customer_user_id)).length,
        // `n > 0` aceitava 1 perfil para 101 clientes ativos: o motor pularia 100 deles em
        // silêncio e o zero final sairia rotulado `completo`. O universo certo é a carteira
        // ATIVA, não a base global.
        esperado: ativos.length,
        // `esperado` entra como EVIDÊNCIA, SEM piso — e isso é decisão medida, não omissão.
        // Distribuição real (psql-ro, 19/08/2026, 3 farmers com carteira ativa): 2 em 100%
        // de cobertura e 1 em 85,96%; NENHUM abaixo de 50%. Qualquer piso plausível ou é
        // inerte (não separa nada do regime atual) ou degrada o farmer de 86% já no primeiro
        // recálculo. Fixar um número aqui seria inventar o limiar — o mesmo erro que este
        // arquivo evita em `baskets`, e o que "rótulo com DEFAULT constante não é fato"
        // (money-path §5) proíbe. O `n`/`esperado` ficam no head justamente para calibrar o
        // piso quando houver farmers suficientes para que ele signifique algo.
      };

      // 2. Build transaction baskets per customer
      let itensResolvidos = 0;
      let itensContaDivergente = 0;
      const baskets: string[][] = [];
      const customerBaskets = new Map<string, Set<string>>();
      const sequentialPurchases = new Map<string, { productId: string; date: Date }[]>();

      for (const order of salesOrders || []) {
        const items: SalesOrderItem[] = Array.isArray(order.items) ? (order.items as SalesOrderItem[]) : [];
        const productIds: string[] = [];
        for (const i of items) {
          const r = resolverItemNoCatalogo(i, order.account, indiceCatalogo);
          if (r.ok) {
            productIds.push(r.productId);
            itensResolvidos++;
          } else if (r.motivo === 'conta_divergente') {
            // O contador que faz este guard ser auditável em vez de inerte-e-mudo: em prod
            // ele vale ZERO hoje (0 de 47.798 itens, medido em 20/08/2026), e é o primeiro
            // sinal de que a colisão que o schema autoriza deixou de ser hipótese.
            itensContaDivergente++;
          }
        }
        if (productIds.length > 0) {
          baskets.push(productIds);
          if (!customerBaskets.has(order.customer_user_id)) customerBaskets.set(order.customer_user_id, new Set());
          productIds.forEach((pid) => customerBaskets.get(order.customer_user_id)!.add(pid));

          // Sequential tracking
          if (!sequentialPurchases.has(order.customer_user_id)) sequentialPurchases.set(order.customer_user_id, []);
          productIds.forEach((pid) => {
            sequentialPurchases.get(order.customer_user_id)!.push({
              productId: pid,
              date: new Date(order.created_at),
            });
          });
        }
      }

      // COBERTURA de HISTÓRICO (par de `clientes_com_profile`; §7.5 do design). Aqui a
      // condição é literal no loop acima: a cesta só entra em `customerBaskets` quando
      // `productIds.length > 0`, isto é, quando ao menos um item resolveu para SKU ATIVO DA
      // CONTA DO PEDIDO — 60,1% dos 47.735 itens em prod (18/08/2026), e a qualificação por
      // conta não mexeu nesse número (medição de 20/08/2026: os 39,9% descartados são 100% SKU
      // inativo da PRÓPRIA conta; zero código órfão, zero cross-account). Cliente sem item utilizável não gera
      // cesta, e sem cesta não há regra a descobrir: `carteira_ativa` farta com esta
      // cobertura zero é zero por CONSTRUÇÃO, não "nada a ofertar".
      //
      // Interseção com a carteira DESTE farmer, não o universo global — 107 dos 861 clientes
      // com pedido não têm nenhum item que resolva, e um farmer feito só deles produziria
      // zero com todos os universos "não-vazios".
      insumos.carteira_com_historico_utilizavel = {
        ok: true,
        n: ativos.filter((c) => customerBaskets.has(c.customer_user_id)).length,
        // `esperado` entra como EVIDÊNCIA, SEM piso — e isso é decisão medida, não omissão.
        // Distribuição real (psql-ro, 19/08/2026, 3 farmers com carteira ativa): 2 em 100%
        // de cobertura e 1 em 85,96%; NENHUM abaixo de 50%. Qualquer piso plausível ou é
        // inerte (não separa nada do regime atual) ou degrada o farmer de 86% já no primeiro
        // recálculo. Fixar um número aqui seria inventar o limiar — o mesmo erro que este
        // arquivo evita em `baskets`, e o que "rótulo com DEFAULT constante não é fato"
        // (money-path §5) proíbe. O `n`/`esperado` ficam no head justamente para calibrar o
        // piso quando houver farmers suficientes para que ele signifique algo.
        esperado: ativos.length,
      };

      // EVIDÊNCIA, não veredicto — e a distinção importa. `baskets` é o universo GLOBAL que
      // alimenta o Apriori (TODOS os pedidos, não só os da carteira); o insumo acima mede a
      // carteira que RECEBE bundle. Fora dos obrigatórios de propósito: `baskets === 0` implica
      // `regras === 0`, e `regras` já é obrigatório aqui desde o #1779 — exigir os dois
      // degradaria pela mesma causa duas vezes, com o motivo apontando o sintoma em vez da
      // causa. Fica no head para auditar quantos pedidos lidos viraram cesta, sem query.
      insumos.baskets = { ok: true, n: baskets.length, esperado: (salesOrders || []).length };

      // SENSOR da identidade account-aware (o par `(omie_codigo_produto, account)` que o banco
      // declara único). `n` conta os itens que resolveram; `esperado` soma a esses os que saíram
      // por DIVERGÊNCIA DE CONTA — e só esses. Item de SKU inativo fica de fora do denominador
      // de propósito: são 39,9% em prod (regime normal, já auditado por
      // `carteira_com_historico_utilizavel`), e diluir a divergência dentro deles daria um
      // número farto que nunca chamaria atenção — o "rótulo com DEFAULT constante" do §5.
      //
      // Hoje `n === esperado` em produção (0 de 47.798 itens divergem, psql-ro 20/08/2026).
      // SEM piso: o veredicto não muda por isto. `n < esperado` é o gatilho para reabrir o
      // achado — é o primeiro dia em que a colisão que o schema autoriza existiu de verdade.
      insumos.itens_identidade_conforme = {
        ok: true,
        n: itensResolvidos,
        esperado: itensResolvidos + itensContaDivergente,
      };

      const totalBaskets = Math.max(baskets.length, 1);

      // 3. Association rule mining (Apriori-like)
      // Count item frequencies
      const itemFreq = new Map<string, number>();
      for (const basket of baskets) {
        const unique = [...new Set(basket)];
        for (const item of unique) {
          itemFreq.set(item, (itemFreq.get(item) || 0) + 1);
        }
      }

      // Frequent items (support >= minSupport)
      const frequentItems = [...itemFreq.entries()]
        .filter(([, count]) => count / totalBaskets >= config.minSupport)
        .map(([id]) => id);

      // Count pairs
      const pairFreq = new Map<string, number>();
      for (const basket of baskets) {
        const unique = [...new Set(basket)].filter(id => frequentItems.includes(id));
        for (let i = 0; i < unique.length; i++) {
          for (let j = i + 1; j < unique.length; j++) {
            const key = [unique[i], unique[j]].sort().join('|');
            pairFreq.set(key, (pairFreq.get(key) || 0) + 1);
          }
        }
      }

      // Count triples
      const tripleFreq = new Map<string, number>();
      for (const basket of baskets) {
        const unique = [...new Set(basket)].filter(id => frequentItems.includes(id));
        for (let i = 0; i < unique.length; i++) {
          for (let j = i + 1; j < unique.length; j++) {
            for (let k = j + 1; k < unique.length; k++) {
              const key = [unique[i], unique[j], unique[k]].sort().join('|');
              tripleFreq.set(key, (tripleFreq.get(key) || 0) + 1);
            }
          }
        }
      }

      // Generate association rules
      const discoveredRules: AssociationRule[] = [];

      // Pair rules: A → B
      for (const [pairKey, pairCount] of pairFreq.entries()) {
        const [a, b] = pairKey.split('|');
        const support = pairCount / totalBaskets;
        if (support < config.minSupport) continue;

        const freqA = itemFreq.get(a) || 0;
        const freqB = itemFreq.get(b) || 0;

        // Rule: A → B
        const confAB = pairCount / freqA;
        const liftAB = confAB / (freqB / totalBaskets);
        if (liftAB >= config.minLift) {
          discoveredRules.push({
            antecedent: [a], consequent: [b],
            antecedentNames: [productMap.get(a)?.descricao || a],
            consequentNames: [productMap.get(b)?.descricao || b],
            support, confidence: confAB, lift: liftAB, type: 'association',
          });
        }

        // Rule: B → A
        const confBA = pairCount / freqB;
        const liftBA = confBA / (freqA / totalBaskets);
        if (liftBA >= config.minLift) {
          discoveredRules.push({
            antecedent: [b], consequent: [a],
            antecedentNames: [productMap.get(b)?.descricao || b],
            consequentNames: [productMap.get(a)?.descricao || a],
            support, confidence: confBA, lift: liftBA, type: 'association',
          });
        }
      }

      // 4. Sequential rules
      for (const [, purchases] of sequentialPurchases.entries()) {
        const sorted = [...purchases].sort((a, b) => a.date.getTime() - b.date.getTime());
        for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            const daysDiff = (sorted[j].date.getTime() - sorted[i].date.getTime()) / (1000 * 60 * 60 * 24);
            if (daysDiff > config.sequentialWindowDays) break;
            if (sorted[i].productId === sorted[j].productId) continue;
            // Count in a temp map (simplified: we already have pair data)
            const existingRule = discoveredRules.find(
              r => r.antecedent[0] === sorted[i].productId && r.consequent[0] === sorted[j].productId
            );
            if (existingRule && existingRule.type === 'association') {
              // Mark as also sequential
              existingRule.type = 'sequential';
            }
          }
        }
      }

      // Sort rules by lift
      discoveredRules.sort((a, b) => b.lift - a.lift);
      setRules(discoveredRules.slice(0, 50)); // Keep top 50

      // `regras` é insumo OBRIGATÓRIO do bundle (ver completude-snapshot): sem regra
      // descoberta não há `applicableRules`, e o motor produz zero por construção. Declara-se
      // o array INTEIRO — é ele que alimenta o filtro abaixo, não o top-50 que vai à tabela.
      insumos.regras = { ok: true, n: discoveredRules.length };

      // ESTE HOOK NÃO PUBLICA MAIS O MODELO GLOBAL. As regras acima seguem alimentando os
      // bundles DESTA execução, em memória — o que saiu foi a persistência em
      // `farmer_association_rules`, que é uma tabela GLOBAL.
      //
      // POR QUÊ (medido em prod, psql-ro, 2026-08-20/21). A tabela tinha DOIS escritores
      // chamando a mesma RPC com modelos diferentes, e o último a escrever vencia:
      //   · o cron `compute-association-rules-daily` (edge `omie-analytics-sync`) gravou 24
      //     regras às 07:30 UTC com `sample_size` 479;
      //   · este hook gravou 4 regras às 01:33 UTC do dia seguinte com `sample_size` 21.579,
      //     porque alguém abriu a tela.
      // Não é hipótese: foi observado ACONTECENDO durante a investigação. Os dois universos
      // discordam (21.579 cestas aqui, de `sales_orders.items` com SKU ativo, contra 30.239
      // no produtor server-side, de `order_items`), e a MESMA coluna `sample_size` passava a
      // significar coisas diferentes conforme quem escreveu por último. Enquanto os dois
      // existissem, corrigir um era ser revertido pelo outro no clique seguinte — a correção
      // do cap de 1.000 no produtor teria meia-vida de uma abertura de tela.
      //
      // Violava, além disso, "1 escritor por slug" (CLAUDE.md): uma VISITA a uma tela não
      // pode republicar o modelo de toda a base.
      //
      // O `rule_type: 'sequential'` que só este caminho produzia NÃO se perde de verdade: ele
      // nunca foi um modelo sequencial — o código apenas TROCAVA o rótulo de uma regra de
      // associação já descoberta quando achava uma ocorrência ordenada na janela, sem
      // support/confidence próprios, sem exigir repetição e aceitando itens do MESMO pedido
      // (diferença de zero dias). As 4 regras vivas em prod estavam TODAS rotuladas
      // `sequential`, o que confirma que o rótulo não discrimina nada. Sequencial de verdade
      // é outro modelo, com unidade, janela e métricas próprias — fatia separada.
      //
      // O fence de verdade é no BANCO (`REVOKE EXECUTE ... FROM authenticated` + a policy de
      // escrita), não neste `if`: código do browser é uma via, não a fronteira (money-path §5).
      // Este bloco sai para o operador não tomar um erro de permissão no lugar de um toast.

      // 4.5. O melhor produto individual de CADA cliente — UMA leitura, não N.
      //
      // Era uma consulta a `farmer_recommendations` POR CLIENTE, dentro do laço abaixo. O
      // #1800 consertou a honestidade dela (o `error` resolvido e a Promise rejeitada
      // passaram a ser capturados); o que sobrou, e que o challenge Codex (gpt-5.6-sol,
      // xhigh) apontou, foi a FORMA:
      //
      //   (a) numa carteira de centenas — a maior em prod tem 3.858 clientes — são centenas
      //       de round-trips seriais;
      //   (b) e, o que importa mais: as N consultas são N INSTANTES. Uma substituição
      //       concorrente de `farmer_recommendations` (a RPC de cross-sell expira a geração
      //       e insere a nova) podia fazer metade dos clientes enxergar uma geração e a
      //       outra metade enxergar outra — todas com sucesso, nenhuma com erro, e o
      //       conjunto NÃO formando um snapshot coerente. Um SELECT único é um snapshot
      //       MVCC único: a incoerência de leitura some por construção.
      //
      // A RPC preserva o desempate LITERAL que o `.order()` encadeado emitia
      // (`affinity_score DESC NULLS LAST, updated_at DESC NULLS FIRST, id DESC`) — inclusive
      // o NULLS FIRST implícito do `updated_at`, que o postgrest-js só serializa quando
      // `nullsFirst` é passado. A migration tem o racional de cada peça, e o harness
      // `db/test-farmer-melhor-individual-bulk.sh` prova a PARIDADE cliente a cliente.
      //
      // PAGINADA como as outras: a capa de 1.000 do PostgREST vale para `.rpc()` igual a
      // `.from()` e já zerou este motor duas vezes (#1782, #1801). `customer_user_id` é
      // único no resultado do `DISTINCT ON`, logo é ordem TOTAL — paginar não pula linha.
      const melhorIndividual = new Map<string, MelhorIndividualRow>();
      /**
       * A leitura acessória falhou — UMA vez, para a execução inteira. Era um CONTADOR de
       * clientes porque a consulta era por-cliente; com a leitura em bloco a falha deixou de
       * ser parcial, e contar clientes daria a impressão de que alguns escaparam.
       */
      let comparacaoIndisponivel = false;
      try {
        // UMA request, e é esse o ponto — não é otimização. A primeira versão desta correção
        // usava `RETURNS TABLE` + `fetchAllPages`, e o challenge Codex (gpt-5.6-sol, xhigh)
        // mostrou que paginar TROCA o defeito de lugar em vez de fechá-lo: K requests são K
        // snapshots. Geração A com 1.500 clientes, página 0 lê os 1.000 primeiros; uma
        // substituição grava a geração B com 500; a página 1 pede OFFSET 1000, recebe `[]` —
        // que é o sinal de FIM — e os clientes 1.001–1.500 viram `nenhum`. `nenhum` é um
        // VEREDICTO na tela ("não há rota individual para este cliente"), exatamente o rótulo
        // que esta entrega veio parar de fabricar. E o canário de `run_id` é cego ao caso: só
        // linhas de A foram observadas, então ele conta UMA geração e não avisa.
        //
        // A RPC agrega em `jsonb` e devolve tudo numa tupla: 1 request = 1 snapshot MVCC, a
        // coerência deixa de ser probabilística, e o cap de 1.000 some por construção (ele
        // conta LINHAS, e agora há uma) — o caminho sai da classe #1782/#1801 em vez de se
        // defender dela.
        const { data, error } = await supabase.rpc('farmer_melhor_individual_por_cliente', {
          p_farmer_id: effectiveUserId,
        });
        if (error) throw error;
        // `data` não-array é resposta MALFORMADA, nunca "vazio": a RPC faz
        // `coalesce(…, '[]'::jsonb)` justamente para o vazio legítimo chegar como `[]`. Sem
        // esta linha, `null` viraria `nenhum` para a carteira inteira — a leitura que não
        // aconteceu apresentada como veredicto, que é o §6 do money-path (o contrato tem de
        // EXPOR a falha, senão o caller não pode detectar). A prova SQL do outro lado deste
        // par é o assert A3 do harness; mexer num sem o outro reabre o buraco.
        if (!Array.isArray(data)) {
          throw new Error(
            `farmer_melhor_individual_por_cliente devolveu ${data === null ? 'null' : typeof data} em vez de array`,
          );
        }
        for (const linha of data as unknown as MelhorIndividualRow[]) {
          melhorIndividual.set(linha.customer_user_id, linha);
        }
      } catch (erroIndividual) {
        console.error('Falha ao ler o melhor individual da carteira:', erroIndividual);
        // …e o `console.error` acima morre no DevTools de quem nunca abre o DevTools. Sem esta
        // linha a falha chegava ao vendedor (toast + "indisponível" em cada cartão) e a MAIS
        // NINGUÉM — o plantão só ficava sabendo se ele reportasse, o que não acontece. O
        // vizinho de cima (head ilegível) já saía por aqui; a assimetria era acidental.
        //
        // `erroComCausa` guarda as duas pontas: a mensagem de domínio para quem lê o alarme e o
        // erro ORIGINAL preso em `cause` para quem for diagnosticar — o `error` do PostgREST é
        // um objeto PLANO (`{message, details, hint, code}`), não um `Error`, e `String(err)`
        // nele imprime "[object Object]"; por isso `mensagemDeErro`, e não `String`.
        //
        // ⚠️ Isto é o RELATO, não uma SÉRIE (§13 do money-path): o alarme prova QUE falhou, não
        // com que frequência — a taxa continua sem denominador, preço reconhecido de manter
        // esta leitura fora do `InsumosSnapshot` pelo motivo do parágrafo abaixo.
        captureException(
          erroComCausa(
            `[farmer/melhor-individual] leitura em bloco falhou — ${mensagemDeErro(erroIndividual) ?? 'erro sem mensagem'}`,
            erroIndividual,
          ),
          { origem: 'farmer/melhor-individual', motor: 'bundle', runId },
        );
        // Sem `throw`: esta comparação é ACESSÓRIA — ela não entra em `recomendacoes`, o
        // payload da RPC de substituição, então derrubar a carteira inteira por causa dela
        // trocaria uma afirmação errada por um prejuízo maior. O que a falha NÃO pode é
        // sumir: ela acorda o plantão (acima), reprova o toast de sucesso, marca cada cliente
        // como `indisponivel` na tela, e impede que a omissão da lista vire um veredicto.
        //
        // ⚠️ DE PROPÓSITO **não** vira insumo do `InsumosSnapshot`, e a reavaliação que esta
        // entrega fez CONFIRMOU a decisão anterior trocando o fundamento dela.
        //
        // O fundamento ANTIGO era o RUÍDO: com a consulta POR CLIENTE, uma falha isolada numa
        // carteira de centenas carimbaria `degradado` em quase toda execução, e sinal que
        // nunca varia deixa de ser sinal. Com a leitura em bloco isso caiu — é 1 leitura e 1
        // falha possível por execução. Cheguei a declarar o insumo por isso; o challenge Codex
        // mostrou que o argumento certo é outro, e que ele aponta para o lado oposto:
        //
        //   "'não obrigatório' só vale para `n===0`; `ok:false` SEMPRE degrada. Portanto
        //    `melhor_individual` passa a bloquear a expiração de bundles embora seja
        //    comprovadamente invariante para `p_linhas`. (…) A decisão anterior estava certa,
        //    mas pela causalidade com `p_linhas`, não pelo ruído."
        //
        // É isso. A completude julga UMA coisa — se o zero de BUNDLES veio de um snapshot
        // íntegro — e esta leitura não participa dela: cliente com bundle entra de qualquer
        // jeito, cliente sem bundle contribui zero linhas com ou sem ela. Declará-la faria uma
        // leitura acessória travar o mecanismo de aposentadoria da fase 2 (`degradado` nunca
        // autoriza expirar) por um motivo que não tem relação com o que está sendo expirado.
        // A falha continua visível — no toast e em cada cartão —, que é onde ela pertence.
        //
        // ⚠️ 3º round (21/08, challenge Codex gpt-5.6-sol/xhigh): "fora do RÓTULO" NÃO quer
        // dizer "fora do `insumos`". A pergunta reaberta não foi a causalidade — essa está
        // fechada acima — e sim que a falha não deixava SÉRIE. O `captureException` acima (#1839)
        // resolveu a metade VISÍVEL: cada falha passa a existir para o plantão. Mas alarme é
        // NUMERADOR — ele só sai QUANDO falha, então "3 falhas" não distingue 3 em 400 execuções
        // de 3 em 3, e quem perguntasse "com que frequência isso falha?" seguia sem denominador
        // (`docs/historico/fase-sem-sinal.md`). Desde este PR a leitura entra no snapshot como
        // EVIDÊNCIA INERTE — `comparacao_individual_leitura` e
        // `comparacao_individual_produto_resolvido`, `ok:true` sempre, fora dos obrigatórios e
        // sem piso (ver o bloco onde são declaradas). Elas não podem degradar veredicto nenhum;
        // registram. **Não as converta em `ok:false` na falha** — é exatamente a mudança que os
        // dois challenges anteriores rejeitaram, agora com o rótulo trocado de lugar.
        comparacaoIndisponivel = true;
      }

      // 5. Generate bundles per customer
      const allCustomerBundles: CustomerBundles[] = [];
      /**
       * Gerações distintas entre os vencedores que a tela de fato EXIBE — e só isso.
       *
       * O nome anterior (`geracoesMisturadas`, contado sobre TODAS as linhas da RPC) afirmava
       * mais do que media, e o challenge Codex nomeou os dois erros: contava clientes que o
       * laço nunca consome (`if (!profile) continue`), então uma geração presente só num
       * cliente invisível gerava aviso sobre cartão nenhum; e não prova unicidade na TABELA —
       * duas gerações vivas com a nova vencendo em todos os clientes contam 1. A invariante da
       * tabela pertence ao writer do cross-sell; daqui só dá para honestamente dizer se o que
       * está NA TELA mistura cálculos de momentos diferentes.
       */
      const geracoesExibidas = new Set<string>();
      /**
       * Denominador do sensor de RESOLUÇÃO: registros que a RPC devolveu E que o laço de fato
       * exercitou contra o `productMap` (depois do gate `if (!profile) continue`).
       *
       * Contado AQUI, não reaproveitado de `insumos.clientes_com_profile`: aquele conta sobre
       * `ativos` (carteira ∩ quem tem pedido) e este laço percorre TODO `clientScores` — em
       * prod os dois empatam, mas não é invariante, e um denominador que coincide por acaso é
       * o "rótulo com DEFAULT constante" do §5 esperando a base mudar.
       */
      let comparacoesAvaliadas = 0;
      /** Quantas delas resolveram para SKU do catálogo ATIVO — o numerador. */
      let comparacoesResolvidas = 0;

      for (const score of clientScores) {
        const cid = score.customer_user_id;
        const profile = profileMap.get(cid);
        if (!profile) continue;

        const healthScore = Math.max(Number(score.health_score || 0), 10);
        const purchased = customerBaskets.get(cid) || new Set();

        // Engagement factor
        const answerRate = Number(score.answer_rate_60d || 0) / 100;
        const whatsappRate = Number(score.whatsapp_reply_rate_60d || 0) / 100;
        const engagementFactor = clamp(0.3 + 0.5 * answerRate + 0.2 * whatsappRate, 0.1, 1.0);

        // Find applicable rules: customer has antecedent but NOT consequent
        const applicableRules = discoveredRules.filter(rule => {
          const hasAntecedent = rule.antecedent.every(id => purchased.has(id));
          const missingConsequent = rule.consequent.some(id => !purchased.has(id));
          return hasAntecedent && missingConsequent;
        });

        // Generate bundles from rules (combine consequents)
        const bundles: BundleRecommendation[] = [];
        const usedCombos = new Set<string>();

        for (const rule of applicableRules) {
          const missingProducts = rule.consequent.filter(id => !purchased.has(id));
          
          // Single consequent bundle
          for (const pid of missingProducts) {
            const product = productMap.get(pid);
            if (!product) continue;
            // O custo decide EXCLUSÃO, nunca ORDEM: só entra SKU que a RPC listou como vendável
            // (margem canônica > 0). Sem custo conhecido não entra — ausente≠zero (#1466).
            if (!vendaveis.has(pid)) continue;
            const price = Number(product.valor_unitario || 0);

            // Try to build bundles of 2-3 by combining with other high-lift rules
            const relatedRules = applicableRules.filter(r2 =>
              r2 !== rule && r2.consequent.some(c => !purchased.has(c) && c !== pid)
            );

            // Bundle of 2: this product + one from related rule
            for (const related of relatedRules.slice(0, 3)) {
              for (const relatedPid of related.consequent) {
                if (purchased.has(relatedPid) || relatedPid === pid) continue;
                const relatedProduct = productMap.get(relatedPid);
                if (!relatedProduct) continue;
                // Mesmo motivo do produto principal: só o vendável entra no par.
                if (!vendaveis.has(relatedPid)) continue;
                const relatedPrice = Number(relatedProduct.valor_unitario || 0);

                const comboKey = [pid, relatedPid].sort().join('|');
                if (usedCombos.has(comboKey)) continue;
                usedCombos.add(comboKey);

                // Bundle metrics
                const avgConfidence = (rule.confidence + related.confidence) / 2;
                const avgLift = (rule.lift + related.lift) / 2;
                const avgSupport = (rule.support + related.support) / 2;

                const pBundle = avgConfidence * (avgLift / 2) * (healthScore / 100) * engagementFactor;

                // Constante (ver bloco de premissas): a média dos dois fatores é ela mesma.
                // Persistida como dado, mas NÃO multiplica o score — sendo 1.0 e igual para todo
                // par, multiplicar por ela não muda ORDEM nenhuma. Ver `affinityBundle`.
                const complexityFactor = FATOR_COMPLEXIDADE;

                const affinityBundle = pBundle;

                if (affinityBundle > 0) {
                  bundles.push({
                    customerId: cid,
                    customerName: profile.name ?? '',
                    products: [
                      { id: pid, name: product.descricao, price },
                      { id: relatedPid, name: relatedProduct.descricao, price: relatedPrice },
                    ],
                    support: avgSupport,
                    confidence: avgConfidence,
                    lift: avgLift,
                    pBundle: Math.round(pBundle * 1000) / 10,
                    affinityBundle: Math.round(affinityBundle * 10000) / 10000,
                    complexityFactor,
                    status: 'pendente',
                  });
                }
              }
            }
          }
        }

        // Ordena por AFINIDADE, top 2
        bundles.sort((a, b) => b.affinityBundle - a.affinityBundle);
        const topBundles = bundles.slice(0, 2);

        // Best individual product (from cross-sell engine data) — agora do Map lido em bloco
        // no passo 4.5. Três estados, e o terceiro é o que o tipo antigo não sabia dizer:
        // `nenhum` = a RPC respondeu e este cliente não tem oferta individual pendente;
        // `indisponivel` = ninguém pode afirmar nada sobre este cliente (e o `motivo` diz por
        // quê: a leitura falhou, ou o SKU eleito não existe mais no catálogo ativo).
        let bestIndividual: ComparacaoIndividual;
        const rec = melhorIndividual.get(cid);
        if (comparacaoIndisponivel) {
          bestIndividual = { status: 'indisponivel', motivo: 'leitura_falhou' };
        } else if (rec) {
          comparacoesAvaliadas++;
          // `product_id` separado ANTES do Map: com `string | null` o compilador passa a EXIGIR
          // o tratamento, em vez de a chave `null` virar um miss indistinguível de SKU inativo.
          const pid = rec.product_id;
          const prod = pid == null ? undefined : productMap.get(pid);
          // Ausente ≠ zero: `Number(null)` é 0 e afirmaria afinidade nula MEDIDA.
          const afinidade = rec.affinity_score == null ? NaN : Number(rec.affinity_score);
          if (pid == null || !prod?.descricao) {
            // Era `productName: prod?.descricao || 'Produto'`: a tela dizia ter ENCONTRADO o
            // melhor individual e mostrava um nome inventado. O `productMap` só tem SKU
            // ATIVO, e `product_id` é nullable no schema — as duas portas caem aqui.
            // "Encontrei algo que não sei identificar" é `não sei`, não `encontrei`.
            bestIndividual = { status: 'indisponivel', motivo: 'produto_nao_resolve' };
          } else {
            geracoesExibidas.add(rec.run_id ?? 'sem-run');
            comparacoesResolvidas++;
            bestIndividual = {
              status: 'encontrado',
              value: {
                productId: pid,
                productName: prod.descricao,
                affinity: Number.isFinite(afinidade) ? afinidade : null,
                type: rec.recommendation_type,
              },
            };
          }
        } else {
          bestIndividual = { status: 'nenhum' };
        }

        // `nenhum` é a ÚNICA ausência que autoriza omitir o cliente da lista, porque é a
        // única que foi de fato verificada. Com `indisponivel` o cliente entra mesmo sem
        // bundle: sumi-lo seria afirmar, pelo silêncio, que não há rota individual para
        // ele — a afirmação que nenhuma leitura sustentou.
        if (topBundles.length > 0 || bestIndividual.status !== 'nenhum') {
          const purchasedProducts = [...purchased]
            .map((pid) => productMap.get(pid)?.descricao)
            .filter((d): d is string => Boolean(d));
          allCustomerBundles.push({
            customerId: cid,
            customerName: profile.name ?? '',
            healthScore,
            bundles: topBundles,
            bestIndividual,
            avgMonthlySpend: Number(score.avg_monthly_spend_180d || 0),
            grossMarginPct: margemConhecida(score.gross_margin_pct),
            categoryCount: Number(score.category_count || 0),
            daysSinceLastPurchase: Number(score.days_since_last_purchase || 0),
            cnae: profile.cnae || '',
            customerType: profile.customer_type || '',
            recentProducts: purchasedProducts.slice(0, 5),
          });
        }
      }

      // Ordena clientes pela MELHOR afinidade de bundle (não pela soma — somar scores premia
      // quem tem mais bundles na lista, não quem tem a melhor oferta).
      allCustomerBundles.sort(
        (a, b) =>
          Math.max(0, ...b.bundles.map((x) => x.affinityBundle)) -
          Math.max(0, ...a.bundles.map((x) => x.affinityBundle)),
      );

      // SENSOR do bundle MISTO. O `useCrossSellEngine` mede outra coisa (se a oferta saiu da
      // conta em que o cliente compra) porque lá as duas direções são legítimas — 47,4% dos
      // clientes compram pelas duas empresas do grupo. Aqui não: um bundle é "compre JUNTOS",
      // e SKUs de empresas diferentes não cabem num pedido só. `esperado` é 100%, e qualquer
      // `n < esperado` é oferta que o fluxo de venda não executa. Ver `cobertura-conta-oferta.ts`.
      //
      // Fora de `INSUMOS_OBRIGATORIOS_BUNDLE` mesmo tendo gatilho: a lista governa se o motor
      // pode declarar "não há o que ofertar" (e expirar a carteira), e um bundle misto não diz
      // nada sobre isso — degradar por causa dele expiraria a carteira INTEIRA por um defeito
      // de composição de UMA linha.
      insumos.bundle_conta_unica = {
        ok: true,
        ...medirBundlesDeContaUnica(
          allCustomerBundles.flatMap((cb) => cb.bundles),
          indiceCatalogo.contaDoProduto,
        ),
      };

      // ── EVIDÊNCIA INERTE da comparação individual (money-path §13, relato DURÁVEL) ────────
      //
      // A leitura do melhor individual segue FORA do juízo da completude, e o motivo não mudou:
      // `p_linhas` é invariante a ela (ver o `catch` do passo 4.5). O que muda aqui é que a
      // falha dela deixa de morrer no toast. Sem isto, "com que frequência a comparação falha?"
      // não tem denominador — o defeito de `docs/historico/fase-sem-sinal.md`, e a tabela é
      // append-only: execução já gravada NÃO aceita backfill.
      //
      // ⚠️ `ok` é `true` por DESENHO, e não é otimismo: para evidência inerte `ok` significa
      // "o sensor conseguiu registrar o desfecho", não "a leitura observada deu certo" — essa
      // está em `n/esperado`. Trocar para `ok:false` na falha PREGA a leitura no veredicto
      // (`avaliarCompletude` filtra `!ok` antes da lista de obrigatórios, então `ok:false`
      // degrada SEMPRE, obrigatório ou não) e trava a aposentadoria da fase 2 por um motivo que
      // não tem relação com o que está sendo expirado. Sem `pisoCobertura` pelo mesmo motivo:
      // com piso, `esperado` deixaria de ser auditoria e voltaria a julgar.
      //
      // São DUAS chaves porque são DUAS unidades, e uma só usaria o denominador errado (achado
      // do challenge Codex gpt-5.6-sol/xhigh): num cenário de 238 avaliados com 1 pendente cujo
      // produto não resolve, "clientes com veredicto" grava 237/238 = 99,6% — o `nenhum`,
      // que é fato comercial legítimo, MASCARA exatamente a deriva que o sensor existe para
      // expor. A resolução real é 0/1.
      //
      //   falha global .................. leitura 0/1 · resolução 0/0
      //   RPC íntegra, ninguém pendente .. leitura 1/1 · resolução 0/0
      //   todo produto quebrado ......... leitura 1/1 · resolução 0/K
      //   tudo íntegro .................. leitura 1/1 · resolução K/K
      //
      // Baseline medido em prod (psql-ro, 21/08/2026): 0 de 313 pendentes não resolvem, em 2
      // farmers (166 + 147). Zero COM denominador — é o regime ANTERIOR à primeira deriva, que
      // é o que torna possível datar quando ela começar (foi assim que o cross-sell expôs o
      // 934/939 `oben`).
      insumos.comparacao_individual_leitura = {
        ok: true,
        // Por EXECUÇÃO: a RPC é 1 request desde o #1817, então a falha é tudo-ou-nada. `n` aqui
        // é booleano honesto — não o disfarce de razão que "clientes lidos" seria (0 ou 238,
        // nunca no meio).
        n: comparacaoIndisponivel ? 0 : 1,
        esperado: 1,
      };
      insumos.comparacao_individual_produto_resolvido = {
        ok: true,
        // Por REGISTRO PENDENTE, que é a unidade da deriva: SKU desativado depois da geração do
        // cross-sell, ou `product_id` null. As duas portas caem no ramo `produto_nao_resolve`,
        // que hoje é o ÚNICO estado do motor invisível em toda parte — não está no toast, e sem
        // esta chave não estaria no head.
        n: comparacoesResolvidas,
        esperado: comparacoesAvaliadas,
      };

      aplicarBundles(allCustomerBundles);
      // Marcados JUNTOS e aqui, não na gravação: a partir deste ponto a tela mostra o
      // resultado DESTE cálculo, e ele produziu linhas — os dois fatos que o `catch` precisa.
      resultadoDestaExecucao = true;
      // CONCLUIU: daqui para baixo só resta PERSISTIR, então qualquer falha adiante é de
      // gravação — e é este flag que impede a tela de culpar a leitura por ela.
      setCalculado(true);
      // Linhas PERSISTÍVEIS, não clientes: um cliente entra em `allCustomerBundles` só com
      // `bestIndividual` (`encontrado` ou `indisponivel`) e nenhum bundle, e essa comparação
      // não vira linha nenhuma no payload da RPC. Contando clientes, esse caso travava o `registrarVazio()` do `catch` sobre uma
      // execução que de fato não produziu nada — o head parava de se mover e "nenhum registro
      // novo" voltava a significar duas coisas opostas (challenge Codex xhigh).
      linhasProduzidas = allCustomerBundles.some((cb) => cb.bundles.length > 0);

      // Persist bundle recommendations — via RPC que SUBSTITUI a geração anterior.
      // PULADO na lente "Ver como" (só leitura: o master inspeciona os bundles do alvo
      // sem regravar a carteira dele).
      //
      // Era `.insert()` puro: cada recálculo EMPILHAVA uma geração nova sem aposentar a
      // anterior, e como `OfertaCruaCard`/`useTacticalPlan` leem `status='pendente'`
      // ordenado por `affinity_bundle` desc com `.limit(1)`/`.limit(2)`, um bundle ANTIGO
      // de score maior seguia sendo o topo indefinidamente. Ver o cabeçalho da migration
      // 20260814223445 para a medição.
      //
      // A RPC expira-e-insere numa transação só; em duas chamadas PostgREST seriam duas
      // transações, e falhar entre elas deixaria o farmer sem NENHUM bundle pendente.
      // `m_bundle`/`lie_bundle` saem do payload — a RPC os fixa em NULL.
      //
      // O `error` é CAPTURADO; sem `throw`, porque os bundles em memória continuam válidos
      // e já foram exibidos — só o toast final deixa de dizer que deu tudo certo.
      let recomendacoesNaoGravadas = 0;
      /** FG006: outro run JÁ gravou — a tabela tem algo mais NOVO que isto. */
      let geracaoPerdida = false;
      /** FG005: outro run está EM VOO — ninguém venceu ainda, e ele pode até dar rollback.
       *  Separado de propósito: dizer "as telas estão com o resultado dele" quando o
       *  concorrente ainda não commitou seria afirmar um desfecho que não existe, e o
       *  operador desistiria de tentar de novo (achado do challenge Codex xhigh). */
      let recalculoConcorrente = false;
      if (!isImpersonating) {
        const recomendacoes = allCustomerBundles.flatMap((cb) =>
          cb.bundles.map((bundle) => ({
            customer_user_id: bundle.customerId,
            // Sem `cost`/`margin` por SKU — o jsonb guardava o custo LITERAL (12/12 linhas em
            // prod). Só id/name/price, e `price` é público.
            bundle_products: bundle.products as unknown as Json,
            support: bundle.support,
            confidence: bundle.confidence,
            lift: bundle.lift,
            p_bundle: bundle.pBundle,
            affinity_bundle: bundle.affinityBundle,
            complexity_factor: bundle.complexityFactor,
          })),
        );

        // Lote vazio não chama a RPC (ela recusaria com FG003): expirar a geração por
        // "não achei bundle nenhum" tiraria a oferta da tela por um dado que falta a
        // montante. Mesmo critério das regras de associação logo acima.
        //
        // O que MUDOU: o vazio deixou de ser silencioso — ele move o HEAD declarando se o
        // snapshot estava íntegro. Vazio com snapshot completo é o "zero de verdade", e é
        // o único sinal que autorizaria a fase 2 a ligar a expiração.
        const { completude, motivo } = avaliarCompletude(insumos, INSUMOS_OBRIGATORIOS_BUNDLE);
        if (recomendacoes.length === 0) {
          await registrarVazio();
        }
        if (recomendacoes.length > 0) {
          const { error: erroRecs } = await supabase.rpc(
            'farmer_bundle_recomendacoes_substituir' as never,
            {
              p_farmer_id: effectiveUserId,
              p_run_id: runId,
              p_geracao_vista: geracaoVista,
              p_linhas: recomendacoes,
              // O head é movido pela própria RPC, na MESMA transação.
              p_completude: completude,
              p_motivo: motivo,
              p_insumos: insumos,
              // Ver useCrossSellEngine: sem o head ORIGINAL, um run vazio mais novo seria
              // sobrescrito por este, que leu snapshot mais velho.
              p_head_visto: headVisto ?? null,
            } as never,
          );
          if (erroRecs) {
            console.error('Falha ao substituir farmer_bundle_recommendations:', erroRecs);
            // FG006 = outro recálculo gravou no meio deste. A tabela ficou com algo MAIS
            // novo — dizer "não gravou, seguem as anteriores" inverteria o sentido.
            const codigo = (erroRecs as { code?: string } | null)?.code;
            if (codigo === 'FG006') {
              geracaoPerdida = true;
            } else if (codigo === 'FG005') {
              recalculoConcorrente = true;
            } else {
              recomendacoesNaoGravadas = recomendacoes.length;
            }
          }
        }
      }

      // O toast reflete o que REALMENTE aconteceu. Antes ele era `success` incondicional —
      // com a persistência falhando calada, o operador via "regras gravadas" e ia embora.
      // Regras e recomendações falham de forma INDEPENDENTE, então os dois desfechos entram
      // no mesmo aviso: reportar só um deixaria o outro invisível.
      const totalBundles = allCustomerBundles.reduce((s, c) => s + c.bundles.length, 0);
      const problemas: string[] = [];
      // Os dois desfechos de PERSISTÊNCIA DE REGRA saíram junto com a escrita: este hook não
      // publica mais `farmer_association_rules` (ver o bloco da seção 4). Sem escrita não há
      // desfecho a relatar — e manter a frase "as regras NÃO foram salvas" seria pior que
      // silêncio, porque afirmaria uma tentativa que não existe. As regras deste run seguem
      // valendo em memória para os bundles abaixo; quem publica o modelo global é o cron.
      if (recomendacoesNaoGravadas > 0) {
        problemas.push(
          recomendacoesNaoGravadas === 1
            ? '1 recomendação NÃO foi gravada — as telas de oferta seguem com as anteriores'
            : `${recomendacoesNaoGravadas} recomendações NÃO foram gravadas — as telas de oferta seguem com as anteriores`,
        );
      }
      if (geracaoPerdida) {
        problemas.push(
          'outro recálculo deste vendedor já gravou enquanto este rodava — os bundles daqui não foram salvos, e as telas estão com o resultado mais novo',
        );
      }
      if (recalculoConcorrente) {
        problemas.push(
          'já havia um recálculo deste vendedor em andamento — os bundles daqui não foram salvos; espere ele terminar e confira',
        );
      }
      // A falha agora é UMA e vale para a carteira inteira — antes era um contador, porque a
      // consulta era por-cliente. O aviso mudou de "N clientes podem ter ficado fora" para o
      // fato exato: a coluna existe na tela, marcada como indisponível, em TODOS os clientes.
      if (comparacaoIndisponivel) {
        problemas.push(
          'a comparação com o melhor produto individual não pôde ser lida — os cartões mostram "indisponível" no lugar dela, e nenhum cliente foi omitido por isso',
        );
      }
      // Duas gerações vivas em `farmer_recommendations` ao mesmo tempo: o melhor individual de
      // um cliente pode vir de um cálculo e o do vizinho de outro. Não é falha DESTA leitura
      // (uma tupla é um snapshot só) — é estado do dado, e antes era invisível daqui, porque o
      // `.select()` nem pedia `run_id`. A frase é deliberadamente sobre A TELA: é o único
      // escopo que este contador sustenta.
      if (geracoesExibidas.size > 1) {
        problemas.push(
          `as comparações individuais na tela vêm de ${geracoesExibidas.size} gerações diferentes — os cartões misturam cálculos de momentos distintos`,
        );
      }

      if (problemas.length > 0) {
        toast.warning(`${totalBundles} bundles gerados, mas ${problemas.join('; e ')}`);
      } else {
        toast.success(`${discoveredRules.length} regras e ${totalBundles} bundles gerados`);
      }
    } catch (error) {
      console.error('Error calculating bundles:', error);
      // O head TAMBÉM se move aqui. `vendaveis` tinha tratamento próprio, mas scores, catálogo,
      // perfis e pedidos são lidos por `fetchAllPages`, que LANÇA — e a exceção caía neste
      // `catch`, que só fazia console+toast. O head anterior, gravado quando a base estava sã,
      // seguia dizendo `completo` — o único rótulo que autoriza a fase 2 a expirar a carteira.
      //
      // `avaliarCompletude` não precisa de ajuda: o insumo que falhou nunca chega a ser
      // declarado, e "insumo obrigatório não declarado" já degrada (ausente ≠ zero). E quando a
      // gravação de linhas já moveu o head, o CAS recusa este registro com FG106 — que é o
      // desfecho certo, não um erro a corrigir.
      // SÓ registra vazio quem de fato não produziu nada. Ver `linhasProduzidas`.
      if (!linhasProduzidas) await registrarVazio();
      const e = error instanceof Error
        ? error
        : new Error(mensagemDeErro(error) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.');
      setErro(e);
      toast.error(e.message);
      setDesatualizado(!resultadoDestaExecucao && bundlesRef.current.length > 0);
    } finally {
      setCalculating(false);
      setLoading(false);
    }
  }, [effectiveUserId, isImpersonating]);

  // ─── Actions ─────────────────────────────────────────────────────────
  // `markBundleOffered` / `markBundleAccepted` / `markBundleRejected` e o
  // `updateConversionStats` que gravava `farmer_category_conversion` foram removidos
  // em 2026-07-21: nenhum componente os importava (`useFarmerBundles` consome apenas
  // `calculateBundles`), então o desfecho de um bundle nunca foi registrado. Havia
  // ainda um bug latente no writer — o `upsert` não passava `onConflict`, e como a PK
  // é `id` (uuid default, ausente do payload) o INSERT nunca conflitava pela PK e
  // violaria o UNIQUE de `category_id` a partir da 2ª gravação, em silêncio (o retorno
  // não era checado). Ver docs/historico/farmer-aprendizado-conversao.md.

  return {
    customerBundles,
    rules,
    loading,
    calculating,
    erro,
    desatualizado,
    calculado,
    calculateBundles,
    config: DEFAULT_CONFIG,
  };
};
