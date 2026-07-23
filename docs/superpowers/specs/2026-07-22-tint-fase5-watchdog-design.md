# Watchdog "tombstone Fase 5 sem SL válida" — design (follow-up 5b#2)

> Follow-up do PR #1549 (Fase 5 tintométrica, migration `20260727120000`, aplicada em prod
> 2026-07-22). Fecha o **P1-7** do challenge Codex, calibrado à época como 5b.
> Money-path: `docs/agent/money-path.md` · domínio: `docs/agent/tintometrico.md`.

## 1. O problema

A Fase 5 desativou **463.995** fórmulas da geração `'1'` (carimbo
`desativada_motivo='fase5_geracao_legada'`) porque cada chave `(account, sku_id, cor_id)`
tinha uma **gêmea SL ativa e válida** para servir no lugar. Os guards G2/G3 da migration
provaram essa propriedade no instante do apply.

**A propriedade não é durável.** Depois do apply, se a gêmea SL invalidar — um corante
perder custo Omie, ficar inativo, ou a receita ser corrompida por um sync — a chave fica
**sem fórmula precificável**: a RPC devolve `precoFinal=NULL` (fail-closed), o balcão não
vende aquela cor, e **ninguém é avisado**. Antes da Fase 5 a `'1'` era o fallback; agora
não é (o filtro de candidata a canônica é ativo-only e **não** foi relaxado).

Modo de falha irmão (**P1-2**): a FONTE retirar a chave depois da Fase 5. O writer
`tint_apply_keys_snapshot(uuid)` faz `UPDATE ... SET desativada_em=now()` apenas em linhas
**ativas** e **não seta `desativada_motivo`** — então ele desativa a SL e a `'1'` permanece
carimbada, com o CSV dela ainda alimentando rótulo e piso via a coluna 13/14 da view.

### "SL válida" — o predicado canônico

Espelha `receita_valida` da view e `corantes_completos` da RPC de preço:

```sql
g.desativada_em IS NULL AND g.sku_id IS NOT NULL
AND EXISTS (SELECT 1 FROM tint_formula_itens fi WHERE fi.formula_id = g.id)   -- tem receita
AND NOT EXISTS (                                                              -- todo corante precificável
      SELECT 1 FROM tint_formula_itens fi
      LEFT JOIN tint_corantes c   ON c.id = fi.corante_id
      LEFT JOIN omie_products op  ON op.id = c.omie_product_id
       WHERE fi.formula_id = g.id
         AND NOT (COALESCE(op.valor_unitario,0) > 0 AND COALESCE(op.ativo,false)
                  AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0))
```

## 2. Dimensionamento em PROD (psql-ro, 2026-07-23 ~01:50 UTC, pós-apply)

| Medição | Valor | Custo |
|---|---|---|
| Linhas carimbadas `fase5_geracao_legada` | **463.995** (= 463.995 chaves distintas) | 3,7s |
| Carimbadas que estão ATIVAS (estado impossível) | **0** (o CHECK segura) | — |
| **P1-7**: carimbada sem gêmea SL ativa e válida | **0** | 20,5s |
| **Efeito**: carimbada sem canônica `receita_valida` (via a view) | **0** | 26,2s |
| **P1-2**: carimbada sem SL ativa, com SL desativada | **0** | 9,5s |
| Fórmulas ATIVAS totais | 496.296 — **496.292 precificáveis**, 4 sem receita, **0 com corante impagável** | 17,4s |
| Desativadas por OUTRO motivo (fonte retirou) | **16.989** (era 16.958 em 21/07) | — |

**Dois oráculos independentes concordam em 0.** O watchdog nasce medindo zero: ele é
**preventivo**, e o número que ele vigia é o que deve continuar zero.

### A descoberta que define o desenho: o dano é em AVALANCHE

Existem **14 corantes no total**, todos precificáveis hoje. Fórmulas ativas por corante:

| Corante | `valor_unitario` | Fórmulas ativas que o usam |
|---|---|---|
| WP87.3900QT CONCENTRADO OCRE | 632,65 | **296.931** |
| WP69.3900QT CONCENTRADO VERMELHO S | 633,20 | 256.739 |
| WP01.3900QT CONCENTRADO PRETO INTE | 498,40 | 227.015 |
| WP02.3900QT CONCENTRADO BRANCO | 606,30 | 190.810 |
| WP12.3900QT CONCENTRADO PRETO | 500,70 | 154.066 |
| … (mais 9, de 137.221 a 7.213) | | |

Um único corante perdendo `valor_unitario` ou ficando inativo no Omie invalida **centenas de
milhares de fórmulas de uma vez**. Como a Fase 5 removeu o fallback de 463.995 chaves, isso
derrubaria a venda de boa parte do catálogo simultaneamente. **O modo de falha dominante não
é uma chave degradar — é um corante derrubar um bloco inteiro.**

