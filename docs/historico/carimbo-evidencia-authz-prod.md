# Carimbo de evidência dos audits de authz de produção

> **A classe (2026-08-25):** existir uma guarda, ela ser a ÚNICA que enxerga um vetor, e não haver
> nada que a faça rodar. Os três audits de prod (`authz:funcoes:prod`, `authz:grants:prod`,
> `authz:audit:prod`) rodavam quando um humano lembrava. `rg` em `.github/` devolvia **zero**
> ocorrência: nenhum runner periódico, em lugar nenhum.
>
> A regra que fica: **guarda sem cadência não é guarda, é uma coisa que já foi rodada uma vez.** E
> a cadência precisa de um artefato — "rodei e estava limpo" que não deixa rastro é indistinguível
> de não ter rodado.

## Por que o CI não resolve, e por que isso não é desculpa

O gate estático (`authz:check`) lê `supabase/migrations/` e é **cego por construção** a dois
vetores que o cabeçalho de `db/audit-grants-funcoes-fechadas.ts` já nomeava:

1. `GRANT`/`REVOKE` colado à mão no SQL Editor do Lovable — não passa por migration nenhuma;
2. migration que mergeou na main e **nunca foi aplicada** — a armadilha-mãe do projeto.

Só os audits de prod veem isso, e eles não rodam no CI porque o runner do GitHub não tem `psql-ro`
— e não deve ter: a credencial é local (`~/.config/afiacao/psql-ro`, role `claude_ro`). Logo "põe
no `ci.yml`" não é a resposta, e o domínio já tinha registrado a lacuna sem fechá-la
([sentinela-authz-controle-nao-mencao.md](sentinela-authz-controle-nao-mencao.md) §9.6):

> "quem o pega é o `authz:funcoes:prod`, que roda on-demand. Entre duas execuções, a janela existe."

## A medição que mudou o desenho

Rodei os três antes de projetar qualquer coisa. O baseline herdado dizia que estavam verdes:

| Comando | Exit | O que disse |
|---|---|---|
| `bun run authz:funcoes:prod` | **0** | o EXECUTE de prod bate com o contrato nas 43 funções |
| `bun run authz:audit:prod` | **0** | gate do manifest vale nas 19 vivas; as 3 reescritas batem no md5 |
| `bun run authz:grants:prod` | **1** | `[DRIFT_PROD] public.sales_orders: anon tem INSERT,DELETE fora do permitido` |

O achado do `grants` **não é novo** — está documentado e aberto desde 2026-08-13
([sentinela-grants-tabelas-fechadas.md](sentinela-grants-tabelas-fechadas.md), "Achado 2"),
deliberadamente não silenciado na allowlist, esperando um `REVOKE` colado no SQL Editor. A causa
real não é grant manual: é resíduo do default `arwdDxtm` do Supabase que nenhum REVOKE mirou.

**É a tese se provando sozinha.** O alarme era real, estava correto, e ficou dormente 12 dias
porque nada o re-levantava. E derrubou a primeira versão do desenho: "carimbo com `exit != 0` →
vermelho bloqueante" **nasceria vermelho** e travaria a fila de merge de ~30 worktrees por um
achado que nenhum PR consegue consertar. Gate vermelho-na-chegada é gate que morre.

## O desenho: a medição fica onde está a credencial, o sinal onde já há cadência

`db/authz-carimbo-prod.json` é escrito **só** por `bun run authz:carimbo:gravar` (roda os 3 audits
sob `psql-ro`) e lido por `bun run authz:carimbo` (roda no CI, sem banco).

### Duas severidades, divididas por uma pergunta

**"Um PR consegue consertar isto?"**

