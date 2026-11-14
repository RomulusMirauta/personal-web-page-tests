/**
 * Local, minimal types for the app's test-hook API (window.__site, __wheel, __city), declared here
 * so the suite stays black-box: it does not import the application's source. Only the parts this
 * suite reads are typed.
 *
 * The production build installs these hooks only when the page is opened with ?test=1. Without the
 * flag they do not exist, so ordinary visitors never see them. Shipping them in the real build is a
 * deliberate choice: the build under test is the build that is deployed.
 */

/** The app's screens, as they appear in URL hashes (#/profile, #/experience, ...). */
export type Screen = 'profile' | 'lab' | 'skills' | 'experience' | 'projects' | (string & {});
export type WheelId = 'hard' | 'soft';

export type Mode =
  | { kind: 'idle' }
  | { kind: 'hover'; cat: string }
  /** `from`: the screen the detail view was opened from (Back returns there). */
  | { kind: 'detail'; cat: string; node: string | null; from?: Screen };

/** The user intents the app's store accepts (the same ones keys, pointer and touch produce). */
export type Action =
  | { t: 'tab'; dir: -1 | 1 }
  | { t: 'tab/set'; screen: Screen }
  | { t: 'wheel/toggle' }
  | { t: 'wheel/set'; wheel: WheelId }
  | { t: 'cat/hover'; cat: string | null }
  | { t: 'cat/open'; cat: string; node?: string | null }
  | { t: 'cat/step'; dir: -1 | 1 }
  | { t: 'node/focus'; node: string }
  | { t: 'node/step'; dir: -1 | 1 }
  | { t: 'node/parent' }
  | { t: 'node/child' }
  | { t: 'back' }
  | { t: 'sound/toggle' }
  | { t: 'city/toggle' }
  | { t: 'city/show-toggle' }
  | { t: 'theme/toggle' }
  | { t: 'ui/hide' }
  | { t: 'ui/show' }
  | { t: 'menu/toggle' }
  | { t: 'card/toggle' }
  | { t: 'controls/toggle' }
  | { t: 'keys/toggle' };

export interface NavCategory {
  id: string;
  nodes: { id: string; parent: string | null; children: string[] }[];
  /** The node selected when the category opens. */
  defaultNode: string | null;
}

export interface AppState {
  screen: Screen;
  wheel: WheelId;
  mode: Mode;
  sound: boolean;
  cityShown: boolean;
  theme: 'dark' | 'light';
  uiHidden: boolean;
  intro: boolean;
  controls: boolean;
  nav: Record<WheelId, NavCategory[]>;
}

/** Where the wheel is on screen right now (wheel SVG units; the SVG's screen matrix maps them). */
export interface WheelGeometry {
  center: { x: number; y: number };
  rInner: number;
  rOuter: number;
  /** SVG unit to CSS pixel scale. */
  scale: number;
  /** Category arcs, angles in degrees clockwise from 12 o'clock. */
  arcs: { id: string; a0: number; a1: number; opacity: number }[];
  nodes: { id: string; cat: string; x: number; y: number; visible: boolean }[];
}

export interface SiteHooks {
  ready: Promise<void>;
  getState(): AppState;
  dispatch(a: Action): void;
}

export interface WheelHooks {
  /** Detach the animation clock from requestAnimationFrame (true) or reattach it (false). */
  manual(on: boolean): void;
  /** Advance the manual clock. */
  step(ms: number): void;
  /** Run every running transition to its end. */
  settle(maxMs?: number): { ms: number; settled: boolean };
  geometry(): WheelGeometry;
}

export interface CityHooks {
  /** Resolves once the background is on screen (the poster painted, or the live scene faded in). */
  ready: Promise<void>;
  renderer: string;
  degraded: boolean;
}

declare global {
  interface Window {
    __site?: SiteHooks;
    __wheel?: WheelHooks;
    __city?: CityHooks;
  }
}
