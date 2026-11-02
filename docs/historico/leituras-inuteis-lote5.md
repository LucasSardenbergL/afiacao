# Plano v4, lote 5 — leituras que a tela não usa e zero fabricado na home (2026-11-01)

Itens N1, C2 (fatia 1) e N3 de `docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md`.

## N1 — Governança montava o motor de scoring só para ler a config

`FarmerGovernance.tsx` fazia `const { config } = useFarmerScoring()`. O hook monta o motor inteiro:
baixa todo o histórico de `sales_orders` (~32k linhas em ~33 páginas sequenciais), `farmer_calls`,
`profiles`, `omie_products`… e calcula a carteira — que a Governança não mostra.

- Novo `useFarmerAlgorithmConfig` (`src/hooks/useFarmerAlgorithmConfig.ts`, react-query) lê só
  `farmer_algorithm_config`. Merge com `DEFAULT_CONFIG` igual ao do motor (chave ausente = default
  que o cálculo aplica), então "valor atual" continua sendo o que o motor usa.
- Única mudança em `useFarmerScoring.ts`: `DEFAULT_CONFIG` passou a ser exportado (1 palavra) — para
  não duplicar os defaults. O lote 16 mexe no hook depois; nada além disso foi tocado.
- **Achado no caminho (consertado aqui):** a leitura de config ignorava o `error` e caía calada no
  default — e a proposta grava `current_params` a partir desses valores, ou seja, gravaria o default
  como se fosse o vigente. Agora: config `null` + `AvisoLeituraFalhou` e o botão de nova proposta
  trava. Após aprovar, a query de config é invalidada (antes o valor ficava preso ao mount).
- O motor (`useFarmerScoring`) segue com o MESMO padrão de config silenciosa → é do lote 16.

## C2 fatia 1 — home staff esperava um profile que não usa

`Index.tsx` segurava o skeleton de TODO mundo no `isLoading` de `useBasicProfile`, que só alimenta o
`CustomerDashboard`. Agora o profile só é pedido/esperado para cliente (`!isStaff ? user?.id :
undefined`, mesmo padrão dos pedidos pendentes — em paralelo ao papel, o cliente não ganha viagem a
mais). `useMyCommercialRole` mantido de propósito: é lente-aware (`useMyCommercialRole.ts:60`).
Paralelizar as zonas (`Promise.all`) é o lote 10.

Limitação aceita: enquanto `roleLoading`, `isStaff` é false e o staff ainda dispara o fetch do
profile (como já dispara o dos pedidos) — mas não ESPERA mais por ele.

## N3 — zona Sistema fabricava zero

`useSistemaZone` fazia `count ?? 0` e ignorava o `error` DEVOLVIDO pelo supabase-js (o `try/catch` só
pega o que LANÇA). Com falha, o KPI dizia "0 aprovações"/"0 staff" e a lista vazia dizia "Tudo em
dia.". Agora cada bloco lança com mensagem própria (`erro` vs `contagem ausente … malformada`), o
`catch` deixa o KPI em `null` ("—") e guarda o porquê (`erroAprovacoes`/`erroStaff`); a
`SistemaZone` troca "Tudo em dia." por `AvisoLeituraFalhou` quando as aprovações não foram lidas.
Degradação continua parcial (um bloco não derruba o outro).

## Prova

`useSistemaZone.falha.test.tsx` (9), `FarmerGovernance.so-config.test.tsx` (3),
`Index.home-staff-sem-profile.test.tsx` (3). Falsificação com controle verde na mesma invocação,
uma camada por vez — ver corpo do PR.
