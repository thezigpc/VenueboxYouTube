import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildQueue, combine, normalizeTvCode, parseChannelLink, parseIsoDuration, parseYouTubeLink, type Video } from "../src/index.js";

describe("parseYouTubeLink", () => {
  test("watch, share, shorts and bare ids", () => {
    assert.deepEqual(parseYouTubeLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), { kind: "video", videoId: "dQw4w9WgXcQ" });
    assert.deepEqual(parseYouTubeLink("youtu.be/dQw4w9WgXcQ?si=abc"), { kind: "video", videoId: "dQw4w9WgXcQ" });
    assert.deepEqual(parseYouTubeLink("https://youtube.com/shorts/dQw4w9WgXcQ"), { kind: "video", videoId: "dQw4w9WgXcQ" });
    assert.deepEqual(parseYouTubeLink("dQw4w9WgXcQ"), { kind: "video", videoId: "dQw4w9WgXcQ" });
    assert.deepEqual(parseYouTubeLink("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30"), { kind: "video", videoId: "dQw4w9WgXcQ" });
  });

  test("playlists", () => {
    const id = "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG";
    assert.deepEqual(parseYouTubeLink(`https://www.youtube.com/playlist?list=${id}`), { kind: "playlist", listId: id });
    assert.deepEqual(parseYouTubeLink(id), { kind: "playlist", listId: id });
    assert.deepEqual(parseYouTubeLink(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${id}`), { kind: "video", videoId: "dQw4w9WgXcQ", listId: id });
  });

  test("mixes, Watch Later and other sites aren't lists", () => {
    assert.equal(parseYouTubeLink("https://www.youtube.com/playlist?list=WL"), null);
    assert.deepEqual(parseYouTubeLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ"), { kind: "video", videoId: "dQw4w9WgXcQ" });
    assert.equal(parseYouTubeLink("https://vimeo.com/123"), null);
    assert.equal(parseYouTubeLink("hello there"), null);
    assert.equal(parseYouTubeLink(""), null);
  });
});

test("channel links", () => {
  assert.deepEqual(parseChannelLink("@thezigpc"), { handle: "@thezigpc" });
  assert.deepEqual(parseChannelLink("https://www.youtube.com/@thezigpc/videos"), { handle: "@thezigpc" });
  assert.deepEqual(parseChannelLink("youtube.com/channel/UCuJgSr1zwEtSUBITTF2XI1w"), { channelId: "UCuJgSr1zwEtSUBITTF2XI1w" });
  assert.deepEqual(parseChannelLink("https://www.youtube.com/user/someone"), { username: "someone" });
  assert.equal(parseChannelLink("https://www.youtube.com/c/Old"), null);
  assert.equal(parseChannelLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
});

test("TV codes", () => {
  assert.equal(normalizeTvCode("123 456 789 012"), "123456789012");
  assert.equal(normalizeTvCode("123-456-789-012"), "123456789012");
  assert.equal(normalizeTvCode("12345"), null);
  assert.equal(normalizeTvCode("abcdefghijkl"), null);
});

test("ISO durations", () => {
  assert.equal(parseIsoDuration("PT3M33S"), 213);
  assert.equal(parseIsoDuration("PT1H"), 3600);
  assert.equal(parseIsoDuration("P1DT1S"), 86401);
  assert.equal(parseIsoDuration("junk"), undefined);
});

const vids = (...ids: string[]): Video[] => ids.map((id) => ({ id, title: id, channel: "" }));

describe("buildQueue", () => {
  const rules = { shuffle: false, loop: false, noRepeatHours: 0 };

  test("keeps order, drops unplayable and duplicates", () => {
    const v = [...vids("a", "b", "a"), { id: "c", title: "", channel: "", unavailable: "Private" }, ...vids("d")];
    assert.deepEqual(buildQueue(v, rules).map((x) => x.id), ["a", "b", "d"]);
  });

  test("shuffle uses every video once", () => {
    const q = buildQueue(vids("a", "b", "c", "d", "e"), { ...rules, shuffle: true });
    assert.deepEqual(q.map((x) => x.id).sort(), ["a", "b", "c", "d", "e"]);
  });

  test("recently played go last, oldest first", () => {
    const now = 10 * 3600_000;
    const lastPlayed = { a: now - 1000, b: now - 2000, c: now - 5 * 3600_000 };
    const q = buildQueue(vids("a", "b", "c", "d"), { ...rules, shuffle: true, noRepeatHours: 2 }, { lastPlayed, now });
    const ids = q.map((x) => x.id);
    assert.deepEqual(ids.slice(2), ["b", "a"]);
    assert.deepEqual(ids.slice(0, 2).sort(), ["c", "d"]);
  });
});

test("combine appends new videos only", () => {
  assert.deepEqual(combine(vids("a", "b"), vids("b", "c", "c")).map((v) => v.id), ["a", "b", "c"]);
});
