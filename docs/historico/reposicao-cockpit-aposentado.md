# Cockpit de Reposição "Ciclo diário" aposentado (2026-10-13)

**Decisão do founder**, com medição de uso real (90d até 2026-10-13):

| Tela | Visitas (PostHog, amostra censurada) | Ações consumadas |
|---|---|---|
| `/admin/reposicao/pedidos` (Gerir pedidos) | 135 | **121 aprovações** (todas daqui) · 21 sync+recalc |
| `/admin/reposicao/sessao` (cockpit) | 19 | 3 "Gerar agora" (2 = founder testando) · 1 PDF (jul) · CSV **nunca** |
| `/sessao/pedidos` (etapa 3) | 19 | **0** aprovações (última ação em 06/06) |
| `/sessao/confirmacao` (etapa 4) · `/sessao/historico` | 0 | só leitura |

Fontes: PostHog HogQL, `cockpit_audit_log`, `pedido_compra_sugerido.aprovado_em/por` (psql-ro).

**O que saiu:** página do cockpit (hero, ContinuarBanner, MetricsStrip, EtapasGrid, CSV/PDF,
AuditLogSection), etapas 3 e 4, histórico da sessão, stepper/`ReposicaoSessionLayout`,
`CicloHojePanel` + `cicloHoje/` (aprovação em lote e "Aprovar elegíveis" — sem uso desde 06/06),
`useReposicaoStatus`/`getStepLocks`/`useItensDoDia`. Stepper e locks **não gateavam nada** no banco
nem no disparo (a edge `disparar-pedidos-aprovados` gateia só por `status`).

**Bugs que morreram junto:** CSV do ciclo com cabeçalho mentiroso ("SKU" = grupo, "Descrição" e
"Fornecedor" = fornecedor, "Qtd" = nº de SKUs) e "Economia potencial R$ 0,00" que era `const economia = 0`
(fabricação — ausente ≠ zero).

**O que migrou para Gerir pedidos:** `DataHealthBanner` (reposicao_sugestoes, estoque_inventario),
`ForaDoMotorBadge`, `BaixoGiroBadge`. "Gerar agora" **não** migrou: o "Sincronizar e recalcular" já
era superset (sync Omie + `gerar_pedidos_sugeridos_ciclo`).

**Navegação:** sidebar "Cockpit" → "Pedidos de compra" (`/admin/reposicao/pedidos`, ganhou o badge
de pendentes que já existia órfão); URLs antigas (`/sessao`, `/sessao/pedidos|confirmacao|historico`,
`/cockpit`) redirecionam para lá. Mercado e Parâmetros seguem nos mesmos paths, sem o stepper.

`cockpit_audit_log` (tabela) fica no banco sem escritor — remoção de schema não foi feita (fora do escopo).
