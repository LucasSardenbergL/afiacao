# Piloto N3 — auto-aprovação de compra Sayerlack (post-mortem, encerramento leve)

> **TL;DR (2026-07-09):** o piloto de auto-aprovação de pedido Sayerlack (OBEN, money-path nível 3)
> **nunca auto-aprovou nada** em toda a janela (~4 semanas) — `reposicao_auto_aprovacao_log` ficou
> **vazio (0 linhas *ever*)**, apesar de pedidos elegíveis fluírem quase todo dia. Veredito:
> **inconclusivo/inerte**, não passou (não há dado pra medir taxa de veto) e não morreu aberto
> (nenhuma compra errada). Decisão: **encerramento leve** — código-máquina fica **dormente** (não
> excluído), tarefa agendada de check-in desativada. Se um dia religar, exigir **ver auto-aprovações
> acontecendo**; NÃO ligar o fusível achando que já rodou.

## O que era o piloto

- Entrou em produção **2026-06-11**. O tick SQL `reposicao_alerta_pedido_minimo_tick` (cron
  `reposicao-alerta-pedido-minimo`, `*/30`) auto-aprovaria pedidos Sayerlack (fornecedor
  `%SAYERLACK%`, ≥ R$3k) que passassem no estrato, gravando em `reposicao_auto_aprovacao_log` com
  `aprovado_por='auto:sayerlack-v2'` e status `aprovado_aguardando_disparo` (dispara no próximo corte
  via edge `disparar-pedidos-aprovados`).
- **v1 ficou inerte** (0 aprovações em 4 dias). **Recalibrado na v2 (2026-06-15):** delta assimétrico
  + mediana (só trava comprar MAIS que mediana×1,30 dos últimos 5 disparos do grupo), SEM janela de
  horário, promo veta só `forward_buying`.
- Salvaguardas por-evento: e-mail por aprovação, auto-suspensão pelo Sentinela, fusível
  `company_config.reposicao_auto_aprovacao_ativa`.
- **Check-in de tendência** (seg/qui) via tarefa agendada `revisar-piloto-auto-aprovacao-sayerlack`,
  pra pegar o que as salvaguardas por-evento não pegam: deriva da taxa de veto, concentração por
  grupo, volume anormal. Critério de morte: veto acumulado > 25% na semana OU 1 compra confirmada
  errada. Critério de aprovação: veto < 10% sustentado por 3 semanas.

## Veredito final (check-in de 2026-07-09, fim da janela de 3 semanas)

Diagnóstico rodado direto no banco (read-only `~/.config/afiacao/psql-ro`):

| Evidência | Resultado |
|---|---|
| `reposicao_auto_aprovacao_log` (total, *ever*) | **0 linhas** — nunca gravou uma aprovação, nem v1 nem v2 |
| Fusível `reposicao_auto_aprovacao_ativa` | **`false`** desde a criação |
| Cron do tick | ativo (`*/30`), mas o braço nunca produziu efeito |
| Candidatos elegíveis (OBEN ≥ R$3k) na janela | **abundantes** — quase todo dia, vários bem acima de 3k (máximos 17k–22k), **vários aprovados manualmente** |

**Não foi falta de pedido elegível** (eles fluíram e foram aprovados na mão). A automação simplesmente
**nunca engatou**. Portanto: **não pode ser promovido pra fase 2** (zero auto-aprovações → sem dado
pra provar veto < 10%); e **não falhou aberto** (nenhuma compra errada). Já estava **fail-closed**
(fusível off) — não precisou do BLOCO B reverso.

### Duas causas-raiz candidatas (não decididas — investigar se reabrir)
1. O fusível `ativa` nunca foi conscientemente ligado (ficou `false` desde o seed).
2. A migration da v2 (delta assimétrico + mediana) pode ter **falhado silenciosamente** no apply —
   armadilha clássica do Lovable (migration custom não auto-aplica). Confirmar no corpo de
   `reposicao_alerta_pedido_minimo_tick` / `reposicao_pedido_auto_aprovavel` antes de religar.

> ⚠️ **Caveat de método:** `company_config` **não tem trigger de `updated_at`** — a coluna não bumpa
> em UPDATE. Então "`updated_at == created_at` ⇒ nunca tocado" é inferência **fraca** nessa tabela. O
> veredito NÃO depende disso: sustenta-se no log vazio (0 linhas *ever*), que é prova direta de que
> nada auto-aprovou.

## Decisão: encerramento leve (2026-07-09)

Motivo de não arrancar o código: o founder pausou o envio automático **"por enquanto"** (porta aberta
pra retomar), e a cirurgia mexeria numa função quente de money-path (o mesmo tick faz o **alerta** e a
edge faz o **disparo**). Custo de deixar dormente ≈ zero (gateado em dois lugares).