| Eixo | Código | Onde | Bloqueia PR? | Conserto |
|---|---|---|---|---|
| Contrato mudou sem re-medir | `CARIMBO_CONTRATO_MUDOU` | step no `validate` | **sim** | `authz:carimbo:gravar` + commit |
| Auditor mudou sem re-medir | `CARIMBO_AUDITOR_MUDOU` | step no `validate` | **sim** | idem |
| Carimbo ausente/ilegível/no futuro | `CARIMBO_AUSENTE` | ambos | **sim** | idem |
| Carimbo > 14 dias | `CARIMBO_VELHO` | job `authz-sentinela` (main) | não | idem |
| Achado vivo em prod | `CARIMBO_ACHADO` | job `authz-sentinela` (main) | não | paste do founder no SQL Editor |

Os eixos de **contrato** e **idade** cobrem vetores **disjuntos** — a mesma simetria de "duas
guardas e nenhuma sozinha basta" que o audit já carregava. O de contrato pega "função nova
declarada fechada e nunca verificada em prod" (muda o repo). O de idade pega "GRANT colado à mão"
(muda prod; o repo não se move, então o fingerprint nunca dispararia).

### Canal próprio, não `ci-main-red`

O job sentinela abre/fecha Issue com label `authz-prod`. Reusar a `ci-main-red` degradaria os dois
sinais: o corpo dela afirma *"Provável reversão por commit direto do Lovable"* — diagnóstico errado
aqui, que mandaria o founder para `deploy.md` procurar um incidente inexistente. É o precedente dos
quatro vazios no mesmo pixel de [fase-sem-sinal.md](fase-sem-sinal.md) §2.

### O monitor fica VERDE com produção suja

O job só falha quando o **gate não conseguiu avaliar** (exit 2). *"O monitor funcionou"* e
*"produção está limpa"* são fatos diferentes; o vermelho de produção vive na Issue. Um job que
mistura os dois produz um sinal que não se sabe ler.

## O que o ritual `/codex` (xhigh) mudou — e o que eu recusei

Duas afirmações do parecer eram **falsificáveis e as verifiquei antes de aceitar**:

| Afirmação do Codex | Verificação | Veredito |
|---|---|---|
| O audit de grants mede 6 dos 8 privilégios | `privBase` = SELECT/INSERT/UPDATE/DELETE/TRUNCATE (+MAINTAIN no PG17) em `db/audit-grants-tabelas-fechadas.ts`; o tipo `Priv` de `scripts/authz-tabelas-fechadas.ts` enumera 8 | ✅ **`REFERENCES` e `TRIGGER` são declaráveis e nunca medidos** |
| `JSON.stringify` de `Set`/`Map` é cego | executado: `Set -> {}  Map -> {}` | ✅ **fingerprint ingênuo nasceria cego** |

O segundo é o achado que mais mudou código: o contrato de authz **tem** `Set` e `Map`
(`ACKNOWLEDGED_SENSITIVE`, `ACL_ONLY_INTERNAL`, `REESCRITAS_CONHECIDAS_INDEX`), e um fingerprint
por `JSON.stringify` seria verde por cegueira. Daí `canonicalizar()`, com tag de tipo (`Set(['a'])`
não colide com `['a']`) e **fail-closed**: valor que ele não sabe representar **lança**, em vez de
virar `{}`.

Também incorporados: `auditor_fingerprint` separado do de contrato (contrato igual + instrumento
incompleto = verde cego — o bug do `REFERENCES` é a prova); `exit 2` **não** sobrescreve o carimbo
(senão falha de rede renovaria a data e a idade recomeçaria); `primeiraVez` por achado, preservada
entre execuções; recusa de `AUTHZ_*_TEST_JSON`/`PSQL_RO` alternativo e pin do cluster por hash do
`system_identifier`; `sourceHead` rebaixado a informativo.

**Onde divergi, e por quê.** O parecer pedia uma *projeção semântica enumerada* (listar os campos
que entram no fingerprint). Recusei: enumerar tem a falha oposta e é exatamente o apodrecimento que
o próprio parecer previu — *"campo semântico novo entra no contrato e fica fora da projeção"*. O
serializador é **estrutural com lista de EXCLUSÃO fechada** (`motivo`, `provaExecutada`): campo
novo entra por default, e a direção do erro passa a ser fail-safe.

