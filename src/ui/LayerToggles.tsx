import { uiColors } from '../config/theme'
import { useAppStore } from '../state/appStore'
import type { LayerVisibility, RoofOverride } from '../state/appStore'

/**
 * 图层开关（SPEC §8.3，DOM、Canvas 外）：节点 / 路径 / 标签 / 室内陈设 / 地面标线
 * 五个布尔开关 + 屋顶 自动-显示-隐藏 三态（SPEC §5.5 手动覆盖项）。
 *
 * - 数据流：读写 store.layers（setLayer），场景分组显隐由各场景组件订阅同一字段驱动
 *   （MapLayer / AgvLayer / FactoryInterior / FactoryBuilding），逐项实时生效；
 * - 分组口径与场景一致：室内陈设 = 货架与工作台 / 立柱 / 吊灯 / 充电桩造型 / 卷帘门；
 *   地面标线 = 通道边缘线 / 斑马线 / 充电区等区域色块（SPEC §8.3）；
 * - 分层：只消费 store 与 config 色值，不 import rendering（SPEC §12）。
 */

/** 布尔图层开关键（LayerVisibility 中除屋顶三态外的五个布尔项） */
type BooleanLayerKey = Exclude<keyof LayerVisibility, 'roof'>

interface LayerToggleDef {
  key: BooleanLayerKey
  label: string
  /** 分组内容说明（SPEC §8.3 口径）；无则说明行不渲染 */
  hint: string | null
}

const LAYER_TOGGLES: readonly LayerToggleDef[] = [
  { key: 'nodes', label: '节点', hint: null },
  { key: 'corridors', label: '路径', hint: null },
  { key: 'labels', label: '标签', hint: null },
  {
    key: 'interior',
    label: '室内陈设',
    hint: '货架与工作台 / 立柱 / 吊灯 / 充电桩造型 / 卷帘门',
  },
  {
    key: 'groundMarkings',
    label: '地面标线',
    hint: '通道边缘线 / 斑马线 / 充电区等区域色块',
  },
]

/** 屋顶三态手动覆盖项（SPEC §5.5：自动 / 强制显示 / 强制隐藏） */
const ROOF_OPTIONS: readonly { value: RoofOverride; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'show', label: '显示' },
  { value: 'hide', label: '隐藏' },
]

export function LayerToggles() {
  const layers = useAppStore((state) => state.layers)
  const setLayer = useAppStore((state) => state.setLayer)

  return (
    <section
      className="panel layer-toggles"
      aria-label="图层开关"
      style={
        {
          background: uiColors.panelBackground,
          borderColor: uiColors.progressTrack,
          '--panel-row-hover': uiColors.rowHover,
        } as React.CSSProperties
      }
    >
      <header
        className="panel-header"
        style={{ color: uiColors.textPrimary, borderBottomColor: uiColors.progressTrack }}
      >
        图层开关
      </header>
      <div className="panel-body">
        {LAYER_TOGGLES.map((toggle) => (
          <div key={toggle.key}>
            <label
              className="layer-toggle-row"
              style={{ color: uiColors.textPrimary }}
              title={toggle.hint ?? undefined}
            >
              <input
                type="checkbox"
                checked={layers[toggle.key]}
                onChange={(event) => setLayer(toggle.key, event.target.checked)}
                style={{ accentColor: uiColors.accent }}
              />
              {toggle.label}
            </label>
            {toggle.hint !== null && (
              <div className="layer-toggle-hint" style={{ color: uiColors.textSecondary }}>
                {toggle.hint}
              </div>
            )}
          </div>
        ))}
        <div
          className="roof-override-row"
          style={{ color: uiColors.textPrimary, borderTopColor: uiColors.progressTrack }}
        >
          <span>屋顶</span>
          <div className="roof-override-options" role="group" aria-label="屋顶显示方式">
            {ROOF_OPTIONS.map((option) => {
              const active = layers.roof === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  className="panel-button roof-option"
                  aria-pressed={active}
                  onClick={() => setLayer('roof', option.value)}
                  style={{
                    color: active ? uiColors.panelBackground : uiColors.textPrimary,
                    background: active ? uiColors.accent : undefined,
                  }}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
