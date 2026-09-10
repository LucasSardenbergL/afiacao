# Piloto: o Codex propondo mutação (autor independente do teste)

**2026-09-09** · money-path · uma chamada `codex-async.sh -r max` · **99s · 15.181 tokens**

## O que se testou

Os 25 contratos de `scripts/mutcheck.d/` foram escritos **pelo mesmo autor dos testes** — ponto cego correlacionado por construção. A hipótese: um autor independente encontra mutação que o autor do teste não pensou.

Mandei ao Codex a fonte e o teste de `src/lib/financeiro/aging-helpers.ts` **sem mostrar o contrato existente**, pedindo 10 linhas no formato `.mut` com o palpite `PEGA`/`SOBREVIVE` de cada uma. O gabarito humano (`scripts/mutcheck.d/aging-helpers.mut`, 8 linhas) ficou de fora do prompt e serviu de comparação depois.

## Resultado medido

| Métrica | Valor |
|---|---|
| Padrões cirúrgicos (casam exatamente 1 linha) | **10/10** — zero ambíguos, zero não-casados |
| Predições corretas | **10/10** (8 `SOBREVIVE` confirmadas, 2 `PEGA` confirmadas) |
| Inválidas (não compilam / não casam) | **0** |
| Sobreviventes **ausentes** do contrato humano | **6 de 8** |

Comando: `scripts/mutcheck.sh src/lib/financeiro/aging-helpers.ts src/lib/financeiro/__tests__/aging-helpers.test.ts <candidato>` — `baseline: ✓ verde`, `controle+ ✓ (2/2)`.

Candidato preservado em `docs/superpowers/specs/2026-09-09-candidato-codex-aging-helpers.mut`.

## As 6 lacunas novas

Nenhuma estava documentada no contrato humano, que cobria a mediana pelo ramo par/ímpar e a concentração como borda heurística — mas não estas:

- `a.lags.push({ valor: lag, peso: pago })` → `peso: 1` — ponderação por valor vira ponderação simples.
- `Math.min(1, Math.max(0, 1 - perdaNova))` → sem o `Math.max(0, …)` — taxa de recebimento pode ficar **negativa** numa projeção de caixa.
- `input.lag_residual_default ?? 15` → `?? 0` — prazo residual ausente vira zero (a classe `ausente ≠ zero`).
- `[...xs].sort((a, b) => a - b)` → `.sort()` — ordenação **lexicográfica** dentro de uma mediana.
- `a.exposicao >= minVolume` → `>` — borda do volume mínimo.
- `saidaDiaria > 0.01` → `>= 0.01` — borda do piso (o contrato humano cobria a direção oposta, `> 0` , como `PEGA`).

## Leitura honesta

**Sobreviveu ≠ bug.** Significa que o teste não detecta aquela mudança — lacuna de cobertura, não defeito de produção. O valor é transformar cada uma em decisão explícita: cobrir, ou marcar `SOBREVIVE | <motivo>` no contrato.

**10/10 não quer dizer "o Codex acerta 100%".** As mutações foram escolhidas **por ele**; o número mede a calibração dele naquilo que escolheu propor, não a taxa de acerto sobre amostra difícil. Um teste mais duro pediria 20 e olharia a distribuição, ou fixaria as mutações antes de pedir o palpite.

**O que o piloto sustenta:** o formato saiu perfeito de primeira num arquivo que ele nunca viu (10/10 cirúrgicas), e 6 das 8 lacunas não estavam no gabarito humano. Isso é evidência a favor da hipótese do autor independente — não prova de superioridade de modelo, que exigiria o controle com 2ª sessão Claude e orçamento igual.
