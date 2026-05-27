import type { CircleSpec, GeneratorSettings, ImageAnalysis, Point } from './types';

interface CandidateStats {
  maskCoverage: number;
  outsidePenalty: number;
  boundarySupport: number;
}

interface OptimizationStep {
  circle: CircleSpec;
  mask: Uint8Array;
  score: number;
  gain: number;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function generateCircleCandidates(analysis: ImageAnalysis, settings: GeneratorSettings): CircleSpec[] {
  const minRadius = Math.max(2, settings.minRadius);
  const maxRadius = Math.max(minRadius + 1, Math.min(settings.maxRadius, Math.max(analysis.width, analysis.height)));
  const addCandidates = generateDistancePeakCandidates(analysis, minRadius, maxRadius, settings);
  const boundaryCandidates = generateBoundaryCandidates(analysis, minRadius, maxRadius, settings);
  const selectedAdd = greedyAdd(analysis, addCandidates, settings);
  const addMask = paintCircles(analysis.width, analysis.height, selectedAdd);
  const subtractCandidates = generateSubtractCandidates(analysis, addMask, minRadius, maxRadius, settings);
  const selectedSubtract = greedySubtract(analysis, addMask, subtractCandidates, settings);
  const finalMask = applySubtract(analysis.width, analysis.height, addMask, selectedSubtract);
  const selected = [...selectedAdd, ...selectedSubtract].map((circle) => enrichFinalCircle(circle, analysis, finalMask));

  const selectedIds = new Set(selected.map((circle) => circle.id));
  const helpers = [...boundaryCandidates, ...addCandidates]
    .filter((circle) => !selectedIds.has(circle.id))
    .sort((a, b) => b.boundarySupport + b.score - (a.boundarySupport + a.score))
    .slice(0, Math.max(0, settings.maxCircles - selected.length))
    .map((circle) => makeCircle(circle.id, circle.centerX, circle.centerY, circle.radius, circle.source === 'contour_fit' ? 'boundary' : 'helper', circle.source, circle.score, {
      ...circle,
      usedInFinal: false,
    }));

  return [...selected, ...helpers].map((circle, index) => withPublicId(circle, index + 1));
}

function generateDistancePeakCandidates(
  analysis: ImageAnalysis,
  minRadius: number,
  maxRadius: number,
  settings: GeneratorSettings,
) {
  const dist = distanceTransform(analysis.mask, analysis.width, analysis.height);
  const peaks: CircleSpec[] = [];
  const step = Math.max(1, Math.round(3 - (settings.simplicity / 100) * 2));
  for (let y = analysis.bounds.minY; y <= analysis.bounds.maxY; y += step) {
    for (let x = analysis.bounds.minX; x <= analysis.bounds.maxX; x += step) {
      const i = y * analysis.width + x;
      const r = dist[i];
      if (r < minRadius || r > maxRadius) continue;
      if (!isLocalMaximum(dist, analysis.width, analysis.height, x, y, Math.max(2, Math.round(r * 0.22)))) continue;
      const stats = circleStats(analysis, x, y, r);
      const radiusScore = Math.min(1, r / Math.max(1, maxRadius));
      const score = stats.maskCoverage * 0.48 - stats.outsidePenalty * 0.9 + radiusScore * 0.28 + stats.boundarySupport * 0.22;
      peaks.push(makeCircle(`distance-${peaks.length}`, x, y, r, 'add', 'distance_peak', score, stats));
    }
  }
  return nmsCircles(peaks.sort((a, b) => b.score - a.score), settings.nmsDistance, Math.max(settings.maxAddCircles * 5, settings.maxCircles * 3));
}

function generateBoundaryCandidates(
  analysis: ImageAnalysis,
  minRadius: number,
  maxRadius: number,
  settings: GeneratorSettings,
) {
  const candidates: CircleSpec[] = [];
  const points = simplifyPoints(analysis.contourPoints, Math.max(2, Math.round(8 - settings.simplicity / 18)));
  const gap = Math.max(4, Math.round(points.length / 70));
  for (let i = 0; i < points.length - gap * 2; i += Math.max(2, Math.round(gap * 0.75))) {
    const circle = circleFromThreePoints(points[i], points[i + gap], points[i + gap * 2]);
    if (!circle || circle.radius < minRadius || circle.radius > maxRadius * 1.8) continue;
    const stats = circleStats(analysis, circle.x, circle.y, circle.radius);
    if (stats.boundarySupport < 0.02) continue;
    const score = stats.boundarySupport * 1.2 + stats.maskCoverage * 0.12 - stats.outsidePenalty * 0.15;
    candidates.push(makeCircle(`boundary-${candidates.length}`, circle.x, circle.y, circle.radius, 'boundary', 'contour_fit', score, stats));
  }
  return nmsCircles(candidates.sort((a, b) => b.score - a.score), settings.nmsDistance * 0.7, settings.maxCircles * 3);
}

function greedyAdd(analysis: ImageAnalysis, candidates: CircleSpec[], settings: GeneratorSettings) {
  const selected: CircleSpec[] = [];
  const current = new Uint8Array(analysis.mask.length);
  let currentScore = scoreMask(current, analysis.mask, settings);
  const max = Math.min(settings.maxAddCircles, settings.maxCircles);
  const masks = candidates.map((circle) => rasterizeCircle(circle, analysis.width, analysis.height));
  const used = new Set<number>();

  for (let step = 0; step < max; step += 1) {
    let best: OptimizationStep | null = null;
    for (let i = 0; i < candidates.length; i += 1) {
      if (used.has(i)) continue;
      const next = unionMask(current, masks[i]);
      const score = scoreMask(next, analysis.mask, settings) - redundancyPenalty(masks[i], current) - countPenalty(selected.length, settings);
      const gain = score - currentScore;
      if (!best || gain > best.gain) best = { circle: candidates[i], mask: masks[i], score, gain };
    }
    const threshold = 0.018 - (settings.simplicity / 100) * 0.014;
    if (!best || best.gain < threshold) break;
    unionMaskInPlace(current, best.mask);
    selected.push({ ...best.circle, role: 'add', score: Math.max(0, Math.min(1, best.score)), usedInFinal: true });
    used.add(candidates.indexOf(best.circle));
    currentScore = scoreMask(current, analysis.mask, settings);
  }
  return selected;
}

function generateSubtractCandidates(
  analysis: ImageAnalysis,
  addMask: Uint8Array,
  minRadius: number,
  maxRadius: number,
  settings: GeneratorSettings,
) {
  const overfill = new Uint8Array(addMask.length);
  for (let i = 0; i < addMask.length; i += 1) overfill[i] = addMask[i] && !analysis.mask[i] ? 1 : 0;
  const dist = distanceTransform(overfill, analysis.width, analysis.height);
  const candidates: CircleSpec[] = [];
  for (let y = 0; y < analysis.height; y += 2) {
    for (let x = 0; x < analysis.width; x += 2) {
      const i = y * analysis.width + x;
      const r = dist[i];
      if (r < minRadius || r > maxRadius) continue;
      if (!isLocalMaximum(dist, analysis.width, analysis.height, x, y, Math.max(2, Math.round(r * 0.25)))) continue;
      const circleMask = rasterizeCircleLike(x, y, r, analysis.width, analysis.height);
      const removesBad = overlapArea(circleMask, overfill);
      const removesGood = overlapArea(circleMask, analysis.mask);
      const score = removesBad / Math.max(1, removesBad + removesGood * 1.8);
      if (score < 0.16) continue;
      candidates.push(makeCircle(`subtract-${candidates.length}`, x, y, r, 'subtract', 'residual_fit', score, {
        maskCoverage: removesBad / Math.max(1, areaOf(overfill)),
        outsidePenalty: removesGood / Math.max(1, areaOf(analysis.mask)),
        boundarySupport: 0,
      }));
    }
  }
  return nmsCircles(candidates.sort((a, b) => b.score - a.score), settings.nmsDistance, settings.maxSubtractCircles * 4);
}

function greedySubtract(analysis: ImageAnalysis, addMask: Uint8Array, candidates: CircleSpec[], settings: GeneratorSettings) {
  const selected: CircleSpec[] = [];
  const current = new Uint8Array(addMask);
  let currentScore = scoreMask(current, analysis.mask, settings);
  const masks = candidates.map((circle) => rasterizeCircle(circle, analysis.width, analysis.height));
  const used = new Set<number>();

  for (let step = 0; step < settings.maxSubtractCircles; step += 1) {
    let best: OptimizationStep | null = null;
    for (let i = 0; i < candidates.length; i += 1) {
      if (used.has(i)) continue;
      const next = subtractMask(current, masks[i]);
      const score = scoreMask(next, analysis.mask, settings) - countPenalty(step, settings) * 0.7;
      const gain = score - currentScore;
      if (!best || gain > best.gain) best = { circle: candidates[i], mask: masks[i], score, gain };
    }
    if (!best || best.gain < 0.006) break;
    subtractMaskInPlace(current, best.mask);
    selected.push({ ...best.circle, role: 'subtract', score: Math.max(0, Math.min(1, best.score)), usedInFinal: true });
    used.add(candidates.indexOf(best.circle));
    currentScore = scoreMask(current, analysis.mask, settings);
  }
  return selected;
}

function distanceTransform(mask: Uint8Array, width: number, height: number) {
  const inf = 1_000_000;
  const dist = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) dist[i] = mask[i] ? inf : 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
      if (y > 0) dist[i] = Math.min(dist[i], dist[i - width] + 1);
      if (x > 0 && y > 0) dist[i] = Math.min(dist[i], dist[i - width - 1] + 1.414);
      if (x < width - 1 && y > 0) dist[i] = Math.min(dist[i], dist[i - width + 1] + 1.414);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (x < width - 1) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
      if (y < height - 1) dist[i] = Math.min(dist[i], dist[i + width] + 1);
      if (x < width - 1 && y < height - 1) dist[i] = Math.min(dist[i], dist[i + width + 1] + 1.414);
      if (x > 0 && y < height - 1) dist[i] = Math.min(dist[i], dist[i + width - 1] + 1.414);
    }
  }
  return dist;
}

