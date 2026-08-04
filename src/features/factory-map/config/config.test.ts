import { describe, expect, it } from 'vitest'

import {
  CAMERA_FAR,
  CAMERA_FIT_MARGIN,
  CAMERA_FOV,
  CAMERA_NEAR,
  ORBIT_DAMPING_FACTOR,
  ORBIT_MAX_DIST,
  ORBIT_MAX_POLAR_DEG,
  ORBIT_MIN_DIST,
  ORBIT_MIN_POLAR_DEG,
  ORBIT_TARGET_CLAMP_MARGIN,
} from './cameraConfig'
import {
  LABEL_ANCHOR_Y,
  LABEL_CAMERA_ANGLE_DELTA_DEG,
  LABEL_CAMERA_POS_DELTA,
  LABEL_MAX_COUNT,
  LABEL_RECALC_MAX_HZ,
  LABEL_RESERVED_NODE,
  LABEL_RESERVED_PATH,
  LABEL_RESERVED_STATION,
  NODE_ENTER,
  NODE_EXIT,
  PATH_LABEL_ENTER,
  PATH_LABEL_EXIT,
  STATION_ENTER,
  STATION_EXIT,
} from './labelPolicy'
import { MAP_REQUEST_TIMEOUT_MS } from './mapLoadConfig'
import {
  ENV_MAP_INTENSITY,
  FOG_FAR,
  FOG_NEAR,
  GLASS_ENV_MAP_INTENSITY,
  MAX_RENDER_PIXELS,
  SHADOW_MAP_SIZE,
} from './qualityProfile'
import {
  CHEVRON_MIN_PATH_LEN,
  CHEVRON_SPACING,
  CURVE_MAX_ERROR,
  CURVE_MAX_SEGMENT,
  FACTORY_MARGIN,
  FLOOR_JOINT,
  FLOOR_TEXTURE_SEED,
  MITER_LIMIT,
  NODE_DOT_R,
  PATH_WIDTH,
  PURLIN_SPACING,
  STATION_RING_INNER_R,
  STATION_RING_OUTER_R,
  STRUCTURE_MAX_Y,
  TRUSS_SPACING,
  WALL_HEIGHT,
  WINDOW_BAND_BOTTOM,
  WINDOW_BAND_TOP,
} from './sceneMetrics'
import {
  CHEVRON_BACKWARD_COLOR,
  CHEVRON_FORWARD_COLOR,
  FACTORY_FLOOR_COLOR,
  FLOOR_JOINT_COLOR,
  FOG_COLOR,
  HEMISPHERE_GROUND_COLOR,
  HEMISPHERE_SKY_COLOR,
  NODE_DOT_COLOR,
  OUTDOOR_GROUND_COLOR,
  PATH_BACKWARD_COLOR,
  PATH_FORWARD_COLOR,
  STATION_CHARGE_COLOR,
  STATION_PARK_COLOR,
  STATION_WORK_COLOR,
  SUN_LIGHT_COLOR,
  TRUSS_STEEL_COLOR,
  WALL_COLUMN_COLOR,
  WALL_PANEL_COLOR,
  WINDOW_GLASS_COLOR,
} from './visualTheme'

it('冒烟：vitest 运行于 node 环境，不启动浏览器（SPEC §15.1）', () => {
  expect(typeof window).toBe('undefined')
  expect(typeof document).toBe('undefined')
})

describe('sceneMetrics（SPEC §13.1）', () => {
  it('常量值与规格一致', () => {
    expect(FACTORY_MARGIN).toBe(10)
    expect(WALL_HEIGHT).toBe(8)
    expect(STRUCTURE_MAX_Y).toBe(9)
    expect(WINDOW_BAND_BOTTOM).toBe(4.0)
    expect(WINDOW_BAND_TOP).toBe(6.5)
    expect(TRUSS_SPACING).toBe(8)
    expect(PURLIN_SPACING).toBe(4)
    expect(FLOOR_JOINT).toBe(6)
    expect(FLOOR_TEXTURE_SEED).toBe(0x4d415033)
    expect(PATH_WIDTH).toBe(0.12)
    expect(CURVE_MAX_ERROR).toBe(0.01)
    expect(CURVE_MAX_SEGMENT).toBe(0.25)
    expect(MITER_LIMIT).toBe(2)
    expect(CHEVRON_SPACING).toBe(6)
    expect(CHEVRON_MIN_PATH_LEN).toBe(1.0)
    expect(NODE_DOT_R).toBe(0.1)
    expect(STATION_RING_OUTER_R).toBe(0.15)
    expect(STATION_RING_INNER_R).toBe(0.09)
  })
})

