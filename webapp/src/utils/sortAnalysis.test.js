import { describe, expect, it } from "vitest";
import {
  clusterFaces,
  exifGps,
  exifTime,
  isGoodFace,
  markBursts,
  preselect,
  scorePhoto,
} from "./sortAnalysis";

const unit = (i) => {
  const e = new Float32Array(512);
  e[i] = 1;
  return e;
};
const face = (embedding, over = {}) => ({
  score: 0.9,
  box: [0.3, 0.3, 0.4, 0.45],
  sharpness: 200,
  embedding,
  ...over,
});
const me = { id: "a", name: "A", embeddings: [unit(0)] };
const you = { id: "b", name: "B", embeddings: [unit(1)] };

describe("isGoodFace", () => {
  it("rejects small, blurry, low-confidence and edge-cut faces", () => {
    expect(isGoodFace(face(unit(0)))).toBe(true);
    expect(isGoodFace(face(unit(0), { box: [0.3, 0.3, 0.32, 0.33] }))).toBe(false);
    expect(isGoodFace(face(unit(0), { sharpness: 5 }))).toBe(false);
    expect(isGoodFace(face(unit(0), { score: 0.52 }))).toBe(false);
    expect(isGoodFace(face(unit(0), { box: [0, 0.3, 0.1, 0.45] }))).toBe(false);
  });
});

describe("scorePhoto / preselect", () => {
  it("marks 'us' only when every tagged person is there", () => {
    const both = scorePhoto({ faces: [face(unit(0)), face(unit(1))] }, [me, you]);
    const one = scorePhoto({ faces: [face(unit(0)), face(unit(7))] }, [me, you]);
    expect(both.us).toBe(true);
    expect(one.us).toBe(false);
    expect(one.people).toEqual(["a"]);
    expect(both.score).toBeGreaterThan(one.score);
    expect(preselect(both, 2)).toBe(true);
    expect(preselect(one, 2)).toBe(false);
  });

  it("without tagged people pre-checks two or more good faces", () => {
    const two = scorePhoto({ faces: [face(unit(3)), face(unit(4))] }, []);
    const solo = scorePhoto({ faces: [face(unit(3))] }, []);
    expect(preselect(two, 0)).toBe(true);
    expect(preselect(solo, 0)).toBe(false);
  });
});

describe("markBursts", () => {
  it("keeps the best of near-identical shots seconds apart", () => {
    const h = "0".repeat(64);
    const photos = [
      { id: 1, time: 0, hash: h, score: 10 },
      { id: 2, time: 5000, hash: "1" + h.slice(1), score: 30 },
      { id: 3, time: 9000, hash: h, score: 20 },
      { id: 4, time: 600000, hash: h, score: 5 }, // ten minutes later: new scene
    ];
    markBursts(photos);
    expect(photos.map((p) => p.dupOf)).toEqual([2, null, 2, null]);
    expect(photos[1].burstSize).toBe(3);
  });

  it("also folds the same scene shot again within a minute and a half", () => {
    const a = "0".repeat(64);
    const b = "1".repeat(18) + "0".repeat(46); // 18 bits apart: same scene, new angle
    const photos = [
      { id: 1, time: 0, hash: a, score: 10 },
      { id: 2, time: 60_000, hash: b, score: 40 },
      { id: 3, time: 400_000, hash: b, score: 5 }, // later: not folded by scene rule
    ];
    markBursts(photos);
    expect(photos.map((p) => p.dupOf)).toEqual([2, null, null]);
  });
});

describe("clusterFaces", () => {
  it("groups the same person across photos", () => {
    const photos = [
      { faces: [face(unit(0)), face(unit(1))] },
      { faces: [face(unit(0))] },
      { faces: [face(unit(1)), face(unit(9))] },
    ];
    expect(clusterFaces(photos).map((c) => c.members.length)).toEqual([2, 2, 1]);
  });
});

describe("EXIF helpers", () => {
  it("parses time and drops clock-reset years", () => {
    expect(exifTime("2015:04:20 17:35:51")).toBe(new Date(2015, 3, 20, 17, 35, 51).getTime());
    expect(exifTime("1970:01:01 00:00:00")).toBeNull();
    expect(exifTime(undefined)).toBeNull();
  });

  it("applies GPS hemispheres", () => {
    expect(exifGps({ lat: 41.38, latRef: "N", lon: 2.17, lonRef: "W" })).toEqual({
      lat: 41.38,
      lon: -2.17,
    });
    expect(exifGps({})).toBeNull();
  });
});
