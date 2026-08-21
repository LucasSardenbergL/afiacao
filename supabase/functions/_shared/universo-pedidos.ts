// Espelho Deno do universo de PEDIDOS dos motores do farmer — DENYLIST.
//
// A AUTORIDADE é `src/lib/farmer/universo-pedidos.ts` (leia lá o porquê da denylist, os dois
// status que nunca existiram nesta tabela e o efeito no DENOMINADOR do Apriori). O edge não
// importa de `src/` — é Deno, e a suíte roda com `--no-remote` —, então a constante é
// ESPELHADA e a paridade é travada no CI por `src/__tests__/edge-money-path-invariants.test.ts`,
// que EXTRAI a lista de status dos dois arquivos e compara os VALORES (não um bloco textual:
// a autoridade em `src/` é 90% prosa por desenho, e marcadores de MIRROR ali afundariam a
// sentinela de `limpeza-fonte`). Comparar valores é o guard mais forte de qualquer jeito —
// reordenar ou reindentar não reprova; acrescentar ou remover um status reprova. O guard cobre
// a FONTE, inclusive uma reescrita do Lovable no deploy (money-path.md, § "Helper espelhado").
//
// POR QUE ESTE ARQUIVO EXISTE (2026-08-20). Havia DUAS cópias divergentes deste conceito no
// repo e nenhuma era canônica no lado Deno: a autoridade em `src/`, e uma terceira lista em
// `_shared/mapas-paginados.ts` (`carregarPedidosDoMes`) que citava só TRÊS dos quatro status
// — faltava `orcamento`. Criar uma QUARTA cópia para o Apriori seria compor o problema, então
// as duas do lado Deno passam a apontar para cá. Efeito da correção do `carregarPedidosDoMes`
// MEDIDO em prod antes de aplicar: 0 linhas com `status = 'orcamento'` em `sales_orders`, logo
// é no-op HOJE — o valor é fechar a divergência latente, não mudar número.
//
// ⚠️ `deleted_at IS NULL` é a OUTRA METADE do contrato e NÃO mora nesta constante — quem
// consome tem de aplicar os DOIS predicados. Mesma pegadinha que a autoridade documenta.
//
// ⚠️ NULL: o `not.in` do PostgREST é NULL-blind (`NULL NOT IN (...)` é NULL, não passa), igual
// ao SQL da autoridade da margem. A paridade é intencional — espelhar a autoridade inclui
// espelhar como ela trata o nulo. Medido em prod (2026-08-20): 0 linhas com `status` nulo,
// então hoje o ponto é teórico.

// SEM `export`, ao contrário da autoridade em `src/` — lá o array É consumido direto
// (`cobertura-conta-oferta.ts`, testes); aqui ele só alimenta o derivado abaixo, e exportá-lo
// reprova o gate de dead-code (`bunx knip`, dentro do `validate`). O guard de paridade compara
// a LISTA PARSEADA, não o texto, então a assimetria do `export` não o quebra — que é
// exatamente a folga pela qual valeu a pena trocar MIRROR textual por comparação de valores.
/** Status que NÃO são venda. Verbatim do corpo em prod de `private.margem_cliente_agregada()`. */
const STATUS_NAO_VENDA: readonly string[] = [
  'cancelado',
  'rascunho',
  'pendente',
  'orcamento',
];

/** Valor pronto para o `.not('status', 'in', …)` do PostgREST: `("a","b",…)`. */
export const STATUS_NAO_VENDA_POSTGREST = `("${STATUS_NAO_VENDA.join('","')}")`;
