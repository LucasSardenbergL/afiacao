# Radar — 1ª carga com situação RFB: `finalize` caiu no timeout de 8s do PostgREST (lote 2026-09)

> 2026-10-21. Primeira carga real com a edge `radar-ingest` v1.2 (#3212). Recuperada à mão pelo envelope; a correção estrutural **não** está aqui (ver "Pendência").

## O que aconteceu

- Aviso do lote 2026-08 (alerta 548) dizia "nenhum cliente com situação cadastral verificada": esperado, o 2026-08 foi carregado pela v1.1. A RFB já tinha publicado 2026-09/2026-10, então o founder disparou `radar-carga-mensal` com `mes=2026-09` (run 39603744753) em vez de esperar o cron de segunda.
- Os chunks entraram (502.779 empresas, 565.696 linhas em `radar_situacao_cadastral`), mas o `finalize` caiu em **57014 `canceling statement due to statement timeout`** e o lote ficou `error`. Causa: a edge chama `radar_aplicar_situacao` por PostgREST como `service_role`, que não tem `statement_timeout` próprio e herda o **8s do `authenticator`**; o passo (a) da função atualiza ~553k linhas de `radar_empresas` (tabela de ~1 GB). Transação única → nada aplicado pela metade (0 descartes, 0 alertas, `rfb_situacao` vazio).
- A prova PG17 (`db/test-radar-situacao-cadastral.sh`) roda sem timeout e com seed pequeno — não tinha como ver isto.

## Recuperação (envelope `db:aplicar`, statement_timeout 300s)

| Arquivo | Tentativa | Resultado |
| --- | --- | --- |
| `db/2026-10-21-radar-finalize-2026-09.sql` (tudo de uma vez) | ensaio 1 perdeu a conexão (cliente zumbi, sem backend no banco); ensaio 2 ok em ~4 min; **#688 real estourou 300s** → rollback | nada gravado (2ª testemunha: `rfb_situacao` 0, lote `error`) |
| `db/2026-10-21-radar-fotos-2026-09-parte1.sql` (passo (a), CNPJ < mediana) | #690 | ✅ 274.535 fotos, ~70s |
| `db/2026-10-21-radar-fotos-2026-09-parte2.sql` (passo (a), ≥ mediana) | #692 | ✅ total 553.644 (= pré-voo) |
| `db/2026-10-21-radar-finalize-2026-09.sql` (re-rodado) | #694 | ✅ `fotos_atualizadas=0`, `leads_descartados=56952`, `clientes_verificados=15061`, `clientes_irregulares=2815`, alerta **554**, lote `complete` 502.779/10.792 |

**Bytes executados ≠ bytes do repo (só nas guardas):** o ledger `db_aplicacoes` guarda o sha256 do que rodou — finalize `8158798f…`, parte 1 `91c92ab8…`, parte 2 `ca5cef93…` (commit `9f8451145`). Depois, o gate `assert-verde-por-ausencia` reprovou as guardas `IF v <> 0` (NULL-blind: contagem ausente passaria como verde) e os arquivos do repo trocaram para `IS DISTINCT FROM`. Nas execuções reais toda contagem foi não-nula (a função `count(*)` nunca devolve NULL), então o resultado é o mesmo; re-aplicar a versão do repo é no-op pelas guardas de estado.

2ª testemunha (psql-ro, outra conexão): lote `complete`; 56.952 `descartado` = 56.952 linhas de `radar_contatos` do usuário de sistema `…ad0f`; foto 2026-09: 02=496.430 · 04=42.943 · 08=14.183 · 03=79 · 01=9; 2.815 linhas com `alertado_em`; alerta 554 `pendente_notificacao` (o `dispatch-notifications` envia). O aviso do lote 2026-09 (`radar_avisar_lote`) sai no cron das 06:45 UTC seguinte, depois do score das 06:30.

## Pendência — o próximo lote cai do mesmo jeito → **resolvida (2026-10-27)**

O passo (a) grava `rfb_situacao_lote` em **toda** empresa a cada lote (o lote muda mesmo quando a situação não muda) → ~550k UPDATEs por mês dentro do request da edge. Correção escolhida pelo founder (opção 1): a aplicação saiu do request.

- **Migration `20261027010000_radar_situacao_por_cron.sql`** (corpo de apply `db/2026-10-27-radar-situacao-por-cron.sql`): `radar_ingest_state.situacao_aplicada_fechamento/_em/_resultado` (1 escritor) + `radar_aplicar_situacao_pendente(p_agora)` + cron `radar-aplicar-situacao-diario` `5 6 * * *` com `SET statement_timeout = '30min'` (≈ 6× o medido; roda como `postgres`, sem o 8s do PostgREST). Pendente ⇔ `complete` e `situacao_aplicada_fechamento ≠ finalizado_em` — chave por IGUALDADE do valor que a edge grava, nunca comparação de relógios Deno × banco.
- **Edge `radar-ingest` v1.3-situacao-por-cron**: o `finalize` recruza, conta e fecha (`complete`), devolve `situacao_aplicacao: "cron"`; não chama mais `radar_aplicar_situacao`.
- **`radar_avisar_lote`** espera a aplicação: o e-mail não sai antes dos descartes/alerta. Se a aplicação não vier em 30 h do fechamento (job falhando OU desativado; ≥ 1 retentativa), o aviso sai assim mesmo, severidade `atencao`, dizendo que a situação NÃO foi aplicada — a pendência nunca fica muda (sem sensor novo, sem tocar o trio da Sentinela).
- Consequência aceita: descarte de lead baixado e alerta de cliente irregular saem na manhã **seguinte** ao finalize (06:05 UTC; a carga de segunda fecha ~08:00–14:00 UTC). Locks de linha em `radar_empresas` por ~5 min, de madrugada de propósito.
- **Codex (challenge, 2026-10-27) — incorporado:** (P1) com 2 lotes pendentes, aplicar o mais velho primeiro descartaria lead que o mais novo diz ativo (a guarda `vigente` compara com a foto já aplicada) → só o lote **mais novo** é aplicado; o pendente mais velho é marcado `superado_por`. (P1) job falhando todo dia deixaria o aviso preso e a saúde verde → o aviso de 30 h acima. (P2) relógios distintos → a chave por igualdade. **Medido e não trocado:** "recruzar no finalize passa de 8s" — o tick leva 12,6s, mas são 2 `count(*)` (~4,8s cada) + o recruzar (~3,3s de leitura); as 2 contagens do finalize medem 1,4s e 2,2s. Cabem, com margem ~2× — risco conhecido, não bloqueio; se um dia estourar, o lote vira `error` ALTO (não silencioso) e o finalize re-roda.
- Prova PG17 `db/test-radar-situacao-por-cron.sh` (nucleo-ci, 31 asserts, `--falsificar` 14/14, `LC_ALL=C` e `pt_BR.UTF-8` — o 1º `pt_BR` pegou um `sed` casando o prefixo `NOTICE:` que vira `AVISO:`).

O caminho de recuperação manual acima (2 metades da foto + finalize) continua válido se o job falhar: hoje basta re-rodar `SELECT public.radar_aplicar_situacao_pendente();` como `postgres` com `statement_timeout` folgado.

### No ar (2026-10-27)

- Migration aplicada pelo `db:aplicar` (recibo #714, ensaio antes); 2ª testemunha `psql-ro`: cron 241 `5 6 * * *` ativo `postgres` com o comando exato, md5 vivo = repo (`a99fd7db…` job, `0c52be46…` aviso), ACL do job só owner, 2026-05/08/09 marcados pelo bootstrap. (Esperou ~45 min a trava do `db:aplicar`, presa por um backend zumbi de outra sessão — não foi contornada.)
- Edge `radar-ingest` v1.3 deployada pelo pacote `64466fb3e7d1` (só esta edge: as 3 financeiras pendentes na mesma hora são de outras entregas e uma delas tinha pré-condição não medida). Agente: 7/7 hashes de `7c25454cc`, 401 com credencial falsa. Sonda (`db/2026-10-27-sonda-disparo-radar-ingest-v1.3.sql`, recibo #720): **DEPLOY CONFIRMADO**, `v1.3-situacao-por-cron`, fonte `cac28750…`; `pendencias:deploy` → `radar-ingest CONFERE`.
- Sensor de edição: `EDICAO_DETECTADA` só porque a resposta trouxe `edit_id`/`commit_sha` — o commit (`0b836c1f5`, e o `02b4d7d57`) é a regeneração de `src/integrations/supabase/types.ts` com as 3 colunas novas de `radar_ingest_state`, arquivo GERADO da lista tolerada (0 commits fora dela). Não revertido: reverter deixaria o tipo atrás do banco.

### Lote 2026-10 (segunda 26/10) — caiu ANTES da edge, por outro motivo

A Action `radar-carga-mensal` (run 40321590205, agendada 06:00, iniciou 12:18 UTC) falhou no `unzip` de `Estabelecimentos4.zip`: download truncado (1 min contra ~9 min dos anteriores; "End-of-central-directory signature not found"). O lote 2026-10 nem foi aberto na edge (`status` só lista 2026-05/08/09) — o 57014 não chegou a acontecer. Re-disparar a carga só depois do deploy da edge v1.3.

## Lições

- **Prova sem o limite de produção não prova o caminho de produção.** O PG17 local não tem o 8s do `authenticator`; função set-based chamada por `.rpc()` precisa ser medida com o volume real ou sair do request.
- **`service_role` sem `rolconfig` não é "sem timeout"**: herda o do `authenticator` (8s). Conferir `pg_roles.rolconfig` dos dois antes de pôr trabalho pesado atrás de `.rpc()`.
- **Ensaio que passa "no limite" não garante o apply**: o ensaio levou ~4 min de 5, o apply real passou de 5. Margem de tempo é parte do pré-voo — se o ensaio usa mais de metade do teto, fatie antes.
