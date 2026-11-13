#ifndef ALBUM_MANAGER_H
#define ALBUM_MANAGER_H

#include <stdbool.h>

#include "esp_err.h"

esp_err_t album_manager_init(void);
esp_err_t album_manager_ensure_default_album(void);
esp_err_t album_manager_list_albums(char ***albums, int *count);
void album_manager_free_album_list(char **albums, int count);
esp_err_t album_manager_create_album(const char *album_name);
esp_err_t album_manager_delete_album(const char *album_name);
esp_err_t album_manager_set_album_enabled(const char *album_name, bool enabled);
bool album_manager_is_album_enabled(const char *album_name);
esp_err_t album_manager_get_enabled_albums(char ***albums, int *count);
esp_err_t album_manager_get_album_path(const char *album_name, char *path, size_t path_len);
bool album_manager_album_exists(const char *album_name);

// PHOTOFRAME-001: pick which album an upload belongs to, spreading the collection
// over "Default", "Default 2", "Default 3", … Auto-rotate picks a random image
// across *all* enabled albums, so the split is invisible on screen; it exists
// because listing an album is a walk of that album's directory, which is what
// stops answering once an album grows to hundreds of files. A bucket the picker
// creates is enabled immediately, otherwise rotation would skip it.
esp_err_t album_manager_pick_upload_album(char *out, size_t out_len, int capacity);
int album_manager_count_album_images(const char *album_name);

#endif
