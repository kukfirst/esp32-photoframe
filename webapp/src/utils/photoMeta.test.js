import { describe, expect, it } from "vitest";
import { collectDates, exifDates, gpsFromTags, nameDates, pickDate } from "./photoMeta";

const d = (...a) => new Date(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0, a[5] ?? 0);
const names = (n) => nameDates(n).map((c) => c.value.getTime());

describe("nameDates", () => {
  it("reads camera names", () => {
    expect(names("IMG_20190704_153012.jpg")).toEqual([d(2019, 7, 4, 15, 30, 12).getTime()]);
    expect(names("PXL_20230101_101010123.jpg")).toEqual([d(2023, 1, 1, 10, 10, 10).getTime()]);
    expect(names("Screenshot_20200102-030405.png")).toEqual([d(2020, 1, 2, 3, 4, 5).getTime()]);
  });

  it("reads WhatsApp names", () => {
    expect(names("WhatsApp Image 2019-07-04 at 15.30.12.jpeg")).toEqual([
      d(2019, 7, 4, 15, 30, 12).getTime(),
    ]);
    expect(names("IMG-20190704-WA0001.jpg")).toEqual([d(2019, 7, 4).getTime()]);
  });

  it("ignores Telegram download names and dateless names", () => {
    expect(names("photo_2026-10-28_12-44-21.jpg")).toEqual([]);
    expect(names("scan_grandma.jpg")).toEqual([]);
    expect(names("IMG_20191340_000000.jpg")).toEqual([]); // month 13
  });
});

describe("collectDates / pickDate", () => {
  const now = d(2026, 10, 28);

  it("prefers the earliest plausible date", () => {
    const cands = [
      { source: "file:lastModified", value: d(2024, 5, 1) },
      { source: "exif:DateTimeOriginal", value: d(2013, 6, 12) },
      { source: "exif:DateTime", value: d(1970, 1, 1) }, // camera clock reset
      { source: "bogus", value: d(2099, 1, 1) }, // future
    ];
    expect(pickDate(cands, now).value).toEqual(d(2013, 6, 12));
    expect(pickDate([], now)).toBeNull();
  });

  it("drops lastModified for Telegram download names", () => {
    expect(collectDates({}, "photo_2026-10-28_12-44-21.jpg", now.getTime())).toEqual([]);
    expect(collectDates({}, "holiday.jpg", now.getTime()).map((c) => c.source)).toEqual([
      "file:lastModified",
    ]);
  });

  it("parses EXIF date strings", () => {
    const tags = { DateTimeOriginal: { description: "2015:08:03 19:45:00" } };
    expect(exifDates(tags)).toEqual([
      { source: "exif:DateTimeOriginal", value: d(2015, 8, 3, 19, 45) },
    ]);
  });
});

describe("gpsFromTags", () => {
  it("applies hemisphere refs", () => {
    const tags = {
      GPSLatitude: { description: 39.625 },
      GPSLatitudeRef: { value: ["S"] },
      GPSLongitude: { description: 19.92 },
      GPSLongitudeRef: { value: ["W"] },
    };
    expect(gpsFromTags(tags)).toEqual({ lat: -39.625, lon: -19.92 });
  });

  it("returns null without GPS", () => {
    expect(gpsFromTags({})).toBeNull();
  });
});
