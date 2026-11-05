# F9 (plano v6, lote 5): a home do tintométrico não espera mais a contagem de ~1 M fórmulas

2026-11-05. Só Publish: sem edge e sem migration.

## O defeito

`TintDashboard.tsx` fazia `count: 'exact'` sobre `tint_formulas` (1.002.356 linhas, conta
`oben`) dentro do mesmo `Promise.all`, e da mesma chave (`['tint-dashboard-metrics']`), que SKUs,
corantes e a última importação. O painel inteiro ficava no skeleton até essa contagem voltar.
Pelo `psql-ro` (index-only scan): 215 ms quente e 7.953 ms frio no plano; hoje,
`EXPLAIN ANALYZE` deu 1.194 ms quente com 1,04 M buffers lidos.

O Codex apontou um ajuste: um `staleTime` longo não resolve, porque não ajuda a 1ª visita e
congelaria a chave inteira.

## O conserto

- **Leitura própria:** `useContagemFormulas`, com a chave
  `['tint-dashboard-metrics', 'formulas-estimadas']`. É um PREFIXO de propósito, porque o
  `TintMapping` invalida `['tint-dashboard-metrics']` em 4 sítios depois de mapear. O card de
  fórmulas tem skeleton, travessão e aviso (`aviso-leitura-formulas`) próprios, e o resto do
  painel não espera por ele nem cai junto com ele.
- **Contagem `planned`:** o PostgREST devolve a estimativa do planner, que é um EXPLAIN com
  0,1 ms de planejamento medido. Comparada com a contagem real, a estimativa errou 0,07%
  (1.001.700 contra 1.002.356, via `reltuples`/EXPLAIN). A RLS da tabela é pseudo-constante
  (`has_role(auth.uid())` em subselect), então não distorce a estimativa.
- **Rótulo:** a tela mostra `~1,0 mi` com "importadas · número aproximado". O número do planner
  aparece só no `title`, como estimativa. Mostrá-lo cru se leria como contagem exata.

## Testes (`TintDashboard.leitura-falhou.test.tsx`, 29 casos)

Casos novos: (1) com a contagem PENDENTE para sempre, SKUs, corantes, a última importação e o card
de rejeitadas renderizam, e o card de fórmulas mostra o skeleton; (2) a leitura pede `planned`;
(3) aparecem o "~" e o rótulo "aproximado", e o número cru não; (4) o formato `~1,0 mi` acima de
1 M; (5) se só a contagem falhar, o card mostra o aviso próprio e o resto fica de pé; (6) a
invalidação pelo prefixo do `TintMapping` refaz a contagem. Os casos antigos, que comparavam com
`994.882` exato, passaram a usar `~995 mil`.

Falsificação com CONTROLE verde na mesma invocação, rodada com `LC_ALL=C` e com
`pt_BR.UTF-8`. As 4 sabotagens deram vermelho nos dois locales: A (a contagem volta a ser
aguardada pela chave das métricas, o serial do defeito), B (tira o "~" e o rótulo), C (volta ao
`exact`) e D (a chave sai do prefixo invalidado).

## A/B de laboratório

O método é o dos lotes 6/6b do v5 (o medidor está nas notas da sessão do lote 1 do v5,
`lcp-ab-lote6/`, adaptado). Comparei o build de produção da main `736448825` (antes) com o do
commit do conserto (depois), cada um com seu servidor estático e cada carga num contexto frio. A
sessão falsa (master) fica no localStorage, e o Supabase é interceptado com 400 ms fixos. A
contagem EXATA de `tint_formulas` ganha, além disso, o tempo de banco medido pelo `psql-ro`; a
`planned` não ganha nada. Usei o perfil desktop (10 Mbps, 40 ms), 10 pares alternados mais 1
aquecimento, e a rota `/tintometrico` renderizou em todas as cargas. A métrica é o instante em que
o painel sai do skeleton (o `h1` aparece), menos o início do auth.

| cenário de banco | antes p50 [IQR] | depois p50 [IQR] | Δ p50 |
|---|---|---|---|
| frio (+7.953 ms na exata) | 8.831 [8.807–9.103] | 853 [847–871] | **−7.978 ms** |
| quente (+215 ms na exata) | 1.068 [1.059–1.079] | 852 [850–854] | **−216 ms** |

- **O serial sumiu.** No frio, as faixas não se sobrepõem (antes: 8.794–11.163; depois:
  845–1.000). Depois do conserto, o painel e o card de fórmulas aparecem juntos, no tempo das
  outras leituras.
- **Limites:** o tempo de banco é INJETADO a partir da medição, então o lab mede o mecanismo (o
  painel parou de esperar a contagem), não o banco de prod. Só a persona master foi medida, no
  perfil desktop. O medidor ficou fora do repo, porque não é gate nem sensor. O build "depois"
  é anterior ao commit da chave-prefixo, que não muda o tempo.

## Fora do escopo (o vizinho)

`TintCatalogo.tsx:22` (KPIs do catálogo) tem o MESMO `count: 'exact'` sobre `tint_formulas`, no
mesmo `Promise.all`, e ainda faz `count ?? 0` (ausente ≠ zero, `money-path.md` §2). O conserto
é o mesmo (contagem própria e estimada, rotulada, com fail-closed), mas ali há o filtro
`desativada_em IS NULL`, cuja estimativa ainda precisa ser medida.
