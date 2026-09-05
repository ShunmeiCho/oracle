// Add new supported generations here, then validate their browser UI and API
// contract. A moving UI label such as Latest is not itself version evidence.
export const GPT_MODEL_CAPABILITIES = {
  "gpt-6-astra": {
    aliases: ["gpt-6"],
    browser: { label: "Latest", version: "6", name: "Astra", proAlias: "gpt-6-pro" },
    api: {
      efforts: ["low", "medium", "high", "xhigh", "max"],
      modes: ["standard", "pro"],
      defaultEffort: "xhigh",
      inputLimit: 272_000,
      inputPerMillion: 10,
      outputPerMillion: 50,
      searchToolType: "web_search",
    },
  },
} as const;

export type RegisteredGptModel = keyof typeof GPT_MODEL_CAPABILITIES;

export function resolveGptModelAlias(
  value: string | undefined,
): { model: RegisteredGptModel; pro: boolean } | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[ _]+/g, "-")
    .replace(/^gpt(?=\d)/, "gpt-");
  for (const model of Object.keys(GPT_MODEL_CAPABILITIES) as RegisteredGptModel[]) {
    const spec = GPT_MODEL_CAPABILITIES[model];
    if (normalized === spec.browser.proAlias) return { model, pro: true };
    if (
      normalized === model ||
      normalized === spec.browser.label.toLowerCase().replace(/ /g, "-") ||
      (spec.aliases as readonly string[]).includes(normalized ?? "")
    )
      return { model, pro: false };
  }
  return undefined;
}

export function isRegisteredBrowserProAlias(value: string | undefined): boolean {
  return resolveGptModelAlias(value)?.pro === true;
}

export function isModernGptModelId(value: string): boolean {
  const major = /^gpt[-_ ]?(\d+)/.exec(value)?.[1];
  const firstSupported = Math.min(
    ...Object.values(GPT_MODEL_CAPABILITIES).map((x) => Number(x.browser.version)),
  );
  return major !== undefined && Number(major) >= firstSupported;
}

export function browserVersionPattern(version: string, name = ""): RegExp {
  if (!/^\d+(?:\.\d+)*$/.test(version)) throw new Error(`Invalid browser version: ${version}`);
  const normalizedVersion = version.replace(/\./g, " ");
  const normalizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const suffix = normalizedName ? `(?: ?${normalizedName})?` : "";
  return new RegExp(
    `^(?:(?:chatgpt|gpt) )?${normalizedVersion}${suffix}(?: ?(?:pro|extra high|high|medium|low|max|thinking))?$`,
  );
}

export function expectedBrowserModel(model: string | undefined): RegisteredGptModel | undefined {
  return resolveGptModelAlias(model)?.model;
}
