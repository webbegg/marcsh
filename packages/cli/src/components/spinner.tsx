import {
  parseColor,
  Renderable,
  RGBA,
  type ColorInput,
  type OptimizedBuffer,
  type RenderableOptions,
  type RenderContext,
} from "@opentui/core";
import { extend } from "@opentui/react";
import { Mode, type ModeType } from "../lib/modes";
import { useTheme } from "../providers/theme";

// The spinner renderable follows opencode's TUI spinner (MIT); see THIRD_PARTY_NOTICES.md.

// cli-spinners' "aesthetic", the spinner marcsh has always shown.
const FRAMES = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰", "▰▱▱▱▱▱▱"];
const INTERVAL_MS = 80;

type SpinnerOptions = RenderableOptions<SpinnerRenderable> & {
  color?: ColorInput;
};

// opentui-spinner does not run on OpenTUI 0.9 (it calls a native encodeUnicode that is gone), so marcsh draws its own.
// It is not live: the renderer's shared animation clock ticks it while it is drawn, and a hidden spinner costs nothing.
export class SpinnerRenderable extends Renderable {
  private readonly glyphs = FRAMES.map((frame) => Array.from(frame, (char) => ({ char, width: Bun.stringWidth(char) })));
  private readonly frameWidth = Math.max(...this.glyphs.map((glyphs) => glyphs.reduce((sum, glyph) => sum + glyph.width, 0)));
  private _color: RGBA;
  private index = 0;

  constructor(ctx: RenderContext, options: SpinnerOptions = {}) {
    super(ctx, options);
    this._color = parseColor(options.color ?? RGBA.defaultForeground());
    this.width = this.frameWidth;
    this.height = 1;
    this.animationFps = 1000 / INTERVAL_MS;
  }

  set color(value: ColorInput) {
    this._color = parseColor(value);
    this.requestRender();
  }

  protected override onAnimationTick(_deltaTime: number, ticks: number) {
    this.index = (this.index + ticks) % this.glyphs.length;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer) {
    let x = this.screenX;
    for (const glyph of this.glyphs[this.index] ?? []) {
      buffer.drawText(glyph.char, x, this.screenY, this._color);
      x += glyph.width;
    }
  }
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    spinner: typeof SpinnerRenderable;
  }
}

extend({ spinner: SpinnerRenderable });

type Props = {
  mode?: ModeType;
};

export function Spinner({ mode = Mode.BUILD }: Props) {
  const { colors } = useTheme();
  const activeColor = mode === Mode.PLAN ? colors.planMode : colors.primary;

  return <spinner color={activeColor} />;
};
