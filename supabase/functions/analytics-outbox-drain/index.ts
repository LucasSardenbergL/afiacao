// analytics-outbox-drain — drena a `analytics_outbox` para o PostHog server-side.
//
// Por que server-side: a telemetria client-side é CENSURADA por bloqueadores
// (PR #1984), e a censura correlaciona com perfil — quem bloqueia tende a usar
// mais. O evento que fundamenta uma decisão de negócio não pode nascer num cano
// que o navegador do usuário decide se entrega.
//
// Spec: docs/superpowers/specs/2026-08-25-analytics-outbox-design.md
// A lógica PURA (payload, classificação, particionamento) vive em payload.ts,
// com suíte Deno própria — aqui fica só a orquestração de I/O.
//
// ⚠️ O PostHog NÃO é fonte de autoridade nesta arquitetura, e isso é deliberado:
// o token de captura é público (o mesmo tipo de chave roda no browser), então
// qualquer pessoa pode empurrar um evento com qualquer nome para o projeto.
// Quem decide continua sendo o Postgres — `pedido_compra_sugerido` e a
// `analytics_outbox`. O PostHog é a superfície de LEITURA, não o registro.
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { comRegistro, type DbRegistro } from "../_shared/registro-execucao.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import {
  classificarResposta,
  type LinhaOutbox,
  montarEvento,
  particionar,
  resumirErro,
  TETO_EVENTOS_POR_LOTE,
} from "./payload.ts";
import {
  classificarSonda,
  EDGE,
  EFEITO,
  erroSondaAmbigua,
  FONTE,
  respostaSonda,
  VERSAO,
} from "./versao.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const POSTHOG_HOST = Deno.env.get("POSTHOG_HOST") ?? "https://us.i.posthog.com";

interface Resultado {
  reivindicados: number;
  aceitos: number;
  transitorios: number;
  quarentena: number;
}

/** Estrutural mínimo do client (service_role) — só o que este worker usa.
 *  Mesmo padrão do `DbRegistro` de `_shared/registro-execucao.ts`: evita `any`
 *  (que o ESLint do repo barra) sem arrastar o tipo inteiro do supabase-js. */
