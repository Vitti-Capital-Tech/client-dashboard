import assert from "node:assert/strict";
import { test } from "node:test";
import { GLOSSARY, glossaryDefinition, glossaryEntry, glossaryForPage } from "./glossary.ts";

test("slugs are unique — a duplicate would shadow an entry silently", () => {
  const slugs = GLOSSARY.map((e) => e.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("every entry has a term and a one-sentence short form", () => {
  for (const e of GLOSSARY) {
    assert.ok(e.term.trim().length > 0, `${e.slug} has no term`);
    assert.ok(e.short.trim().length > 0, `${e.slug} has no short form`);
    // The short form is a tooltip. Two sentences in a tooltip is a paragraph.
    assert.ok(
      e.short.replace(/\.(?=\s|$)/g, "|").split("|").filter((p) => p.trim()).length <= 2,
      `${e.slug}'s short form runs past two sentences: ${e.short}`,
    );
  }
});

test("definitions state what a figure is, never what to do about it", () => {
  /**
   * The rule the module header sets out, enforced rather than trusted. These
   * screens are client-facing in a wholesale product, and the line between
   * explaining a number and advising on it is the whole regulatory point — the
   * same gate `lib/commentary/prompt.ts` puts in front of generated text.
   */
  const ADVICE = /\b(you should|we recommend|worth (buying|selling|reviewing)|consider (buying|selling)|price target|a good time to)\b/i;
  for (const e of GLOSSARY) {
    const text = `${e.short} ${e.long ?? ""}`;
    assert.equal(ADVICE.test(text), false, `${e.slug} reads as advice: ${text}`);
  }
});

test("definitions quote no figures — a number in a definition goes stale", () => {
  // Times and statutory references are the deliberate exceptions: "10am to 4pm"
  // and "section 708" are part of what the term MEANS, not an example of it.
  const ALLOWED = /\b(7am|10am|4pm|4:10pm|4:11pm|2:10pm|708|T\+2|two business days|GICS)\b/;
  for (const e of GLOSSARY) {
    for (const sentence of `${e.short} ${e.long ?? ""}`.split(/(?<=\.)\s+/)) {
      if (!/[$%]|\b\d/.test(sentence)) continue;
      assert.ok(ALLOWED.test(sentence), `${e.slug} quotes a figure: ${sentence.trim()}`);
    }
  }
});

test("glossaryEntry finds an entry, and is undefined for an unknown slug", () => {
  assert.equal(glossaryEntry("strike")?.term, "Strike");
  assert.equal(glossaryEntry("not-a-term"), undefined);
});

test("glossaryDefinition prefers the long form and falls back to the short", () => {
  const withLong = GLOSSARY.find((e) => e.long);
  const withoutLong = GLOSSARY.find((e) => !e.long);
  assert.ok(withLong);
  assert.equal(glossaryDefinition(withLong), withLong.long);
  if (withoutLong) assert.equal(glossaryDefinition(withoutLong), withoutLong.short);
});

test("every page's terms resolve — a typo'd slug would drop a word silently", () => {
  for (const route of [
    "/portal/client",
    "/portal/client/positions",
    "/portal/client/options",
    "/portal/client/placements",
    "/portal/client/market",
    "/portal/client/insights",
    "/portal/client/watchlist",
    "/portal/client/alerts",
  ]) {
    const entries = glossaryForPage(route);
    assert.ok(entries.length > 0, `${route} explains nothing`);
    for (const e of entries) assert.ok(glossaryEntry(e.slug), `${route} names a missing slug`);
  }
});

test("a detail route inherits its section's terms", () => {
  // The failure this guards is invisible: an empty strip looks exactly like a
  // page with no jargon on it, so a placement detail page would quietly stop
  // explaining s708 and scaleback and nobody would see it happen.
  assert.deepEqual(
    glossaryForPage("/portal/client/placements/abc-123").map((e) => e.slug),
    glossaryForPage("/portal/client/placements").map((e) => e.slug),
  );
});

test("the home route does not swallow every page under it", () => {
  // "/portal/client" prefixes every other client route, so longest-prefix wins
  // or Options would render Home's terms.
  assert.notDeepEqual(
    glossaryForPage("/portal/client/options").map((e) => e.slug),
    glossaryForPage("/portal/client").map((e) => e.slug),
  );
  assert.ok(glossaryForPage("/portal/client/options").some((e) => e.slug === "strike"));
});

test("an unmapped route explains nothing rather than guessing", () => {
  assert.deepEqual(glossaryForPage("/portal/staff/clients"), []);
  assert.deepEqual(glossaryForPage(""), []);
});

test("the renamed column is findable under the name it used to have", () => {
  // Clients who learned "unrealised" elsewhere must still find it, which is the
  // entire reason `also` exists.
  const openPnl = glossaryEntry("open-pnl");
  assert.ok(openPnl?.also?.includes("Unrealised P&L"));
});
