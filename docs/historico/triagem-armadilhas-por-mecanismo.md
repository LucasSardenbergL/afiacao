# Triagem das Armadilhas por MECANISMO — e por que a minha própria triagem errou 35%

> **A classe (2026-09-07):** para decidir o que sai de um arquivo carregado em 100% das sessões, o
> teste certo é *"qual comando fica vermelho se eu violar isso?"*. Mas responder esse teste **lendo
> o que o próprio manual afirma sobre a máquina** é circular: as afirmações do manual sobre os
> próprios gates envelhecem, e nada verifica que envelheceram. Eu apliquei o teste às 23 armadilhas
> do CLAUDE.md, uma auditoria independente conferiu, e **6 das 17 afirmações verificáveis eram
> falsas**. O corte que eu propus era 3,2× maior que o corte real.

**Como apareceu:** o founder perguntou *"como podemos trabalhar melhor o CLAUDE.md? fui fazendo no
impulso e não fiz a segmentação correta"*. A medição mostrou o arquivo em **2.599/2.600 palavras** —
1 palavra de folga.

## 1. Os números medidos (não estimados)

| Métrica | Valor |
|---|---|
| CLAUDE.md | 110 linhas · 19.752 B · **2.599 palavras** · ~5.643 tokens |
| Teto do `claude:size` | 20.480 B / **2.600 palavras** → **folga: 1 palavra** |
| `## ⚠️ Armadilhas` | **1.228 palavras = 47% do arquivo**, 23 bullets, maior com 143 palavras |
| Sensor `InstructionsLoaded` (16 dias) | 1.605 loads · **1.060 sessões** · 0 erros do sensor |
| Custo bruto | **≈9,1 M tokens em 16 dias** só de CLAUDE.md; 4,3 M só de Armadilhas |
| Loads vindos de worktree | 1.339 de 1.605 |

**Compactar não muda a inclinação:** o commit `105d00b9d` levou Armadilhas de 1.079 → 1.000
palavras. Hoje está em **1.228**. Recresceu 228 em semanas — exatamente o que o cabeçalho do
`check-claude-md-budget.sh` previu.

## 2. O eixo — e por que o eixo sozinho não basta

A tese: o arquivo está segmentado por **assunto** (banco/deploy/sync), mas o eixo que decide custo
e segurança é **o que garante que a regra não seja violada**. Por esse eixo as armadilhas são
4 espécies: (a) já é máquina · (b) pode virar máquina · (c) julgamento · (d) domínio duplicado.

**O painel corrigiu o eixo.** Ele decide bem o que pode ser REMOVIDO, mas não decide o que precisa
ser UNIVERSAL. São três critérios, não um:

1. **necessidade antes da ação** — a regra precisa ser conhecida antes da primeira decisão?
2. **alcance entre tarefas** — vale para qualquer tarefa ou só ao tocar um caminho?
3. **proteção executável demonstrada** — existe detector, ele é obrigatório, e bloqueia ANTES do efeito?

O critério 3 tem três partes e eu tratei como uma. Um bullet carrega **várias obrigações**; o gate
costuma cobrir uma. E **gate e texto agem em momentos diferentes**: o gate reprova o trabalho
pronto, o texto muda a decisão antes da linha ser escrita.

## 3. O placar — 11 confirmadas, 6 refutadas

O que eu afirmei ao classificar, e o que a auditoria encontrou no repo:

