-- ============================================================
-- ia_uso_limite — semeia a cota de `generate-bundle-argument`
--
-- PRÉ-REQUISITO do PR fix/ia-cota-generate-bundle-argument. A edge passa a
-- chamar `ia_consumir_cota`, que é FAIL-CLOSED por desenho: função sem linha
-- aqui devolve `sem_limite` → a edge responde HTTP 503. Sem este seed, a
-- argumentação de bundle PARA em produção assim que a edge for deployada.
-- ORDEM: rodar este SQL ANTES do deploy da edge.
--
-- POR QUE a edge precisava de cota (mesma classe do #2086): ela TEM
-- `authorizeCronOrStaff`, mas dentro de `if (decisaoSonda.tipo !== "disparo")`
-- — o helper guarda só o ramo da SONDA. O caminho de DISPARO, o que chama a
-- Anthropic, chegava lá com `supabase.auth.getUser()` pelado: sem role, sem
-- `is_approved`, sem cota. Como `/auth` é cadastro público e sem convite,
-- qualquer pessoa da internet virava principal válido — um customer com
-- `is_approved=false`, barrado em TODA a UI, ainda assim queimava o orçamento
-- da organização em laço.
--
-- LIMITES (120/hora, 600/dia) — folgados de propósito, e a razão importa:
-- não há série histórica para calibrar (a edge nunca foi instrumentada, então
-- `ia_uso_evento` não tem uma linha dela — isso é ausência de MEDIÇÃO, não
-- medição de ausência). A chamada é deliberada, por bundle, disparada pela
-- vendedora em `useBundleArguments`/`useDiagnosticQuestions` — dois modos, logo
-- até 2 chamadas por bundle. Uma gestora varrendo muitos clientes numa hora é
-- uso REAL e não pode tomar 429; 120/hora é uma chamada a cada 30s sustentada,
-- acima dessa cadência. O objetivo é LIMITAR O ILIMITADO: o abusador sai de
-- infinito para 600 chamadas/dia. Precedente de ferramenta de staff no mesmo
-- espírito: copilot-analyze (600/2500). Aperte depois de uma semana de dado
-- real em `ia_uso_evento`.
--
-- Idempotente: `ON CONFLICT (funcao) DO NOTHING` (PK é `funcao`). Re-colar é
-- seguro e NÃO sobrescreve um limite já ajustado à mão.
-- ============================================================

INSERT INTO public.ia_uso_limite (funcao, limite_hora, limite_dia)
VALUES ('generate-bundle-argument', 120, 600)
ON CONFLICT (funcao) DO NOTHING;
