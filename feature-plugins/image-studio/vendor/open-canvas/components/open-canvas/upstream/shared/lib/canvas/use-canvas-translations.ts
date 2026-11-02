import messages from "../../../config/locale/messages/zh/pages/canvas.json";

type TranslationValues = Record<string, string | number>;

type MessageTree = { [key: string]: string | MessageTree };

function translate(path: string, values?: TranslationValues) {
  let value: string | MessageTree | undefined = messages as MessageTree;
  for (const part of path.split(".")) value = typeof value === "object" ? value[part] : undefined;
  const text = typeof value === "string" ? value : path;
  return text.replace(/\{(\w+)\}/g, (placeholder, key: string) => String(values?.[key] ?? placeholder));
}

export function useCanvasTranslations() { return translate; }

export function useCanvasLocale() {
  return "zh";
}
