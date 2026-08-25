# A canária que acumulava DOIS papéis — e por que a régua da sonda não serve nela

**Classe:** um mesmo marcador sendo usado como prova de **comportamento** e como prova de
**deploy**. Ele consegue a primeira e falha na segunda, calado — e quem lê acha que verificou.

Irmão de `sonda-marcador-congelado.md` (que trata do `VERSAO` da sonda), mas a régua é OUTRA, e é
por isso que este documento existe separado: aplicar o critério de lá aqui produz falso positivo.

Auditar os 6 `contrato` pelo critério da sonda ("último commit em `index.ts` mais novo que o
último que mexeu no marcador") acusa **4 defasadas**. Três são FALSO POSITIVO, e entender por quê
é a lição: **os dois marcadores respondem perguntas diferentes.** O `VERSAO` da sonda tem de
discriminar QUALQUER bundle; o `contrato` da canária nomeia a fatia que a **fixture** verifica, e
fica estável de forma legítima quando a edge muda em coisa que a fixture não cobre.

O que decide não é a data — é **quem é a única prova de deploy daquela edge**:

| edge | contrato | tem sonda? | veredito |
|---|---|---|---|
| `omie-vendas-sync` | `identidade-a2-client-to-user-v2` | não | ✅ em dia (#1974) |
| `generate-tactical-plan` | `v1.1-paginacao-eof-e-cursor` | sim | ✅ reusa o próprio `VERSAO` |
| `analyze-unified-order` | `praticado-vence-omie-v1` | sim | ok — a sonda prova o deploy |
| `omie-analytics-sync` | `doc-ambiguo-fail-closed-v1` | sim | ok — idem |
| `omie-financeiro` | `paginacao-guards-v1` | sim | ok — idem |
| **`carteira-rebuild`** | **`trava-saida-v1`** | **NÃO (era)** | 🚨 defeito — corrigido no #1999 |

**`carteira-rebuild` era o caso mais desprotegido do repo**, por uma combinação que nenhum gate
alcançava: sem `versao.ts` ficava fora do `sonda:bump` e do `sonda:fingerprint` (que só varrem
edge instrumentada); não importa `_shared/paginate.ts`, então o gate "nenhuma edge fica SEM prova
de deploy" a pulava — e ele **se declara piso**, então não é furo dele; e não estava em
`VERIFICAVEL_POR_CANARIA`, então nada registrava a canária como prova de deploy.

Resultado: o `contrato` acumulava os DOIS papéis e falhava no segundo. Congelado em 2026-07-20
(56f9f58b3), enquanto entravam a correção de paginação de 2026-07-28 (f6561b0b2, "13 sites onde
falha vira fim") e a consolidação do especificador de 2026-08-08 (5f5523df9).

⚠️ **A de paginação é a classe que NENHUMA fixture discrimina** — no-op por DESENHO enquanto o
`max-rows` de prod for 1000 (`deploy-no-op-por-desenho.md`). Aquele deploy era literalmente
INVERIFICÁVEL: a canária responde `trava-saida-v1` com o bundle de julho ou o de agosto.

**A correção não foi bumpar o contrato — foi separar os papéis.** A edge ganhou sonda
(`versao.ts`, `v1.0-sensor-inicial`, honesto porque o sensor de VERSÃO nasce ali), e a canária
segue provando comportamento. É a mesma divisão que torna as outras 5 saudáveis. Efeito colateral
que compõe: ao virar instrumentada ela entrou automaticamente no `sonda:bump` e no
`sonda:fingerprint` (mapa 32 → 33), então as próximas fatias dela ficam cobertas por construção.

⚠️ **Sondar bundle pré-sensor aqui é CARO** — diferente da `omie-analytics-sync`, onde um corpo sem
`action` conhecida cai no 400 do `default`. Esta edge não roteia por `action`: bundle que não
conhece `probe` ignora o campo e roda o rebuild (lease + ~6909 upserts). Resposta sem o eco
`probe:true` = a sonda não rodou E o rebuild rodou.

⚠️ **O parse do corpo é DEFENSIVO aqui, e a divergência é deliberada.** O fluxo real é dirigido por
QUERY PARAM e nunca leu o corpo, então POST sem body é chamada legítima; fazer `req.json()`
reprovar corpo ausente (como na `omie-analytics-sync`, onde o corpo é obrigatório) transformaria
todo chamador de hoje em 400 — a sonda derrubaria o rebuild que ela existe para verificar.
