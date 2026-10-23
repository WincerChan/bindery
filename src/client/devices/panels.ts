/** One physical screen shared by every model that uses it. */
export const SCREEN_PANELS = {
  "758x1024": { width: 758, height: 1024, ppi: 212, inches: 6 },
  "600x800": { width: 600, height: 800, ppi: 167, inches: 6 },
  "1072x1448": { width: 1072, height: 1448, ppi: 300, inches: 6 },
  "1080x1430": { width: 1080, height: 1430, ppi: 265, inches: 6.8 },
  "1264x1680": { width: 1264, height: 1680, ppi: 300, inches: 7 },
  "1404x1872@227": { width: 1404, height: 1872, ppi: 227, inches: 10.3 },
  "1404x1872@300": { width: 1404, height: 1872, ppi: 300, inches: 7.8 },
  "1440x1920": { width: 1440, height: 1920, ppi: 300, inches: 8 },
} as const;
export type ScreenPanelId = keyof typeof SCREEN_PANELS;
export type ScreenPanel = (typeof SCREEN_PANELS)[ScreenPanelId];
