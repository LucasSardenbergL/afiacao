# Máquinas meta — quando construir, e como

> Máquina meta = gate, sensor, sonda, hook, motor, laboratório, corpus: código que vigia código.
> Regra viva no `CLAUDE.md` (Armadilhas): **máquina nova só com INCIDENTE citado por ID no PR.**
> Origem: [loop-de-chips.md](../historico/loop-de-chips.md) — de 09 a 28/09, 55% dos chips eram meta
> achada de passagem, ~60 de 82 vindos de 5 máquinas, vários causados por máquina recém-criada por
> OUTRA sessão.

## Quando construir (critério operacional — parecer do Fable 5.1, 2026-09-29)

Cumulativo. Registre no corpo do PR `Máquina meta: <#incidente | nenhuma>` (auditável por grep, sem hook):

1. **Dano NOMEADO fora do repo** — usuário ou founder viu erro em prod, dinheiro errado,
   deploy/migration silenciosamente ausente — **ou** verde-falso PROVADO num PR de PRODUTO.
   CI vermelho, lento ou flaky não é incidente; o vermelho da própria máquina nunca justifica uma
   segunda máquina.
2. **Recorrência ≥2**, ou dinheiro/irreversibilidade já na 1ª. 1ª ocorrência reversível → conserta a
   instância e registra 3 linhas em `docs/historico/`.
3. **Nasce com DONO do vermelho** — quem conserta quando apita. Sem dono é fábrica de chip (caso: o
   mutation-check vermelho em todo PR porque o gate do #2629 nasceu sem cenário que o derrubasse).

Exceções: sensor de uso de PRODUTO que nasce com a superfície (regra "Fase N+1 exige SINAL" do
`CLAUDE.md`); falsificação de guard money-path (método de [money-path.md](money-path.md)).

## Como construir (movido do `CLAUDE.md` em 2026-09-29 — eram resumos de `docs/historico/`)

- **Laço de espera é fail-OPEN por omissão** — `until <sucesso>; do sleep; done` só reconhece o sucesso; abort, arquivo sobrescrito e processo morto caem em *continuar esperando* (`ausente ≠ zero` no TEMPO). Exija **teto + ramo que DIZ "não consegui"**, e marcador que casa a FALHA. → `docs/historico/espera-sem-desistencia.md`
- **Sonda ausente: degradar é certo no SENSOR, errado no script que APAGA.** Sonda de script destrutivo é **fail-CLOSED** — e **`command -v` não basta** (presente-porém-QUEBRADA esvazia o guard igual): exija resposta POSITIVA. `set -e` é suspenso pelo CONTEXTO DE CHAMADA (`if ! f` sobrevive; `f;` morre) ⇒ `| head` latente engana a varredura. → `docs/historico/sonda-ausente-em-script-que-apaga.md`
- **Gate textual limpa comentário com o stripper COMPARTILHADO** (`removerComentarios` de `@/lib/gates/limpeza-fonte`) — **nunca** regex local: ela não sabe o que é string e apaga o miolo do arquivo ANTES da medição (verde por CEGUEIRA). Gate novo herda o sentinela do maior bloco contíguo descartado, e escolhe a CAMADA do stripper pelo que MEDE (markdown: `removerCercas` de `scripts/lib/markdown-codigo.ts`; **shell: `removerComentariosShell` de `@/lib/gates/limpeza-shell`**). Alarme de stripper tem DOIS lados (sobre- **e SUB**-limpeza), e **sensor que consulta a máquina que vigia herda o defeito dela** → ≥1 eixo POR FORA. → `docs/historico/gates-textuais-cegos.md`