function isLocalMaximum(dist: Float32Array, width: number, height: number, x: number, y: number, radius: number) {
  const center = dist[y * width + x];
  for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy += 1) {
    for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx += 1) {
      if (dist[yy * width + xx] > center + 0.001) return false;
    }
  }
  return true;
}

function scoreMask(current: Uint8Array, target: Uint8Array, settings: GeneratorSettings) {
  let intersection = 0;
  let predicted = 0;
  let targetArea = 0;
  let falsePositive = 0;
  for (let i = 0; i < current.length; i += 1) {
    if (current[i]) predicted += 1;
    if (target[i]) targetArea += 1;
    if (current[i] && target[i]) intersection += 1;
    if (current[i] && !target[i]) falsePositive += 1;
  }
  if (targetArea === 0) return 0;
  const precision = predicted === 0 ? 0 : intersection / predicted;
  const recall = intersection / targetArea;
  const fidelity = settings.simplicity / 100;
  const beta = 0.72 + (1 - fidelity) * 0.38;
  const beta2 = beta * beta;
  const fScore = precision + recall === 0 ? 0 : ((1 + beta2) * precision * recall) / (beta2 * precision + recall);
  return fScore - (falsePositive / Math.max(1, predicted)) * (0.18 + fidelity * 0.5);
}

