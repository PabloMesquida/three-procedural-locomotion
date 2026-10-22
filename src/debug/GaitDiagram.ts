import type { Language } from '../i18n.ts';
import type { GaitController } from '../locomotion/GaitController.ts';
import type { Side } from '../rig/HumanRig.ts';

const COLORS: Record<Side, string> = { left: '#4fc3f7', right: '#ffb74d' };
const SWING_COLOR = '#2a2d33';

/** Texts of the diagram in each language. */
const TEXT: Record<Language, { phase: string; stepsPerSecond: string; sides: Record<Side, string> }> = {
  en: { phase: 'phase', stepsPerSecond: 'steps/s', sides: { left: 'Left', right: 'Right' } },
  es: { phase: 'fase', stepsPerSecond: 'pasos/s', sides: { left: 'Izquierdo', right: 'Derecho' } },
};

export interface GaitDiagramOptions {
  /** Language of the texts (English by default). */
  language?: Language;
}

/**
 * Diagram of the gait cycle (HTML):
 * one bar per foot; colored stretch = stance, dark = swing.
 * The white line is the current global phase.
 */
export class GaitDiagram {
  readonly element: HTMLDivElement;

  private readonly gait: GaitController;
  private readonly text: (typeof TEXT)[Language];
  private readonly marker: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly rows: Record<Side, HTMLDivElement> = {} as Record<Side, HTMLDivElement>;

  constructor(gait: GaitController, options: GaitDiagramOptions = {}) {
    this.gait = gait;
    this.text = TEXT[options.language ?? 'en'];
    this.element = document.createElement('div');
    this.element.className = 'gait-diagram';

    this.label = document.createElement('div');
    this.element.appendChild(this.label);

    const bars = document.createElement('div');
    bars.className = 'gait-bars';
    for (const side of ['left', 'right'] as const) {
      const row = document.createElement('div');
      row.className = 'gait-row';
      row.style.background = this.stanceGradient(side);
      row.title = this.text.sides[side];
      this.rows[side] = row;
      bars.appendChild(row);
    }
    this.marker = document.createElement('div');
    this.marker.className = 'gait-marker';
    bars.appendChild(this.marker);
    this.element.appendChild(bars);
  }

  update(): void {
    const g = this.gait;
    this.marker.style.left = `${(g.phase * 100).toFixed(2)}%`;
    for (const side of ['left', 'right'] as const) this.rows[side].style.background = this.stanceGradient(side);
    const steps = (g.frequency * 2).toFixed(2);
    this.label.textContent = `Gait: ${g.mode.toUpperCase()} · ${this.text.phase} ${g.phase.toFixed(2)} · ${steps} ${this.text.stepsPerSecond}`;
  }

  /** CSS gradient with the foot's stance stretch over the global phase 0 → 1. */
  private stanceGradient(side: Side): string {
    const b = this.gait.duty[side] * 100;
    const start = this.gait.offsets[side] === 0 ? 0 : 100 - this.gait.offsets[side] * 100;
    const end = start + b;
    const c = COLORS[side];
    if (end <= 100) {
      return `linear-gradient(90deg, ${SWING_COLOR} ${start}%, ${c} ${start}%, ${c} ${end}%, ${SWING_COLOR} ${end}%)`;
    }
    const wrap = end - 100;
    return `linear-gradient(90deg, ${c} ${wrap}%, ${SWING_COLOR} ${wrap}%, ${SWING_COLOR} ${start}%, ${c} ${start}%)`;
  }
}
