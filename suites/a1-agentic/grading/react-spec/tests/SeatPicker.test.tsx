// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeatPicker, type Seat } from "../src/SeatPicker.js";

// React refuses to run act() outside a declared test environment.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEATS: Seat[] = [
  { id: "a1", label: "A1", taken: false },
  { id: "a2", label: "A2", taken: true },
  { id: "a3", label: "A3", taken: false },
  { id: "a4", label: "A4", taken: false },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(max = 2, onChange: (ids: string[]) => void = () => {}) {
  act(() => {
    root.render(<SeatPicker seats={SEATS} maxSelectable={max} onChange={onChange} />);
  });
}
const seat = (id: string) =>
  container.querySelector<HTMLButtonElement>(`[data-seat-id="${id}"]`) as HTMLButtonElement;
const click = (id: string) => act(() => seat(id).dispatchEvent(new MouseEvent("click", { bubbles: true })));

describe("SeatPicker", () => {
  it("renders one button per seat with its label", () => {
    render();
    expect(container.querySelectorAll("button")).toHaveLength(4);
    expect(seat("a1").textContent).toBe("A1");
  });

  it("disables taken seats and marks them", () => {
    render();
    expect(seat("a2").disabled).toBe(true);
    expect(seat("a2").dataset.state).toBe("taken");
  });

  it("marks free seats free", () => {
    render();
    expect(seat("a1").dataset.state).toBe("free");
  });

  it("selects on click and deselects on a second click", () => {
    render();
    click("a1");
    expect(seat("a1").dataset.state).toBe("selected");
    click("a1");
    expect(seat("a1").dataset.state).toBe("free");
  });

  it("blocks remaining free seats once the limit is reached", () => {
    render(2);
    click("a1");
    click("a3");
    expect(seat("a4").disabled).toBe(true);
    expect(seat("a4").dataset.state).toBe("blocked");
    expect(seat("a1").dataset.state).toBe("selected");
  });

  it("unblocks when a selection is released", () => {
    render(2);
    click("a1");
    click("a3");
    click("a1");
    expect(seat("a4").disabled).toBe(false);
    expect(seat("a4").dataset.state).toBe("free");
  });

  it("reports selection in seat order, not click order", () => {
    const onChange = vi.fn();
    render(3, onChange);
    click("a4");
    click("a1");
    expect(onChange).toHaveBeenLastCalledWith(["a1", "a4"]);
  });

  it("never selects a taken seat", () => {
    const onChange = vi.fn();
    render(3, onChange);
    click("a2");
    expect(onChange).not.toHaveBeenCalled();
    expect(seat("a2").dataset.state).toBe("taken");
  });

  it("renders a live region with the current count", () => {
    render(2);
    const status = () => container.querySelector('[role="status"]')?.textContent;
    expect(status()).toBe("0 of 2 selected");
    click("a1");
    expect(status()).toBe("1 of 2 selected");
  });
});