function circleStats(analysis: ImageAnalysis, cx: number, cy: number, r: number): CandidateStats {
  const circleMask = rasterizeCircleLike(cx, cy, r, analysis.width, analysis.height);
  const circleArea = Math.max(1, areaOf(circleMask));
  const inside = overlapArea(circleMask, analysis.mask);
  const boundarySupport = estimateBoundarySupport(analysis, cx, cy, r);
  return {
    maskCoverage: inside / Math.max(1, areaOf(analysis.mask)),
    outsidePenalty: (circleArea - inside) / circleArea,
    boundarySupport,
  };
}

function estimateBoundarySupport(analysis: ImageAnalysis, cx: number, cy: number, r: number) {
  const tolerance = Math.max(2, r * 0.035);
  let support = 0;
  const bins = new Uint8Array(96);
  for (const point of analysis.contourPoints) {
    const delta = Math.abs(Math.hypot(point.x - cx, point.y - cy) - r);
    if (delta > tolerance) continue;
    const angle = ((Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI + 360) % 360;
    bins[Math.floor((angle / 360) * bins.length)] = 1;
  }
  for (const value of bins) support += value;
  return support / bins.length;
}

function rasterizeCircle(circle: CircleSpec, width: number, height: number) {
  return rasterizeCircleLike(circle.centerX, circle.centerY, circle.radius, width, height);
}

function rasterizeCircleLike(cx: number, cy: number, r: number, width: number, height: number) {
  const out = new Uint8Array(width * height);
  const minX = Math.max(0, Math.floor(cx - r));
  const maxX = Math.min(width - 1, Math.ceil(cx + r));
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(height - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) out[y * width + x] = 1;
    }
  }
  return out;
}

