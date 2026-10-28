import { describe, expect, it } from "vitest";
import {
  assignPlaces,
  buildIndex,
  matchToken,
  nearestCity,
  parseFolderName,
  placeLabel,
  timeGroups,
} from "./folderPlaces";

const gazetteer = {
  cities: [
    ["Vienna", "AT", 1691468, 48.208, 16.372, ["Wien", "Vienne", "Вена"]],
    ["Graz", "AT", 303270, 47.067, 15.442, ["Grac"]],
    ["Salzburg", "AT", 157245, 47.799, 13.044, []],
    ["Amsterdam", "NL", 741636, 52.374, 4.89, []],
    ["Helsinki", "FI", 558457, 60.17, 24.935, ["Helsingfors"]],
    ["Paris", "FR", 2138551, 48.853, 2.349, []],
    ["Paris", "US", 25171, 33.661, -95.556, []],
  ],
};
const index = buildIndex(gazetteer, ["AT", "NL", "FI", "FR", "US"]);
const best = (t) => placeLabel(matchToken(index, t).places[0]);

describe("parseFolderName", () => {
  it("reads date and places", () => {
    expect(parseFolderName("2011.09 Finnland-Netherland-Vienna")).toEqual({
      year: 2011,
      month: 9,
      tokens: ["Finnland", "Netherland", "Vienna"],
    });
    expect(parseFolderName("2013.01 Vienn-Graz-Salzburg").tokens).toEqual([
      "Vienn",
      "Graz",
      "Salzburg",
    ]);
  });

  it("copes with no date", () => {
    expect(parseFolderName("Paris")).toEqual({ year: null, month: null, tokens: ["Paris"] });
  });
});

describe("matchToken", () => {
  it("finds countries in other languages and with typos", () => {
    expect(best("Finnland")).toBe("Finland");
    expect(best("Netherland")).toBe("Netherlands");
    expect(best("Австрия")).toBe("Austria");
  });

  it("finds cities by alternate names and close spellings", () => {
    expect(best("Wien")).toBe("Vienna, Austria");
    expect(best("Vienn")).toBe("Vienna, Austria");
    expect(matchToken(index, "Vienn").exact).toBe(false);
  });

  it("ranks ambiguous names by population and keeps the rest as options", () => {
    const { places } = matchToken(index, "Paris");
    expect(places.map(placeLabel)).toEqual(["Paris, France", "Paris, United States"]);
  });
});

describe("nearestCity", () => {
  it("maps GPS to the closest city", () => {
    expect(nearestCity(index, { lat: 48.2, lon: 16.4 }).name).toBe("Vienna");
  });
});

describe("timeGroups / assignPlaces", () => {
  const h = (d, hour) => new Date(2011, 8, d, hour).getTime();
  it("splits on a new day or a long gap", () => {
    const photos = [
      { time: h(1, 10) },
      { time: h(1, 11) },
      { time: null },
      { time: h(2, 9) },
      { time: h(2, 20) },
    ];
    expect(timeGroups(photos).map((g) => g.length)).toEqual([3, 1, 1]);
  });

  it("spreads the folder's places over groups in order", () => {
    expect(assignPlaces(3, 3)).toEqual([0, 1, 2]);
    expect(assignPlaces(6, 3)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(assignPlaces(2, 1)).toEqual([0, 0]);
    expect(assignPlaces(2, 0)).toEqual([null, null]);
  });
});
