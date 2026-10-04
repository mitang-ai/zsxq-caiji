import type { Appearance } from "../../shared/appearance";
export type AppearanceProps = {
  appearance: Appearance;
  onAppearanceChange: (choice: Appearance) => void;
};
export function AppearanceSelect({
  appearance,
  onAppearanceChange,
}: AppearanceProps) {
  return (
    <label className="appearance-control">
      <span className="visually-hidden">外观</span>
      <select
        aria-label="外观"
        value={appearance}
        onChange={(e) => onAppearanceChange(e.target.value as Appearance)}
      >
        <option value="system">跟随系统</option>
        <option value="paper">浅色</option>
        <option value="graphite">深色</option>
      </select>
    </label>
  );
}
