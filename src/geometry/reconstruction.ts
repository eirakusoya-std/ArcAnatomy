import type { ArcSpec, CircleSpec, ConstructionData, ImageAnalysis, RegionCondition } from './types';

export function buildConstruction(
  analysis: ImageAnalysis,
  circles: CircleSpec[],
): ConstructionData {
  const compositionMask = rasterizeCircleComposition(analysis.width, analysis.height, circles);
  const compositionEdge = extractMaskEdges(compositionMask, analysis.width, analysis.height);
  const arcs = deriveOptimizedArcs(analysis, circles, compositionEdge);
  const conditions: RegionCondition[] = circles
    .filter((circle) => circle.role === 'add' || circle.role === 'subtract')
    .map((circle) => ({
      circleId: circle.id,
      relation: circle.role === 'add' ? 'add' : 'subtract',
      expression:
        circle.role === 'add'
          ? `(x - ${circle.centerX.toFixed(1)})^2 + (y - ${circle.centerY.toFixed(1)})^2 <= ${circle.radius.toFixed(1)}^2`
          : `erase when (x - ${circle.centerX.toFixed(1)})^2 + (y - ${circle.centerY.toFixed(1)})^2 <= ${circle.radius.toFixed(1)}^2`,
    }));

  const expression = makeExpression(conditions);
  return {
    width: analysis.width,
    height: analysis.height,
    circles,
    arcs,
    conditions,
    expression,
    generatedAt: new Date().toISOString(),
  };
}

function rasterizeCircleComposition(width: number, height: number, circles: CircleSpec[]) {
  const mask = new Uint8Array(width * height);
  circles
    .filter((circle) => circle.role === 'add' || circle.role === 'subtract')
    .forEach((circle) => {
      const minX = Math.max(0, Math.floor(circle.centerX - circle.radius));
      const maxX = Math.min(width - 1, Math.ceil(circle.centerX + circle.radius));
      const minY = Math.max(0, Math.floor(circle.centerY - circle.radius));
      const maxY = Math.min(height - 1, Math.ceil(circle.centerY + circle.radius));
      const r2 = circle.radius * circle.radius;
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if ((x - circle.centerX) ** 2 + (y - circle.centerY) ** 2 <= r2) {
            mask[y * width + x] = circle.role === 'add' ? 1 : 0;
          }
        }
      }
    });
  return mask;
}

function extractMaskEdges(mask: Uint8Array, width: number, height: number) {
  const edge = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (!mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width]) {
        edge[i] = 1;
      }
    }
  }
  return edge;
}

function deriveOptimizedArcs(analysis: ImageAnalysis, circles: CircleSpec[], compositionEdge: Uint8Array): ArcSpec[] {
  const arcs: ArcSpec[] = [];
  circles.forEach((circle) => {
    const usedInSilhouette = circle.role === 'add' || circle.role === 'subtract';
    const bins = 144;
    const active = new Uint8Array(bins);
    const support = new Uint16Array(bins);
    const tolerance = Math.max(2.5, circle.radius * 0.026);

    if (usedInSilhouette) {
      accumulateCircleBinsFromEdge(analysis, compositionEdge, circle, bins, tolerance, active, support);
    }
    accumulateCircleBinsFromPoints(analysis.contourPoints, circle, bins, tolerance * 1.4, usedInSilhouette ? undefined : active, support);

    const ranges = active.some(Boolean)
      ? binsToArcRanges(active, support, bins, usedInSilhouette ? 2 : 1)
      : [];

    if (ranges.length === 0) {
      arcs.push({
        id: `A-${circle.id}-full`,
        circleId: circle.id,
        startAngle: 0,
        endAngle: 360,
        usedInSilhouette,
        usedAsHelperOnly: circle.role === 'helper' || circle.role === 'boundary',
      });
      return;
    }

    ranges.forEach((range, index) => {
      arcs.push({
        id: `A-${circle.id}-${index + 1}`,
        circleId: circle.id,
        startAngle: range.startAngle,
        endAngle: range.endAngle,
        usedInSilhouette,
        usedAsHelperOnly: circle.role === 'helper' || circle.role === 'boundary',
      });
    });
  });
  return arcs;
}

