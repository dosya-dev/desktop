// Drag-to-move asks before anything moves. Per the confirmation design
// standard the title is "Are you sure?" and the description names the item
// (or counts files and folders) and the destination. Enter / Escape answer it
// like the other desktop dialogs.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MoveConfirmModal } from "./MoveConfirmModal";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(props: Partial<React.ComponentProps<typeof MoveConfirmModal>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MoveConfirmModal
        names={["Report.pdf"]}
        fileCount={1}
        folderCount={0}
        folderName="Archive"
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />,
    );
  });
  return { onConfirm, onCancel };
}

const heading = () => container!.querySelector("h3")?.textContent;
const description = () => container!.querySelector("#move-confirm-description")?.textContent;
const button = (label: string) =>
  Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === label)!;
const press = (key: string, target: EventTarget = window) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

describe("MoveConfirmModal", () => {
  it("asks 'Are you sure?' and names the item and folder for a single move", () => {
    render();
    expect(heading()).toBe("Are you sure?");
    expect(description()).toBe("You are moving Report.pdf to Archive.");
    expect(container!.querySelectorAll("#move-confirm-description strong")).toHaveLength(2);
  });

  it("counts files and folders separately and lists up to five names", () => {
    render({ names: ["a.txt", "b.txt", "c.txt", "Photos", "Music"], fileCount: 3, folderCount: 2, folderName: "Files" });
    expect(heading()).toBe("Are you sure?");
    expect(description()).toBe("You are moving 3 files and 2 folders to Files.");
    expect(container!.querySelectorAll("li")).toHaveLength(5);
  });

  it("says only files, or only folders, when that is all that moves", () => {
    render({ names: ["a.txt", "b.txt"], fileCount: 2, folderCount: 0, folderName: "Files" });
    expect(description()).toBe("You are moving 2 files to Files.");
    act(() => root!.unmount());
    root = createRoot(container!);
    act(() => {
      root!.render(<MoveConfirmModal names={["A", "B"]} fileCount={0} folderCount={2} folderName="Files" onConfirm={() => {}} onCancel={() => {}} />);
    });
    expect(description()).toBe("You are moving 2 folders to Files.");
  });

  it("Move confirms and Cancel cancels", () => {
    const { onConfirm, onCancel } = render();
    act(() => button("Move").click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    act(() => button("Cancel").click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Enter confirms once and Escape cancels", () => {
    const { onConfirm, onCancel } = render();
    press("Enter", document.activeElement ?? window);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    press("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Enter on the focused Cancel button does not move", () => {
    const { onConfirm } = render();
    press("Enter", button("Cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Move has focus on open", () => {
    render();
    expect(document.activeElement?.textContent).toBe("Move");
  });

  it("a pending move ignores Enter and disables Move", () => {
    const { onConfirm } = render({ pending: true });
    press("Enter");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button("Move").disabled).toBe(true);
  });
});
