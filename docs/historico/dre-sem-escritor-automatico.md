# DRE sem escritor automático — Oben parada em março/2026 (2026-10-18)

## Sintoma

Leitura pós-deploy do `fin-cashflow-engine` v1.5 (#3146, [ciclo-financeiro-cliente.md](ciclo-financeiro-cliente.md)):
PME da Oben `null` com o motivo "CMV do DRE cobre 6/12 meses fechados (último: 2026-03)". Em
`fin_dre_snapshots`, a Oben tinha competência só até 2026-03 e caixa só 2026-04; a Colacor SC também
parava em 2026-03; a Colacor tinha os 12 meses.

## Causa raiz (medida por psql-ro)

`fin_dre_snapshots` tem um único escritor — a edge `omie-financeiro`, `action` `calcular_dre` /
`calcular_dre_year` — e **nenhum cron o chamava**. O agendamento mensal (`fin-dre-mensal`) foi escrito
só como COMENTÁRIO em `20260328200400_fix_cron_sync.sql` e nunca foi para `cron.job`. O DRE se
recalculava apenas por clique (botão em /financeiro e no fechamento) ou por sessão de agente.

`fin_sync_log` (todas as linhas `calcular_dre*`): o último cálculo da Oben foi 2026-05-30 (caixa de
abril, 1 mês); o último de competência, 2026-03-29 (`calcular_dre_year` das 3 empresas). A Colacor
"estava em dia" só porque sessões a recalcularam à mão em 13–14/10 (fora_dre fase 2). A fonte não era o
problema: `fin_contas_pagar`/`receber` da Oben tinham `updated_at` do próprio dia.

## Conserto

- `supabase/migrations/20261019090100_fin_dre_recalculo_diario_cron.sql` — job
  `fin-dre-recalculo-diario`, 15:30 UTC (12:30 SP, após o 2º ciclo de sync): competência dos 12 meses
  fechados + corrente (1 chamada por empresa/ano, ~0,2 s/mês — fecha sozinho um buraco de semanas),
  caixa do anterior + corrente (1 chamada por empresa/mês, ~30 s/mês). Regimes em chamadas separadas.
  Pula (empresa, mês) com qualquer versão de `fin_fechamentos` em status ≠ `aberto`: o fechamento
  guarda só a FK do snapshot, e o upsert reescreveria os números que ele referencia.
- `db/recalculo-fin-dre-oben-colacor-sc-2026-04-a-10.sql` — recompute único de abr–out/2026
  (competência Oben + Colacor SC; caixa Oben), com os ids do pg_net capturados para conferência.

Codex (challenge, high) — aceitos: separar regimes, janela de competência larga, guarda em qualquer
versão do fechamento, ids na postcondição, não prometer `resultado_provisorio` no mês corrente.
Refutados com medida: "o recálculo mascara o cartão `omie_sync_financeiro`" — o cartão já é "última
linha de qualquer action" e recebe ~60 linhas/dia (sync_pedidos, nfes…); 6 linhas/dia a mais não mudam
nada. Registrados como resíduo:
- **truncamento latente**: as consultas mensais de CP/CR do `calcularDRE` não paginam (teto de 1.000 do
  PostgREST). Pior mês medido: 534 títulos (CR Oben) — não ativo, margem ~2×;
- **corrida** enqueue × escrita na guarda de fechamento (segundos; 0 fechamentos em prod hoje).

## Lição

Snapshot derivado sem escritor agendado apodrece em silêncio: o consumidor (PME) degradou honestamente
para `null`, que é o certo — mas ninguém via que a FONTE do snapshot era só um botão. Ao criar tabela
derivada, a pergunta é "quem a escreve sem humano?", e o `cron.job` responde, não o comentário na
migration.

## Aplicado e validado (2026-10-19, psql-ro)

- Migration: `db:aplicar` tentativa #547 → job `fin-dre-recalculo-diario` (jobid 215, `30 15 * * *`, ativo).
- Recompute: tentativa #548 → ids pg_net 122589–122597, **9/9 HTTP 200**, 9/9 `complete` em
  `fin_sync_log` (a mais lenta 36,8 s — caixa de um mês da Oben).
- `fin_dre_snapshots` competência, meses fechados out/2025–set/2026: **Oben 12/12, Colacor SC 12/12**.
  Oben caixa abr–out/2026 recalculado (7/7). CMV competência da Oben abr–set: R$ 160k–225k/mês.
