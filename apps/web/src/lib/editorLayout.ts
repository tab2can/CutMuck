export type EditorLayout = {
  playerH: number;
  sideW: number;
  clipTimelineH: number;
};

export const DEFAULT_EDITOR_LAYOUT: EditorLayout = {
  playerH: 520,
  sideW: 480,
  clipTimelineH: 156,
};

const LAYOUT_KEY = "cutmuck.editorLayout";

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function readEditorLayout(): EditorLayout {
  if (typeof window === "undefined") return DEFAULT_EDITOR_LAYOUT;
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_EDITOR_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<EditorLayout>;
    return {
      playerH: clamp(Number(parsed.playerH) || DEFAULT_EDITOR_LAYOUT.playerH, 200, 760),
      sideW: clamp(Number(parsed.sideW) || DEFAULT_EDITOR_LAYOUT.sideW, 320, 760),
      clipTimelineH: clamp(
        Number(parsed.clipTimelineH) || DEFAULT_EDITOR_LAYOUT.clipTimelineH,
        72,
        440
      ),
    };
  } catch {
    return DEFAULT_EDITOR_LAYOUT;
  }
}

export function writeEditorLayout(layout: EditorLayout) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // ignore quota / private mode
  }
}
