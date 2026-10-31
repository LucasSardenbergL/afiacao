# Radar: o cron da RFB casa contato ↔ status por CNPJ (2026-10-31)

> Follow-up de [radar-contato-integridade.md](radar-contato-integridade.md) (Codex P1 herdado). Migration
> `20261031190000_radar_situacao_contato_por_cnpj.sql`. Prova: `db/test-radar-situacao-contato-por-cnpj.sh` (núcleo do CI).

## Problema

No trecho (b) de `public.radar_aplicar_situacao` (cron `radar-aplicar-situacao-diario`, 06:05 UTC), o contato
`descartado` nascia do **retrato** (`tmp_rfb_irreg`, com o status lido antes) e o `UPDATE` do estado relia o status
**vivo**, sem trava. A conferência era só `v_leads_upd <> v_leads`. Traço: depois do retrato, o vendedor leva X a
`virou_cliente` e reabre Y (`descartado` → `a_contatar`). O contato sai para X, que não muda, e o estado muda Y, que fica
sem contato: 1 = 1, a contagem passa. Com o vendedor no meio do `UPDATE`, o `status_anterior` saía velho.

## O que mudou (só o trecho (b))

Um statement:

```sql
WITH alvo AS MATERIALIZED (SELECT … FROM radar_empresas re JOIN tmp_rfb_irreg i …
                            WHERE <candidato pelo retrato> AND NOT COALESCE(re.ja_cliente, false)
                              AND re.prospeccao_status NOT IN ('descartado','virou_cliente')
                            FOR UPDATE OF re),
     estado  AS (UPDATE radar_empresas … FROM alvo … RETURNING cnpj, status_anterior, descricao),
     contato AS (INSERT INTO radar_contatos … SELECT … FROM estado RETURNING cnpj, status_anterior)
SELECT …, EXISTS (estado EXCEPT ALL contato ∪ contato EXCEPT ALL estado) INTO …;
```

- O retrato só aponta os **candidatos**. Status e `ja_cliente` valem na **linha travada** (EvalPlanQual re-avalia o
  `WHERE` contra a versão que outra transação acabou de gravar).
- O estado muda só nas linhas travadas, e o contato nasce do que o `UPDATE` devolveu: contato ⇔ mudança **por
  construção**, com o `status_anterior` da linha travada.
- A postcondição compara os dois conjuntos **por CNPJ** (`EXCEPT ALL` nos dois sentidos), não pelos totais. Ela não tem
  vermelho próprio com o corpo correto (a construção já garante); o dente dela é a sabotagem `contato_do_retrato`.
- (a), (c), os avisos e a regra de negócio não mudam. O G4 da prova confere que o corpo novo, sem o trecho (b), é byte
  a byte o predecessor de prod sem o trecho (b).
- A guarda `private.radar_empresas_status_guard` segue zerando a autoria (o cron não declara dono), e o cron sem JWT não
  esbarra no RD005/RD007 (exclui `virou_cliente` antes).

## Prova

PENDENTE

## Limites declarados

- O lado "documento nas fontes" do cliente (`radar_docs_clientes()`: `profiles` e `omie_clientes_nao_vinculados`) segue
  vindo do retrato: não há linha a travar. Um cadastro que entra nas fontes no meio da chamada não protege o lead
  daquele lote (protege no próximo, e o `ja_cliente` da linha já protege o caminho do cadastro pelo Radar).
- Avisos (`fornecedor_alerta`/`alertado_em`) não têm o defeito: lêem só `radar_situacao_cadastral`, cujo único escritor de
  `alertado_em` é esta função.

## Deploy

PENDENTE
