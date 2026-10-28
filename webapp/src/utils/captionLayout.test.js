import { describe, expect, it } from "vitest";
import { MAX_ZOOM, clampView, coverZoom } from "./captionLayout";

const portrait = { width: 3000, height: 4000 };
const W = 1600;
const H = 1200;

describe("coverZoom", () => {
  it("is the zoom at which a portrait photo covers a landscape frame", () => {
    // fit = 1200/4000 = 0.3, cover = 1600/3000 = 0.5333
    expect(coverZoom(portrait, W, H)).toBeCloseTo(0.5333 / 0.3, 3);
  });
});

describe("clampView", () => {
  it("bounds the zoom", () => {
    expect(clampView(portrait, W, H, { zoom: 0.2, u: 0.5, v: 0.5 }).zoom).toBe(1);
    expect(clampView(portrait, W, H, { zoom: 99, u: 0.5, v: 0.5 }).zoom).toBe(MAX_ZOOM);
  });

  it("centres an axis where the photo is smaller than the frame", () => {
    // At zoom 1 the portrait photo is 900 px wide in a 1600 px frame.
    expect(clampView(portrait, W, H, { zoom: 1, u: 0.1, v: 0.9 })).toEqual({
      zoom: 1,
      u: 0.5,
      v: 0.5,
    });
  });

  it("never leaves a gap on an axis where the photo is larger", () => {
    // At zoom 2 the photo is 1800 x 2400: v may move, but not past the edges.
    const view = clampView(portrait, W, H, { zoom: 2, u: 0.5, v: 0 });
    expect(view.v).toBeCloseTo(600 / 2400, 5); // top edge flush with the frame
    expect(clampView(portrait, W, H, { zoom: 2, u: 0.99, v: 0.5 }).u).toBeCloseTo(
      1 - 800 / 1800,
      5
    );
  });
});
