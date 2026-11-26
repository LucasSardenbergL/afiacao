# Crédito-IA fatia 5b — redução automática do limite + backtest IA × regra (2026-11-26)

Programa: spec `docs/superpowers/specs/2026-11-20-credito-ia-design.md` (§5.3, §9.9, §9.10) · plano `docs/superpowers/plans/2026-11-20-credito-ia.md` (PR 4, item 8 da revisão pós-Codex). São as duas peças que o PR 5 (#4192) deixou para depois do PR 4.

## Premissas (o Lucas pediu para implementar assumindo premissas)

- **Hoje não há limite vigente.** A 1ª leva do PR 4 ainda está pendente: `credito_limite` tem 0 linhas e há ~30 propostas `pendente`. A redução foi provada em PG17 e **fica inerte em prod** até existir vigente. O lote do cron não acha raiz.
- **A redução não bloqueia pedido por si.** Ela só muda o número do vigente. Quem bloqueia é o enforcement do PR 6, que está desligado nas 3 empresas.
- **"Cai para a trava determinística" = corte sem IA.** O builder-check do spec dizia "reduz para max(exposição, sugerido pela IA)". Na hora do corte a IA não roda para vigente. Por isso o corte é determinístico e a IA re-propõe logo depois (caminho de volta, abaixo).
  - Aceite: exposição de R$ 650 e vigente de R$ 3.000 ⇒ R$ 600.
- **Aviso ao Lucas = proposta de revisão na fila de `/credito/limites`.** A nova proposta da IA aparece com o vigente reduzido ao lado. Notificação push ao Lucas fica fora desta fatia.

## O que mudou

| Camada | Depois |
|---|---|
| Migration `20261126150000_credito_reducao_automatica.sql` | 1 writer `private.credito_limite_gravar`; trigger `credito_limite_lastro`; status `aplicada_auto_reducao`; redutor `private.credito_reduzir_limite`; lote `private.credito_reducao_lote` no pg_cron `credito-reducao-auto` (`2-59/5`, `statement_timeout 60s`); estado `credito_reducao_verificacao`; `credito_aprovar_proposta`, `credito_registrar_avaliacao` e `credito_raizes_elegiveis` substituídas (corpo de prod + o ramo 5b, guarda de drift por 2 hashes exatos) |
| `db/backtest-credito-ia-regra.sql` | backtest descritivo, re-rodável por psql-ro |
| Edge / Front | **nenhum** — sem deploy de edge, sem Publish |

### Regras de piora (só evidência COMPROVADA corta)

| Regra | Quando | Corte |
|---|---|---|
| E1 | piso comprovado (vencido ≥ 60 d com saldo, mesma régua do piso) | 0 / 0 d / `alto` |
| E2 | título aberto que cruzou 15 d de atraso **depois** da última ficha aprovada pelo Lucas (`vigente.ficha_calculada_em`) | limite = floor₁₀₀(títulos abertos + reservas efetivas ativas), "nada novo"; enquanto o causador estiver aberto, cada passada aperta de novo |
| E3 | cadastro irregular no lote publicado do Radar (03/04/08) | risco `alto`, limite intacto |

Não cortam, porque são dado ausente ou deriva e não piora comprovada (Codex desenho P1-1/P1-2):
- queda de K × compra média ou do prazo honrado;
- histórico inconclusivo;
- piso indeterminado;
- sync defasado;
- exposição NULL.

Nesses casos o gate já dá 🟡 na hora, e o redutor devolve o motivo sem escrever.

Identidade mudou (assinatura ou titularidade de um par) ⇒ `grupo_mudou`: não corta pela ficha de outro grupo.

### Um writer, auditoria e "só desce"

- `credito_limite` tem **um** writer: `private.credito_limite_gravar`. A aprovação do Lucas e a redução passam por ele. A pós-condição varre `pg_proc` e aborta se outra função fizer DML na tabela.
- Os valores vêm da proposta, nunca de parâmetro. A versão do vigente tem de ser a esperada **e** a versão-base da proposta.
- A redução é uma linha de `credito_limite_proposta` com status `aplicada_auto_reducao`. Ela guarda a ficha do momento, os cortes com antes/depois, o motivo e a versão-base, e vira `origem_proposta_id` do vigente.
- Regras do ramo automático:
  - nunca INSERT;
  - exige ≥ 1 piora estrita;
  - limite e prazo não sobem, risco não melhora;
  - preserva `grupo_assinatura`, `ficha_calculada_em` e `aprovado_por` (não lava `grupo_mudou` nem `limite_desatualizado`, nem se passa por aprovação);
  - só vale a linha da própria transação.
- O trigger `credito_limite_lastro` reconfere tudo isso na tabela, como defesa em profundidade.

### Caminho de volta

O vigente **revisável** volta ao laço da edge `credito-ia-avaliar`: origem = redução, ou composição do grupo mudada.
- A 1ª proposta sobre a versão vigente sai na hora; depois, semanal.
- `credito_registrar_avaliacao` aceita esse grupo só se a ficha foi calculada sobre a versão vigente.
- Só sobe com o clique do Lucas.
- Vigente aprovado e íntegro continua fora do laço, como no PR 4.

## Prova

`db/test-credito-reducao-auto.sh` roda em PG17, com as migrations reais do PR 1, PR 2, PAGTO PARCIAL, fronteira-60 e PR 4, mais a 5b.

**86 asserts** com controle verde e **38 sabotagens** vermelhas pelo motivo certo, cada uma derrubando uma camada. Depois vem a re-prova estrita. Verde em `C` e `pt_BR.UTF-8`. Cobre:
- inerte sem vigente;
- E1, E2 (duas passadas, fronteira de 15 d, vencido já visto pelo Lucas, reservas efetivas × sombra, exposição NULL), E3;
- nunca sobe;
- `grupo_mudou`;
- caminho de volta;
- pendente antiga não desfaz o corte;
- writer (aumento, sem piora, versão, outra transação, sem vigente);
- trigger (valores, monotonia, `ficha_calculada_em`, INSERT);
- lote retomável (30 raízes em 2 passadas) e erro isolado por raiz;
- 2 sessões: grupo ocupado não trava o lote, e duas reduções serializam;
- ACL e cron.

Lições da falsificação:
- **Restaurar exige a cadeia de prod.** Reaplicar a 5b sobre um corpo sabotado é recusado pela própria guarda de drift, com razão. O harness restaura com PR 4 + 5b.
- **Sem `lock_timeout` o lote pendura.** A sabotagem S25 travou o harness: o lote esperava para sempre um lock que só seria solto depois dele. Agora o check tem teto de 8 s e fica vermelho em vez de pendurar.

## Codex

- **Desenho** (gpt-6.2-astra high), 2 rodadas.
  - 1ª: 0 P0, 6 P1, 5 P2. Os principais: K × e dado ausente virariam catraca permanente; R3 contava vencidos e perdia evento; o writer precisava amarrar cada escrita à proposta; a varredura precisava de transações curtas; o backtest misturava 3 datas.
  - 2ª: fechou P1-2, P1-4 e P1-6. Pediu a base do E2 em `vigente.ficha_calculada_em`, `grupo_mudou` no caminho de revisão e a substituição da fórmula registrada. Tudo acatado.
  - O ponto do cron com `CALL` + `COMMIT` sumiu: o lote é função curta (≤ 25 raízes), não procedure.
- **Diff** (gpt-6.2-astra high): 0 P0, 4 P1, 4 P2, todos acatados.
  - P1-1: E1/E2 exigem o espelho do CR em dia nas empresas do grupo. Título pago no Omie e aberto no espelho não pode virar corte permanente.
  - P1-2: identidade, ficha, causador do E2, exposição e reservas saem de **um** comando, num snapshot só.
  - P1-3: lock de **sessão** para ler, solto na hora quando não há corte; o lote para na 1ª redução, então há um corte por transação e é a última escrita.
  - P1-4: o laço inclui os vigentes fora da carteira ativa.
  - P2: trigger com piora estrita; INSERT automático exercitado; S26 numa raiz saudável; aprovação × redução nas duas ordens; `initdb` no locale da rodada; coorte prospectiva fixa na 1ª proposta; cobertura conta título sem mapa; piso em T indeterminado por falta de saldo ou emissão.
  - A pós-condição por regex em `pg_proc` é complementar (Codex): a exclusividade do writer está provada pelos testes do trigger e do writer.
- **Diff, 3ª rodada:** 1 P1 + 4 P2, acatados.
  - P1: `WHEN OTHERS` não pega `query_canceled`. O `statement_timeout` numa raiz lenta desfazia o lote e devolvia a raiz à frente da fila. Agora o 57014 é registrado, o lock de sessão é solto e o lote encerra. A prova X1 reproduz com o grupo ocupado e `statement_timeout` de 1 s.
  - P2: a ficha só é chamada com identidade válida; a aprovação espera o corte ainda sem commit e é recusada por versão (C4); prospectivo com data e decisão da mesma 1ª proposta; piso em T não fica indeterminado por título baixado antes de T.
- **Diff, 4ª rodada (confirmação):** **aprovou o merge**, com 0 P0, 0 P1 e 2 P2, acatados: piso em T NULL-safe (`IS NOT TRUE`) e X1 com 1 raiz, provando que a seguinte vem antes da cancelada.

## Backtest IA × regra (prod, psql-ro, 2026-11-26 09:41 SP, 93 propostas em 93 grupos)

`~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -f db/backtest-credito-ia-regra.sql`. A última linha tem de ser `BACKTEST_FIM ok`.

É **descritivo**, não preditivo, e os nomes dizem isso:
- "piso reconstruído em T com a composição de hoje";
- "proposta de hoje (in-sample)": a ficha da IA já contém as baixas destas safras.

O out-of-time de verdade é a seção **prospectiva**: títulos emitidos depois da proposta. Ela está vazia hoje e amadurece sozinha; re-rodar o arquivo é a medida.

Parâmetros: T = hoje − 90; safra = CR de venda (1.01.*) com vencimento em (T, hoje − 15]; em dia = baixa ≤ venc + 5.

| seção | balde | grupos | títulos | R$ com desfecho | atraso por R$ % | atraso > 15 d por R$ % |
|---|---|---|---|---|---|---|
| cobertura | atrasou |  | 478 | 373541.43 |  |  |
| cobertura | em_dia |  | 1015 | 698106.65 |  |  |
| cobertura | fora_do_grupo:sem_mapa |  | 0 |  |  |  |
| cobertura | grupos_so_sem_desfecho | 0 |  |  |  |  |
| cobertura | sem_desfecho:recebido_sem_baixa |  | 1 | 85.00 |  |  |
| cobertura | sem_desfecho:vencimento_nulo |  | 0 |  |  |  |
| piso_reconstruido_T | comprovado | 26 | 279 | 217192.33 | 61.1 | 55.7 |
| piso_reconstruido_T | livre | 306 | 1214 | 854455.75 | 28.2 | 17.7 |
| ia_limite | acima_1k | 11 | 61 | 35151.20 | 30.7 | 14.1 |
| ia_limite | ate_1k | 26 | 47 | 17517.49 | 17.6 | 14.7 |
| ia_limite | limite_0 | 17 | 78 | 42518.11 | 51.3 | 40.6 |
| ia_risco | alto | 25 | 95 | 50459.51 | 45.9 | 36.8 |
| ia_risco | baixo | 17 | 48 | 20292.06 | 0.7 | 0.0 |
| ia_risco | medio | 12 | 43 | 24435.23 | 50.6 | 25.5 |
| ia_risco_bruto | alto | 25 | 95 | 50459.51 | 45.9 | 36.8 |
| ia_risco_bruto | baixo | 17 | 48 | 20292.06 | 0.7 | 0.0 |
| ia_risco_bruto | medio | 12 | 43 | 24435.23 | 50.6 | 25.5 |
| piso_reconstruido_T_sem_proposta | comprovado | 24 | 271 | 206990.31 | 59.3 | 53.7 |
| piso_reconstruido_T_sem_proposta | livre | 254 | 1036 | 769470.97 | 27.9 | 17.7 |
| proposta_restringe_x_piso_hoje | ia_libera · piso_hoje_livre | 26 | 87 | 44227.29 | 27.9 | 13.7 |
| proposta_restringe_x_piso_hoje | ia_restringe · piso_hoje_comprovado | 11 | 70 | 41502.11 | 51.7 | 40.7 |
| proposta_restringe_x_piso_hoje | ia_restringe · piso_hoje_livre | 17 | 29 | 9457.40 | 20.2 | 19.5 |
| proposta_restringe_x_piso_T | ia_libera · piso_T_libera | 26 | 87 | 44227.29 | 27.9 | 13.7 |
| proposta_restringe_x_piso_T | ia_restringe · piso_T_bloqueia | 2 | 8 | 10202.02 | 96.3 | 96.3 |
| proposta_restringe_x_piso_T | ia_restringe · piso_T_libera | 26 | 91 | 40757.49 | 33.2 | 21.9 |
| proposta_restringe_x_gate_v2 | ia_libera · v2_amarelo | 2 | 9 | 2138.80 | 13.8 | 7.0 |
| proposta_restringe_x_gate_v2 | ia_libera · v2_sem_pv | 24 | 78 | 42088.49 | 28.6 | 14.0 |
| proposta_restringe_x_gate_v2 | ia_restringe · v2_amarelo | 1 | 2 | 240.00 | 100.0 | 100.0 |
| proposta_restringe_x_gate_v2 | ia_restringe · v2_sem_pv | 23 | 79 | 39075.11 | 45.2 | 33.4 |
| proposta_restringe_x_gate_v2 | ia_restringe · v2_vermelho | 4 | 18 | 11644.40 | 46.9 | 46.9 |
| prospectivo | titulos_pos_proposta_maduros |  | 0 |  |  |  |

**Leitura (descritiva — não é poder preditivo):**
- **Cobertura:** 1.493 títulos de safra com desfecho (R$ 1,07 mi) em 332 grupos.
  - Só 1 título ficou fora como `sem_desfecho` (RECEBIDO sem baixa inferida).
  - Nenhum título ficou sem mapa, nenhum com vencimento nulo e nenhum grupo só sem desfecho.
- **A regra separa.** Grupos com piso reconstruído em T atrasaram **61,1 %** do R$ da safra seguinte (55,7 % além de 15 d). Os livres atrasaram **28,2 %** (17,7 %).
- **A IA separa in-sample, como esperado.** A ficha dela já viu essas baixas.
  - Risco `baixo`: **0,7 %** de atraso por R$ (0,0 % > 15 d), em 17 grupos.
  - Risco `medio`: **50,6 %**, em 12 grupos.
  - Risco `alto`: **45,9 %**, em 25 grupos.
  - Limite 0: **51,3 %**. Limite acima de R$ 1 mil: **30,7 %**.
  - O risco bruto da IA é igual ao pós-trava: nenhuma trava mudou o risco nestes 54 grupos.
- **Concordância proposta × piso em T:**
  - 28 dos 54 grupos concordam: 26 a IA libera e o piso libera; 2 os dois restringem (96,3 % de atraso).
  - Nos outros 26, **a IA restringe e o piso libera**, com 33,2 % de atraso por R$ (21,9 % > 15 d). É acima dos 27,9 % / 13,7 % de onde os dois liberam: a IA pega um risco que o piso não vê.
  - Nenhum grupo em que o piso bloqueia e a IA libera.
- **Prospectivo:** 0 títulos maduros emitidos depois da 1ª proposta. A 1ª leva é de 2026-11-25/26; a medida do §9.10 amadurece a partir de ~4 semanas.
- **Amostra pequena:** 54 grupos com proposta, e o recorte não é aleatório (a 1ª leva anda por ordem). Use como sinal de coerência, não como calibração de K.

## Fora (declarado)

- **Vigente aprovado envelhece.** Passados 14 d da ficha, o gate dá 🟡 `limite_desatualizado`, e o laço do PR 4 não reavalia vigente íntegro. É pré-existente e pesa antes de ligar o enforcement (PR 6).
- **Aviso push ao Lucas** quando há corte.
- **Concordância IA × regra no painel `/credito/painel`.** O bloco só sabe mostrar "indisponível + motivo". Alimentá-lo exige mudar a RPC e o front (Publish). O número vive aqui e na query. A concordância IA × Lucas nasce sozinha das decisões da 1ª leva.

## Deploy

- **Migration:** `bun run db:aplicar` a partir da main mergeada (#4214 → `f69be4435`), com ensaio verde antes. Resultado: **`db_aplicacoes` #1472 `aplicada`** às 12:39:40Z, sha256 `99823831…`, igual ao do ensaio.
- **2ª testemunha** por psql-ro:
  - os 3 corpos substituídos com o md5 do corpo 5b (aprovar `be6ce845`, elegíveis `0f119a19`, registrar `fa7e30ae`), com ACL igual à de antes (aprovar só `authenticated`; registrar só `service_role`);
  - 4 funções novas `private.*`, todas SECURITY DEFINER e só com o dono;
  - **0 writers** de `credito_limite` além do writer único;
  - trigger `credito_limite_lastro` ligado e CHECK com `aplicada_auto_reducao`;
  - `credito_reducao_verificacao` com RLS e só SELECT para `service_role`/`claude_ro`;
  - cron `credito-reducao-auto` ativo como `postgres` (`2-59/5`, `statement_timeout 60s`).
- **Inerte, como previsto:** 0 vigentes, 0 verificações, 0 reduções. Crons depois do apply (12:39Z → 16:02Z, psql-ro, `cron.job_run_details`): `credito-reducao-auto` com **41 execuções, todas `succeeded`**; `credito-ia-avaliar` com **14 `succeeded`**. Propostas `pendente` novas seguem chegando (a última às 16:01Z), então o laço da edge segue funcionando com a `credito_raizes_elegiveis` substituída.
- **Sem edge e sem Publish.**

## Como reverter

`SELECT cron.unschedule('credito-reducao-auto');` para o corte automático. As linhas de redução ficam como trilha. Voltar o writer exige reaplicar os corpos do PR 4 (founder, SQL Editor).
