import { describe, expect, it } from "vitest";
import { AGENT_LANGUAGES, agentLanguage, dateLine, fallbackReplies, isTimeZone } from "./localized.js";

const FRIDAY_AFTERNOON = new Date("2026-10-23T15:51:00Z");

describe("agentLanguage", () => {
  it("is the TTS language, else the first STT language, else English", () => {
    expect(agentLanguage({ tts: { language: "de" }, stt: { language: "fr" } })).toBe("de");
    expect(agentLanguage({ tts: {}, stt: { language: "fr,de" } })).toBe("fr");
    expect(agentLanguage({ tts: {}, stt: {} })).toBe("en");
  });

  it("reads a regional tag by its language and falls back to English for one without wording", () => {
    expect(agentLanguage({ tts: { language: "pt-BR" }, stt: {} })).toBe("pt");
    expect(agentLanguage({ tts: { language: "ja" }, stt: { language: "de" } })).toBe("en");
  });
});

describe("fallbackReplies", () => {
  it("has both lines in every supported language, each its own", () => {
    const seen = new Set<string>();
    for (const language of AGENT_LANGUAGES) {
      const { turnFailed, stepLimit } = fallbackReplies(language);
      for (const line of [turnFailed, stepLimit]) {
        expect(line.trim()).toBe(line);
        expect(line).not.toMatch(/[—!]/);
        seen.add(line);
      }
    }
    expect(seen.size).toBe(AGENT_LANGUAGES.length * 2);
  });
});

describe("dateLine", () => {
  it("states the date, the 24-hour time and the zone, then the next 14 days", () => {
    const line = dateLine(FRIDAY_AFTERNOON, "Europe/Berlin", "en");
    const [today, days] = line.split(" The next days: ");
    expect(today).toBe("Today is Friday, October 23, 2026, 17:51 (Europe/Berlin).");
    expect(days!.split(", ")).toEqual([
      "Sat Oct 24",
      "Sun Oct 25",
      "Mon Oct 26",
      "Tue Oct 27",
      "Wed Oct 28",
      "Thu Oct 29",
      "Fri Oct 30",
      "Sat Oct 31",
      "Sun Nov 1",
      "Mon Nov 2",
      "Tue Nov 3",
      "Wed Nov 4",
      "Thu Nov 5",
      "Fri Nov 6",
    ]);
  });

  it("counts calendar days in the agent's zone across a DST change", () => {
    // 23:30 in Berlin the night the clocks go forward (Sunday 2027-03-28 has 23 hours):
    // 24-hour steps would land on Monday 00:30 and skip Sunday.
    const line = dateLine(new Date("2027-03-27T22:30:00Z"), "Europe/Berlin", "en");
    expect(line).toContain("Saturday, March 27, 2027, 23:30 (Europe/Berlin)");
    expect(line.split(" The next days: ")[1]!.split(", ").slice(0, 3)).toEqual(["Sun Mar 28", "Mon Mar 29", "Tue Mar 30"]);
  });

  it("uses the date in the agent's zone, not the server's", () => {
    // 23:30 UTC on Friday is already Saturday in Tokyo.
    const line = dateLine(new Date("2026-10-23T23:30:00Z"), "Asia/Tokyo", "en");
    expect(line.startsWith("Today is Saturday, October 24, 2026, 08:30 (Asia/Tokyo).")).toBe(true);
  });

  it("speaks the agent's language", () => {
    expect(dateLine(FRIDAY_AFTERNOON, "Europe/Berlin", "de")).toMatch(
      /^Heute ist Freitag, 23\. Oktober 2026, 17:51 Uhr \(Europe\/Berlin\)\. Die nächsten Tage: Sa\.? 24\. Okt\./,
    );
    expect(dateLine(FRIDAY_AFTERNOON, "Europe/Paris", "fr")).toContain("Nous sommes le vendredi 23 octobre 2026, il est 17:51");
    expect(dateLine(FRIDAY_AFTERNOON, "Europe/Madrid", "es")).toContain("Hoy es viernes, 23 de octubre de 2026, 17:51");
    for (const language of AGENT_LANGUAGES) {
      const line = dateLine(FRIDAY_AFTERNOON, "UTC", language);
      expect(line).toContain("15:51");
      expect(line).toContain("(UTC)");
    }
  });
});

describe("isTimeZone", () => {
  it("accepts IANA names and UTC, refuses anything else", () => {
    expect(isTimeZone("Europe/Berlin")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Berlin")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone(2)).toBe(false);
  });
});
