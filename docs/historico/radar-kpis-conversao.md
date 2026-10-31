# Radar: o card "Viraram cliente (mês)" conta conversões (2026-10-31)

> Follow-up de [radar-contato-integridade.md](radar-contato-integridade.md). Migration
> `20261031142000_radar_kpis_conversao.sql`. Prova: `db/test-radar-kpis-conversao.sh` (núcleo do CI, 19 asserts,
> 10 sabotagens).

## Problema

`radar_kpis.virou_cliente_mes` contava `prospeccao_status = 'virou_cliente'` pelo carimbo `prospeccao_atualizado_em`,
e tinha dois defeitos:

1. **O carimbo se move.** O gestor pode tirar um cliente confirmado de `virou_cliente` (RD007 deixa). Se ele o devolve
   num mês novo, a mesma conversão conta outra vez.
2. **Vincular não é converter.** O vendedor que liga e descobre que o lead **já era** cliente no Omie só vincula o
   cadastro existente (`origem = 'lookup'` no ledger `omie_cliente_confirmacoes`), e isso também entrava no card.

Em prod hoje (psql-ro, 2026-10-31) há 0 empresas em `virou_cliente`, 0 `omie_cadastrado_em` e 0 linhas no ledger, então
nenhum número publicado muda.

## Decisão do founder

O card conta o lead que satisfaz as três condições:

- **ainda está em `virou_cliente`.** O lead que o gestor tirou sai do card.
- **foi cadastrado no mês de SP pela data `omie_cadastrado_em`.** Essa data não se move: só
  `radar_registrar_cadastro_omie` a grava, uma vez, com o vínculo vazio, e nenhuma função a limpa.
- **foi criado pelo Radar no Omie.** Isso quer dizer uma linha `origem = 'incluir'` no ledger com o mesmo CNPJ e o
  mesmo código. É a mesma regra do `v_criado_por_nos` do cadastro, então ledger com `lookup` + `incluir` do mesmo
  código conta.

O resto do retorno (`lote`, `novos`, `a_contatar`, `em_conversa`) não muda, e o gate `private.cap_radar_prospectar`
continua igual. No front, o card ganhou a dica "clientes que o Radar criou no Omie neste mês".

## Prova

O harness monta o schema de prod: o snapshot, a ACL, a cadeia de 29/10, a 20261031111000 e o predecessor com o md5 de
prod (`de4e4731…`) conferido antes da migration.

O contador é cumulativo: cada lead entra por vez e o assert lê o KPI depois dele, então cada regra tem o seu assert. A
ponta a ponta usa as RPCs reais:

1. o cadastro pela v2 conta;
2. o gestor tira o lead e ele sai do card;
3. o lead é devolvido num mês novo e não reconta.

`--falsificar`: com controle verde (19 asserts), as 10 sabotagens ficaram vermelhas, cada uma no assert declarado:

| Sabotagem | Assert vermelho |
|---|---|
| carimbo móvel | K3 |
| `lookup` conta | K2 |
| sem status | K4 |
| outro código | K6 |
| fuso UTC | K9 |
| limite aberto (`>`) | K8 |
| sem teto do mês | K10 |
| `JOIN` no lugar do `EXISTS` | K5b |
| sem gate | K0b |
| `anon` com EXECUTE | G2 |

A prova recusa (exit 1, `PROVA DESATUALIZADA`) quando uma migration POSTERIOR mexe em `radar_kpis`. Isso foi provado
plantando uma migration falsa.

## Revisão (Codex max, 422 s): nenhuma ALTA, 2 MÉDIAS e 3 BAIXAS, todas tratadas

| Achado | Tratamento |
|---|---|
| MÉDIA: `radar_kpis` fora do `CV_FUNCOES`. Uma migration posterior que tirasse o gate não entraria no harness, e a prova seguiria verde | Guarda fail-closed: migration posterior que cite `radar_kpis` reprova a prova até entrar no harness |
| MÉDIA: o ledger não tem unicidade. Um `JOIN` no lugar do `EXISTS` contaria duas vezes, sem assert que pegasse | K5b (`incluir` + `incluir`) e a sabotagem `join_multiplica` |
| BAIXA: o G1 reaplicava a migration (que revoga `anon`) antes de o G2 olhar a ACL | A ACL é lida antes e depois da reaplicação (G2/G3), com a sabotagem `acl_anon` |
| BAIXA: a sabotagem do fuso exigia K7 vermelho, que fica verde entre 21h e 24h de SP no último dia do mês | Declarada em K9, vermelho nos dois casos |
| BAIXA (herdado): uma transação aberta antes da virada lê `now()` do mês velho e enxergaria o cadastro do mês novo | Teto `< date_add(início, 1 mês, SP)` e K10 com a sabotagem `sem_teto` |

**Desempenho, medido em prod:** `EXPLAIN (ANALYZE, BUFFERS)` da contagem nova roda em **0,08 ms**. O planner entra pelo
índice único parcial do vínculo (`omie_codigo_cliente IS NOT NULL`), em vez de varrer as 573 mil linhas, então não
precisa de índice novo.

**Lição de harness:** sob `LC_ALL=C`, `grep -E '[✓✗]'` não casa nada, porque a classe de caracteres multibyte vira
classe de bytes. Contar asserts assim derrubou o laço da falsificação **calado** pelo `errexit`, depois do controle
verde. A contagem agora sai dos contadores `PASS+FAIL`, como na prova irmã.

## Deploy

| Camada | Estado | Quem |
|---|---|---|
| Migration `20261031142000` | ⏳ envelope `bun run db:aplicar` antes do merge, validada por psql-ro | esta sessão |
| Edge | nenhuma | — |
| Publish do Lovable (dica no card) | ⏳ depois do merge | **founder** |
