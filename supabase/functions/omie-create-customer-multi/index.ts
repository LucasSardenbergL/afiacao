import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

/**
 * PR-CAPTURE-B — Cria cliente nas 3 contas Omie em paralelo (Colacor / Oben / Colacor SC)
 * e grava o mapping em `omie_clientes` pra cada empresa.
 *
 * Padrão de secrets: OMIE_{EMPRESA}_APP_KEY + OMIE_{EMPRESA}_APP_SECRET
 *   - OMIE_COLACOR_APP_KEY/SECRET
 *   - OMIE_OBEN_APP_KEY/SECRET
 *   - OMIE_COLACOR_SC_APP_KEY/SECRET
 *
 * Se uma empresa não tem secret configurada, é skipped (graceful degradation).
 * Retorna { results: [{ empresa, status, codigo_cliente_omie? error? }] } pra UI mostrar.
 */

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

type EmpresaKey = 'colacor' | 'oben' | 'colacor_sc';
const EMPRESAS: EmpresaKey[] = ['colacor', 'oben', 'colacor_sc'];
const EMPRESA_LABEL: Record<EmpresaKey, string> = {
  colacor: 'Colacor',
  oben: 'Oben',
  colacor_sc: 'Colacor SC',
};
const EMPRESA_SECRET_PREFIX: Record<EmpresaKey, string> = {
  colacor: 'OMIE_COLACOR',
  oben: 'OMIE_OBEN',
  colacor_sc: 'OMIE_COLACOR_SC',
};

interface ReqBody {
  user_id: string;
  razao_social: string;
  cnpj?: string | null;
  email?: string | null;
  phone?: string | null;
  nome_contato?: string | null;
  cidade?: string | null;
  estado?: string | null;
  endereco?: string | null;
  target_empresas?: EmpresaKey[]; // default: todas
  tags?: string[];
}

interface EmpresaResult {
  empresa: EmpresaKey;
  empresa_label: string;
  status: 'created' | 'skipped_no_secret' | 'error';
  codigo_cliente_omie?: number;
  error?: string;
}

interface OmieClientePayload {
  codigo_cliente_integracao: string;
  razao_social: string;
  cnpj_cpf: string;
  pessoa_fisica?: string;
  nome_fantasia?: string;
  email?: string;
  telefone1_numero?: string;
  cidade?: string;
  estado?: string;
  endereco?: string;
  tags?: Array<{ tag: string }>;
}