- ✅ Tarefa agendada `revisar-piloto-auto-aprovacao-sayerlack` **desativada** (`enabled: false`) em
  `~/.claude/scheduled-tasks/`. ⚠️ *Correção de 2026-08-06: a redação original dizia "diretório
  removido" — **o diretório existe** (`SKILL.md` presente, `lastRunAt` de 2026-07-09). Sem efeito
  prático (desativada não dispara), mas quem for reabrir procuraria um diretório que está lá.*
- ✅ Código-máquina **permanece** (dormente):
  - braço de auto-aprovação dentro de `reposicao_alerta_pedido_minimo_tick` (função SQL, prod);
  - `reposicao_pedido_auto_aprovavel` (calc de elegibilidade, ociosa);
  - chaves `company_config.reposicao_auto_aprovacao_*` (`ativa=false`, `delta_max`,
    `cooldown_falha_horas`, `corte_utc` órfã);
  - tabela `reposicao_auto_aprovacao_log` (vazia);
  - lógica de backlog de auto-aprovados na edge `disparar-pedidos-aprovados` (ociosa).

### 🚨 Aviso pra quem for mexer nisso no futuro
Existe código de auto-aprovação de compra **desligado** em produção. Ele **NUNCA rodou / nunca foi
validado em produção** (log vazio). **NÃO** ligue `reposicao_auto_aprovacao_ativa=true` achando que o
piloto já provou o comportamento — ele não provou. Se reabrir: (1) confirme que a v2 está de fato no
corpo da função (pode ter caído na falha silenciosa de migration); (2) religue conscientemente com
relógio novo de 3 semanas; (3) o sucesso exige **ver auto-aprovações acontecendo**, não só ausência de
erro. Encerramento **completo** (arrancar o braço, aposentar chaves, dropar a tabela, limpar a edge) é
tarefa de código à parte, com ritual money-path (migration + `CREATE OR REPLACE` com pré-flight +
redeploy de edge + testes).

## Mudança relacionada no mesmo dia — trava de R$3k removida

A régua `company_config.reposicao_alerta_pedido_valor_minimo` (R$3.000) era o **mínimo de faturamento
da própria Sayerlack** (pedido abaixo não fatura, trava no fornecedor) — **uma régua, dois usos**:
alerta "pronto pra aprovar" + **gate de disparo** que barra o envio abaixo do mínimo
([`src/lib/reposicao/disparo-gate-helpers.ts`](../../src/lib/reposicao/disparo-gate-helpers.ts),
espelhado verbatim na edge `disparar-pedidos-aprovados`). O founder confirmou que **a Sayerlack não
tem mais mínimo (fatura qualquer valor)** → régua zerada: `SET value='0'`. O código trata `≤ 0` como
**gate desligado** (fail-open deliberado), então zerar desliga alerta-piso E gate de disparo de uma
vez. **Efeito colateral:** o e-mail "[Compras] pedido Sayerlack atingiu R$X — pronto pra aprovar" para
de sair (era definido por esse limite); pedidos seguem visíveis/aprováveis em Reposição → Pedidos.
Reversível: `SET value='3000'`. Para manter um alerta de pedido pendente SEM piso de valor, seria
preciso **desacoplar** alerta e gate (hoje é uma régua só) — mudança de código, não feita.

> Referência operacional do domínio: [`docs/agent/reposicao.md`](../agent/reposicao.md).
>
> ⚠️ *Correção de 2026-08-06: a redação original mandava ver a entrada "Reposição N3 —
> auto-aprovação Sayerlack v2" no **CLAUDE.md §10**. Essa seção não existe mais — o CLAUDE.md foi
> reestruturado em seções nomeadas e o detalhe operacional migrou para `docs/agent/`.*

## Reconferência de produção — 2026-08-06 (4 semanas depois)

Este post-mortem ficou fora do versionamento desde 07-09 (só como arquivo não commitado no
diretório principal) e entrou no repo pelo #1665. Ao commitar, as afirmações centrais foram
**remedidas em PROD** via `~/.config/afiacao/psql-ro` — nenhuma envelheceu, nada religou sozinho:

| Afirmação (medida em 2026-07-09) | Remedido em 2026-08-06 |
|---|---|
| `reposicao_auto_aprovacao_log` vazio (*ever*) | ✅ `count(*) = 0` |
| Fusível `reposicao_auto_aprovacao_ativa` off | ✅ `false` |
| Régua de R$3k zerada (alerta + gate de disparo) | ✅ `reposicao_alerta_pedido_valor_minimo = 0` |

Chaves dormentes conferem com o descrito acima: `delta_max=0.30`, `cooldown_falha_horas=48`,
`corte_utc=13:00` (órfã). **O aviso 🚨 continua valendo integralmente** — o piloto não ganhou
validação por ter passado mais um mês desligado. Ausência de incidente em código que nunca
executou é ausência de dado, não evidência de segurança.
