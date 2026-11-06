# KPIs de reposição e badge de melhorias: falha de leitura não vira zero (plano v7, lote 3: C8–C11)

Data: 2026-11-05. Plano: `docs/superpowers/plans/2026-11-05-plano-melhoria-v7/README.md`, itens
C8 (CAD-ZERO), C9 (MERC-PROMO), C10 (OPP-ERRO) e C11 (MELH-BADGE), mais o erro → `[]` do histórico
de ciclos (linha da tabela de dívidas). É a classe do v6 lote 2 (#3611): **ausente ≠ zero**. Só
frontend, sem migration nem edge. Vai para produção pelo **Publish** manual.

## O defeito, por item

- **C8, `AdminReposicaoCadastros.tsx`.** Os 3 KPIs faziam `if (error) return 0`, e o render ainda
  aplicava `?? 0` com tom neutro. "SKUs sem cadeia logística: 0" dizia "tudo mapeado" quando a
  leitura tinha caído. O anti-join no cliente (duas leituras) era pior: se só a lista de grupos
  falhasse, voltava 0, mas se ela viesse vazia por erro, todo SKU ativo viraria "sem cadeia". O
  "Histórico de ciclos" fazia `if (error) return []` e mostrava "Nenhum ciclo encontrado". Na
  tabela, `num_skus ?? 0` e `valor_total ?? 0` também fabricavam "0" e "R$ 0,00" por linha.
- **C9, `AdminReposicaoMercado.tsx`.** "Promoções vigentes" fazia `if (error) return 0` e fixava
  `unavailable: false`. A premissa de que os 3 irmãos estavam certos era **parcialmente falsa**:
  eles levavam `unavailable`, mas o render imprimia `c.value` (0) sempre e só acrescentava "Sem
  dados disponíveis". Era um zero com ressalva.
- **C10, `AdminReposicaoOportunidades.tsx` + `OportunidadesTable.tsx`.** O `queryFn` já lançava; o
  defeito era o consumidor, `data: oportunidades = []` sem ler o estado. As somas partiam de zero
  ("economia R$ 0", "0 SKUs") e a tabela caía no `<EstadoVazio>`. Era idêntico ao controle `[]`
  com sucesso (reprodução do Codex). Vizinhos do mesmo defeito, na mesma tela: `cicloHoje`
  descartava `promo.error`/`aumento.error` (→ "Sem ciclo hoje", e o botão sumia), `totalSkusAtivos`
  tinha default 0 ("de 0 SKUs ativos"), e o dialog de confirmação diria "0 SKUs, R$ 0,00".
- **C11, `useMelhorias.ts` + `AppShell.tsx`.** `if (error) return 0`, e o shell só desenha o badge
  com valor > 0: a falha sumia calada, "nada aberto". Como o plano já registrava, trocar `0` por
  `null` não muda nada, porque `null` também esconde.

## O conserto

O padrão é o mesmo nos quatro itens. O `queryFn` **lança** e o render lê `estadoDeLeitura()` /
`naoConsegui()` / `desatualizado()` de `src/lib/leitura/estado-de-leitura.ts`.

- **`src/components/reposicao/KpiContagem.tsx`** (novo, serve ao C8 e ao C9). Um card com quatro
  faces: carregando (esqueleto), sem leitura ("—" + motivo, borda tracejada, sem a cor do valor),
  desatualizado (o número da última leitura boa + "Desatualizado — a última atualização falhou"),
  e pronta. `data-testid="kpi-<id>"` e `data-estado` servem de âncora de guard. Segue o idioma do
  `CardKpi` do Recebimento (#3611) e acrescenta o estado de desatualizado.
- **Histórico de ciclos:** `<AvisoLeituraFalhou variante="bloco">` no lugar do "Nenhum ciclo"; com
  dado anterior em mãos, a lista fica e ganha o aviso de desatualizada. Nas linhas, ausente vira "—".
- **C10:** a página deriva `estadoOportunidades`, `oportunidadesVelhas` (desatualizado) e
  `oportunidadesSemLeitura` da MESMA query, e passa isso aos KPIs **e** à tabela. `KpiCards` ganha
  `estados` e números `number | null` (`null` = "não sei", com esqueleto ou "—" e motivo).
  `OportunidadesTable` ganha `semLeitura`, que renderiza o aviso no lugar do `<EstadoVazio>`. O
  `GerarCicloDialog` aceita `null` e diz que a contagem não está disponível, mas deixa gerar,
  porque o ciclo é calculado no servidor.
- **C11, contrato de 3 faces** em `src/components/shell/badge-de-contagem.ts` (`faceDoBadge`; a pílula em `BadgeDeContagem.tsx`):
  `numero` (lido e > 0) · `oculto` (lido 0, ou ainda carregando/desabilitado, para não piscar "?"
  no 1º paint) · `indisponivel` (erro/sem rede, **inclusive com número antigo em cache**, que vai
  para o tooltip como "última leitura: N"). O `NavItem` ganha `badgeIndisponivel?: string`, e o
  `SidebarItem` desenha a pílula "?" com o motivo em `title`/`aria-label`. É um helper puro, sem
  sistema global de alertas, e por ora só o badge de melhorias o usa. As dependências do `useMemo`
  da nav são **primitivas** (número e motivo), não o objeto da face, que é novo a cada render e
  quebraria o memo dos itens (v4, lote 10, C8).

## Fora do escopo (de propósito)

- `COUNT … NOT EXISTS` no banco para o C8. O plano marca como opcional, e os volumes (588 / 392
  linhas) não truncam hoje.
- A truncagem do histórico de ciclos (`.limit(2000)` com teto de 1.000 do PostgREST; OBEN = 784).
  Está na baseline do `single-shot-truncado-gate`.
- Os outros badges do `AppShell` (pedidos pendentes, aumentos, negociação, notificações) ainda
  descartam `error`. A mesma `faceDoBadge` serve a eles, mas o plano escopou só o de melhorias.

## Evidência

São 5 arquivos de teste novos. Cada um simula a falha, exige "—" ou o aviso (casa a âncora
`data-estado`/`data-testid`, não a copy) e traz o seu CONTROLE (leitura boa → o número):
`AdminReposicaoCadastros.leitura-falhou`, `AdminReposicaoMercado.leitura-falhou`,
`AdminReposicaoOportunidades.oportunidades-leitura` (inclui o caso de dado anterior
desatualizado), `shell/badge-de-contagem` e `useMelhorias.badge-leitura`. Os testes existentes de
`KpiCards`/`OportunidadesTable` foram atualizados para as props novas. Ao todo, 11 arquivos e 37
testes verdes.

**Falsificação** (commitado antes; restauro por `git checkout`). Na MESMA invocação rodam o
controle verde em `LC_ALL=C` e em `pt_BR.UTF-8` (21/21 nos dois) e 8 sabotagens, uma camada por
vez, cada uma **vermelha nos dois locales**, com asserção (não crash) no teste esperado:

| Sabotagem | Camada | Teste que ficou vermelho |
| --- | --- | --- |
| S1 | `queryFn` do anti-join volta a `return 0` (`e2`) | Cadastros: "—" com motivo, não "0" |
| S2 | histórico de ciclos volta a `return []` | Cadastros: aviso, não "Nenhum ciclo" |
| S3 | promoções volta a `return 0` | Mercado: query em erro + "—" |
| S4 | `KpiContagem` deixa de reconhecer sem-leitura | Mercado: motivo ausente |
| S5a | tabela recebe `semLeitura={null}` | Oportunidades: aviso da tabela |
| S5b | KPI recebe a soma crua (`R$ 0`) | Oportunidades: nenhum "0,00" em falha |
| S6 | aviso de desatualizado desligado | Oportunidades: refetch que falha |
| S7 | `useMelhoriasBadge` volta a `return 0` | hook em erro, não success com 0 |
| S8 | `faceDoBadge` ignora o número velho | badge: erro com cache → indisponível |

A S1 derrubou só o teste de render, porque o teste "query entra em ERRO" exercita a outra ponta
(`e1`). Isso confirma que as duas camadas são independentes.

## No ar (2026-11-06)

O #3648 mergeou às 03:59Z (squash `a07930873`), e o founder fez o Publish. A prova é determinística,
pelo carimbo de SHA do bundle, e não por sentinela:
`monitor-deploy.sh --pr 3648 https://steu.lovable.app` → **exit 0, `PR_NO_AR`**. O ar serve
`3dad9809`, que é a ponta da `origin/main`, e não houve `AVISO_REVERT_POSTERIOR`. Antes disso
conferi na main os 11 marcadores dos arquivos tocados, porque dois commits do sync do Lovable
("Lovable update", "Work in progress") vieram depois do merge: nenhum os reverteu.

Adoção: o service worker só troca de build quando o cliente recarrega. Bytes no ar provam
disponibilidade, não adoção.

