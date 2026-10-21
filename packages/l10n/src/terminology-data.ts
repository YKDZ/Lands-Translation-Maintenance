export type TerminologySourceMatcher =
  | { readonly kind: "word"; readonly forms: readonly string[] }
  | { readonly kind: "phrase"; readonly forms: readonly string[] }
  | {
      readonly kind: "claim-sense";
      readonly forms: readonly string[];
      readonly sense: "verb" | "noun";
    }
  | {
      readonly kind: "declare-sense";
      readonly forms: readonly string[];
      readonly sense: "verb" | "noun";
    };

export interface TerminologyEntry {
  readonly id: string;
  readonly source: TerminologySourceMatcher;
  readonly allowedTranslations: readonly string[];
  readonly context: string;
  readonly suppressOverlaps?: readonly string[];
  readonly notApplicableContext?: readonly {
    readonly form: string;
    readonly precedingWords?: readonly string[];
    readonly followingWords?: readonly string[];
    readonly pathSegments?: readonly string[];
  }[];
  readonly sourceReference: {
    readonly path: string;
    readonly commit: string;
    readonly section: string;
  };
}

const legacyReadme = {
  path: "README.md",
  commit: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad",
  section: "术语表",
} as const;

function word(
  id: string,
  forms: readonly string[],
  translation: string,
  context = "README 将该词列为 Lands 玩法中的领域术语。",
): TerminologyEntry {
  return {
    id,
    source: { kind: "word", forms },
    allowedTranslations: [translation],
    context,
    sourceReference: legacyReadme,
  };
}

function phrase(
  id: string,
  forms: readonly string[],
  translation: string,
  context: string,
  suppressOverlaps: readonly string[] = [],
): TerminologyEntry {
  return {
    id,
    source: { kind: "phrase", forms },
    allowedTranslations: [translation],
    context,
    ...(suppressOverlaps.length === 0 ? {} : { suppressOverlaps }),
    sourceReference: legacyReadme,
  };
}

function sense(
  id: string,
  kind: "claim-sense" | "declare-sense",
  forms: readonly string[],
  value: "verb" | "noun",
  translation: string,
  context: string,
  suppressOverlaps: readonly string[] = [],
): TerminologyEntry {
  return {
    id,
    source: { kind, forms, sense: value },
    allowedTranslations: [translation],
    context,
    ...(suppressOverlaps.length === 0 ? {} : { suppressOverlaps }),
    sourceReference: legacyReadme,
  };
}

