# Clientes — onda E: desempenho e escala (2026-11-24)

Tela `/admin/customers`. A carteira da vendedora tem ~2.832 clientes, a do master sob a lente ~12.701,
e a base ~16k. Programa de ondas A–E; esta é a camada de DADOS (fatia 1). A virtualização da lista é a
fatia 2: espera o link da linha da onda C chegar na main.

## Como foi medido

Produção pede login, e a sessão não digita senha. Por isso a medida é um **harness determinístico**
(fora do commit): a página real (`AdminCustomers` → scope → lista) com o Supabase simulado. Cada request
leva **150 ms**, perto da RTT medida até o PostgREST (≈110 ms quente, mais o tempo do servidor). O
harness conta requests por tabela, o pico de requests em voo, o tempo até a 1ª linha e até tudo
assentar, e as `<tr>`/nós no DOM. O tempo inclui o render no jsdom; vale para comparar, não como
número absoluto do browser.

Bundle: `vite build` + fecho do grafo de imports estáticos de cada rota, descontado o boot (eager).

## Antes (main 3892c222e)

| cenário | 1ª linha | assentado | requests | pico em voo | `<tr>` | nós DOM |
|---|---|---|---|---|---|---|
| carteira 2.832 — abrir | 4,27 s | 8,12 s | 76 | 32 | 2.832 | 59.524 |
| base completa — abrir | 0,32 s | 0,51 s | 8 | 4 | 100 | 2.154 |

- Carteira, abrir: `carteira_assignments` 3 · `profiles` 19 (em série) · `farmer_client_scores` 19 (em série) · `get_scores_margem` 3 (só DEPOIS do último score) · `venda_contato` 15 + `route_contact_log` 15 (os 30 de uma vez) · `tool_categories` 1.
- Carteira, digitar 5 termos que estreitam (pausa de 450 ms): 3 + 3 releituras do último contato (cada recorte novo = key nova).
- Base completa, 3 × "carregar mais": 7 leituras de score (900 ids **relidos**) + 3 da margem + 5 + 5 do último contato.
- RPC de margem falhando: a lista inteira perdia scores, prioridade e filtro de saúde ("Tentar novamente").
- Bundle: boot 984 KB (gzip 292 KB). `/admin/customers` = chunk 75 KB (gzip 21) + 229 KB além do boot (gzip 73). 360 = chunk 38 KB (gzip 11) + 309 KB além do boot (gzip 104).

## Depois — fatia 1 (camada de dados)

| cenário | 1ª linha | assentado | requests | pico em voo | `<tr>` | nós DOM |
|---|---|---|---|---|---|---|
| carteira 2.832 — abrir | **2,46 s** (−42%) | **3,69 s** (−55%) | 75 | **14** | 2.832 | 59.524 |
| base completa — abrir | 0,20 s | 0,23 s | 7 | 5 | 100 | 2.154 |

- Carteira, digitar os mesmos 5 termos: **0** releituras (antes 6). Busca e filtro de saúde não trocam mais a key do último contato: ela é o lote estável do escopo.
- Base completa, 3 × "carregar mais": 3 leituras de score (300 ids, **nenhum relido**; antes 7 leituras e 900 ids) e 3 + 3 do último contato (antes 5 + 5).
- RPC de margem falhando: scores, prioridade e filtro seguem; só a margem diz "indisponível" (`margem_indisponivel`).
- `tool_categories` saiu da abertura da lista: só é lido quando uma ficha abre (o único consumidor é o AddToolDialog da 360).
- A contagem de requests na abertura da carteira quase não cai (76 → 75). O ganho é de CAMINHO CRÍTICO: os 19 + 19 lotes passam de série a 4 em voo, e a margem corre junto com os scores em vez de depois deles. Cortar o NÚMERO de requests é trabalho da RPC agregada (abaixo).

### O que mudou (código)

1. `fetchScoresPorCustomer`: `lerMargensIsolada` captura a falha da RPC e marca cada score com `margem_indisponivel`. Os scores continuam lançando. Teste com a marca do ramo: `scores-margem-isolada.test.ts`.
2. Lotes de 150 com 4 em voo: `coletarEmLotesConcorrente`, que a onda A já tinha criado, foi movido para a plataforma (`src/lib/lotes.ts`), porque o último contato (admin-crm) também o usa e a fronteira barrava. Mantém a ordem dos lotes e propaga o erro.
3. `useClientesScope.lotesIds`: lotes estáveis e só-acrescenta (página do servidor na base; carteira A–Z em um lote). Os scores fazem uma query por lote: `useClientesScope.cache-paginas.test.tsx`.
4. `useUltimoContato(lotesIds)`: uma query por lote, key = `hashIds` do lote, e `estadoDe(id)` por linha (a página que carrega não apaga as lidas).

Falsificação (controle verde na mesma invocação, uma camada por vez): margem relançando, remontagem por ordem de chegada, key de todas as páginas, último contato pela lista filtrada. Todas ficaram vermelhas.

## RPC agregada (score + último contato): o desenho, sem implementar nesta onda

Medido em prod via psql-ro (`EXPLAIN ANALYZE`, sem RLS): o join carteira → profiles → scores → lateral(max de `venda_contato` e de `route_contact_log`, 180 d) leva **0,52 s para 2.832** clientes e **0,41 s para 12.701** (cache quente). No cliente, a mesma leitura são ~75 requests (~17 rodadas de 4 em voo).

**Se paga**, sobretudo na lente do master (12.701 = 85 lotes × 3 fontes). Desenho:

- `listar_carteira_clientes(p_owner_ids uuid[] default null)`, **SECURITY INVOKER** (a RLS de `carteira_assignments`, `profiles`, `farmer_client_scores`, `venda_contato` e `route_contact_log` continua valendo: `venda_contato` só abre para o dono ou master, e o último contato da vendedora segue só dos próprios registros).
- Devolve perfil + colunas de score + `ultimo_contato_em/desfecho/fonte`. **Sem margem**: ela segue pela `get_scores_margem` (gate `cap_custo_ler`), em paralelo.
- Paginação por **keyset** (`user_id > p_depois ORDER BY user_id LIMIT 1000`), não OFFSET: cada página custa só a sua fatia. 2.832 = 3 requests; 12.701 = 13.
- Ordem A–Z/prioridade continua no cliente (a carteira é lida inteira); a base completa segue na `listar_clientes_base`.
- `REVOKE` de `PUBLIC` **e** `anon`; prova em PG17 (`db/test-*.sh`) com falsificação; deploy = migration manual.
