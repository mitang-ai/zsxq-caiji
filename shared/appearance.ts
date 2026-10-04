export type Appearance = "system" | "paper" | "graphite";
export function normalizeAppearance(value: unknown): Appearance {
  // Retain old storage keys and reader preferences; retiring a palette is not
  // a database migration. warm/mist both resolve to the neutral light palette.
  return value === "graphite"
    ? "graphite"
    : value === "paper" || value === "warm" || value === "mist"
      ? "paper"
      : "system";
}
export function resolvedAppearance(
  value: unknown,
  dark: boolean,
): "paper" | "graphite" {
  const choice = normalizeAppearance(value);
  return choice === "system" ? (dark ? "graphite" : "paper") : choice;
}
