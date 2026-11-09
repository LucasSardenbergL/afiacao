# Radar — pacote N: desempenho e acabamento (2026-11-09)

3ª revisão do Radar (Codex + Fable) → 5 pacotes paralelos J/K/L/M/N. Este é o de desempenho e acabamento da fila
`/radar`. Merge ≠ produção: Publish e a migration do item 6 são do founder.

## O que mudou

1. **Invalidação cirúrgica da fila** (`src/lib/radar/invalidar-cache.ts`, `src/queries/useRadarLista.ts`).
   Antes: toda mutação invalidava `['radar']` inteiro, e a `useInfiniteQuery` relia TODAS as páginas carregadas —
   10 páginas = 10 `radar_lista` por contato registrado, a lista piscava e reordenava sob o dedo.
   Agora `invalidarRadar(qc, { cnpj })` (registro de contato e cadastro no Omie):
   - lê só o lead (`buscarEmpresaRadarFresca`, mesma chave da ficha → a ficha e a fila dividem a leitura) e troca
     a linha no lugar, ou a tira se ela saiu do recorte (`leadSegueNaFila`: status pedido / não descartado e
     `ja_cliente` sem o toggle — o mesmo predicado da `radar_lista` para o que UMA ação muda);
   - recorte que depende de outra tabela (meus atendimentos, para visitar, só sugeridos), leitura do lead que falha,
     página em voo, ou lead fora das páginas mas dentro do recorte → relê a fila como antes (nunca fica velha calada);
   - mapa/ranking (agregados pré-calculados) só ficam velhos; ficha, KPIs, atendimentos etc. relêem como antes.
   - Sem `cnpj` (desfazer, lote) o comportamento é o de antes — os testes do pacote I seguem verdes.
   - **Offset**: o `pageParam` virou o offset no servidor = linhas em cache. Tirar um lead no lugar encolhe o recorte
     do servidor em 1 antes do offset; o "página × 50" de antes pularia uma empresa. O "tem mais?" olha o que o
     servidor MANDOU (marca num WeakMap, levada pelo `structuralSharing` — sem isso a página de 49 dizia "acabou";
     pego pelo teste).
   - **`maxPages` NÃO entrou**: exige paginação para trás (`getPreviousPageParam` + rolagem para cima em
     `RadarClientes.tsx`, da `radar-l-vendedor`) e, com offset, descartar páginas do topo some com a posição do
     vendedor. A cirúrgica tira o custo que motivava o `maxPages`.
2. **Chip "Para visitar" sob demanda** (`useRadarParaVisitarContagem`). Medido em prod (psql-ro, 2026-11-08): o
   pré-corte da 2ª `radar_lista` (`p_so_visitar`, ~67 mil CNPJs com sinal × o recorte padrão) custa **~5,5 s** de seq
   scan em `radar_empresas` (93 mil buffers lidos do disco), ANTES da regra `radar_contato_visitar` por linha —
   contra o `statement_timeout` de 8 s do `authenticated`. E rodava a cada troca de filtro, com o chip ligado ou não.
   Agora: chip desligado = nenhuma leitura e nenhum número; ligado = o número sai da própria fila (que já é o
   recorte), exato no fim, "N+" com página seguinte. Zero chamada extra.
3. **Mapa e ranking dizem que não aplicam o "Para visitar"** (`RadarMapa.tsx`, `RadarRankingCidades.tsx`). Alinhar
   exigiria o caminho VIVO da `radar_contagem_por_municipio` com a regra por lead — o mesmo custo de ~5,5 s+ do item 2,
   sem agregado que o cubra. Fica o aviso explícito; alinhar de verdade = dimensão "visitar" no agregado por município
   (plano medido antes; a carga do agregado é da `radar-k-carga`).
4. **Busca com pausa + cancelamento**: `RadarFiltros` confirma busca/município 400 ms depois da última tecla (Enter e
   sair do campo confirmam na hora; valor trocado por fora entra no campo). A `radar_lista` recebe o `signal` do
   react-query (`.abortSignal`): filtro trocado cancela a leitura em voo.
5. **Rótulos acessíveis**: busca (`searchbox`), município, UF e status com nome acessível.
6. **Peso morto no banco**: `radar_salvar_geocode` dropada (migration `20261111120100_radar_drop_salvar_geocode.sql`).
   Sem chamador desde #884; em prod nenhuma função/view/trigger/cron a cita e `geocode_status` é NULL nas 573 mil
   linhas. **`radar_rfb_descricao` NÃO é peso morto**: `radar_aplicar_situacao` a chama (prosrc em prod) — fica.
   `radar_placar_uso`/`radar_coorte_resultado`/`radar_conversao_por_faixa` não foram tocadas (decisão da
   `radar-m-medicao`).

## Provas

- vitest: `src/lib/radar/__tests__/invalidar-cache.test.ts` (cache real do react-query, observers ativos),
  `para-visitar-contagem.test.ts`, `src/components/radar/__tests__/RadarFiltros.digitacao.test.tsx`; os testes da
  lista e da página seguem verdes.
- Falsificação com controle verde na mesma invocação: ignorar o `cnpj` (4 vermelhos), perder a marca da página
  encolhida (1), offset por página (1), mandar por tecla (1), contar com o chip desligado (1).
- SQL executando (PG17): `db/test-roteirizador-prospects.sh` aplica a migration real do drop 2× (idempotente) e
  confere que `radar_prospects_para_rota` segue devolvendo o geo gravado; sabotar o `DROP` dispara a pós-condição.

## Lição

"Contagem ao lado do chip" parece barata e não é: o chip roda o recorte INTEIRO, a cada filtro, para mostrar um
número. Antes de pôr número num chip, medir o recorte em prod; se não há agregado, o número é sob demanda.
