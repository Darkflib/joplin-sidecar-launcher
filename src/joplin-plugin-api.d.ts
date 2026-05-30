/**
 * Ambient type declarations for the Joplin plugin API.
 *
 * The `api` module is a virtual module injected by the Joplin runtime —
 * it is never bundled. These declarations give TypeScript enough information
 * to type-check our source code without pulling in the full @joplin/lib
 * internal module graph (which has its own unrelated type errors).
 *
 * The shapes here are derived from @joplin/lib/services/plugins/api/.
 * Keep them in sync when upgrading Joplin's minimum version.
 */

// ---------------------------------------------------------------------------
// api/types
// ---------------------------------------------------------------------------
declare module 'api/types' {
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

  export interface SettingSection {
    label: string;
    iconName?: string;
    description?: string;
  }

  export interface SettingItem {
    section?: string;
    type: SettingItemType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
    label: string;
    description?: string;
    public: boolean;
    minimum?: number;
    maximum?: number;
    step?: number;
    isEnum?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: Record<string, any>;
    subType?: string;
    advanced?: boolean;
    storage?: number;
    secure?: boolean;
  }

  export interface MenuItem {
    commandName: string;
    accelerator?: string;
    label?: string;
  }

  export interface DialogButton {
    id: string;
    title: string;
  }

  export interface VersionInfo {
    version?: string;
    platform?: string;
    syncVersion?: number;
    profileVersion?: number;
    releaseDate?: string;
    revision?: string;
  }

  export interface CommandDeclaration {
    name: string;
    label?: string;
    iconName?: string;
    execute?: (...args: unknown[]) => Promise<unknown> | void;
  }
}

// ---------------------------------------------------------------------------
// api  (the joplin singleton)
// ---------------------------------------------------------------------------
declare module 'api' {
  import type {
    CommandDeclaration,
    DialogButton,
    MenuItem,
    MenuItemLocation,
    SettingItem,
    SettingSection,
    VersionInfo,
  } from 'api/types';

  interface JoplinSettings {
    registerSection(name: string, section: SettingSection): Promise<void>;
    registerSettings(settings: Record<string, SettingItem>): Promise<void>;
    value(key: string): Promise<unknown>;
    setValue(key: string, value: unknown): Promise<void>;
    onChange(callback: (event: { keys: string[] }) => Promise<void>): Promise<void>;
    globalValue(key: string): Promise<unknown>;
  }

  interface JoplinCommands {
    register(declaration: CommandDeclaration): Promise<void>;
    execute(commandName: string, ...args: unknown[]): Promise<unknown>;
  }

  interface JoplinViewsPanels {
    create(id: string): Promise<string>;
    setHtml(handle: string, html: string): Promise<void>;
    show(handle: string, show?: boolean): Promise<void>;
    visible(handle: string): Promise<boolean>;
    onMessage(handle: string, callback: (message: unknown) => Promise<unknown>): Promise<void>;
    postMessage(handle: string, message: unknown): Promise<void>;
  }

  interface JoplinViewsMenus {
    create(
      id: string,
      label: string,
      menuItems: MenuItem[],
      location?: MenuItemLocation,
    ): Promise<void>;
  }

  interface JoplinViewsMenuItems {
    create(
      id: string,
      commandName: string,
      location?: MenuItemLocation,
    ): Promise<void>;
  }

  interface JoplinViewsDialogs {
    create(id: string): Promise<string>;
    setHtml(handle: string, html: string): Promise<void>;
    setButtons(handle: string, buttons: DialogButton[]): Promise<void>;
    open(handle: string): Promise<{ id: string }>;
    showMessageBox(message: string): Promise<number>;
    setFitToContent(handle: string, fit: boolean): Promise<void>;
  }

  interface JoplinViews {
    panels: JoplinViewsPanels;
    menus: JoplinViewsMenus;
    menuItems: JoplinViewsMenuItems;
    dialogs: JoplinViewsDialogs;
  }

  interface JoplinPlugins {
    register(plugin: { onStart: () => Promise<void> }): Promise<void>;
    onUnload(callback: () => Promise<void>): void;
    id(): string;
    pluginIds(): Promise<string[]>;
  }

  interface JoplinClipboard {
    writeText(text: string): Promise<void>;
    readText(): Promise<string>;
  }

  interface Joplin {
    settings: JoplinSettings;
    commands: JoplinCommands;
    views: JoplinViews;
    plugins: JoplinPlugins;
    clipboard: JoplinClipboard;
    versionInfo(): Promise<VersionInfo>;
    shouldUseDarkColors(): Promise<boolean>;
  }

  const joplin: Joplin;
  export default joplin;
}