| # | Bullet | pal. | Eu disse | Verdade |
|---|---|---|---|---|
| 14 | falsificação de teste | **143** | coberto por `test:falsificacao` | **vigia de FORMA**: só exige que suítes `scripts/test-*.sh` com `--falsificar` rodem com a flag (`scripts/falsificacao-cobertura.test.ts:6-8`). Não varre `WHEN OTHERS THEN 'OK'`, SQLSTATE, `SET ROLE`, `toThrow()` pelado |
| 15 | evidência positiva | 67 | 2 hooks cobrem | `bash-contexto-nudge.sh:2-10` é sobre **tamanho de saída**; `pipestatus-zsh-guard.sh` **avisa sem bloquear** — disparou nesta sessão declarando *"AVISO, não um bloqueio"* |
| 22 | deploy de edge / ledger | 60 | coberto por `pendencias:deploy` | não está no `ci.yml` nem em `settings.json`; só as skills `/fecho` e `lovable-deploy-verify` o chamam |
| 17 | sonda fail-CLOSED | 56 | hook `sonda-processo-guard` | hook errado — ele vigia `pgrep -f`/`ps` em laços, advisory. A cobertura real é `scripts/test-wt-clean.sh:15-16,84,177` |
| 12 | lente "Ver como" | 23 | **sem** gate | **tem**: `eslint.config.js:69-87` (`no-restricted-imports`, error) via `bun lint` (`ci.yml:326`) |
| 3 | sync Lovable reverte a main | 47 | **sem** gate | **tem sensor**: `.github/workflows/lovable-watch.yml` roda em todo push na main e abre Issue. Pós-fato, não pré-merge — mas não é "só texto" |

**Ressalva de mecanismo (confirmada):** `psql:errorstop` **não é step do CI**. A violação fica
vermelha via `scripts/test-psql-ro-error-stop.sh:98-116` (`test:hooks`) e
`scripts/psql-ro-error-stop-gate.test.ts:124` (vitest). Nomear "o comando que reprova" exige saber
QUAL — e o CLAUDE.md nomeava o errado.

**Confirmadas:** os 5 gates de edge (`ci.yml:153,189,238,256,268`) · manifesto de módulos
(`manifesto.gate.test.ts` + `fronteiras.gate.test.ts:13` no vitest — mas **`manifesto.gate` não é
comando nenhum**, é apelido) · o bullet de multi-sessão é ponteiro para a §108 do MESMO arquivo ·
`timeout_milliseconds` · laço de espera · stripper textual · PL/pgSQL · e os dois de domínio já
duplicados (`database.md:184`, `sync.md:78-79`).

## 4. Os dois buracos estruturais que a triagem revelou

### 4.1 `security_invoker` — declarado não-medido, no próprio código

`WITH (security_invoker=on)` omitido num `CREATE OR REPLACE VIEW` faz a view ler como OWNER e
**bypassar RLS em produção** — falha ABERTA. Hoje é protegida por 83 palavras de texto.

- `authz:check` roda no CI mas é **offline** e não menciona `security_invoker` (`scripts/authz-gate-check.ts`)
- `scripts/lib/authz-rls.ts:31-33` e `authz-carimbo.ts:39` **declaram que o eixo view/`invoker` NÃO é medido**
- os auditores que sabem (`authz:rls:prod`, `audit:migrations`) exigem banco e **não estão no `ci.yml`**

**Critério de aceite do gate futuro** (não basta grepar o texto): casos vulneráveis reprovam e
casos seguros passam, em banco descartável — presença textual da opção não prova isolamento.

### 4.2 Não existe Postgres no CI — e 288 provas não rodam

```
serviços postgres no ci.yml ......................... 0
scripts db/test-*.sh no repo ...................... 288
desses, citados em QUALQUER workflow ................. 0
única menção a db/test- no ci.yml ......... linha 331 — é COMENTÁRIO
```

Não é que faltou escrever o gate do `security_invoker` — **falta a infraestrutura onde qualquer
gate de SQL rodaria**. Um Postgres descartável no CI destrava de uma vez `security_invoker`,
`timeout_milliseconds`, PL/pgSQL late-bound e o REVOKE de duas pontas, e faz as 288 provas
existentes finalmente valerem.

## 5. A regra que sai disto

**Um manual que cita seus gates vale a frescura dos nomes.** O CLAUDE.md diz `manifesto.gate`
(comando inexistente), diz que `psql:errorstop` vigia (vigia, mas não como step de CI), e
**[CLAUDE.md:62](../../CLAUDE.md) diz "Sem cron de sonda ativa" quando existem três migrations**
(`20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql`,
`20260906151204_deploy_sonda_cron_fail_closed.sql`,
`20260907101349_deploy_sonda_alvos_onda1.sql`) e `_shared/sonda-cron-alvos.ts`.