describe('labelPolicy（SPEC §13.2）', () => {
  it('常量值与规格一致', () => {
    expect(NODE_ENTER).toBe(40)
    expect(NODE_EXIT).toBe(44)
    expect(STATION_ENTER).toBe(90)
    expect(STATION_EXIT).toBe(95)
    expect(PATH_LABEL_ENTER).toBe(25)
    expect(PATH_LABEL_EXIT).toBe(28)
    expect(LABEL_MAX_COUNT).toBe(300)
    expect(LABEL_CAMERA_POS_DELTA).toBe(0.25)
    expect(LABEL_CAMERA_ANGLE_DELTA_DEG).toBe(0.25)
    expect(LABEL_RECALC_MAX_HZ).toBe(10)
    expect(LABEL_RESERVED_STATION).toBe(120)
    expect(LABEL_RESERVED_NODE).toBe(120)
    expect(LABEL_RESERVED_PATH).toBe(60)
    expect(LABEL_ANCHOR_Y).toBe(0.5)
  })

  it('三类保留名额总和等于全局上限（§8.3）', () => {
    expect(LABEL_RESERVED_STATION + LABEL_RESERVED_NODE + LABEL_RESERVED_PATH).toBe(LABEL_MAX_COUNT)
  })
})

describe('cameraConfig（SPEC §13.3）', () => {
  it('常量值与规格一致', () => {
    expect(CAMERA_FOV).toBe(46)
    expect(CAMERA_NEAR).toBe(0.1)
    expect(CAMERA_FAR).toBe(2000)
    expect(CAMERA_FIT_MARGIN).toBe(1.15)
    expect(ORBIT_MIN_DIST).toBe(3)
    expect(ORBIT_MAX_DIST).toBe(350)
    expect(ORBIT_MIN_POLAR_DEG).toBe(5)
    expect(ORBIT_MAX_POLAR_DEG).toBe(80)
    expect(ORBIT_DAMPING_FACTOR).toBe(0.08)
    expect(ORBIT_TARGET_CLAMP_MARGIN).toBe(20)
  })
})

describe('qualityProfile（SPEC §13.3）', () => {
  it('常量值与规格一致', () => {
    expect(ENV_MAP_INTENSITY).toBe(0.5)
    expect(GLASS_ENV_MAP_INTENSITY).toBe(0.6)
    expect(FOG_NEAR).toBe(250)
    expect(FOG_FAR).toBe(1200)
    expect(MAX_RENDER_PIXELS).toBe(8_294_400)
    expect(SHADOW_MAP_SIZE).toBe(4096)
  })
})

describe('mapLoadConfig（SPEC §13.4）', () => {
  it('常量值与规格一致', () => {
    expect(MAP_REQUEST_TIMEOUT_MS).toBe(15_000)
  })
})

describe('visualTheme（SPEC §6.8 / §7）', () => {
  it('环境配色与规格一致', () => {
    expect(FACTORY_FLOOR_COLOR).toBe('#A9A6A0')
    expect(FLOOR_JOINT_COLOR).toBe('#7F7C76')
    expect(WALL_PANEL_COLOR).toBe('#E9E7E2')
    expect(WALL_COLUMN_COLOR).toBe('#8A94A0')
    expect(WINDOW_GLASS_COLOR).toBe('#A8CCE8')
    expect(TRUSS_STEEL_COLOR).toBe('#5D6873')
    expect(OUTDOOR_GROUND_COLOR).toBe('#ACA79B')
    expect(FOG_COLOR).toBe('#D8E0E8')
  })

  it('§6.6 灯光配色与规格一致', () => {
    expect(SUN_LIGHT_COLOR).toBe('#FFF6E8')
    expect(HEMISPHERE_SKY_COLOR).toBe('#DCEAF7')
    expect(HEMISPHERE_GROUND_COLOR).toBe('#B8B2A4')
  })

  it('地图配色与规格一致', () => {
    expect(PATH_FORWARD_COLOR).toBe('#C9CAC6')
    expect(PATH_BACKWARD_COLOR).toBe('#E57373')
    expect(CHEVRON_FORWARD_COLOR).toBe('#83847F')
    expect(CHEVRON_BACKWARD_COLOR).toBe('#C05454')
    expect(NODE_DOT_COLOR).toBe('#78909C')
    expect(STATION_WORK_COLOR).toBe('#2196F3')
    expect(STATION_CHARGE_COLOR).toBe('#8BC34A')
    expect(STATION_PARK_COLOR).toBe('#F44336')
  })
})
