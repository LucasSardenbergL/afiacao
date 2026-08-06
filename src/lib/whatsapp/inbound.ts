export interface ParsedInbound {
  waMessageId: string;
  fromPhone: string;
  type: 'text' | 'audio' | 'image' | 'template' | 'system';
  body: string | null;
  mediaId: string | null;
  contactName: string | null;
  waTimestamp: Date | null;
}

const KNOWN_TYPES = new Set(['text', 'audio', 'image']);

export function parseInboundWebhook(payload: unknown): ParsedInbound[] {
  const out: ParsedInbound[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      const messages = value?.messages as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(messages)) continue;
      const contacts = value?.contacts as Array<{ profile?: { name?: string } }> | undefined;
      const contactName = contacts?.[0]?.profile?.name ?? null;
      for (const m of messages) {
        const rawType = String(m.type ?? '');
        const type = (KNOWN_TYPES.has(rawType) ? rawType : 'system') as ParsedInbound['type'];
        const tsRaw = m.timestamp ? Number(m.timestamp) : NaN;
        out.push({
          waMessageId: String(m.id ?? ''),
          fromPhone: String(m.from ?? ''),
          type,
          body: type === 'text' ? String((m.text as { body?: string })?.body ?? '') : null,
          mediaId: (m.audio as { id?: string })?.id ?? (m.image as { id?: string })?.id ?? null,
          contactName,
          waTimestamp: Number.isFinite(tsRaw) ? new Date(tsRaw * 1000) : null,
        });
      }
    }
  }
  return out.filter((x) => x.waMessageId && x.fromPhone);
}

// --- Statuses do webhook (retorno de entrega de mensagens OUT — núcleo HSM) ---
// Cloud API entrega value.statuses[] separado de value.messages[].
export interface ParsedStatus {
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  erro: string | null;
  waTimestamp: Date | null;
}

const KNOWN_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

export function parseStatusWebhook(payload: unknown): ParsedStatus[] {
  const out: ParsedStatus[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      const statuses = value?.statuses as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(statuses)) continue;
      for (const s of statuses) {
        const status = String(s.status ?? '');
        if (!KNOWN_STATUSES.has(status)) continue;
        const tsRaw = s.timestamp ? Number(s.timestamp) : NaN;
        const errors = s.errors as Array<{ code?: number; title?: string; message?: string }> | undefined;
        const e0 = errors?.[0];
        out.push({
          waMessageId: String(s.id ?? ''),
          status: status as ParsedStatus['status'],
          erro: e0 ? `${e0.code ?? ''} ${e0.title ?? e0.message ?? ''}`.trim() : null,
          waTimestamp: Number.isFinite(tsRaw) ? new Date(tsRaw * 1000) : null,
        });
      }
    }
  }
  return out.filter((x) => x.waMessageId);
}

// Progressão monotônica: webhooks chegam fora de ordem; nunca regredir status.
const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 9 };

export function isStatusUpgrade(current: string | null, next: string): boolean {
  const cur = current ? (STATUS_RANK[current] ?? 0) : -1;
  const nxt = STATUS_RANK[next] ?? -1;
  return nxt > cur;
}

export function waPhoneCandidates(input: string | null | undefined): string[] {
  if (!input) return [];
  let d = String(input).replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (d.length < 10) return [];
  const out = new Set<string>([d]);
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length === 9 && rest.startsWith('9')) {
    out.add(ddd + rest.slice(1));
  } else if (rest.length === 8 && /^[6-9]/.test(rest)) {
    out.add(ddd + '9' + rest);
  }
  return [...out];
}

export function is24hWindowOpen(lastInboundAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false;
  const t = lastInboundAt instanceof Date ? lastInboundAt.getTime() : new Date(lastInboundAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < 24 * 60 * 60 * 1000;
}
