# F11: os polls do shell não competem com o LCP (plano v6)

**2026-11-05.** Item F11 do plano v6 (`docs/superpowers/plans/2026-11-04-plano-melhoria-v6/README.md`, §2 F). A hipótese era que os polls secundários do shell competiam com o LCP e deviam ser adiados. O Codex pediu medir antes as requisições realmente disparadas. **Veredito: adiar não ganha nada mensurável → F11 DESCARTADO.** O laboratório achou um vazamento à parte (o cliente polava `fin_period_overrides`), e este PR o consertou.

## Método (o mesmo do lote 6, `boot-chunk-paralelo-auth-lote6.md`)

- Build de produção da main `a73c7b968`, servido estático.
- Sessão falsa no localStorage. O Supabase é interceptado com 400 ms fixos por requisição: `user_roles` devolve a persona, `profiles` aprovado, `[]` no resto e `null` nas RPCs.
- Tráfego externo bloqueado (PostHog, Google Fonts), contexto frio a cada carga.
- Cada requisição não-OPTIONS é registrada com o instante em ms desde `performance.timeOrigin`. O LCP vem do `PerformanceObserver`.
- **Ablação**, que dá o teto do ganho: uma 2ª build com `enableStaffPolls = false` no `AppShell` e o `DataHealthBadge` desligado, ou seja, **sem nenhum** poll de badge, o que é mais forte que adiar. São 15 pares alternados por perfil, mais 1 aquecimento descartado, com p por Mann-Whitney.
- O script ficou no scratchpad (não é gate nem sensor). O método está aqui para ser reproduzido.

## O que foi medido

### Requisições no boot de `/` (persona master, desktop)

- **47 requisições antes do LCP** (2,33 s): 10 são badges do shell mais o `get_data_health`. O resto se divide entre o gate de auth (`user_roles`, `profiles`, `commercial_roles`, `authz_contract_version`), a telemetria e ~22 do `StaffDashboard`.
- Em 130 s ociosos foram **104** no total. Em regime, por minuto: ~10 do shell (os de 60 s, `pedido_compra_sugerido` a 30 s, `get_data_health` a 120 s), ~17 do dashboard e 2 do `fin_period_overrides`.
- A contagem de ~13 polls do plano superestimava: telefonia, tarefas e WhatsApp não disparam (congelados), e `tint_sync_runs` só dispara uma vez.
- Employee: mesmo padrão, 98 em 130 s e 44 antes do LCP (sem `get_data_health`, sem o badge de melhorias e sem `list_impersonation_targets`).

### Mobile (Slow 4G + CPU 4×): a linha do tempo explica o resultado

- Os badges do shell saem em **7,0 s**, logo depois do auth.
- As queries do dashboard só saem em **9,1 s**, porque esperam o chunk lazy do `StaffDashboard` (carga fria, sem a dica do lote 6b).
- O LCP (`<p>`) pinta em **9,14 s**, junto com o dashboard.
- Os polls chegam ~2 s antes, durante o download do chunk, e são respostas de cabeçalho (`HEAD` com `count`) de poucas centenas de bytes. Não há o que adiar no caminho do LCP.

### A/B da ablação (LCP em ms, p50 [IQR])

| perfil | com polls | sem nenhum poll do shell | Δ pareado p50 | p |
|---|---|---|---|---|
| mobile (Slow 4G + CPU 4×) | 9.508 [9.160–10.136] | 9.592 [9.304–10.048] | **−20** [−192 a +348] | 0,68 |
| desktop (10 Mbps, 40 ms) | 2.348 [2.344–2.388] | 2.344 [2.344–2.356] | **+4** [−4 a +44] | 0,33 |

Remover **todos** os badges (−10 requisições no boot) não move o LCP em nenhum perfil. Adiar, que é mais fraco que remover, também não moveria.

## Achado consertado neste PR: o cliente polava `fin_period_overrides` a cada 30 s

- Na persona customer, a **única** requisição recorrente em idle era `rest:fin_period_overrides`, a cada 30 s (em 2,2, 32,6 e 63,1 s).
- A origem é o `ActiveOverrideBadge` do topbar, que fica **fora** do gate `enableStaffPolls`.
- A RLS (`fin_period_overrides_select_staff`, conferida via `psql-ro`) só deixa employee e master lerem, então todo cliente polava 120 vezes por hora para receber vazio. É o mesmo vazamento que o comentário do `enableStaffPolls` já tinha fechado para os outros badges.
- **Conserto:** `usePeriodOverride(company, { habilitado })`. O topbar passa `isStaff` real (`useAuth`, a mesma identidade dos outros polls do shell). O `PeriodOverrideModal` continua no default `true`.
- **Teste:** `usePeriodOverride.test.tsx`, "gate desligado não consulta". Falsificado: tirar o `&& habilitado` deixa o teste vermelho, e os 2 controles ficam verdes na mesma invocação.
- **Lab depois do conserto** (build deste PR, 70 s ociosos): o customer fez **0** requisições de `fin_period_overrides`, 21 no total contra 24 antes. O master continua polando a 30 s (em 1,7, 32,1 e 62,6 s): o badge de staff segue vivo.

## O que NÃO é F11 e fica anotado

- **`get_data_health` roda o `_data_health_compute()` inteiro por chamada** (~0,23 s de SQL, medido no D6), a cada 120 s por aba de master aberta, ou seja, ~7 s de banco por hora por aba. Com 1 usuário é desprezível. Ler um snapshot do watchdog seria otimização sem sinal: fica sem item.
- **O shell e o `useReposicaoZone` do dashboard contam as mesmas tabelas** (`pedido_compra_sugerido`, `eventos_outlier`, `fornecedor_aumento_anunciado`) com filtros diferentes: o shell conta o ciclo do dia com 2 status, o dashboard conta só `pendente_aprovacao`, em qualquer dia. **Não** é dedup trivial como o do lote 4 do v5, porque a semântica difere. Também fica sem item enquanto não houver sinal.

## Limites

- Os 400 ms são fixos e as respostas interceptadas não consomem banda emulada. Num Slow 4G real, ~10 respostas `HEAD` custam alguns KB, contra os ~95 KB do chunk do dashboard.
- Mede o mecanismo, não o usuário real (o campo tem 1 usuário, ver §1 do plano).
