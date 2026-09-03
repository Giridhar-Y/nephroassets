import { describe, expect, it } from "vitest";
import { CHUNK_ROWS, chunkCsvRows, findDuplicateFarIds, splitCsvFields, splitCsvLines } from "./csvChunking.js";

describe("splitCsvLines", () => {
  it("splits plain rows on LF", () => {
    expect(splitCsvLines("a,b\nc,d\ne,f")).toEqual(["a,b", "c,d", "e,f"]);
  });

  it("splits plain rows on CRLF", () => {
    expect(splitCsvLines("a,b\r\nc,d\r\ne,f")).toEqual(["a,b", "c,d", "e,f"]);
  });

  it("does not split on a comma or newline inside a quoted field — the whole point of not using a naive split('\\n')", () => {
    const text = 'a,"multi\nline",c\nd,e,f';
    expect(splitCsvLines(text)).toEqual(['a,"multi\nline",c', "d,e,f"]);
  });

  it("handles an escaped quote (\"\") inside a quoted field without losing quote-tracking state", () => {
    const text = 'a,"has ""quotes"" inside",c\nd,e,f';
    expect(splitCsvLines(text)).toEqual(['a,"has ""quotes"" inside",c', "d,e,f"]);
  });

  it("drops a single trailing blank line (file ends with a newline) rather than treating it as an empty row", () => {
    expect(splitCsvLines("a,b\nc,d\n")).toEqual(["a,b", "c,d"]);
  });
});

describe("splitCsvFields", () => {
  it("splits a plain line into fields", () => {
    expect(splitCsvFields("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("keeps a comma inside a quoted field as part of that one field, not a delimiter", () => {
    expect(splitCsvFields('a,"b, with comma",c')).toEqual(["a", "b, with comma", "c"]);
  });

  it("unescapes a doubled quote inside a quoted field", () => {
    expect(splitCsvFields('a,"say ""hi""",c')).toEqual(["a", 'say "hi"', "c"]);
  });

  it("preserves empty fields", () => {
    expect(splitCsvFields("a,,c")).toEqual(["a", "", "c"]);
  });
});

describe("findDuplicateFarIds", () => {
  const header = ["farId", "subClassification", "assetDescription"];

  it("flags no rows when every FAR ID is unique", () => {
    const lines = ["FAR-1,Test-Sub,A", "FAR-2,Test-Sub,B"];
    expect(findDuplicateFarIds(header, lines)).toEqual([]);
  });

  it("flags the second (and later) occurrence, case-insensitively, with the correct 1-based row number (header = row 1)", () => {
    const lines = ["FAR-1,Test-Sub,A", "far-1,Test-Sub,B", "FAR-2,Test-Sub,C", "FAR-1,Test-Sub,D"];
    const dups = findDuplicateFarIds(header, lines);
    expect(dups).toEqual([
      { row: 3, farId: "far-1", message: 'Duplicate FAR ID "far-1" — already appears earlier in this file.' },
      { row: 5, farId: "FAR-1", message: 'Duplicate FAR ID "FAR-1" — already appears earlier in this file.' }
    ]);
  });

  it("ignores a blank farId cell rather than treating repeated blanks as duplicates of each other", () => {
    const lines = [",Test-Sub,A", ",Test-Sub,B"];
    expect(findDuplicateFarIds(header, lines)).toEqual([]);
  });

  it("returns no duplicates (rather than throwing) when the header has no farId column at all", () => {
    expect(findDuplicateFarIds(["notFarId"], ["x", "y"])).toEqual([]);
  });
});

describe("chunkCsvRows", () => {
  const header = ["farId", "assetDescription"];

  it("puts every row in one chunk when the file is smaller than CHUNK_ROWS", () => {
    const lines = ["FAR-1,A", "FAR-2,B"];
    const chunks = chunkCsvRows(header, lines);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.rowOffset).toBe(0);
  });

  it("splits into multiple chunks at the CHUNK_ROWS boundary, with correct rowOffset per chunk", async () => {
    const lines = Array.from({ length: CHUNK_ROWS + 1 }, (_, i) => `FAR-${i},Asset ${i}`);
    const chunks = chunkCsvRows(header, lines);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.rowOffset).toBe(0);
    expect(chunks[1]!.rowOffset).toBe(CHUNK_ROWS);

    // Each chunk's blob starts with the same header line, followed by only its own rows.
    const firstText = await chunks[0]!.blob.text();
    const firstLines = firstText.split("\r\n");
    expect(firstLines[0]).toBe("farId,assetDescription");
    expect(firstLines).toHaveLength(1 + CHUNK_ROWS);

    const secondText = await chunks[1]!.blob.text();
    const secondLines = secondText.split("\r\n");
    expect(secondLines[0]).toBe("farId,assetDescription");
    expect(secondLines).toHaveLength(2); // header + the 1 overflow row
    expect(secondLines[1]).toBe(`FAR-${CHUNK_ROWS},Asset ${CHUNK_ROWS}`);
  });

  it("uses a caller-supplied chunkRows instead of the CHUNK_ROWS default", () => {
    const lines = ["FAR-1,A", "FAR-2,B", "FAR-3,C"];
    const chunks = chunkCsvRows(header, lines, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.rowOffset).toBe(0);
    expect(chunks[1]!.rowOffset).toBe(2);
  });
});
