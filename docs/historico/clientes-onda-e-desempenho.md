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

## Depois

(preenchido no PR)
