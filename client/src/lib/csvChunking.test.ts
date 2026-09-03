import { describe, expect, it } from "vitest";
import {
  CHUNK_ROWS,
  chunkCsvRows,
  findDuplicateFarIds,
  findDuplicateMasterKeys,
  findMergeFileConflicts,
  splitCsvFields,
  splitCsvLines
} from "./csvChunking.js";

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

describe("findDuplicateMasterKeys", () => {
  it("flags the second (and later) occurrence of a Code column, case-insensitively", () => {
    const check = findDuplicateMasterKeys("code", "Code");
    const lines = ["CTR-1,Desc A,true", "ctr-1,Desc B,true", "CTR-2,Desc C,true"];
    expect(check(["code", "description", "active"], lines)).toEqual([
      { row: 3, farId: "ctr-1", message: 'Duplicate Code "ctr-1" — already appears earlier in this file.' }
    ]);
  });

  it("returns no duplicates when the configured key column is missing", () => {
    const check = findDuplicateMasterKeys("code", "Code");
    expect(check(["name"], ["x"])).toEqual([]);
  });
});

describe("findMergeFileConflicts", () => {
  const header = ["parentFarId", "childFarId"];

  it("flags no conflicts for a clean file", () => {
    const lines = ["FAR-1,FAR-2", "FAR-3,FAR-4"];
    expect(findMergeFileConflicts(header, lines)).toEqual([]);
  });

  it("flags every row for a child FAR ID used more than once (Rule 7)", () => {
    const lines = ["FAR-1,FAR-9", "FAR-2,FAR-9"];
    const errors = findMergeFileConflicts(header, lines);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.message).toContain('Child FAR ID "FAR-9" appears 2 times');
    expect(errors[1]!.message).toContain('Child FAR ID "FAR-9" appears 2 times');
  });

  it("flags a literal A-parent-of-B / B-parent-of-A cycle (Rule 8) — alongside the separate parent/child-in-different-rows check, which fires independently for the same pair, same as the server", () => {
    const lines = ["FAR-1,FAR-2", "FAR-2,FAR-1"];
    const errors = findMergeFileConflicts(header, lines).map((e) => e.message);
    expect(errors).toContain('Cycle detected: "FAR-1" and "FAR-2" can\'t both be parent of each other in the same file.');
    expect(errors).toContain('Cycle detected: "FAR-2" and "FAR-1" can\'t both be parent of each other in the same file.');
    expect(errors).toHaveLength(6);
  });

  it("flags a FAR ID used as a parent in one row and a child in another", () => {
    const lines = ["FAR-1,FAR-2", "FAR-2,FAR-3"];
    const errors = findMergeFileConflicts(header, lines);
    expect(errors.some((e) => e.message.includes('"FAR-2" is used as a parent here'))).toBe(true);
    expect(errors.some((e) => e.message.includes('"FAR-2" is used as a child here'))).toBe(true);
  });

  it("is case-sensitive, matching the server's own comparisons exactly", () => {
    const lines = ["FAR-1,far-9", "FAR-2,FAR-9"];
    expect(findMergeFileConflicts(header, lines)).toEqual([]);
  });

  it("returns no conflicts when the parentFarId/childFarId columns are missing", () => {
    expect(findMergeFileConflicts(["farId"], ["x"])).toEqual([]);
  });
});
