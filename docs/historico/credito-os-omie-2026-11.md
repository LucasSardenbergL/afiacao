# Sombra de crédito das OS criadas no Omie da Colacor SC (crédito-IA PR 7, opção C — 2026-11-26)

Programa: spec `docs/superpowers/specs/2026-11-20-credito-ia-design.md` §9/§10 · antecedente: `credito-os-afiacao-2026-11.md` (opção C cancelada e reaberta).

**Decisão do Lucas (2026-11-26):** implementar as fatias 1 e 2 mesmo com a opção C registrada como cancelada. Ele sabe que o ganho esperado é pequeno, porque a Colacor SC não fatura OS no Omie desde 2025-12-19 e o prazo nasce em título manual que a sombra do PR 5 já soma. O risco é a "reserva fantasma" de OS abandonadas. A medição separa a OS viva do resto.

## Fatia 1 — espelho das OS (PR A)

| Camada | O que nasce |
|---|---|
| Edge `omie-os-sync` | `servicos/os/ListarOS` da `colacor_sc`, 50 por página, até a página vazia. `probe` (action ausente) e `sync` só para cron/service_role; staff recebe 403 sem tocar o Omie (Codex P0). |
| Migration `20261126233000_omie_os_espelho.sql` | `omie_os_espelho` (PK `company, n_cod_os`), `omie_os_staging`, `omie_os_sync_runs`; RPCs `omie_os_sync_abrir/gravar/fechar` (SECURITY DEFINER, só service_role, lock por empresa); view `omie_os_abertas_v` (`security_invoker`); normalizador `omie_os_numero_normalizado`; cron `omie-os-sync-1h` às `:53`. |
| Medição | `db/medir-omie-os.sql`: saúde do sync, OS por situação, abertas por idade e por dias sem movimento, **prova do elo OS → título VENR** nos dois sentidos. |
| Front | nenhum, sem Publish |

### Como a integridade é decidida

A varredura (`varredura.ts`) só se declara íntegra se:
- terminou numa página vazia ou num fim-de-paginação **depois** do piso de `total_de_paginas` (fim no meio aborta);
- não houve página repetida nem `nCodOS` repetido entre páginas;
- `lidas = distintas = total_de_registros` declarado;
- nenhuma OS veio sem identidade.

O **banco** confere de novo no `fechar`: o staging precisa ter exatamente o total declarado. Só um run íntegro promove a geração do staging ao espelho (Codex desenho P1-2: o lote nunca lê uma mistura de duas varreduras) e conta ausência. O sumiço exige **2** varreduras íntegras. `ausente_desde` recebe a 1ª data de ausência, reaparecer zera a contagem e nada é apagado do espelho. O 2º `fechar` do mesmo run não faz nada.

**Ausente ≠ zero:** o parser nunca faz `Number(null)`/`Number('')`. Valor, cliente, prazo, flag e data ilegíveis viram `NULL`, e o banco aceita cada campo só com o tipo jsonb esperado. O prazo é o maior `nDias`, e só quando **toda** parcela traz `nDias`. A view considera aberta só a OS com `faturada IS FALSE AND cancelada IS FALSE`: flag NULL é indeterminada.

**Elo OS → título:** `fin_contas_receber` `id_origem='VENR'`, com `numero_pedido` e `c_num_os` normalizados (só dígitos, sem zeros à esquerda, vazio ou só zeros rejeitado) e o **mesmo** `omie_codigo_cliente`. A medição conta OS faturadas com título, VENR com 0, 1 ou mais OS candidatas, e o mesmo número com outro cliente. Caso conhecido: OS 461 ↔ `RPS 278`/NFS-e 302.

### Prova

- `db/test-omie-os-sync.sh` (PG17): **40 asserts**, verdes em `C` e em `pt_BR.UTF-8`.
- **13 sabotagens**, cada uma vermelha no assert declarado, com controle verde na mesma invocação.
- Testes Deno: parser e varredura, **19**.
- Duas sabotagens (sumiço com 1 varredura e 1ª data sobrescrita) já são barradas pelo `CHECK` da tabela, a 2ª camada. O vermelho exigido é o do passo que a constraint impede.

### Codex

- Desenho (fatias 1+2): gpt-6.2-astra · high · 80s · 34.421 tokens. Resultado: 0 P0, 7 P1 e 1 P2, todos acatados.
  - Na fatia 1: geração íntegra via staging, `nCodOS` repetido entre páginas aborta, e `fechar` só com run `rodando` sob o lock.
  - Na fatia 2: `ausente` mantém a reserva, OS que estreia faturada é conciliada, VENR com uma única OS candidata, residual próprio no teste da candidata, `indeterminada` reserva cheia, e N medido em 15/30/60/90.
