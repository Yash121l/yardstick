import { useCallback, useState } from "react";

export interface Seat {
  id: string;
  label: string;
  taken: boolean;
}

export interface Props {
  seats: Seat[];
  maxSelectable: number;
  onChange(selectedIds: string[]): void;
}

export function SeatPicker({ seats, maxSelectable, onChange }: Props) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const toggle = useCallback(
    (id: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else if (next.size < maxSelectable) next.add(id);
        else return prev;
        // Seat order, not click order.
        onChange(seats.filter((s) => next.has(s.id)).map((s) => s.id));
        return next;
      });
    },
    [maxSelectable, onChange, seats],
  );

  const atLimit = selected.size >= maxSelectable;

  return (
    <div>
      {seats.map((s) => {
        const isSelected = selected.has(s.id);
        const state = s.taken
          ? "taken"
          : isSelected
            ? "selected"
            : atLimit
              ? "blocked"
              : "free";
        return (
          <button
            key={s.id}
            type="button"
            data-seat-id={s.id}
            data-state={state}
            disabled={s.taken || state === "blocked"}
            onClick={() => toggle(s.id)}
          >
            {s.label}
          </button>
        );
      })}
      <div role="status">{`${selected.size} of ${maxSelectable} selected`}</div>
    </div>
  );
}
