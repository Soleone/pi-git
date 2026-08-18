import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { CommitEditor } from "../src/ui/commit-editor.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function innerEditor(component: CommitEditor): Editor {
  return (component as unknown as { editor: Editor }).editor;
}

describe("CommitEditor", () => {
  it("starts a prefilled message at the beginning when requested", () => {
    const component = new CommitEditor(
      {} as TUI,
      theme,
      "",
      "subject\nbody",
      () => {},
      { cursorAtStart: true },
    );

    expect(innerEditor(component).getCursor()).toEqual({ line: 0, col: 0 });
  });

  it("keeps the default cursor at the end", () => {
    const component = new CommitEditor({} as TUI, theme, "", "subject\nbody", () => {});

    expect(innerEditor(component).getCursor()).toEqual({ line: 1, col: 4 });
  });
});
