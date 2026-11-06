export type ResourcePurpose =
  | "chat-language"
  | "gui-language"
  | "dialog-language"
  | "configuration"
  | "metadata"
  | "documentation"
  | "bedrock-excluded"
  | "other-excluded";

export type TranslationFieldCategory =
  | "chat-string"
  | "chat-string-list"
  | "gui-string"
  | "gui-lore"
  | "dialog-string"
  | "dialog-label-format"
  | "configuration-string"
  | "configuration-string-list";

export type TranslationFieldScene =
  | "gui-general"
  | "gui-title"
  | "gui-item-name"
  | "gui-item-lore"
  | "dialog-title"
  | "dialog-button-label"
  | "dialog-button-tooltip"
  | "dialog-input-label"
  | "dialog-label-format"
  | "dialog-body-text"
  | "category-name"
  | "category-description"
  | "level-title"
  | "level-attribute-description"
  | "level-requirement-title"
  | "level-requirement-description";

export type TranslationFormat =
  | "plain"
  | "minimessage"
  | "legacy-color"
  | "legacy-color-minimessage"
  | "label-format"
  | "legacy-variable"
  | "legacy-variable-minimessage"
  | "legacy-color-variable-minimessage"
  | "map-html-minimessage";

export const translationFieldScenes = [
  "gui-general",
  "gui-title",
  "gui-item-name",
  "gui-item-lore",
  "dialog-title",
  "dialog-button-label",
  "dialog-button-tooltip",
  "dialog-input-label",
  "dialog-label-format",
  "dialog-body-text",
  "category-name",
  "category-description",
  "level-title",
  "level-attribute-description",
  "level-requirement-title",
  "level-requirement-description",
] as const satisfies readonly TranslationFieldScene[];

export const translationFieldCategories = [
  "chat-string",
  "chat-string-list",
  "gui-string",
  "gui-lore",
  "dialog-string",
  "dialog-label-format",
  "configuration-string",
  "configuration-string-list",
] as const satisfies readonly TranslationFieldCategory[];

export const translationFormats = [
  "plain",
  "minimessage",
  "legacy-color",
  "legacy-color-minimessage",
  "label-format",
  "legacy-variable",
  "legacy-variable-minimessage",
  "legacy-color-variable-minimessage",
  "map-html-minimessage",
] as const satisfies readonly TranslationFormat[];

export interface ResourceInventoryEntry {
  readonly path: string;
  readonly purpose: ResourcePurpose;
}

export interface TranslationField {
  readonly path: readonly string[];
  readonly category: TranslationFieldCategory;
  readonly scene?: TranslationFieldScene;
}

export interface TranslationMapping {
  readonly source: string;
  readonly target: string;
  readonly definitionsSource?: string;
  readonly fields: readonly TranslationField[];
}

export interface LandsProjectConfiguration {
  readonly resources: readonly ResourceInventoryEntry[];
  readonly translationScope: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly mappings: readonly TranslationMapping[];
  };
}
