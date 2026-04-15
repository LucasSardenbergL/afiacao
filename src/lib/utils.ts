import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Decode HTML entities that come from Omie API responses
 * e.g. &apos; → ', &amp; → &, &quot; → ", &lt; → <, &gt; → >
 */
export function decodeHtmlEntities(text: string | null | undefined): string {
  if (!text) return '';
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return doc.documentElement.textContent || text;
}
