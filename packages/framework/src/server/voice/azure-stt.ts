/** Kugel short language code -> Azure BCP-47 locale (mirrors the classic
 * voice stack's config so both STT paths agree). */
const LOCALE_BY_LANGUAGE: Record<string, string> = {
  en: "en-US",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  it: "it-IT",
};

export function azureLocales(language: string): string[] {
  const codes = language
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  if (codes.length === 0) codes.push("en");
  return codes.map((code) => LOCALE_BY_LANGUAGE[code] ?? `${code}-${code.toUpperCase()}`);
}
