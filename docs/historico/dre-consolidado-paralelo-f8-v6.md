# DRE consolidado em paralelo (plano v6, F8 — DRE-IO)

> 2026-11-04. `src/hooks/useFinanceiro.ts` (`loadDRE`, `view === 'all'`) · prova
> `src/hooks/__tests__/useFinanceiro.dre-consolidado-paralelo.test.tsx`. Molde: VAL-IO do v5
> ([fin-valor-cockpit-mapas-apoio-paralelos.md](fin-valor-cockpit-mapas-apoio-paralelos.md)) e o
> `getLastSyncTime` do [lote 11](hot-contas-pagar-lote11.md). Condição do F8 (uso real do consolidado)
> confirmada pelo founder no chat da sessão do plano v6 (disse que usa o consolidado e mandou seguir).

**Defeito.** O consolidado fazia três `await getDRE(...)` em série (oben → colacor → colacor_sc). As leituras
são independentes (`fin_dre_snapshots` filtrado por empresa, ano e regime), então a espera era `t1+t2+t3`.

**Conserto.** `Promise.all` sobre a constante `EMPRESAS_DRE_CONSOLIDADO`. Preserva as três coisas que o Codex
contestou:

- **ordem fixa** — `Promise.all` devolve na ordem do array, não na de chegada, e o `.flat()` concatena nela;
- **falha integral** — uma rejeição rejeita o todo e cai no `catch` de sempre (`setDre([])` + `marcarFalha('dre')`).
  `allSettled` com filtro seria o DRE parcial apresentado como o grupo;
- **geração** — o `if (g !== geracoes.current.dre) return` continua depois do `await`.

**Prova (falsificada).** Quatro testes, cada um com a sua sabotagem, rodados na MESMA invocação com controle verde:
o laço serial reverte só "as 3 começam antes de qualquer uma resolver"; `allSettled` reverte só a falha integral;
empurrar na ordem de chegada reverte só a ordem; tirar a guarda de geração reverte só a geração.

**Ganho (estimativa, não medido no cliente).** Na prod (psql-ro, 2026-11-04) cada leitura executa em ~0,17 ms
no servidor (11 linhas por empresa e regime, bitmap index scan na chave única). A espera é quase toda ida-e-volta
(rede + PostgREST + RLS), então o consolidado passa de ~3 RTT para ~1 RTT — da ordem de 2 RTT a menos por carga.

Deploy: só **Publish** (front-end puro; sem migration nem edge).
