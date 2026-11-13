#ifndef ALBUM_LISTING_H
#define ALBUM_LISTING_H

#include <stdbool.h>

// PHOTOFRAME-001: how one album directory is walked.
//
// The original handler ran stat() once per image to find that image's thumbnail.
// Each lookup re-walks the album directory, so listing N photos cost O(N^2)
// directory traffic on the SD card: measured on the owner's frame, a 3-photo album
// listed in 25 ms while a 301-photo album never answered within 60 s. The file
// names are already in hand from readdir, so this module collects them in a single
// pass and matches thumbnails in memory instead.
//
// Kept free of ESP-IDF calls on purpose: tests/host/album_listing_test.c compiles
// this file with plain gcc against a directory of fixture files.

typedef struct {
    char *filename;   // displayable image file, owned by the entry
    char *thumbnail;  // matching "<base>.jpg", or NULL; owned by the entry
} album_listing_entry_t;

// Scan `album_path` in one readdir pass. On success returns the number of entries
// and stores a malloc'ed array (NULL when the album is empty) sorted by filename —
// sorted, so that paging with ?limit/?offset stays stable while photos are added.
// Returns -1 if the directory cannot be opened, -2 on allocation failure.
int album_listing_scan(const char *album_path, album_listing_entry_t **entries);

void album_listing_free(album_listing_entry_t *entries, int count);

#endif
