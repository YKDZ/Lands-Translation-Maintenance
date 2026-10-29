import type {
  TranslationFieldCategory,
  TranslationFieldScene,
  TranslationFormat,
} from "#/lioni/lands-model";

const sceneCategories: Readonly<
  Record<TranslationFieldScene, TranslationFieldCategory>
> = {
  "gui-general": "gui-string",
  "gui-title": "gui-string",
  "gui-item-name": "gui-string",
  "gui-item-lore": "gui-lore",
  "dialog-title": "dialog-string",
  "dialog-button-label": "dialog-string",
  "dialog-button-tooltip": "dialog-string",
  "dialog-input-label": "dialog-string",
  "dialog-label-format": "dialog-label-format",
  "dialog-body-text": "dialog-string",
  "category-name": "configuration-string",
  "category-description": "configuration-string-list",
  "level-title": "configuration-string",
  "level-attribute-description": "configuration-string",
  "level-requirement-title": "configuration-string",
  "level-requirement-description": "configuration-string-list",
  "role-name": "configuration-string",
};

const sceneFormats: Readonly<Record<TranslationFieldScene, TranslationFormat>> =
  {
    "gui-general": "minimessage",
    "gui-title": "minimessage",
    "gui-item-name": "legacy-color-minimessage",
    "gui-item-lore": "legacy-color-minimessage",
    "dialog-title": "minimessage",
    "dialog-button-label": "minimessage",
    "dialog-button-tooltip": "minimessage",
    "dialog-input-label": "minimessage",
    "dialog-label-format": "label-format",
    "dialog-body-text": "minimessage",
    "category-name": "legacy-color-minimessage",
    "category-description": "legacy-color-minimessage",
    "level-title": "legacy-color-minimessage",
    "level-attribute-description": "legacy-color-variable-minimessage",
    "level-requirement-title": "legacy-variable-minimessage",
    "level-requirement-description": "legacy-color-variable-minimessage",
    "role-name": "legacy-color-minimessage",
  };

export function sceneMatchesCategory(
  category: TranslationFieldCategory,
  scene: TranslationFieldScene,
): boolean {
  return sceneCategories[scene] === category;
}

export function formatForScene(
  scene: TranslationFieldScene,
): TranslationFormat {
  return sceneFormats[scene];
}
