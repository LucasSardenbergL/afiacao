# Reforma tributária, Simples e NF-e — guias externos da OpenAccountants (ponteiro PINADO)

> ⚠️ **O conteúdo externo é RASCUNHO com fontes citadas ("source-cited draft"), SEM revisão de
> contador (CRC)** — o próprio guia declara `reviewed_by: pending`. Serve para entender a regra e
> formular a pergunta certa ao contador; **nunca** para apurar imposto nem decidir regime. Vale a
> regra 5 desta skill: na dúvida, "confirmar com contador".

## O que é, e por que é ponteiro (não cópia)

Três guias do projeto [OpenAccountants](https://github.com/openaccountants/openaccountants)
(© Glimpse Ltd), sob a **OA Guide License v1.0** (SPDX `LicenseRef-OA-Guide-License-1.0`).

O texto **não** é copiado para cá: este repo é **público**, e a licença só libera redistribuição
**não comercial** (§2e) — num repo público de empresa isso é zona cinzenta; embutir os guias em
produto ou agente **oferecido a terceiros** exige licença comercial (§4a). O uso aqui é o do §2(a):
a empresa consultando os guias para os próprios tributos, pelo assistente que ela mesma usa.

## Os guias — pinados no commit `2338bb0c` (2026-09-27)

| guia | cobre | tamanho |
|---|---|---|
| `brazil-vat` | tributos sobre consumo (PIS/Cofins, ICMS, ISS, IPI, Imposto Seletivo) e a reforma: EC 132/2023, LC 214/2025, LC 227/2026 (2ª fase). **2026 = fase de teste: CBS 0,9% + IBS 0,1%** destacados na nota | ~8,9 mil palavras |
| `br-simples-nacional` | Simples Nacional: anexos, fator R, sublimite, DAS, CBS/IBS no Simples — a Colacor SC e a comparação Presumido × Simples | ~3,1 mil palavras |
| `brazil-einvoice` | NF-e, NFS-e, NFC-e, CT-e, SEFAZ e os campos de CBS/IBS nos documentos de 2026 | ~4,0 mil palavras |

URLs — **sempre neste sha**, nunca `main` (o upstream publica toda semana):

- https://raw.githubusercontent.com/openaccountants/openaccountants/2338bb0caeb8709675203319bf1172bdb5727523/agent-skills/brazil-vat/SKILL.md
- https://raw.githubusercontent.com/openaccountants/openaccountants/2338bb0caeb8709675203319bf1172bdb5727523/agent-skills/br-simples-nacional/SKILL.md
- https://raw.githubusercontent.com/openaccountants/openaccountants/2338bb0caeb8709675203319bf1172bdb5727523/agent-skills/brazil-einvoice/SKILL.md

## Como usar

1. Só quando a pergunta for de **regra** (reforma, alíquota-teste, regime, anexo do Simples,
   documento fiscal) — não para número do Grupo, que vem do banco (`schema-financeiro.md`).
2. Leia **sob demanda** (WebFetch ou `curl -fsSL` na URL pinada) e só o guia necessário: os três
   somam ~16 mil palavras.
3. No relatório, cite a fonte como "OpenAccountants @2338bb0c — rascunho sem revisão de CRC".
4. Divergência com o contador → **o contador vence**; registre a dúvida em
   `assets/templates/perguntas-contador.md`.

## Limites conhecidos

- **Não cobre split payment** — nenhum dos três (o tema só aparece em `br-return-assembly`, fora
  deste pin).
- É rascunho sem CRC; não substitui a lei complementar nem a regulamentação vigente.
- **Atualizar o pin:** novo sha → `skill-scanner` offline no guia → reler a licença → trocar o sha
  aqui e na tabela de `docs/agent/skills.md`.
