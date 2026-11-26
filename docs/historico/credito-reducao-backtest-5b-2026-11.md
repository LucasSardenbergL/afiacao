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

**@ASSERTS@ asserts** com controle verde e **@SABS@ sabotagens** vermelhas pelo motivo certo, cada uma derrubando uma camada. Depois vem a re-prova estrita. Verde em `C` e `pt_BR.UTF-8`. Cobre:
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
- **Diff:** @CODEX_DIFF@

## Backtest IA × regra (prod, psql-ro, @BT_DATA@)

`~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -f db/backtest-credito-ia-regra.sql`. A última linha tem de ser `BACKTEST_FIM ok`.

É **descritivo**, não preditivo, e os nomes dizem isso:
- "piso reconstruído em T com a composição de hoje";
- "proposta de hoje (in-sample)": a ficha da IA já contém as baixas destas safras.

O out-of-time de verdade é a seção **prospectiva**: títulos emitidos depois da proposta. Ela está vazia hoje e amadurece sozinha; re-rodar o arquivo é a medida.

Parâmetros: T = hoje − 90; safra = CR de venda (1.01.*) com vencimento em (T, hoje − 15]; em dia = baixa ≤ venc + 5.

@BT_TABELA@

## Fora (declarado)

- **Vigente aprovado envelhece.** Passados 14 d da ficha, o gate dá 🟡 `limite_desatualizado`, e o laço do PR 4 não reavalia vigente íntegro. É pré-existente e pesa antes de ligar o enforcement (PR 6).
- **Aviso push ao Lucas** quando há corte.
- **Concordância IA × regra no painel `/credito/painel`.** O bloco só sabe mostrar "indisponível + motivo". Alimentá-lo exige mudar a RPC e o front (Publish). O número vive aqui e na query. A concordância IA × Lucas nasce sozinha das decisões da 1ª leva.

## Deploy

@DEPLOY@

## Como reverter

`SELECT cron.unschedule('credito-reducao-auto');` para o corte automático. As linhas de redução ficam como trilha. Voltar o writer exige reaplicar os corpos do PR 4 (founder, SQL Editor).