function unionMask(base: Uint8Array, add: Uint8Array) {
  const out = new Uint8Array(base);
  unionMaskInPlace(out, add);
  return out;
}

function unionMaskInPlace(base: Uint8Array, add: Uint8Array) {
  for (let i = 0; i < base.length; i += 1) if (add[i]) base[i] = 1;
}

function subtractMask(base: Uint8Array, sub: Uint8Array) {
  const out = new Uint8Array(base);
  subtractMaskInPlace(out, sub);
  return out;
}

function subtractMaskInPlace(base: Uint8Array, sub: Uint8Array) {
  for (let i = 0; i < base.length; i += 1) if (sub[i]) base[i] = 0;
}

function paintCircles(width: number, height: number, circles: CircleSpec[]) {
  const out = new Uint8Array(width * height);
  for (const circle of circles) unionMaskInPlace(out, rasterizeCircle(circle, width, height));
  return out;
}

function applySubtract(width: number, height: number, base: Uint8Array, circles: CircleSpec[]) {
  const out = new Uint8Array(base);
  for (const circle of circles) subtractMaskInPlace(out, rasterizeCircle(circle, width, height));
  return out;
}

function overlapArea(a: Uint8Array, b: Uint8Array) {
  let count = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] && b[i]) count += 1;
  return count;
}

function areaOf(mask: Uint8Array) {
  let count = 0;
  for (const value of mask) count += value;
  return count;
}

function redundancyPenalty(candidate: Uint8Array, current: Uint8Array) {
  const overlap = overlapArea(candidate, current);
  const area = Math.max(1, areaOf(candidate));
  return (overlap / area) * 0.035;
}

function countPenalty(count: number, settings: GeneratorSettings) {
  const simplicity = 1 - settings.simplicity / 100;
  return count * (0.002 + simplicity * 0.006);
}

function nmsCircles(circles: CircleSpec[], nmsDistance: number, limit: number) {
  const selected: CircleSpec[] = [];
  for (const circle of circles) {
    const duplicate = selected.some((picked) => {
      const centerDistance = Math.hypot(circle.centerX - picked.centerX, circle.centerY - picked.centerY);
      const radiusDelta = Math.abs(circle.radius - picked.radius);
      const threshold = Math.max(nmsDistance, Math.min(circle.radius, picked.radius) * 0.55);
      return centerDistance < threshold && radiusDelta < Math.max(4, Math.min(circle.radius, picked.radius) * 0.35);
    });
    if (!duplicate) selected.push(circle);
    if (selected.length >= limit) break;
  }
  return selected;
}

