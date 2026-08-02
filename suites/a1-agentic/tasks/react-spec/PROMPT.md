# Build the SeatPicker component

Implement `SeatPicker` in `src/SeatPicker.tsx` against the spec below. A stub
with the right props is already there.

## Props

```ts
interface Seat { id: string; label: string; taken: boolean }
interface Props {
  seats: Seat[];
  maxSelectable: number;
  onChange(selectedIds: string[]): void;
}
```

## Behaviour

- Render one `<button>` per seat, with the seat's `label` as its text and
  `data-seat-id` set to the seat's `id`.
- A taken seat's button is `disabled` and carries `data-state="taken"`.
- Clicking a free seat selects it: `data-state="selected"`. Clicking it again
  deselects it: `data-state="free"`.
- A free, unselected seat is `data-state="free"`.
- Once `maxSelectable` seats are selected, the remaining free seats become
  `disabled` and carry `data-state="blocked"`. Deselecting frees them again.
- `onChange` fires on every selection change with the selected ids in the order
  the seats appear in `seats`, never in click order.
- Render a live region: an element with `role="status"` reading exactly
  `"{n} of {maxSelectable} selected"`.

Do not create a git commit.
