import {
  CORRIDOR_ARROW_SPACING,
  RIBBON_DASH_GAP,
  RIBBON_DASH_LENGTH,
  RIBBON_DASH_WIDTH,
  RIBBON_LIFT,
  RIBBON_MITER_LIMIT,
  RIBBON_OVERLAY_LIFT,
  RIBBON_WIDTH,
} from '../config/constants'
import { mapColors } from '../config/theme'
import type { RibbonGeometryParams } from '../rendering/scene/map/ribbonGeometry'

/**
 * 走廊 ribbon 几何参数（SPEC §6.2）：尺寸阈值与色彩集中在 config（SPEC §5.1）。
 * MapLayer 底图合并几何与 SelectionHighlight 走廊高亮覆盖共用的基底参数
 * （高亮覆盖经 buildCorridorHighlightParams 替换宽度 / 抬升 / 色值派生）。
 */
export const RIBBON_PARAMS: RibbonGeometryParams = {
  width: RIBBON_WIDTH,
  lift: RIBBON_LIFT,
  miterLimit: RIBBON_MITER_LIMIT,
  dashLength: RIBBON_DASH_LENGTH,
  dashGap: RIBBON_DASH_GAP,
  dashWidth: RIBBON_DASH_WIDTH,
  overlayLift: RIBBON_OVERLAY_LIFT,
  arrowSpacing: CORRIDOR_ARROW_SPACING,
  colors: {
    normal: mapColors.corridor,
    oneWay: mapColors.corridorOneWay,
    back: mapColors.corridorBack,
  },
}
