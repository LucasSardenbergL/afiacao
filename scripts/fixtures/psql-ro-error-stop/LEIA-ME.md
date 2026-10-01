# Fixtures do gate `psql-ro` / `ON_ERROR_STOP`

Arquivos REAIS (não strings sintéticas no teste), com a expectativa no NOME:

- `viola-*` → o gate tem de sair **1** com este arquivo no corpo.
- `limpo-*` → o gate tem de sair **0**.
- `indeterminado-*` → o gate tem de sair **2**: o fiscal não sabe julgar a fonte, e isso nunca é
  "limpo" (desde 2026-10-01: o stripper e o parser do TS discordam sobre onde mora o caminho).

As `*.ts.fixture` de `l` em diante (`viola-m…o`, `limpo-l…o`, `indeterminado-a`) são do eixo da
instrução EMITIDA: o gerador que não executa o wrapper, mas IMPRIME o comando que o operador roda.

A extensão termina em `.fixture` de propósito: o `enumerar` do gate casa `.sh`/`.ts`, então estes
arquivos são invisíveis à varredura do repo. Sem isso, o fiscal se auto-acusaria — e "desligar a
regra para o fixture" é o começo de uma allowlist que ninguém revisita.

Consumidores (os DOIS, sobre os MESMOS bytes):
- `scripts/psql-ro-error-stop-gate.test.ts` (vitest, roda no CI);
- `scripts/test-psql-ro-error-stop.sh` (materializa em tmp, roda o CLI de verdade nos dois locales
  e, com `--falsificar`, sabota UMA camada por vez).

Cada fixture existe porque isola UMA camada: é a regra da casa aprendida no #2167 — contar casos
verdes não prova nada; a camada precisa de um caso em que ela é a ÚNICA que pode reprovar.
