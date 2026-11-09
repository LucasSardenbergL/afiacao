# Universo de pedidos compartilhado e paralelo nos 3 motores do Farmer — plano v4, lote 16 (C4′)

**Data:** 2026-11-02 · **Item do plano:** C4′ (`docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md`)

## Problema

`useFarmerScoring`, `useCrossSellEngine` e `useBundleEngine` baixavam, cada um por conta, o MESMO
universo de `sales_orders` (denylist `STATUS_NAO_VENDA_POSTGREST` + `deleted_at IS NULL`) via
`fetchAllPages`: páginas `.range` de 1.000 **em série**. Em prod são 32.159 linhas, ~33 requisições
por motor, e o scoring monta em 5 telas (Dashboard, LOCC, Calls, CarteiraBoard, RoutePlanner).

O C4 original (janela de 12 meses, sem `items`) foi recusado pelo founder em 2026-11-01: tiraria
724 de 1.233 clientes (59%) do score. O C4′ troca só o TRANSPORTE: o score não pode mudar.

## O que mudou

1. **`src/lib/farmer/universo-pedidos-query.ts`** — uma consulta react-query (`['farmer',
   'universo-pedidos', userIdReal]`) com a UNIÃO das colunas que os três leem.
2. **Keyset particionado** (`fetchAllKeyset`, novo em `src/lib/postgrest.ts`): 8 faixas disjuntas
   do uuid (`FAIXAS_DO_ID`, piso/teto abertos nas pontas = cobertura por construção), cada uma com
   o seu cursor `gt(id)`, todas em paralelo. Concatenadas na ordem, dão a MESMA sequência global
   por `id` que a leitura sequencial dava — e a ordem é observável nos motores (desempates,
   `ordemDeLeitura` da referência de preço, `slice` de regras do bundle).
3. **Frescor por papel:** quem PUBLICA (cross-sell e bundle gravam a geração) e o botão
   Recalcular relêem sempre (`fresco: true`); o scoring ao montar reusa até 60 s. Leitura em voo
   na mesma chave é compartilhada.
4. **Os ~82 call sites de `fetchAllPages` não foram tocados** (não reabre o M-50).

## Decisões (parecer Codex de desenho, 362 s · 110.869 tokens)

- **Ondas de offset em paralelo foram DESCARTADAS.** O Codex reproduziu: com páginas por offset
  pedidas em paralelo, um INSERT concorrente faz uma linha que existia **sumir** sem duplicata e
  sem página "não-vazia depois da curta" — nenhum guard pega. Keyset elimina o deslocamento: toda
  linha que existe durante a leitura inteira volta exatamente uma vez (não é fotografia atômica).
- **`networkMode: 'always'`:** com o default `'online'`, offline deixa o `fetchQuery` PAUSADO sem
  rejeitar — o motor ficaria "calculando" para sempre, sem `erro`.
- **`retry: false`, `gcTime` 2 min, sem `structuralSharing`:** erro chega na hora (como antes);
  são ~14 MB de jsonb.
- **Chave pelo usuário REAL** (é a RLS dele que decide as linhas), nunca o alvo da lente.
- **Deep-freeze MEDIDO e recusado:** congelar o array compartilhado deixou o cálculo dos motores
  ~10x mais lento (bundle 366 ms → 4,5 s no golden). A guarda contra mutação é o `readonly` do tipo
  + teste que roda motores no mesmo QueryClient contra o golden.

## Prova

- **Golden antes/depois** (`src/test/golden/universo-pedidos/`): saída de cada motor gravada com o
  código de main ANTERIOR à troca (commit próprio), fixture determinística de 6.500 pedidos,
  config não-padrão, relógio fixo. Compara bit a bit: scores/agenda (gestor, vendedor recortado
  pela carteira, lente "Ver como"), recomendações e bundles **e os payloads persistidos**.
- **Equivalência da leitura** (`src/lib/farmer/__tests__/universo-pedidos-query.test.ts`):
  `lerUniversoPedidos()` ≡ a leitura sequencial anterior para N ∈ {0, 1, 999, 1000, 1001, 5999,
  8000, 12345} e com todos os ids numa faixa só; erro em CADA leitura possível rejeita; guards de
  cursor/faixa não honrados; o contraexemplo de INSERT concorrente (offset repete linha, keyset não).

## Config do algoritmo (commit próprio)

O `useFarmerScoring` lia `farmer_algorithm_config` num `useEffect` que ignorava o `error` (caía
calado no DEFAULT) e o cálculo não dependia da config — chegando depois do papel comercial, o 1º
cálculo saía com o DEFAULT e ficava. Agora lê por `useFarmerAlgorithmConfig`; falha ⇒ `erro` sem
cálculo; o `config` exposto é o que produziu os scores (Dashboard/LOCC: "pesos indisponíveis" em
vez de DEFAULT exibido como vigente); só a execução mais recente publica.

## Lições

- **Paralelizar paginação por offset troca um risco conhecido (duplicata) por um invisível
  (omissão).** Paralelo seguro precisa de partição por CHAVE + cursor, não de páginas especulativas.
- **"Mesmo dado ⇒ mesmo score" inclui a ORDEM das linhas** quando o cálculo desempata por ela.
- **Golden só prova se for gravado ANTES** — commit do golden separado do commit da troca.
