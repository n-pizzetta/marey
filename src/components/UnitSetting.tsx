import { keepFocus } from "../utils/keepFocus";
import { UNITS, setUnit, useUnit } from "../utils/units";

/** The one display setting: what usage figures lead with, and what each unit means. */
export function UnitSetting() {
  const unit = useUnit();
  return (
    <div className="profile-unit">
      <div className="profile-row">
        <span className="profile-row-label">Show usage in</span>
        <div className="unit-toggle" role="group" aria-label="Usage unit">
          {UNITS.map((u) => (
            <button
              key={u.id}
              type="button"
              className={`unit-opt ${unit === u.id ? "active" : ""}`}
              aria-pressed={unit === u.id}
              onMouseDown={keepFocus}
              onClick={() => setUnit(u.id)}
            >
              {u.label}
            </button>
          ))}
        </div>
      </div>
      <p className="profile-hint">{UNITS.find((u) => u.id === unit)?.hint}</p>
    </div>
  );
}
