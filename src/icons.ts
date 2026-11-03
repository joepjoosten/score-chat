/** Lucide icons as Foldkit SVG nodes. */
import type { Html, HtmlBuilder } from 'foldkit/html'
import type { IconNode } from 'lucide'

export {
  ArrowDownToLine,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleUser,
  Code2,
  FileMusic,
  FileUp,
  Files,
  Highlighter,
  LoaderCircle,
  LogOut,
  MessageSquare,
  Minus,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  Settings2,
  SkipBack,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide'

type SvgChild =
  'path' | 'circle' | 'rect' | 'line' | 'polyline' | 'polygon' | 'ellipse'

export function icon<M>(
  h: HtmlBuilder<M>,
  node: IconNode,
  size = 16,
  className = '',
): Html {
  return h.svg(
    [
      h.Attribute('xmlns', 'http://www.w3.org/2000/svg'),
      h.Attribute('width', String(size)),
      h.Attribute('height', String(size)),
      h.ViewBox('0 0 24 24'),
      h.Attribute('fill', 'none'),
      h.Attribute('stroke', 'currentColor'),
      h.Attribute('stroke-width', '2'),
      h.Attribute('stroke-linecap', 'round'),
      h.Attribute('stroke-linejoin', 'round'),
      h.Class(`lucide ${className}`.trim()),
      h.AriaHidden(true),
    ],
    node.map(([tag, attributes]) =>
      h[tag as SvgChild](
        Object.entries(attributes).map(([name, value]) =>
          h.Attribute(name, String(value)),
        ),
      ),
    ),
  )
}
