# A sonda que mede o marcador do objeto ERRADO — sempre-vermelha diagnostica pendência

**Data:** 2026-09-07 · **Domínio:** banco / apply manual (Lovable) · **Skill:** `lovable-db-operator`
**Caso:** `20260907095841_disparado_simulado_e_estado_pos_disparo.sql` (money-path)

> **A classe:** uma sonda cujo marcador pertence a **outro objeto** que não o consultado é
> incondicionalmente vermelha — e vermelha, numa sonda de apply, **não é um alarme: é um
> diagnóstico**. "PENDENTE" é uma afirmação sobre o mundo, e essa sonda a emite sem nunca ter
> olhado para o mundo. É o espelho exato de `sempre-verde aprova TUDO`
> ([falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md)), com a agravante de
> **parecer diligência**: quem recebe "PENDENTE" age, cola SQL, mexe em produção.
>
> **O par simétrico:** [sonda-marcador-congelado.md](sonda-marcador-congelado.md) é a outra metade
> desta família — lá o marcador é o certo mas está **parado no tempo** (bump omitido), e o defeito
> produz falso **positivo** ("está no ar"); aqui o marcador está no objeto **errado**, e o defeito
> produz falso **negativo** permanente. As duas dizem a mesma coisa por lados opostos: **um marcador
> só prova o que prova se você souber a que objeto ele pertence e de quando ele é.**

## O defeito

A sonda que abriu a sessão:

```sql
SELECT CASE WHEN pg_get_functiondef(p.oid) ILIKE '%aceito_portal_sem_protocolo%'
            THEN 'ja aplicada' ELSE 'PENDENTE' END
  FROM pg_proc p ... WHERE p.proname = 'reposicao__valida_cancelamento_pos_disparo';
```

O marcador `aceito_portal_sem_protocolo` aparece 2× na migration — **linhas 146 e 180, ambas dentro
do bloco `cancelar_pedido_sugerido`** (118–192). O trigger consultado é o bloco **50–117**. O
marcador nunca esteve no corpo dele, nem na versão nova. A sonda retorna `PENDENTE` para todo
estado do banco, hoje e depois de qualquer apply.

O erro não está na regex, no `ILIKE`, nem no `%`: cada peça é defensável isolada. Está no **par
(marcador, objeto)**, que nenhuma peça sozinha valida. Por isso escapa à revisão que lê a query
procurando um bug de sintaxe — não há um.

## Por que passou: o veredito estava CERTO por coincidência

O que blindou o defeito foi o estado do mundo concordar com ele. A migration **estava** mesmo
pendente — e não parcialmente: as **três** funções em forma antiga, provado pelo corpo literal em
prod (`IF OLD.status NOT IN ('disparado', 'concluido_recebido')`). A sonda quebrada e a realidade
deram a mesma resposta, e a coincidência passou por confirmação.

É a condição em que esse defeito é indetectável por observação: **enquanto o mundo está no estado
que a sonda sempre alega, ela é indistinguível de uma sonda boa.** Só o primeiro apply a
desmascararia — e aí ela diria "PENDENTE" sobre algo aplicado, pedindo um segundo apply.

Nota lateral: o corpo ANTIGO não mencionava `disparado_simulado` nem em comentário (0 ocorrências),
então ali até um predicado ingênuo teria funcionado. A exigência de casar a **estrutura** da
condição — registrada em
[disparado-simulado-nao-era-estado-pos-disparo.md](disparado-simulado-nao-era-estado-pos-disparo.md)
— vale para o corpo **novo**, cujos comentários citam o estado várias vezes. As duas armadilhas são
distintas e independentes: uma é o predicado fraco demais, outra é o alvo trocado.

## A defesa: falsificar a sonda contra o estado "ANTES"

Antes de confiar num `✅`, exija que a sonda saiba emitir `❌` — e prove isso **sobre o texto real do
estado anterior**, não sobre um exemplo inventado. Na prática, custa uma linha: capture o corpo vivo
ANTES do apply e guarde-o.

```sql
-- os predicados, rodados contra o corpo ANTIGO capturado da prod (dollar-quote evita escapar aspas)
SELECT ($falsif$<prosrc antigo>$falsif$ ~ 'OLD[.]status NOT IN [(][^)]*disparado_simulado');
--  f  ← a sonda DISCRIMINA. Se vier t, ela é cega e o ✅ dela não vale nada.
```

Medido neste caso: `f` nos três corpos antigos, `t` nos três vivos. É o mesmo movimento da
falsificação de teste — sabotar e exigir vermelho — aplicado à **sonda de leitura**, onde costuma
ser esquecido porque "é só um SELECT".

O corolário prático, para apply manual: a sonda boa é a que **vira**. Se ela deu o mesmo veredito
antes e depois do Run, ou o Run não pegou, ou a sonda não mede.

## O segundo achado: medição única mente sobre o PRESENTE

No meio desta sessão o banco mudou. A primeira medição mostrou as 3 funções antigas; minutos depois,
os mesmos predicados deram verdadeiro. A divergência entre corpo vivo e arquivo caiu de **12/21/8
linhas para 2/2/2** — e essas 2 são linhas vazias de borda, artefato da extração do `prosrc`. Alguém
aplicou a migration enquanto eu preparava o handoff.

Com ~30 worktrees e o founder operando o SQL Editor em paralelo, **o estado do banco não é estável
dentro de uma sessão**. Um diagnóstico medido no início e entregue no fim descreve um passado. Aqui
teria produzido um handoff redundante — pedir para colar SQL já aplicado — que é barato por
idempotência, mas gasta a confiança no diagnóstico.

É a mesma regra que o CLAUDE.md já impõe para o `gh pr create` ("RE-conferir imediatamente antes"),
estendida ao banco: **re-meça imediatamente antes de entregar o handoff, não só ao diagnosticar.**

## Resíduo

1. **Sonda de apply: case marcador e objeto no MESMO bloco.** Antes de escrever a query, confirme
   com `grep -n '<marcador>\|^CREATE OR REPLACE FUNCTION'` que o marcador cai dentro do bloco da
   função consultada. Uma linha, pega a classe inteira.
2. **Falsifique a sonda contra o corpo anterior real** antes de aceitar o `✅` dela. Capture o
   `prosrc` vivo ANTES do apply — é a única linha de base disponível depois que o Run acontece.
3. **Re-meça antes de entregar**, não só ao diagnosticar. O banco tem outros escritores.

A sonda corrigida para este caso, que casa estrutura e objeto certo:

```sql
SELECT CASE WHEN prosrc ~ 'OLD[.]status NOT IN [(][^)]*disparado_simulado'
            THEN 'ja aplicada' ELSE 'PENDENTE' END
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
 WHERE p.proname = 'reposicao__valida_cancelamento_pos_disparo';
```

**Desfecho:** as duas migrations pendentes foram aplicadas pelo founder e validadas por mim via
`psql-ro` — `20260907095841` (3 funções na forma nova, trigger armado, ACLs e gate canônico
preservados, guard de portal intacto) e `20260907101349` (4/4 alvos da onda 1 ativos, invariante
`banco ⊆ repo` fechado em 7 = 7).
