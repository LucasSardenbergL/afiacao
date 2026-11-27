# Desligamento de funcionário — um fluxo que revoga tudo de uma vez

> 2026-11-27. Origem: lacuna achada na onda D 4b-1 (`clientes-onda-d-pii-carteira.md`): tirar o papel não
> tirava a flag de equipe, o `commercial_roles` nem a carteira; fazia-se à mão no banco. Um desligado com
> carteira mantinha acesso a PII (onda D condiciona PII a papel + carteira/cobertura) e às filas de
> venda/cobrança.

## O que existe agora

- **Tela:** `/governance/users` → botão **Desligar** na linha do funcionário (só master; some na própria linha;
  desabilitado na lente "Ver como"). Diálogo exige: quem recebe a carteira, motivo e o nome digitado.
- **Edge `desligar-funcionario`** (v1.0): gate canônico + `authorizeMaster`; chama a RPC com o **JWT do master**
  e depois bane no Auth (`ban_duration: 876000h`, reversível com `"none"`); grava o resultado do ban.
- **RPC `desligar_funcionario(p_user_id, p_novo_dono, p_motivo)`** (migration `20261127120000`), uma transação:
  papel employee/master · `is_employee`/`is_approved` · `commercial_roles` · `omie_vendedor_map` → novo dono ·
  `carteira_assignments` → novo dono · `company_config.carteira_hunter_user_id` (se era o hunter) ·
  `carteira_coverage` encerrada · `cobranca_caso` aberto e `tarefas` abertas → novo dono · `vendor_sip_credentials`
  removida. Audita em `funcionario_desligamentos` (RLS: só master lê; nenhum papel da aplicação escreve).
- **Prova:** `db/test-desligamento-funcionario.sh` — 39 asserts; `--falsificar` = 14 sabotagens × 2 locales
  (28/28 acusadas pelo assert certo, controle verde nos dois).

## Decisões (founder, 2026-11-27)

1. Carteira vai para um colega escolhido na tela (sem fila de órfãos).
2. Nada se apaga do histórico — `auth.users`/`profiles`/pedidos/contatos/ligações ficam atribuídos ao desligado.
3. Login bloqueado (ban no Auth), não só tirar acesso.
4. Só master desliga; nunca a si mesmo (logo nunca o último master — o guard explícito seria inalcançável).

## Lições

- **A carteira não é editável de forma durável pela tabela.** `carteira_assignments` é DERIVADA pelo
  `carteira-rebuild` de `omie_vendedor_map` + `carteira_hunter_user_id`. Trocar o dono só nas linhas seria
  desfeito no rebuild noturno (07:30 UTC) — o remapeamento do MAPA é a mudança de verdade.
- **Corrida com o rebuild (Codex P1):** checar `syncing` ANTES de travar deixava um claim entrar no meio. A RPC
  trava a linha `sync_state(carteira_rebuild, global)` e decide na MESMA leitura; sem a linha, recusa (um claim
  concorrente a criaria sem esperar). A prova L2 usa duas conexões: o claim concorrente espera o COMMIT.
- **Elegibilidade ≠ ter trabalho (Codex P1):** com o hunter NULL, a primeira versão desligava um cliente comum.
  Elegível = papel, flag ou `commercial_role` hoje, ou desligamento anterior (retry/resíduo).
- **Masters recíprocos (Codex P1):** lock global antes do gate; o 2º espera e cai no gate (prova L3).
- **Ação de UM registro não usa `useMutationComRegistro`** (docstring do hook): o estado vive na auditoria própria.

## Fora (derivados, se refazem no recálculo)

`venda_sugestao`, `meta_potencial_carteira`, `farmer_agenda`, `farmer_tactical_plans` — gerados a partir da
carteira. Histórico intocado: `farmer_calls`, `route_visits`, `cobranca_promessa`, `permission_change_log`.

## Deploy

Migration (envelope `db:aplicar`) → edge `desligar-funcionario` (Publish) → front (Publish). Sem a migration a
edge devolve `PGRST202` (`deploy.md`: migration PRIMEIRO).
