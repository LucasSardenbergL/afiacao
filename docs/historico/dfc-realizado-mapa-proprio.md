# DFC realizado (método direto) — mapa próprio de fluxo e identidade da ótica bancária (2026-11-22)

Desenho: `docs/superpowers/specs/2026-11-22-dre-fluxo-caixa-mapa-proprio-design.md` §4. Migration `20261122180000` (tabela `fin_categoria_fluxo_mapping` + view `v_fin_fluxo_caixa_realizado`). Mapa `db/2026-11-22-fin-fluxo-mapa-proprio.sql` (229 contas). Prova `db/test-fin-dfc-realizado.sh` (46 asserts, C e pt_BR, 9 falsificações). Tela: seção na aba "Fluxo de Caixa" de `/financeiro`.

## Antes

Não existia classificação operacional/investimento/financiamento em lugar nenhum. O realizado da aba era só total diário, e descartava todo movimento sem título — inclusive R$ 219k de extrato (tarifas, pix de serviço) — por um filtro feito para tirar transferências.

## Identidade da ótica bancária (medido em prod, histórico inteiro)

- `fin_movimentacoes` com `categoria_descricao` (= cGrupo) `CONTA_CORRENTE_REC/PAG` e `valor > 0` é a fonte: um evento de caixa por linha; `CONTA_A_*` é resumo cumulativo por título e dobraria. `data_movimento` = data de crédito em 100% das baixas.
- **Versões:** 4 grupos `(empresa, omie_ncodbaixa)` duplicados, todos versão (hash `ncodmov` mudou; mesmo valor/data/conta; a velha congelada) ⇒ **última observação por baixa**, escolhida ANTES do filtro de valor (baixa corrigida para 0 não ressuscita a versão anterior).
- **Sem identificador** (66 baixas, nenhuma atualizada após 2026-10-09): comparadas só com baixas **vencedoras** do mesmo título e sentido — mesmo valor ⇒ `pendente_identidade`; só o título ⇒ `pendente_revisao`; órfã (11, R$ 37,6k) entra. Os dois pendentes ficam fora das atividades e visíveis.
- **Extrato/transferência** não têm identificador; chaves naturais repetidas sempre com descrições diferentes e sem versão congelada ⇒ lançamentos distintos, entram todos.
- **TRAP/TRAR** = `transferencia_interna` pela ORIGEM; 100% pareadas dentro da própria empresa em 12m (resíduo de entradas R$ 477 na oben, R$ 20 na colacor).

## Decisões

- **Tabela própria**, não coluna no mapa da DRE: DRE e DFC respondem perguntas diferentes (colacor 2.01.01 ficou sem DRE por uso misto, mas tem R$ 121k de caixa; 0.01.* e tarifas de extrato não têm o que fazer na DRE). Sem `_default` (código não é global).
- **Política IFRS 18** já: juros e parcela de empréstimo pagos em financiamento; juros/rendimentos recebidos em investimento; parcelamento de tributo em operacional (linha própria); IRPJ/CSLL em linha própria (CPC 03 item 35); resgate de aplicação de liquidez = `equivalente_caixa`, fora das atividades.
- **Master-only DENTRO da view** (`has_role`): a RLS de `fin_movimentacoes` (`fin_user_can_access`) libera funcionário, e o `security_invoker` sozinho vazaria o DFC (P0 do Codex — a 1ª prova passou porque a fixture restringia a movimentação a master).
- Consulta da tela (1 empresa, 12m): 0,73 s em prod. O filtro de empresa não desce à janela (varre ~78k linhas da ótica bancária) — reavaliar quando crescer.

## Pendências registradas

- Parcela de empréstimo sem abertura principal × juros: o total de juros pagos é **parcial** (a tela avisa).
- Reconciliação saldo inicial + variação = saldo final: o Omie guarda só o saldo atual; snapshots de tesouraria só desde 2026-05. A tela diz "sem base".
- colacor_sc 1.04.04 "Empréstimos/Financiamentos" (R$ 383k histórico) = captação até o founder confirmar se é mútuo do grupo.
- Projeção (A1/`fin-cashflow-engine`) ainda rotula por código cru — usar este mapa é a próxima onda.
