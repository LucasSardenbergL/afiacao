# Replay — modo PACOTE do F0′ dos suaves (implementação da spec 2026-11-09 §4.4)

**Entrega:** o modo "pacote" do replay `scripts/reposicao-replay/`, que mede o F0′ nos 12 SKUs suaves da coorte Sayerlack/OBEN junto com F1/F2/F3 nos intermitentes, com a régua de capital para mudança que **compra** serviço (D1/D1b). Spec: [2026-11-09-f0-suaves-atendimento-a-design.md](../superpowers/specs/2026-11-09-f0-suaves-atendimento-a-design.md) (Codex de desenho APROVA na rodada 4). Ponto de partida: o NO-GO oficial do TSB ([reposicao-replay-tsb.md](reposicao-replay-tsb.md)).

**Fora desta entrega:** a rodada oficial do pacote sobre os dados (outra sessão, numa extração de dia útil feita depois do motor do dia, R40), migration, edge, `db/embalagem-motor-rpc.sql` e produção.

## O que entrou

| Peça | Onde | Contrato |
|---|---|---|
| Perfil do F0′ (`P0`, `Alt1`, `Alt2a`, `Alt2b`) | `formulas.ts` (`PerfilF0`, `sugestaoF0`, `pontoDePedidoF0`) | tabela da §4.4 campo a campo; o **status** é sempre o do P0 (o perfil muda o valor, nunca quais dias têm sugestão); vigência a partir de 01/02, aquecimento sempre P0 |
| Demanda e σd por du | `janelaPorDu`/`demandaPorDu`/`sigmaPorDu` | venda < d no balde do du (fim de semana → du anterior); a de borda esquerda cujo du cai fora da janela não entra; feriado não existe no calendário |
| Cache | `chaveCache` | o perfil entra na chave; P0 mantém a chave do modo oficial |
| Calibração do pacote | `calibracao.ts` (`calibrarPacote`, `escolherTupla`, `estadoDaTupla`) | §4.2: lista finita de 29 perfis × {F1, F2, F3}; `calibrar` sem mudança; tupla inteira; três estados (qualquer INDETERMINADA ⇒ seleção INDETERMINADA, nunca a valorada por exclusão) |
| Régua 3′/3″ | `estatistica.ts` (`avaliarCriterios(ev, { pacote: { teto } })`) | 3′ = a grade de economia (absorve o 5); 3″ = aumento = −redução, PASSA com LS ≤ teto, FALHA com LI > teto; os dois também no estresse (D1b) |
| Avaliação | `rodar.ts` (`Congelado.suaves`, `mapaPacote`) | baseline = F0 de hoje; `A_alt` = máscara dos intermitentes ORIGINAIS |
| Orquestração e relatório | `pacote.ts` | `bun scripts/reposicao-replay/pacote.ts [--dados DIR] [--paralelo N] [--estabilidade]`; o teto vem de `$REPLAY_DADOS/teto-capital-pacote.json` (`{"teto": 0.2}`), gravado ANTES da rodada — sem ele a rodada para |
| Diagnósticos (informativos) | `pacote.ts` | A suaves × A intermitentes, sem a 1ª semana, sem o 8689717792, capital por SKU (`simular({ capitalPorSku: true })`), fronteira capital × fill A com o benefício líquido, estabilidade (cortes fev–mar/mar–abr e leave-one-SKU-out) |

## Números nos dados de 09/11 (calibração, 50 réplicas — NÃO é a rodada oficial do pacote)

- **Paridade nula P0 × F0:** 0/1.656 SKU-dias diferentes na calibração e 0/3.132 na avaliação; o controle Alt1 difere em 768 e 2.244 (mesma invocação).
- **"F0 atual + F2" (β 0,02; 0,999/0,999/0,95):** célula A **93,94%**, estoque **+49,13%** — reproduz a grade oficial e a §3 da spec.
- Com as definições EXATAS da §4.4 (gravação completa, σd por du), os perfis rendem menos que a medição preliminar da §3 (que usava gravação simplificada e σd corrido):

  | suaves | só suaves: A / Δ estoque | pacote F2: A / Δ estoque |
  |---|---:|---:|
  | P0 | 90,58% / 0 | 93,94% / +49,13% |
  | Alt1 | 92,67% / +9,99% | 96,03% / +59,12% |
  | Alt2a z 2,326 | 93,67% / +23,87% | 97,03% / +73,00% |
  | Alt2b z 2,326 | 93,39% / +19,09% | 96,75% / +68,21% |

  O σd por du é menor que o corrido (os zeros de fim de semana saem), e isso tira margem: a Alt2a a z 2,326 cai de 98,11% (§3) para 97,03% no pacote.

## Validação

Registrada no corpo do PR (comandos e rc colados): suíte, typecheck, lint, knip, lint:shell, falsificação por camada nos dois locales, o modo oficial reproduzindo o NO-GO e o Codex adversarial do código.
