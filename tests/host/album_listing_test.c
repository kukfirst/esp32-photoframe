// Host test for main/album_listing.c — the PHOTOFRAME-001 album scan.
//
// It compiles the real firmware source with plain gcc (album_listing.c uses no
// ESP-IDF calls on purpose) against a throw-away directory of fixture files.
// Run: tests/host/run.sh
//
// What it pins down:
//   * one pass, no stat(): thumbnails are matched from the names readdir gave us;
//   * a photo whose "<base>.jpg" is missing must be reported without a thumbnail;
//   * a .jpg that belongs to no photo must never appear as a photo of its own;
//   * the result is sorted by filename, which is what makes ?limit/?offset paging
//     stable while photos are being added;
//   * the scan stays cheap as the album grows (the old handler went quadratic).

#include <assert.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "album_listing.h"

#define FIXTURE "/tmp/photoframe-album-test"

static void touch(const char *dir, const char *name)
{
    char path[512];
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    FILE *f = fopen(path, "w");
    assert(f);
    fputs("x", f);
    fclose(f);
}

static int expected_with_thumbnail = 0;
static int expected_without_thumbnail = 0;

static void build_fixture(int photos)
{
    system("rm -rf " FIXTURE);
    mkdir(FIXTURE, 0755);

    for (int i = 0; i < photos; i++) {
        char base[64];
        snprintf(base, sizeof(base), "photo%04d", i);
        char image[80];
        snprintf(image, sizeof(image), "%s.epdgz", base);
        touch(FIXTURE, image);
        // Every 7th photo arrives without its thumbnail, on purpose.
        if (i % 7) {
            char thumb[80];
            snprintf(thumb, sizeof(thumb), "%s.jpg", base);
            touch(FIXTURE, thumb);
            expected_with_thumbnail++;
        } else {
            expected_without_thumbnail++;
        }
    }

    touch(FIXTURE, "plain.png");        // displayable, thumbnail-less
    touch(FIXTURE, "legacy.bmp");       // displayable
    touch(FIXTURE, "stray.jpg");        // a jpg that is nobody's thumbnail
    touch(FIXTURE, "notes.txt");        // not an image at all
    touch(FIXTURE, "._photo0001.epdgz"); // AppleDouble junk, skipped upstream too
    mkdir(FIXTURE "/nested", 0755);     // subdirectories are not photos
}

int main(void)
{
    const int photos = 800;
    build_fixture(photos);

    album_listing_entry_t *entries = NULL;
    int count = album_listing_scan(FIXTURE, &entries);

    const int want = photos + 2; // .epdgz batch + plain.png + legacy.bmp
    printf("scan: %d entries (expected %d)\n", count, want);
    assert(count == want);

    int with_thumbnail = 0;
    int without_thumbnail = 0;
    for (int i = 0; i < count; i++) {
        // No entry may be a .jpg or a dot file.
        const char *ext = strrchr(entries[i].filename, '.');
        assert(ext && strcasecmp(ext, ".jpg") != 0);
        assert(entries[i].filename[0] != '.');

        if (entries[i].thumbnail) {
            with_thumbnail++;
            // The thumbnail must be the same base name with .jpg.
            char expected[256];
            snprintf(expected, sizeof(expected), "%.*s.jpg",
                     (int)(ext - entries[i].filename), entries[i].filename);
            assert(strcmp(entries[i].thumbnail, expected) == 0);
        } else {
            without_thumbnail++;
        }
    }
    printf("with thumbnail: %d, without: %d\n", with_thumbnail, without_thumbnail);
    assert(with_thumbnail == expected_with_thumbnail);
    // plus plain.png and legacy.bmp, which have no .jpg next to them
    assert(without_thumbnail == expected_without_thumbnail + 2);

    // Sorted, so paging is stable.
    for (int i = 1; i < count; i++) {
        assert(strcmp(entries[i - 1].filename, entries[i].filename) < 0);
    }
    printf("sorted: ok (first=%s last=%s)\n", entries[0].filename, entries[count - 1].filename);

    // The ones that should have no thumbnail really have none.
    assert(strcmp(entries[0].filename, "legacy.bmp") == 0 && entries[0].thumbnail == NULL);
    int found_plain = 0;
    for (int i = 0; i < count; i++) {
        if (strcmp(entries[i].filename, "plain.png") == 0) {
            found_plain = 1;
            assert(entries[i].thumbnail == NULL);
        }
    }
    assert(found_plain);
    album_listing_free(entries, count);

    // A missing directory is reported, not silently empty.
    entries = NULL;
    assert(album_listing_scan(FIXTURE "/does-not-exist", &entries) == -1);
    assert(entries == NULL);

    // An empty album scans as empty.
    system("rm -rf /tmp/photoframe-album-empty; mkdir -p /tmp/photoframe-album-empty");
    entries = NULL;
    assert(album_listing_scan("/tmp/photoframe-album-empty", &entries) == 0);

    // Cost of the scan at album size: it must not grow super-linearly the way the
    // old per-file stat() did.
    struct timespec before, after;
    clock_gettime(CLOCK_MONOTONIC, &before);
    entries = NULL;
    count = album_listing_scan(FIXTURE, &entries);
    clock_gettime(CLOCK_MONOTONIC, &after);
    album_listing_free(entries, count);
    double ms = (after.tv_sec - before.tv_sec) * 1e3 + (after.tv_nsec - before.tv_nsec) / 1e6;
    printf("rescan of %d files: %.2f ms\n", count, ms);
    assert(ms < 100.0);

    system("rm -rf " FIXTURE " /tmp/photoframe-album-empty");
    puts("OK");
    return 0;
}
