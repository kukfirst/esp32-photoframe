"""Build the compact gazetteer the Sort tab uses to read folder names.

Input: GeoNames cities15000.txt (CC BY 4.0, https://download.geonames.org/export/dump/).
Output JSON: {"source": ..., "cities": [[name, country_code, population, lat, lon, [alt names]], ...]}
Only Latin and Cyrillic alternate names are kept: folder names use those scripts.

    python3 build_gazetteer.py cities15000.txt ~/models/photoframe/gazetteer.json
"""

import json
import re
import sys

SCRIPT_OK = re.compile(r"^[ -ɏЀ-ӿ'’.\-]+$")


def main(src: str, dst: str) -> None:
    cities = []
    with open(src, encoding="utf-8") as fh:
        for line in fh:
            f = line.rstrip("\n").split("\t")
            name, ascii_name, alts, lat, lon, cc, pop = f[1], f[2], f[3], f[4], f[5], f[8], f[14]
            if f[7] == "PPLX":
                continue  # sections of a city (Barri Gòtic): GPS should name the city
            seen = {name.casefold()}
            keep = []
            for alt in [ascii_name, *alts.split(",")]:
                alt = alt.strip()
                if not alt or len(alt) > 40 or not SCRIPT_OK.match(alt) or alt.casefold() in seen:
                    continue
                seen.add(alt.casefold())
                keep.append(alt)
            cities.append([name, cc, int(pop or 0), round(float(lat), 3), round(float(lon), 3), keep])
    cities.sort(key=lambda c: -c[2])
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump({"source": "GeoNames cities15000 (CC BY 4.0)", "cities": cities}, fh,
                  ensure_ascii=False, separators=(",", ":"))
    print(f"{len(cities)} cities -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