function simplifyPoints(points: Point[], stride: number) {
  return points.filter((_, index) => index % Math.max(1, stride) === 0);
}

function circleFromThreePoints(a: Point, b: Point, c: Point): { x: number; y: number; radius: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 0.001) return null;
  const ux =
    ((a.x ** 2 + a.y ** 2) * (b.y - c.y) +
      (b.x ** 2 + b.y ** 2) * (c.y - a.y) +
      (c.x ** 2 + c.y ** 2) * (a.y - b.y)) /
    d;
  const uy =
    ((a.x ** 2 + a.y ** 2) * (c.x - b.x) +
      (b.x ** 2 + b.y ** 2) * (a.x - c.x) +
      (c.x ** 2 + c.y ** 2) * (b.x - a.x)) /
    d;
  return { x: ux, y: uy, radius: distance({ x: ux, y: uy }, a) };
}

function enrichFinalCircle(circle: CircleSpec, analysis: ImageAnalysis, finalMask: Uint8Array) {
  const boundarySupport = estimateFinalBoundarySupport(analysis, finalMask, circle);
  return makeCircle(circle.id, circle.centerX, circle.centerY, circle.radius, circle.role, circle.source, circle.score, {
    ...circle,
    boundarySupport,
    usedInFinal: true,
  });
}

function estimateFinalBoundarySupport(analysis: ImageAnalysis, finalMask: Uint8Array, circle: CircleSpec) {
  const tolerance = Math.max(2, circle.radius * 0.03);
  const bins = new Uint8Array(144);
  for (let y = 1; y < analysis.height - 1; y += 1) {
    for (let x = 1; x < analysis.width - 1; x += 1) {
      const i = y * analysis.width + x;
      if (!finalMask[i]) continue;
      if (finalMask[i - 1] && finalMask[i + 1] && finalMask[i - analysis.width] && finalMask[i + analysis.width]) continue;
      const delta = Math.abs(Math.hypot(x - circle.centerX, y - circle.centerY) - circle.radius);
      if (delta > tolerance) continue;
      const angle = ((Math.atan2(y - circle.centerY, x - circle.centerX) * 180) / Math.PI + 360) % 360;
      bins[Math.floor((angle / 360) * bins.length)] = 1;
    }
  }
  let count = 0;
  for (const bin of bins) count += bin;
  return count / bins.length;
}

function makeCircle(
  id: string,
  centerX: number,
  centerY: number,
  radius: number,
  role: CircleSpec['role'],
  source: CircleSpec['source'],
  score: number,
  partial: Partial<CircleSpec> & Partial<CandidateStats> = {},
): CircleSpec {
  return {
    id,
    cx: centerX,
    cy: centerY,
    r: radius,
    centerX,
    centerY,
    radius,
    role,
    visible: true,
    usedInFinal: partial.usedInFinal ?? (role === 'add' || role === 'subtract'),
    startAngle: partial.startAngle ?? 0,
    endAngle: partial.endAngle ?? 360,
    boundarySupport: partial.boundarySupport ?? 0,
    maskCoverage: partial.maskCoverage ?? 0,
    outsidePenalty: partial.outsidePenalty ?? 0,
    score,
    source,
    equation: equationFor(centerX, centerY, radius),
  };
}

function withPublicId(circle: CircleSpec, index: number) {
  const id = `C${index}`;
  return {
    ...circle,
    id,
    equation: equationFor(circle.centerX, circle.centerY, circle.radius),
  };
}

export function equationFor(centerX: number, centerY: number, radius: number) {
  return `(x - ${centerX.toFixed(1)})^2 + (y - ${centerY.toFixed(1)})^2 = ${radius.toFixed(1)}^2`;
}
