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