interface DbRpc {
  rpc(
    fn: string,
    params: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

// TODA resposta carrega `versao`/`edge`/`fonte` — não só a da sonda. É a metade da prova de deploy
// que dispensa invocação: o cron `analytics-outbox-drain` faz `net.http_post` DIRETO nesta edge a
// cada 5 minutos, então o corpo daqui cai em `net._http_response` e o marcador se lê PASSIVAMENTE,
// sem chamar nada, sem cron secret e sem pagar efeito. Ver versao.ts.
function jsonRes(corpo: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ ...corpo, versao: VERSAO, edge: EDGE, fonte: FONTE }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // ⚠️ SONDA DE VERSÃO — logo após o gate (que já aceita x-cron-secret) e ANTES do createClient, do
  // claim e de qualquer POST ao PostHog. Esta edge NÃO lia o corpo do request; o parse nasce aqui
  // já no lugar certo, e o `catch` mantém o caminho do cron (corpo `{}` → fluxo real) intacto.
  // Ver versao.ts / _shared/sonda-versao.ts.
  const body = await req.json().catch(() => ({}));

  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return jsonRes(respostaSonda(VERSAO), 200);
  // Fail-CLOSED: `probe` com valor não reconhecido NUNCA cai no fluxo real por omissão.
  if (decisaoSonda.tipo === "ambiguo") {
    return jsonRes({ erro: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  // ⚠️ Chave ausente é falha de CONFIGURAÇÃO e sai com status de erro. Degradar
  // em silêncio aqui produziria exatamente a leitura envenenada que este
  // trabalho existe para acabar: fila crescendo, cron verde, série vazia — e
  // ninguém consegue distinguir "não houve fenômeno" de "o cano nunca abriu".
  const ingestKey = Deno.env.get("POSTHOG_INGEST_KEY");

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const resultado = await comRegistro(
      db as unknown as DbRegistro,
      "analytics_outbox.drenar",
      auth.via === "cron" ? { via: "cron" } : { via: "staff", userId: auth.userId },
      // ⚠️ O guard da chave mora DENTRO do callback registrado — e essa posição é
      // a lição, não um detalhe de estilo. Ele já foi um `return` ANTES do
      // `comRegistro`, e por isso o apagão de 2026-08-26 (32h, 13× HTTP 500)
      // deixou ZERO linhas de falha em `acoes_execucoes`: o registro nunca chegou
      // a ser aberto. Três superfícies diziam "saudável ou ausente" ao mesmo
      // tempo — `cron.job_run_details` = succeeded (só prova o ENQUEUE), o
      // registro de execução vazio, e as colunas da fila impecáveis (tentativas=0,
      // porque a máquina de retry fica rio abaixo do claim, que nunca rodou).
      // Lançando aqui dentro, `comRegistro` fecha o registro com status='erro' e
      // re-lança — o `catch` externo devolve a MESMA resposta HTTP de antes.
      //
      // ⚠️ A string do erro é IDÊNTICA de propósito. O #2091 a documentou como
      // prova de VERSÃO da edge sem PAT: `git grep` mostra que ela existe em UM
      // arquivo só, então um 500 com este corpo em `net._http_response` identifica
      // o bundle. Reescrevê-la ("faltou a chave", "chave ausente") não quebraria
      // teste nenhum e apagaria em silêncio uma via de verificação de deploy.
      () => {
        if (!ingestKey) {
          console.error("[analytics-outbox-drain] POSTHOG_INGEST_KEY ausente — nada foi drenado");
          throw new Error("POSTHOG_INGEST_KEY nao configurado");
        }
        return drenar(db as unknown as DbRpc, ingestKey);
      },
      (r) => ({ ...r }),
    );
    return jsonRes({ ...resultado });
  } catch (e) {
    // mensagemDeErro evita o "[object Object]" que esconde a causa no painel.
    const msg = mensagemDeErro(e) ?? "(sem mensagem)";
    console.error("[analytics-outbox-drain] falhou:", msg);
    return jsonRes({ erro: msg }, 500);
  }
});

async function drenar(db: DbRpc, ingestKey: string): Promise<Resultado> {
  // O claim é atômico e já aplica o backoff ANTES do HTTP (lease implícito):
  // se este worker morrer no meio, a linha volta sozinha à fila em vez de ficar
  // presa, e `FOR UPDATE SKIP LOCKED` impede que duas execuções sobrepostas do
  // cron reivindiquem a mesma linha.
  const { data, error } = await db.rpc("analytics_outbox_claim", {
    p_limite: TETO_EVENTOS_POR_LOTE,
  });
  if (error) throw new Error(`claim: ${error.message}`);

  const linhas = (data ?? []) as LinhaOutbox[];
  const resultado: Resultado = {
    reivindicados: linhas.length,
    aceitos: 0,
    transitorios: 0,
    quarentena: 0,
  };
  if (linhas.length === 0) return resultado;

  // Mantém o vínculo evento→linha para saber QUAIS ids marcar em cada desfecho.
  const porUuid = new Map(linhas.map((l) => [l.event_id, l.id]));
  const lotes = particionar(linhas.map(montarEvento));

  for (const lote of lotes) {
    const ids = lote.map((ev) => porUuid.get(ev.uuid)!).filter((id) => id !== undefined);
    let status = 0;
    let corpo = "";
    try {
      // ⚠️ NADA de `sent_at` na query string: o PostHog usa esse parâmetro para
      // AJUSTAR o timestamp, e um timestamp ajustado quebra a dedup — o retry
      // viraria evento novo e inflaria a contagem que ele deveria preservar.
      const resp = await fetch(`${POSTHOG_HOST}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: ingestKey, batch: lote }),
      });
      status = resp.status;
      if (!resp.ok) corpo = (await resp.text()).slice(0, 200);
    } catch (e) {
      status = 0; // falha de rede antes de haver status
      corpo = mensagemDeErro(e) ?? "falha de rede";
    }

    const desfecho = classificarResposta(status);
    if (desfecho === "aceito") {
      // "aceito" = ACEITE HTTP. O PostHog responde 200 e ainda assim descarta
      // evento inválido — quem confere ingestão de verdade é a view
      // `analytics_outbox_reconciliacao`, na origem.
      const { error: e1 } = await db.rpc("analytics_outbox_aceitar", { p_ids: ids });
      if (e1) throw new Error(`aceitar: ${e1.message}`);
      resultado.aceitos += ids.length;
    } else if (desfecho === "transitorio") {
      // O backoff já foi aplicado no claim; aqui só fica o motivo.
      await db.rpc("analytics_outbox_falhar", { p_ids: ids, p_erro: resumirErro(status, corpo) });
      resultado.transitorios += ids.length;
    } else {
      // 400/401/403/413: insistir só queima quota e mantém dado pessoal parado
      // na fila. Quarentena PARA de tentar, fica visível — e `purgar_em` já
      // garante que ela também expira.
      await db.rpc("analytics_outbox_quarentena", {
        p_ids: ids,
        p_erro: resumirErro(status, corpo),
      });
      resultado.quarentena += ids.length;
      console.error(
        `[analytics-outbox-drain] ${ids.length} evento(s) em quarentena — HTTP ${status}`,
      );
    }
  }

  return resultado;
}