Consequência: a causa-raiz do cenário dominante é observável em **14 linhas**, não em 464k.

## 3. Arquitetura — duas camadas

| Camada | Vigia | Custo medido | Cobre |
|---|---|---|---|
| **A — corante** | corante impagável **em uso** por fórmula ativa | **214ms** | a avalanche, com detecção rápida; vale também para chaves que nunca tiveram a `'1'` |
| **B — chave** | carimbada Fase 5 sem canônica `receita_valida` | 26,2s | receita corrompida numa fórmula isolada, fonte retirando a chave, e caminhos não previstos — com fidelidade ao que o balcão lê |

São complementares: **A** é barata, rápida e ampla sobre a **causa**; **B** é completa e fiel
sobre o **efeito** no escopo que a Fase 5 criou. Nenhuma substitui a outra:

- A sem B: não vê receita corrompida nem chave retirada pela fonte.
- B sem A: só detecta a avalanche na varredura seguinte, e ignora o dano fora do tombstone.

### Restrição dura: a Camada B NÃO pode viver no `_data_health_compute`

Não é preferência, é timeout medido. `statement_timeout` por role em prod:

| Role | `statement_timeout` |
|---|---|
| `anon` | 3s |
| `authenticated` | **8s** |
| `supabase_admin` (o cron) | **0 = sem limite** |
| `claude_ro` (diagnóstico) | 30s (explica os estouros em 45s) |

O dashboard `/health` chama `get_data_health()` (SECURITY DEFINER, `EXECUTE` para
`authenticated`) que chama `_data_health_compute()`, via `useDataHealth.ts:21` — e o
`DataHealthBadge` a repete periodicamente. **SECURITY DEFINER troca privilégio, não
`statement_timeout`**: a sessão continua sendo a do `authenticated`, com 8s de orçamento
total. Um check de 26s ali derrubaria o dashboard inteiro por timeout, para todo mundo.

⇒ A Camada B fica **obrigatoriamente** num cron dedicado (roda como `supabase_admin`,
timeout 0). A Camada A (214ms) caberia no Sentinela; o que pesa contra é só o risco de
cascata do arquivo quente (45.362 chars, 5 reversões históricas, ~58 sessões vivas).

### Oráculo da Camada B: a própria view

A detecção B usa `v_tint_formula_canonica` ("chave carimbada sem canônica `receita_valida`")
em vez de reimplementar o predicado, porque: (i) é o que o balcão lê, então mede o dano real
em vez de um proxy; (ii) precisão > recall — não alarma se a chave tiver outro fallback
válido; (iii) evita criar uma **terceira** cópia do predicado de validade (ele já vive na
view e na migration da Fase 5), que é exatamente o acoplamento da lição §9 do money-path.

### Canal de alerta

Catálogo tint é 100% da conta **`oben`** (496.296 ativas). O canal reusa a infra existente:
`fin_alertas` (UNIQUE parcial `(company,tipo) WHERE dismissed_at IS NULL` ⇒ anti-spam, emite
só na transição ok→degradado) + `fornecedor_alerta` → edge `dispatch-notifications`, com
dismiss ao voltar a zero. **Tipos dedicados por classe** (lição `sync.md` §Sentinela: duas
classes no mesmo tipo ficam silenciadas pelo `ON CONFLICT DO NOTHING`).

## 4. Escopo da v1

**Só detecção + alerta.** Sem recuperação automática: não reativar a `'1'`, porque ela é a
geração **congelada de março** e pode ter preço tão obsoleto quanto a SL que caiu — reativar
às cegas restaura a venda com preço potencialmente errado, que é pior que fail-closed.
Recuperação vira decisão de produto posterior, informada pela frequência real observada.

O P1-2 entra de graça na detecção (a chave retirada vira "não vende" e o alerta pega); a
**ação** de recarimbar/limpar o motivo toca o writer do snapshot e fica no 5b separado.

## 5. Prova

Harness PG17 próprio (`db/test-tint-fase5-watchdog.sh`), aplicando a migration REAL:

- semeia o estado degradado — a gêmea SL invalidando **depois** do carimbo. O cenário **K10**
  de `db/test-tint-fase5-desativacao.sh` já o constrói (foi o seed que a falsificação F1
  daquele harness precisou criar, e é literalmente este P1-7);
- asserta detecção (degradado ⇒ alerta), não-detecção (saudável ⇒ silêncio), e **dismiss**
  ao voltar a zero;
- falsifica cada assert declarando o **conjunto exato** que a sabotagem derruba
  (`confere_falsificacao`, lição #1505 — falsificação prova dente, só instrumentação prova
  especificidade);
- baseline verde explícito antes de cada sabotagem (o exit code não distingue "pegou o bug"
  de "não rodou nada").

## 6. Riscos e lacunas conhecidas

