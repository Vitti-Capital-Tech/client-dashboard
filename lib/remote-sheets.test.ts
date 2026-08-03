import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyLink, normalizeExcelUrl } from "./remote-sheets-url.ts";

test("Remote Sheets - classify Google Sheets links and extract the file id", () => {
  const kind = classifyLink(
    "https://docs.google.com/spreadsheets/d/1AbC-dEf_GhI123/edit#gid=0"
  );
  assert.equal(kind.provider, "google");
  assert.equal(kind.provider === "google" && kind.fileId, "1AbC-dEf_GhI123");
});

test("Remote Sheets - classify Google Drive /file/d/ links", () => {
  const kind = classifyLink(
    "https://drive.google.com/file/d/1ZzY_xW-987/view?usp=sharing"
  );
  assert.equal(kind.provider, "google");
  assert.equal(kind.provider === "google" && kind.fileId, "1ZzY_xW-987");
});

test("Remote Sheets - classify Google Drive ?id= links (open / uc variants)", () => {
  for (const url of [
    "https://drive.google.com/open?id=1QqR_sT-456",
    "https://drive.google.com/uc?export=download&id=1QqR_sT-456",
  ]) {
    const kind = classifyLink(url);
    assert.equal(kind.provider, "google", url);
    assert.equal(kind.provider === "google" && kind.fileId, "1QqR_sT-456", url);
  }
});

test("Remote Sheets - classify SharePoint and OneDrive links as microsoft", () => {
  for (const url of [
    "https://vitticapital.sharepoint.com/:x:/s/Deals/EaBc123?e=xyz",
    "https://1drv.ms/x/s!AbCdEf",
    "https://onedrive.live.com/edit.aspx?resid=ABC123",
  ]) {
    assert.equal(classifyLink(url).provider, "microsoft", url);
  }
});

test("Remote Sheets - classify unrelated links as other", () => {
  assert.equal(
    classifyLink("https://example.com/files/placement-tracker.xlsx").provider,
    "other"
  );
});

test("Remote Sheets - normalize a Google Sheet to its xlsx export URL", () => {
  assert.equal(
    normalizeExcelUrl("https://docs.google.com/spreadsheets/d/1AbC-dEf_GhI123/edit#gid=0"),
    "https://docs.google.com/spreadsheets/d/1AbC-dEf_GhI123/export?format=xlsx"
  );
});

test("Remote Sheets - normalize a Drive file to its direct download URL", () => {
  assert.equal(
    normalizeExcelUrl("https://drive.google.com/file/d/1ZzY_xW-987/view?usp=sharing"),
    "https://drive.google.com/uc?export=download&id=1ZzY_xW-987"
  );
});

test("Remote Sheets - normalize a SharePoint link by forcing download=1", () => {
  const out = normalizeExcelUrl(
    "https://vitticapital.sharepoint.com/:x:/s/Deals/doc.aspx?sourcedoc=123"
  );
  assert.ok(out.includes("download.aspx"), out);
  assert.ok(out.includes("download=1"), out);
});

test("Remote Sheets - normalize leaves an unrelated direct URL untouched", () => {
  const url = "https://example.com/files/placement-tracker.xlsx";
  assert.equal(normalizeExcelUrl(url), url);
});

test("Remote Sheets - normalize does not append download=1 twice", () => {
  const out = normalizeExcelUrl(
    "https://vitticapital.sharepoint.com/:x:/s/Deals/file.xlsx?download=1"
  );
  assert.equal(out.match(/download=1/g)?.length, 1, out);
});