⇒ **gate de frescura:** todo comando/gate citado no CLAUDE.md deve existir E ser invocado por CI ou
hook. Teria pego 4 dos meus 6 erros e a linha 62 sozinho.

**E o mapa erra nos DOIS sentidos.** O PR que trouxe este documento ficou VERMELHO no `validate`:
existe um gate `docs:indice` (`scripts/docs-indice-gate-check.ts`) que exige linha própria em
`docs/historico/README.md` para todo doc do diretório — e o CLAUDE.md **não o menciona em lugar
nenhum**. Escrevi um texto sobre afirmações que envelhecem e fui reprovado por maquinaria que o
manual nunca nomeou. Um gate que ninguém acha só reprova depois do fato; a mesma perda que um nome
que não aponta mais para nada. ⇒ o gate de frescura precisa dos dois lados: **nome citado que não
existe** e **gate que existe e não é citado**.

## 6. Fila (ordem deliberada)

1. **Gate de frescura** dos comandos citados — barato, pega a linha 62 e a classe inteira
2. **Postgres descartável no CI** — entrega própria; destrava toda a espécie (b) de SQL
3. **Corte enxuto: ~165 palavras**, não 530 — só o confirmado, mais a correção da linha 62.
   **Sem `--gerar-baseline` cego:** ele reescreve TODAS as seções com o valor de hoje
   (`check-claude-md-budget.sh:121-129`), então rodá-lo para a catraca clicar em Armadilhas
   legitimaria silenciosamente o crescimento de qualquer outra seção no mesmo commit. Aceitar
   só reduções, validando contra a revisão base.
4. **Regra de ENTRADA** — lição nova nasce classificada em (a)/(b)/(c)/(d) e só entra no CLAUDE.md
   se for (c). Sem isso recresce como já recresceu (1.079 → 1.000 → 1.228).

**Ordem dentro do corte:** (a) confirmado sai agora porque a máquina cobre; (b) só sai DEPOIS do
gate existir — cortar antes é trocar texto por nada. E **(d) não sai junto com (a)**: em (a) a
máquina cobre, em (d) a proteção continua sendo texto cuja entrega depende do agente seguir o
índice. São atos diferentes com riscos diferentes.

## 7. Pendências abertas

- **Divergência não resolvida:** `ausente ≠ zero` é testável na fronteira de dados (teste de
  null/undefined/vazio/zero-legítimo) ou é decisão semântica? Testar a fronteira valida o código
  escrito, não a decisão de fabricar o número. **Evidência que decide:** pegar os incidentes
  históricos de `Number(null)===0` e perguntar se um teste de fronteira os teria pego antes do merge.
- **Renomear a espécie (c)** de "julgamento que máquina nenhuma pega" para **"sem cobertura
  automática demonstrada"** — a formulação atual declara impossibilidade sem prova.
- **Split por `paths:` em `.claude/rules/`: DESTRAVADO.** Estava bloqueado por "subagente carrega
  CLAUDE.md?" (o sensor não distingue: `agent_type` aparece 0× em 1.605 registros). Mas identidade
  é proxy errado — a pergunta testável é **"a instrução chegou antes da ação?"**, verificável com
  tarefas controladas diretas/delegadas/pós-compact. A segurança não deve depender de descobrir
  como subagentes carregam texto: invariantes essenciais ficam na raiz e os bloqueios ficam nos
  executores.
- **Sensor:** `memory_type` vem no payload do `InstructionsLoaded` e é **descartado**. Extraí-lo é
  ~3 linhas e provavelmente identifica o mecanismo de carregamento.

## Ver também

- [split-claude-md-sensor.md](split-claude-md-sensor.md) — os 3 mecanismos de divisão e por que a
  divisão óbvia (`@import`) não economiza nada
- [fase-sem-sinal.md](fase-sem-sinal.md) — a fase N+1 exige sinal da fase N (o sensor É a fase 0)
- [gates-textuais-cegos.md](gates-textuais-cegos.md) — verde por cegueira em gate de texto