function accumulateCircleBinsFromEdge(
  analysis: ImageAnalysis,
  edge: Uint8Array,
  circle: CircleSpec,
  bins: number,
  tolerance: number,
  active: Uint8Array,
  support: Uint16Array,
) {
  const minX = Math.max(0, Math.floor(circle.centerX - circle.radius - tolerance));
  const maxX = Math.min(analysis.width - 1, Math.ceil(circle.centerX + circle.radius + tolerance));
  const minY = Math.max(0, Math.floor(circle.centerY - circle.radius - tolerance));
  const maxY = Math.min(analysis.height - 1, Math.ceil(circle.centerY + circle.radius + tolerance));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!edge[y * analysis.width + x]) continue;
      const delta = Math.abs(Math.hypot(x - circle.centerX, y - circle.centerY) - circle.radius);
      if (delta > tolerance) continue;
      const bin = angleToBin(x, y, circle, bins);
      active[bin] = 1;
      support[bin] += 2;
    }
  }
}

function accumulateCircleBinsFromPoints(
  points: Array<{ x: number; y: number }>,
  circle: CircleSpec,
  bins: number,
  tolerance: number,
  active: Uint8Array | undefined,
  support: Uint16Array,
) {
  for (const point of points) {
    const delta = Math.abs(Math.hypot(point.x - circle.centerX, point.y - circle.centerY) - circle.radius);
    if (delta > tolerance) continue;
    const bin = angleToBin(point.x, point.y, circle, bins);
    if (active) active[bin] = 1;
    support[bin] += 1;
  }
}

function binsToArcRanges(active: Uint8Array, support: Uint16Array, bins: number, minBins: number) {
  const filled = bridgeSmallGaps(active, bins);
  const runs: Array<{ start: number; end: number; weight: number; length: number }> = [];
  const visited = new Uint8Array(bins);

  for (let i = 0; i < bins; i += 1) {
    if (!filled[i] || visited[i]) continue;
    let end = i;
    let weight = 0;
    let length = 0;
    while (filled[end % bins] && !visited[end % bins] && length < bins) {
      visited[end % bins] = 1;
      weight += support[end % bins];
      length += 1;
      end += 1;
    }
    if (length >= minBins) runs.push({ start: i, end: end - 1, weight, length });
  }

  return runs
    .sort((a, b) => b.weight + b.length * 3 - (a.weight + a.length * 3))
    .slice(0, 4)
    .sort((a, b) => a.start - b.start)
    .map((run) => ({
      startAngle: (run.start / bins) * 360,
      endAngle: (((run.end + 1) % bins) / bins) * 360,
    }));
}

function bridgeSmallGaps(active: Uint8Array, bins: number) {
  const filled = new Uint8Array(active);
  for (let i = 0; i < bins; i += 1) {
    const prev = filled[(i - 1 + bins) % bins];
    const next = filled[(i + 1) % bins];
    if (!filled[i] && prev && next) filled[i] = 1;
  }
  return filled;
}

function angleToBin(x: number, y: number, circle: CircleSpec, bins: number) {
  const angle = normalizeAngle((Math.atan2(y - circle.centerY, x - circle.centerX) * 180) / Math.PI);
  return Math.min(bins - 1, Math.floor((angle / 360) * bins));
}

function normalizeAngle(angle: number) {
  return ((angle % 360) + 360) % 360;
}

function makeExpression(conditions: RegionCondition[]) {
  if (conditions.length === 0) return 'No circle conditions selected.';
  return conditions
    .map((condition, index) => `${index + 1}. ${condition.relation === 'add' ? 'add inside' : 'subtract inside'} ${condition.circleId}`)
    .join(' -> ');
}
