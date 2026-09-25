import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ApplyDateInput } from "./ApplyDateInput.js";

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof ApplyDateInput>[0]> = {}) {
  const onApply = vi.fn();
  render(<ApplyDateInput value="2026-09-25" onApply={onApply} testId="d" min="2026-04-01" max="2027-03-31" {...props} />);
  return { onApply, input: screen.getByTestId("d") as HTMLInputElement };
}
const applyButton = () => screen.queryByRole("button", { name: "Apply" });

describe("ApplyDateInput: date changes are staged until Apply", () => {
  it("picking dates (calendar clicks, typing, the popup's Today/Clear) only stages; nothing applies", () => {
    const { onApply, input } = setup();
    expect(applyButton()).toBeNull(); // nothing staged yet
    fireEvent.change(input, { target: { value: "2026-06-30" } });
    fireEvent.change(input, { target: { value: "2026-05-31" } });
    expect(onApply).not.toHaveBeenCalled();
    expect(input.value).toBe("2026-05-31");
    expect(applyButton()).toBeTruthy();
  });

  it("Apply applies the staged date once", () => {
    const { onApply, input } = setup();
    fireEvent.change(input, { target: { value: "2026-06-30" } });
    fireEvent.click(applyButton()!);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith("2026-06-30");
  });

  it("Enter applies; Escape discards the staged date", () => {
    const { onApply, input } = setup();
    fireEvent.change(input, { target: { value: "2026-06-30" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("2026-09-25");
    expect(applyButton()).toBeNull();
    fireEvent.change(input, { target: { value: "2026-07-31" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onApply).toHaveBeenCalledWith("2026-07-31");
  });

  it("a half-typed / out-of-range date can't be applied (typing a year passes through 0002-…)", () => {
    const { onApply, input } = setup();
    fireEvent.change(input, { target: { value: "0002-09-25" } });
    expect(applyButton()).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onApply).not.toHaveBeenCalled();
  });

  it("an empty date applies only where clearing is allowed", () => {
    const blocked = setup();
    fireEvent.change(blocked.input, { target: { value: "" } });
    expect(applyButton()).toBeNull();
    cleanup();
    const allowed = setup({ allowEmpty: true });
    fireEvent.change(allowed.input, { target: { value: "" } });
    fireEvent.click(applyButton()!);
    expect(allowed.onApply).toHaveBeenCalledWith("");
  });

  it("follows the applied value when it changes from outside (e.g. a Reset button)", () => {
    function Harness() {
      const [v, setV] = useState("2026-06-30");
      return (
        <>
          <ApplyDateInput value={v} onApply={setV} testId="d" />
          <button onClick={() => setV("2026-09-25")}>Reset</button>
        </>
      );
    }
    render(<Harness />);
    const input = screen.getByTestId("d") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-05-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(input.value).toBe("2026-09-25");
    expect(applyButton()).toBeNull();
  });
});