- **Ancoragem no carimbo.** A Camada B só enxerga chaves com tombstone Fase 5. Se o carimbo
  for limpo (follow-up 5b#1) ou a linha deletada, a chave sai do escopo — a Camada A cobre
  parcialmente esse vão por não depender do tombstone.
- **Quem vigia o vigia.** `cron.job_run_details` reporta `succeeded` mesmo quando nada rodou;
  um cron morto deixa o watchdog verde-silencioso. Precisa de decisão explícita sobre
  heartbeat próprio.
- **Nasce em zero.** Um detector que nunca disparou não prova que dispara — daí a exigência
  de falsificação e de um cenário semeado que force o alerta.

## 7. Challenge Codex — REPROVADO, e o que mudou

Consulta em 2026-07-22 (`gpt-5.6-sol`, reasoning `high`; a 1ª tentativa em `xhigh` morreu no
hard-stop de 20min sem produzir uma linha). Parecer cru preservado no scratchpad da sessão.
Veredito: **REPROVADO** — 1 P0, 6 P1, 2 P2.

### Achados aceitos (o desenho muda)

| # | Achado | Efeito no desenho |
|---|---|---|
| P0 | B diária deixa a avalanche invisível por 24h | **A a cada 5min · B a cada 6h** |
| P1 | "P1-2 entra de graça" está **errado**: classes com remediações distintas no mesmo `tipo` são silenciadas pelo `ON CONFLICT DO NOTHING`, e com ~30 retiradas/dia o alerta nunca volta a zero | **tipos de alerta separados por classe** |
| P1 | A e B no mesmo job = dependência de falha | funções, crons e alertas **separados** |
| P1 | Sem estado operacional, ausência de alerta não é saúde | **dead-man com `last_success_at`**; timeout ≠ sucesso; timeout nunca dismissa |
| P1 | Carimbo não é fundamento durável (delete/limpeza fazem o universo sumir ⇒ zero ⇒ "verde") | **vigia de cardinalidade** do universo carimbado (v1); ledger completo → v2 |
| P2 | Os dois oráculos não são independentes — compartilham a definição de validade | registrado como limite conhecido da evidência |

**O P1-2 era erro meu**: o spec citava a lição do `sync.md` sobre `ON CONFLICT` silenciar a
segunda classe e a violava no desenho seguinte.

### Achado aceito cuja conclusão a medição refina

**"A view não é o consumidor completo"** — procede: `get_tint_price` faz
`v_preco_final := CASE WHEN v_base_disponivel AND v_corantes_completos THEN … ELSE NULL END`,
e a view só expõe o segundo termo. **Mas `base_disponivel` não discrimina gêmeas**: medido
**0 chaves** com divergência de `base_ok` entre a '1' e a SL (o `sku_id` é o mesmo), logo a
Fase 5 não causou nem piorou essa condição.

Consequência quantificada: das 463.995 carimbadas, **296.536 (64%) já tinham base
indisponível** — não vendiam antes da Fase 5. **A exposição real do P1-7 são as 167.459
chaves com base disponível.** Incluir `base_disponivel` no *gatilho* produziria 296.536
alertas no dia 1 sobre condição pré-existente (o watchdog nasceria como ruído, contra
precisão>recall) ⇒ fica **fora do gatilho, dentro do relatório**.

### Achado calibrado

**"26s contra timeout de 45s é pouca margem"** — o Codex usou o número do meu prompt. Medido
depois: o cron roda como `supabase_admin` (`statement_timeout=0`); os 30s/45s eram do role de
diagnóstico. A margem não é o risco; o risco *derivado* (erro engolido virando falso verde)
permanece e é coberto pelo dead-man.

### Fora da v1 (decisão minha, registrada)

Ledger `tint_fase5_coverage_keys` completo · modo degradado explícito com
`price_source='legacy_csv'` · telemetria de tentativas reais de precificação sem preço ·
detecção de custo **aberrante** (valor positivo porém errado/obsoleto). Todos procedem; nenhum
é pré-requisito da detecção, e cada um é uma decisão de produto própria.

## 8. Desenho final da v1

Quatro sinais, tipos distintos, funções e crons separados:

| Sinal | `tipo` do alerta | Frequência | Custo |
|---|---|---|---|
| corante impagável em uso | `tint_corante_impagavel_em_uso` | `*/5` | 214ms |
| chave carimbada sem preço | `tint_fase5_chave_sem_preco` | 6h | 26s |
| fonte retirou a chave com legado exposto | `tint_fase5_fonte_retirada` | 6h | junto de B |
| o próprio watchdog parou | `tint_fase5_watchdog_stale` | dead-man | — |

Severidade escala com a contagem (1 chave ≠ 300 mil). Nenhum reativa fórmula: a
recuperação segue humana, e a `'1'` congelada de março nunca volta a canônica sozinha.