export const terminologyEntries: readonly TerminologyEntry[] = [
  word("nation", ["nation", "nations"], "联邦", "由城镇组成的实体。"),
  word("capital", ["capital", "capitals"], "首都", "建立联邦的城镇。"),
  {
    ...word(
      "land",
      ["land", "lands"],
      "城镇",
      "Lands 插件中的城镇领地实体；产品名 Lands 不适用此术语。",
    ),
    notApplicableContext: [
      {
        form: "Lands",
        precedingWords: ["from", "to", "of", "about", "plugin", "by"],
        followingWords: [
          "plugin",
          "command",
          "commands",
          "API",
          "server",
          "world",
          "issue",
        ],
      },
      {
        form: "Lands",
        pathSegments: ["prefix"],
      },
    ],
  },
  word("area", ["area", "areas"], "子区域", "城镇领土内划出的小区域。"),
  word("camp", ["camp", "camps"], "露营地", "临时、固定大小的城镇。"),
  word("wilderness", ["wilderness"], "荒野", "没有被占领的区块。"),
  word("role", ["role", "roles"], "职位", "城镇或联邦成员的权限控制。"),
  word("owner", ["owner", "owners"], "所有者"),
  word("tenant", ["tenant", "tenants"], "住户", "区域租客和买主都用此词。"),
  {
    id: "trust",
    source: { kind: "word", forms: ["trust", "trusts", "trusted", "trusting"] },
    allowedTranslations: ["邀请", "加入"],
    context: "对应其他领地插件的 invite；从玩家视角也可表达为被加入。",
    sourceReference: legacyReadme,
  },
  phrase(
    "trusted-player",
    ["trusted player", "trusted players"],
    "成员",
    "已受信任并获得成员身份的玩家。",
    ["trust"],
  ),
  word(
    "untrust",
    ["untrust", "untrusted", "untrusting"],
    "移出",
    "对应其他领地插件的 kick。",
  ),
  sense(
    "claim-verb",
    "claim-sense",
    ["claim", "claims", "claimed", "claiming"],
    "verb",
    "占领",
    "动词义；与名词义领土区分。",
  ),
  sense(
    "claim-noun",
    "claim-sense",
    ["claim", "claims"],
    "noun",
    "领土",
    "名词义；与动词义占领区分。",
  ),
  word(
    "unclaim",
    ["unclaim", "unclaims", "unclaimed", "unclaiming"],
    "取消占领",
  ),
  phrase(
    "natural-settings",
    ["natural flag", "natural flags", "natural setting", "natural settings"],
    "环境设置",
    "影响区域环境行为，例如刷怪或 TNT 对方块的影响。",
  ),
  phrase(
    "role-settings",
    ["role flag", "role flags", "role setting", "role settings"],
    "职位设置",
    "控制职位玩家的权限，例如能否破坏方块。",
  ),
  phrase(
    "mainblock",
    ["mainblock", "mainblocks", "main block", "main blocks"],
    "城镇核心",
    "城镇创建时自动产生的方块结构。",
  ),
  word("bank", ["bank", "banks"], "金库", "城镇和联邦的“银行”。"),
  word("storage", ["storage"], "仓库", "城镇核心中的虚拟物品空间。"),
  word("upkeep", ["upkeep"], "维护费", "城镇和联邦定期向服务器支付的款项。"),
  word(
    "taxes",
    ["tax", "taxes"],
    "税费",
    "成员定期向所属城镇或联邦支付的款项。",
  ),
  word(
    "relation",
    ["relation", "relations"],
    "外交关系",
    "城镇、联邦等在战争中的关系。",
  ),
  word("ally", ["ally", "allies"], "盟友"),
  word("enemy", ["enemy", "enemies"], "政敌"),
  word("neutral", ["neutral", "neutrals"], "中立"),
  word("war", ["war", "wars"], "战争"),
  phrase(
    "capture-block-or-flag",
    ["capture block", "capture blocks", "capture flag", "capture flags"],
    "战旗",
    "战争中攻方用于占领守方领土的信标道具；此完整短语不等同于普通动词 capture。",
  ),
  word("attacker", ["attacker", "attackers"], "攻方"),
  word("defender", ["defender", "defenders"], "守方"),
  word(
    "tribute",
    ["tribute", "tributes"],
    "赔偿金",
    "一方投降后向另一方支付的款项。",
  ),
  word(
    "shield",
    ["shield", "shields"],
    "战争护盾",
    "保护城镇或联邦免于战争的一段时间。",
  ),
  sense(
    "declare-noun",
    "declare-sense",
    ["declaration", "declarations", "war declaration", "war declarations"],
    "noun",
    "宣战书",
    "名词义，常见完整短语为 war declaration。",
    ["war"],
  ),
  sense(
    "declare-verb",
    "declare-sense",
    [
      "declare",
      "declares",
      "declared",
      "declaring",
      "declare war",
      "declares war",
      "declared war",
      "declaring war",
    ],
    "verb",
    "宣战",
    "动词义，常见完整短语为 declare war。",
    ["war"],
  ),
];

export const terminologyStyleSource = {
  path: ".scratch/minimessage-audit/legacy/README.md",
  commit: "b8f6985a4ad2af1b76b05f0f79b718a2234623ad",
  section: "翻译风格",
} as const;
