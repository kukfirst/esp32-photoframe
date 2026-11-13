#include "album_listing.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

typedef struct {
    char **names;
    int count;
    int capacity;
    bool failed;
} name_list_t;

static void name_list_init(name_list_t *list)
{
    list->names = NULL;
    list->count = 0;
    list->capacity = 0;
    list->failed = false;
}

static void name_list_push(name_list_t *list, const char *name)
{
    if (list->count == list->capacity) {
        int new_capacity = list->capacity ? list->capacity * 2 : 64;
        char **grown = realloc(list->names, (size_t)new_capacity * sizeof(char *));
        if (!grown) {
            list->failed = true;
            return;
        }
        list->names = grown;
        list->capacity = new_capacity;
    }

    list->names[list->count] = strdup(name);
    if (!list->names[list->count]) {
        list->failed = true;
        return;
    }
    list->count++;
}

static void name_list_free(name_list_t *list)
{
    if (!list->names) {
        return;
    }
    for (int i = 0; i < list->count; i++) {
        free(list->names[i]);
    }
    free(list->names);
    list->names = NULL;
    list->count = 0;
    list->capacity = 0;
}

static int compare_string_pointers(const void *a, const void *b)
{
    return strcmp(*(char *const *)a, *(char *const *)b);
}

static bool sorted_names_contain(char **sorted, int count, const char *name)
{
    int low = 0;
    int high = count - 1;
    while (low <= high) {
        int mid = low + (high - low) / 2;
        int cmp = strcmp(sorted[mid], name);
        if (cmp == 0) {
            return true;
        }
        if (cmp < 0) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return false;
}

static const char *extension_of(const char *name)
{
    const char *dot = strrchr(name, '.');
    if (!dot || dot == name) {
        return NULL;
    }
    return dot;
}

static bool is_displayable_image(const char *name)
{
    const char *ext = extension_of(name);
    if (!ext) {
        return false;
    }
    return strcasecmp(ext, ".bmp") == 0 || strcasecmp(ext, ".png") == 0 ||
           strcasecmp(ext, ".epdgz") == 0;
}

static bool is_thumbnail(const char *name)
{
    const char *ext = extension_of(name);
    return ext && strcasecmp(ext, ".jpg") == 0;
}

int album_listing_scan(const char *album_path, album_listing_entry_t **entries)
{
    if (!album_path || !entries) {
        return -1;
    }
    *entries = NULL;

    DIR *dir = opendir(album_path);
    if (!dir) {
        return -1;
    }

    name_list_t images;
    name_list_t thumbnails;
    name_list_init(&images);
    name_list_init(&thumbnails);

    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        // "._something" are AppleDouble leftovers, skipped by the original handler
        // too; anything else that is not a regular file is skipped by type.
        if (entry->d_name[0] == '.' && entry->d_name[1] == '_') {
            continue;
        }
        if (entry->d_type != DT_REG && entry->d_type != DT_UNKNOWN) {
            continue;
        }

        if (is_thumbnail(entry->d_name)) {
            name_list_push(&thumbnails, entry->d_name);
        } else if (is_displayable_image(entry->d_name)) {
            name_list_push(&images, entry->d_name);
        }
    }
    closedir(dir);

    if (images.failed || thumbnails.failed) {
        name_list_free(&images);
        name_list_free(&thumbnails);
        return -2;
    }

    // qsort() with a NULL base is undefined even for a count of 0.
    if (images.count > 1) {
        qsort(images.names, (size_t)images.count, sizeof(char *), compare_string_pointers);
    }
    if (thumbnails.count > 1) {
        qsort(thumbnails.names, (size_t)thumbnails.count, sizeof(char *),
              compare_string_pointers);
    }

    if (images.count == 0) {
        name_list_free(&images);
        name_list_free(&thumbnails);
        return 0;
    }

    album_listing_entry_t *out = calloc((size_t)images.count, sizeof(album_listing_entry_t));
    if (!out) {
        name_list_free(&images);
        name_list_free(&thumbnails);
        return -2;
    }

    const int total = images.count;

    for (int i = 0; i < total; i++) {
        out[i].filename = images.names[i];
        images.names[i] = NULL; // ownership moves to the entry

        const char *ext = extension_of(out[i].filename);
        if (ext && thumbnails.count > 0) {
            char thumbnail_name[256];
            snprintf(thumbnail_name, sizeof(thumbnail_name), "%.*s.jpg",
                     (int)(ext - out[i].filename), out[i].filename);
            if (sorted_names_contain(thumbnails.names, thumbnails.count, thumbnail_name)) {
                out[i].thumbnail = strdup(thumbnail_name);
                if (!out[i].thumbnail) {
                    album_listing_free(out, total);
                    name_list_free(&thumbnails);
                    return -2;
                }
            }
        }
    }

    name_list_free(&images);
    name_list_free(&thumbnails);
    *entries = out;
    return total;
}

void album_listing_free(album_listing_entry_t *entries, int count)
{
    if (!entries) {
        return;
    }
    for (int i = 0; i < count; i++) {
        free(entries[i].filename);
        free(entries[i].thumbnail);
    }
    free(entries);
}
