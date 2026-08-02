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

export function SeatPicker(_props: Props) {
  return null;
}
