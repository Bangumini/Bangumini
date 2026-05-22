import { pinyin } from "pinyin-pro";

export function buildPinyinKeywords(text: string): string[] {
  if (!text) return [];

  const chars = pinyin(text, { toneType: "none", type: "array" });
  const full = chars.join("");
  const initials = chars.map((c) => c[0] || "").join("");

  const result = new Set<string>([full, initials]);
  for (const c of chars) {
    result.add(c);
  }

  return [...result];
}

export function buildSubjectKeywords(nameCn?: string, name?: string): string[] {
  const keywords: string[] = [];
  if (nameCn) keywords.push(...buildPinyinKeywords(nameCn));
  if (name) keywords.push(...buildPinyinKeywords(name));
  return keywords;
}