**Recusei por escopo** (viram limites declarados, não silêncio): consertar `REFERENCES`/`TRIGGER`
no audit de grants, ACL por coluna, reconciliação de RLS vivo, saída JSON estruturada dos audits, e
a máquina de SLA/assignee com bloqueio direcionado. São conserto do **instrumento**; esta entrega é
a **cadência** dele. Misturar as duas entregaria as duas pela metade.

## Limites declarados

1. **O carimbo é AUTO-RELATO.** Nada dentro do repo prova que o comando rodou — a credencial vive
   fora dele. A garantia é *"alguém rodou ESTES auditores contra ESTE contrato há no máximo N
   dias"*. A defesa contra fabricação é econômica, não criptográfica: rodar é 1 linha; forjar exige
   manter dois fingerprints coerentes à mão. O modelo de ameaça é **erro, não fraude**.
2. **Não atesta "a autorização de prod"** — atesta três fatias curadas. Pontos cegos **medidos**:
   `REFERENCES`/`TRIGGER` nunca medidos; ACL por **coluna** fora (`has_table_privilege` é
   table-level — e é justamente o vetor de `sales_orders`, `GRANT SELECT (omie_payload)`); RLS vivo
   (`relrowsecurity`, policies, `qual`/`with_check`) não reconciliado por nenhum dos três.
3. **N não é latência de detecção.** A janela real é `N + atraso do schedule + tempo até alguém
   rodar + tempo até o founder aplicar`. Por isso há **dois** limiares: aviso em 7 dias (não pune,
   aparece na saída e na Issue) e vencimento em 14. Ratchet: uma constante em
   `scripts/lib/authz-carimbo.ts`.
4. **`schedule` do GitHub não é relógio garantido** — atrasa, descarta run, e é desabilitado após
   60 dias sem atividade no repo.
5. **Janela intra-período:** prod pode mudar um minuto depois de uma medição limpa. Nenhum carimbo
   fecha isso; só reduz o tamanho da janela.
6. **`denominador` do `grants` é `null`** — aquele audit não emite linha `🔎`. Registrado como
   `null` honesto, não fabricado.

## Prova

| Comando | Exit | O que diz |
|---|---|---|
| `bun run authz:carimbo:gravar` | **0** | grava o carimbo; alvo `claude_ro@PostgreSQL 17.6`, read-only, cluster `a0010e4a9b3b3e6b` |
| `bun run authz:carimbo` (modo PR) | **0** | contrato e auditores batem; imprime o achado como ⚠️ sem bloquear |
| `bun run authz:carimbo -- --exigir-frescor` | **1** | `[CARIMBO_ACHADO] grants … (aberto desde 2026-08-13)` |
| `bunx vitest run scripts/authz-carimbo.test.ts` | **0** | 36 testes |

**Falsificação** (sabotar a lib e exigir vermelho — commit feito antes, `restaurar()` é
`git checkout --`), casando o **código delimitado** do ramo, não "lançou algo":

| # | Sabotagem | Resultado |
|---|---|---|
| F1 | `canonicalizar` volta a ser `JSON.stringify` (o bug do `Set -> {}`) | 🔴 vermelho |
| F2 | eixo de idade nunca dispara (`if (false)`) | 🔴 vermelho |
| F3 | `idFinding` volta a usar a linha inteira (prosa lava a dívida) | 🔴 vermelho |
| F4 | `CARIMBO_CONTRATO_MUDOU` deixa de bloquear | 🔴 vermelho |
| F5 | **controle inócuo** (insere um comentário) | 🟢 verde — o gate não é vermelho-sempre |

O carimbo nasceu com a dívida **datada corretamente**: `primeiraVez: 2026-08-13`, não a data do
rollout. Sem essa semente, o próprio rollout teria apagado 12 dias de dívida — e um achado
"conhecido e fresco" para sempre é o modo pelo qual re-executar vira o mecanismo de esconder o
problema.

## Pendente do founder

O alarme de `sales_orders` fica de pé até o `REVOKE` ser colado no SQL Editor do Lovable. O bloco e
a query de validação pós-apply estão no corpo do PR.
