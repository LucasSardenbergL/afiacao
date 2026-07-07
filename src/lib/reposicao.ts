import { supabase } from "@/integrations/supabase/client";
import { logger } from "@/lib/logger";

export const formatBRL = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

export const formatDate = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
};

function toCsvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const csv = [headers.join(";"), ...rows.map((r) => r.map(toCsvValue).join(";"))].join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function logAudit(params: {
  userId: string | null;
  action: string;
  result: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await supabase.from("cockpit_audit_log").insert([{
      user_id: params.userId ?? undefined,
      action: params.action,
      result: params.result,
      metadata: (params.metadata ?? {}) as never,
    }]);
  } catch (e) {
    // não bloqueia a UI, mas registra no logger pra não perder a auditoria silenciosamente
    logger.warn("Falha ao gravar cockpit_audit_log", {
      action: params.action,
      result: params.result,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
