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

2ª testemunha (psql-ro, outra conexão): lote `complete`; 56.952 `descartado` = 56.952 linhas de `radar_contatos` do usuário de sistema `…ad0f`; foto 2026-09: 02=496.430 · 04=42.943 · 08=14.183 · 03=79 · 01=9; 2.815 linhas com `alertado_em`; alerta 554 `pendente_notificacao` (o `dispatch-notifications` envia). O aviso do lote 2026-09 (`radar_avisar_lote`) sai no cron das 06:45 UTC seguinte, depois do score das 06:30.

## Pendência — o próximo lote cai do mesmo jeito

O passo (a) grava `rfb_situacao_lote` em **toda** empresa a cada lote (o lote muda mesmo quando a situação não muda) → ~550k UPDATEs por mês dentro do request da edge. O lote 2026-10 (cron de segunda 26/10 06:00 UTC) vai repetir o 57014. Correção a decidir (não feita aqui): tirar `radar_aplicar_situacao` do request da edge (finalize só enfileira; um job pg_cron, que roda como `postgres` com `statement_timeout` explícito, aplica) e/ou aplicar em fatias por faixa de CNPJ. Até lá, o caminho de recuperação é este: as 2 metades da foto + o finalize, trocando o lote nos arquivos.

## Lições

- **Prova sem o limite de produção não prova o caminho de produção.** O PG17 local não tem o 8s do `authenticator`; função set-based chamada por `.rpc()` precisa ser medida com o volume real ou sair do request.
- **`service_role` sem `rolconfig` não é "sem timeout"**: herda o do `authenticator` (8s). Conferir `pg_roles.rolconfig` dos dois antes de pôr trabalho pesado atrás de `.rpc()`.
- **Ensaio que passa "no limite" não garante o apply**: o ensaio levou ~4 min de 5, o apply real passou de 5. Margem de tempo é parte do pré-voo — se o ensaio usa mais de metade do teto, fatie antes.