function digitsOnly(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

async function createClienteInOmie(
  empresa: EmpresaKey,
  body: ReqBody,
): Promise<EmpresaResult> {
  const prefix = EMPRESA_SECRET_PREFIX[empresa];
  const appKey = Deno.env.get(`${prefix}_APP_KEY`);
  const appSecret = Deno.env.get(`${prefix}_APP_SECRET`);

  if (!appKey || !appSecret) {
    return {
      empresa,
      empresa_label: EMPRESA_LABEL[empresa],
      status: 'skipped_no_secret',
      error: `Secrets ${prefix}_APP_KEY/SECRET não configuradas`,
    };
  }

  // Determina pessoa física ou jurídica pelo CNPJ
  const cnpjDigits = digitsOnly(body.cnpj);
  const isPF = cnpjDigits.length === 11;
  const isPJ = cnpjDigits.length === 14;

  if (!cnpjDigits) {
    // Sem CNPJ, gera placeholder de PF com sufixo do user_id (pra Omie aceitar)
    // Mas isso pode dar erro no Omie. Melhor retornar error se não tem doc.
    return {
      empresa,
      empresa_label: EMPRESA_LABEL[empresa],
      status: 'error',
      error: 'CNPJ/CPF é obrigatório pra criar cliente no Omie',
    };
  }

  const payload: OmieClientePayload = {
    codigo_cliente_integracao: `prospect-${body.user_id.slice(0, 18)}`,
    razao_social: body.razao_social,
    cnpj_cpf: cnpjDigits,
    pessoa_fisica: isPF ? 'S' : 'N',
    nome_fantasia: body.nome_contato || body.razao_social,
    email: body.email || undefined,
    telefone1_numero: digitsOnly(body.phone) || undefined,
    cidade: body.cidade || undefined,
    estado: body.estado || undefined,
    endereco: body.endereco || undefined,
    tags: body.tags && body.tags.length > 0 ? body.tags.map((t) => ({ tag: t })) : undefined,
  };

  // Remove undefined pra Omie não reclamar
  Object.keys(payload).forEach((k) => {
    if ((payload as Record<string, unknown>)[k] === undefined) delete (payload as Record<string, unknown>)[k];
  });

  try {
    const resp = await fetch(`${OMIE_API_URL}/geral/clientes/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call: 'IncluirCliente',
        app_key: appKey,
        app_secret: appSecret,
        param: [payload],
      }),
    });

    const data = await resp.json();

    // Omie retorna codigo_cliente_omie em sucesso; faultcode/faultstring em erro (SOAP-like)
    if (data.faultstring || !resp.ok) {
      // Cliente já existe? Tenta upsert via UpsertCliente
      if (typeof data.faultstring === 'string' && data.faultstring.includes('já cadastrado')) {
        // Faz UpsertCliente como retry
        const respUpsert = await fetch(`${OMIE_API_URL}/geral/clientes/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            call: 'UpsertCliente',
            app_key: appKey,
            app_secret: appSecret,
            param: [payload],
          }),
        });
        const dataUpsert = await respUpsert.json();
        if (dataUpsert.codigo_cliente_omie) {
          return {
            empresa,
            empresa_label: EMPRESA_LABEL[empresa],
            status: 'created',
            codigo_cliente_omie: dataUpsert.codigo_cliente_omie,
          };
        }
        return {
          empresa,
          empresa_label: EMPRESA_LABEL[empresa],
          status: 'error',
          error: dataUpsert.faultstring ?? 'Upsert failed',
        };
      }
      return {
        empresa,
        empresa_label: EMPRESA_LABEL[empresa],
        status: 'error',
        error: data.faultstring ?? `HTTP ${resp.status}`,
      };
    }

    return {
      empresa,
      empresa_label: EMPRESA_LABEL[empresa],
      status: 'created',
      codigo_cliente_omie: data.codigo_cliente_omie,
    };
  } catch (err) {
    return {
      empresa,
      empresa_label: EMPRESA_LABEL[empresa],
      status: 'error',
      error: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!body.user_id || !body.razao_social) {
    return new Response(JSON.stringify({ error: "user_id + razao_social required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const targets = body.target_empresas && body.target_empresas.length > 0
    ? body.target_empresas
    : EMPRESAS;

  try {
    // Executa nas N empresas em paralelo
    const results = await Promise.all(
      targets.map((empresa) => createClienteInOmie(empresa, body)),
    );

    // Persiste mapping em omie_clientes pra cada sucesso
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const successfulRows = results
      .filter((r) => r.status === 'created' && r.codigo_cliente_omie)
      .map((r) => ({
        user_id: body.user_id,
        omie_codigo_cliente: r.codigo_cliente_omie!,
        empresa_omie: r.empresa, // assume coluna empresa_omie em omie_clientes; ajusta se nome diferente
      }));

    if (successfulRows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: insErr } = await (supabase.from('omie_clientes') as any).upsert(
        successfulRows,
        { onConflict: 'user_id,empresa_omie' }
      );
      if (insErr) {
        console.warn('[omie-create-customer-multi] mapping upsert failed:', insErr);
        // não bloqueia — sucesso parcial é melhor que rollback completo
      }
    }

    const createdCount = results.filter((r) => r.status === 'created').length;
    const errorCount = results.filter((r) => r.status === 'error').length;
    const skippedCount = results.filter((r) => r.status === 'skipped_no_secret').length;

    return new Response(JSON.stringify({
      ok: createdCount > 0,
      summary: {
        created: createdCount,
        errors: errorCount,
        skipped: skippedCount,
        total: results.length,
      },
      results,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[omie-create-customer-multi]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
