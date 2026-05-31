/**
 * Concrete runtime values for Joplin plugin API enums.
 *
 * `api/types` is NOT available via require() in the Joplin plugin sandbox —
 * it is a compile-time-only module in the official generator template.
 * We bundle the enum values we actually use here so they are always present
 * without relying on the sandbox module system.
 *
 * Values are taken from @joplin/lib/services/plugins/api/types.ts.
 * Keep in sync when raising app_min_version.
 */

export enum SettingItemType {
  Int = 1,
  String = 2,
  Bool = 3,
  Array = 4,
  Object = 5,
  Button = 6,
}

export enum MenuItemLocation {
  File = 'file',
  Edit = 'edit',
  View = 'view',
  Note = 'note',
  Folder = 'folder',
  Tools = 'tools',
  Help = 'help',
  EditorContextMenu = 'editorContextMenu',
  NoteListContextMenu = 'noteListContextMenu',
  FolderContextMenu = 'folderContextMenu',
  TagContextMenu = 'tagContextMenu',
  Context = 'context',
}
