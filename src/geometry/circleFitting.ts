import type {
  CircleDebugRow,
  CircleFittingDebugData,
  CircleSpec,
  GeneratorSettings,
  ImageAnalysis,
  Point,
  RejectionReason,
  SelectionStepDebug,
  ShapeOptimizationDebug,
} from './types';

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

interface IndexedPoint extends Point {
  contourIndex: number;
}

interface ArcMetrics {
  startAngle: number;
  endAngle: number;
  arcLength: number;
  fitError: number;
  contourSupport: number;
  coveredContourIndices: number[];
  rejectionReason?: RejectionReason;
}

interface AddSelectionResult {
  selected: CircleSpec[];
  rejected: CircleSpec[];
  coverageMask: Uint8Array;
  steps: SelectionStepDebug[];
}

type OptimizableRole = 'add' | 'subtract' | 'helper';

interface ShapeScore {
  score: number;
  iou: number;
  falsePositive: number;
  falseNegative: number;
  boundaryMismatch: number;
}

interface RoleOptimizationResult {
  circles: CircleSpec[];
  finalMask: Uint8Array;
  falsePositive: Uint8Array;
  falseNegative: Uint8Array;
  debug: ShapeOptimizationDebug;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function generateCircleCandidates(analysis: ImageAnalysis, settings: GeneratorSettings): CircleSpec[] {
  return generateCircleCandidatesWithDebug(analysis, settings).circles;
}

export function generateCircleCandidatesWithDebug(
  analysis: ImageAnalysis,
  settings: GeneratorSettings,
): { circles: CircleSpec[]; debug: CircleFittingDebugData } {
  const minRadius = Math.max(2, settings.minRadius);
  const maxRadius = Math.max(minRadius + 1, Math.min(settings.maxRadius, Math.max(analysis.width, analysis.height)));
  const dist = distanceTransform(analysis.mask, analysis.width, analysis.height);
  const fillCandidates = generateDistancePeakCandidates(analysis, minRadius, maxRadius, settings, dist);
  const boundarySample = getSimplifiedContourPoints(analysis, settings);
  const arcCandidates = generateBoundaryCandidates(analysis, minRadius, maxRadius, settings, boundarySample);
  const addSelection = settings.contourFirstMode
    ? greedyContourAdd(analysis, arcCandidates, fillCandidates, settings)
    : greedyFillAdd(analysis, [...arcCandidates, ...fillCandidates], settings);
  const initialSelectedAdd = addSelection.selected;
  const initialAddMask = paintCircles(analysis.width, analysis.height, initialSelectedAdd);
  const subtractCandidates = generateSubtractCandidates(analysis, initialAddMask, arcCandidates, initialSelectedAdd, minRadius, maxRadius, settings);
  const initialSelectedSubtract = greedySubtract(analysis, initialAddMask, subtractCandidates, settings);
  const optimization = optimizeCircleRoles(
    analysis,
    [
      ...initialSelectedAdd,
      ...initialSelectedSubtract,
      ...arcCandidates.slice(0, settings.maxCircles * 3),
      ...fillCandidates.slice(0, Math.max(2, settings.maxFillCircles * 3)),
      ...subtractCandidates.slice(0, settings.maxSubtractCircles * 3),
    ],
    initialSelectedAdd,
    initialSelectedSubtract,
    settings,
  );
  const selected = optimization.circles
    .filter((circle) => circle.role === 'add' || circle.role === 'subtract')
    .map((circle) => enrichFinalCircle(circle, analysis, optimization.finalMask));
  const selectedAdd = selected.filter((circle) => circle.role === 'add');
  const selectedSubtract = selected.filter((circle) => circle.role === 'subtract');

  const selectedIds = new Set(selected.map((circle) => circle.id));
  const rejectedIds = new Set(addSelection.rejected.map((circle) => circle.id));
  const optimizedHelpers = optimization.circles.filter((circle) => circle.role === 'helper');
  const helpers = [...optimizedHelpers, ...arcCandidates, ...fillCandidates]
    .filter((circle) => !selectedIds.has(circle.id))
    .sort((a, b) => b.contourSupport + b.arcLength / 1000 + b.score - (a.contourSupport + a.arcLength / 1000 + a.score))
    .slice(0, Math.max(0, settings.maxCircles - selected.length))
    .map((circle) => makeCircle(circle.id, circle.centerX, circle.centerY, circle.radius, circle.source === 'contour_fit' ? 'boundary' : 'helper', circle.source, circle.score, {
      ...circle,
      rejectionReason: circle.rejectionReason ?? (rejectedIds.has(circle.id) ? 'not_selected' : undefined),
      usedInFinal: false,
      candidateKind: circle.candidateKind === 'arc' ? 'arc' : 'helper',
    }));

  const circles = [...selected, ...helpers].map((circle, index) => withPublicId(circle, index + 1));
  const overfillRegion = makeOverfillMask(paintCircles(analysis.width, analysis.height, selectedAdd), analysis.mask);
  const debug: CircleFittingDebugData = {
    cleanedMask: new Uint8Array(analysis.mask),
    extractedContour: pointsToMask(analysis.rawContourPoints, analysis.width, analysis.height),
    contourImage: new Uint8Array(analysis.edge),
    smoothedContour: pointsToMask(analysis.smoothedContourPoints, analysis.width, analysis.height),
    contourSegments: segmentsToMask(analysis.contourPoints, analysis.contourSegments, analysis.width, analysis.height),
    simplifiedContour: pointsToMask(boundarySample, analysis.width, analysis.height),
    distanceTransform: dist,
    allRawCircleCandidates: [...arcCandidates, ...fillCandidates, ...subtractCandidates].map(circleToDebugRow),
    arcCandidates: arcCandidates.map(circleToDebugRow),
    fillCandidates: fillCandidates.map(circleToDebugRow),
    selectedAddCircles: selectedAdd.map(circleToDebugRow),
    selectedSubtractCircles: selectedSubtract.map(circleToDebugRow),
    rejectedCandidates: [...addSelection.rejected, ...arcCandidates.filter((circle) => circle.rejectionReason)].map(circleToDebugRow),
    contourCoverage: addSelection.coverageMask,
    contourCoverageImage: contourCoverageToMask(analysis, addSelection.coverageMask),
    selectionSteps: addSelection.steps,
    finalGeometryBeforeSubtract: paintCircles(analysis.width, analysis.height, selectedAdd),
    overfillRegion,
    falsePositiveRegion: optimization.falsePositive,
    falseNegativeRegion: optimization.falseNegative,
    finalGeometryAfterSubtract: optimization.finalMask,
    shapeOptimization: optimization.debug,
  };

  return { circles, debug };
}

function optimizeCircleRoles(
  analysis: ImageAnalysis,
  rawCandidates: CircleSpec[],
  initialAdd: CircleSpec[],
  initialSubtract: CircleSpec[],
  settings: GeneratorSettings,
): RoleOptimizationResult {
  const candidates = uniqueCircles(rawCandidates)
    .slice(0, Math.max(settings.maxCircles * 5, settings.maxAddCircles + settings.maxSubtractCircles + 8));
  const initialAddIds = new Set(initialAdd.map((circle) => circle.id));
  const initialSubtractIds = new Set(initialSubtract.map((circle) => circle.id));
  const roles = new Map<string, OptimizableRole>();
  const masks = new Map<string, Uint8Array>();
  for (const circle of candidates) {
    roles.set(circle.id, initialAddIds.has(circle.id) ? 'add' : initialSubtractIds.has(circle.id) ? 'subtract' : 'helper');
    masks.set(circle.id, rasterizeCircle(circle, analysis.width, analysis.height));
  }

  let currentMask = composeRoleMask(candidates, roles, masks, analysis.width, analysis.height);
  let currentScore = scoreShape(currentMask, analysis.mask, candidates, roles, settings);
  const initialScore = currentScore.score;
  const acceptedRoleFlips: ShapeOptimizationDebug['acceptedRoleFlips'] = [];
  let acceptedAdditions = 0;
  let acceptedRemovals = 0;
  let iterations = 0;

  for (let iteration = 0; iteration < 18; iteration += 1) {
    let best: { id: string; from: OptimizableRole; to: OptimizableRole; mask: Uint8Array; score: ShapeScore; delta: number } | null = null;
    for (const circle of candidates) {
      const from = roles.get(circle.id) ?? 'helper';
      for (const to of possibleRoles(from)) {
        if (!roleWithinLimits(circle.id, to, roles, settings)) continue;
        const trialRoles = new Map(roles);
        trialRoles.set(circle.id, to);
        const trialMask = composeRoleMask(candidates, trialRoles, masks, analysis.width, analysis.height);
        const trialScore = scoreShape(trialMask, analysis.mask, candidates, trialRoles, settings);
        const delta = trialScore.score - currentScore.score;
        if (!best || delta > best.delta) best = { id: circle.id, from, to, mask: trialMask, score: trialScore, delta };
      }
    }
    if (!best || best.delta < 0.002) break;
    roles.set(best.id, best.to);
    currentMask = new Uint8Array(best.mask);
    currentScore = best.score;
    iterations = iteration + 1;
    if (best.from === 'helper' && best.to !== 'helper') acceptedAdditions += 1;
    if (best.from !== 'helper' && best.to === 'helper') acceptedRemovals += 1;
    acceptedRoleFlips.push({ circleId: best.id, from: best.from, to: best.to, score: best.score.score, delta: best.delta });
  }

  const optimizedCircles = candidates.map((circle) => {
    const initialRole = initialAddIds.has(circle.id) ? 'add' : initialSubtractIds.has(circle.id) ? 'subtract' : 'helper';
    const finalRole = roles.get(circle.id) ?? 'helper';
    const usedInFinal = finalRole === 'add' || finalRole === 'subtract';
    const finalMask = masks.get(circle.id) ?? rasterizeCircle(circle, analysis.width, analysis.height);
    return makeCircle(circle.id, circle.centerX, circle.centerY, circle.radius, finalRole, circle.source, circle.score, {
      ...circle,
      initialRole,
      finalRole,
      usedInFinal,
      changedInOptimization: initialRole !== finalRole,
      scoreContribution: estimateScoreContribution(currentMask, analysis.mask, finalMask, finalRole),
      rejectionReason: usedInFinal ? undefined : circle.rejectionReason ?? 'not_selected',
      candidateKind: finalRole === 'subtract' ? 'subtract' : circle.candidateKind,
    });
  });
  const { falsePositive, falseNegative } = errorMasks(currentMask, analysis.mask);
  return {
    circles: optimizedCircles,
    finalMask: currentMask,
    falsePositive,
    falseNegative,
    debug: {
      initialAddCircleIds: [...initialAddIds],
      initialSubtractCircleIds: [...initialSubtractIds],
      optimizedAddCircleIds: optimizedCircles.filter((circle) => circle.role === 'add').map((circle) => circle.id),
      optimizedSubtractCircleIds: optimizedCircles.filter((circle) => circle.role === 'subtract').map((circle) => circle.id),
      initialScore,
      optimizedScore: currentScore.score,
      iterations,
      acceptedRoleFlips,
      acceptedAdditions,
      acceptedRemovals,
    },
  };
}

function uniqueCircles(circles: CircleSpec[]) {
  const out: CircleSpec[] = [];
  const seen = new Set<string>();
  for (const circle of circles) {
    if (seen.has(circle.id)) continue;
    seen.add(circle.id);
    out.push(circle);
  }
  return out;
}

function possibleRoles(role: OptimizableRole): OptimizableRole[] {
  return role === 'add' ? ['subtract', 'helper'] : role === 'subtract' ? ['add', 'helper'] : ['add', 'subtract'];
}

function roleWithinLimits(circleId: string, role: OptimizableRole, roles: Map<string, OptimizableRole>, settings: GeneratorSettings) {
  const next = new Map(roles);
  next.set(circleId, role);
  let add = 0;
  let subtract = 0;
  for (const value of next.values()) {
    if (value === 'add') add += 1;
    if (value === 'subtract') subtract += 1;
  }
  return add <= settings.maxAddCircles && subtract <= settings.maxSubtractCircles && add + subtract <= settings.maxCircles;
}

function composeRoleMask(circles: CircleSpec[], roles: Map<string, OptimizableRole>, masks: Map<string, Uint8Array>, width: number, height: number) {
  const out = new Uint8Array(width * height);
  for (const circle of circles) {
    if (roles.get(circle.id) !== 'add') continue;
    unionMaskInPlace(out, masks.get(circle.id) ?? rasterizeCircle(circle, width, height));
  }
  for (const circle of circles) {
    if (roles.get(circle.id) !== 'subtract') continue;
    subtractMaskInPlace(out, masks.get(circle.id) ?? rasterizeCircle(circle, width, height));
  }
  return out;
}

function scoreShape(shape: Uint8Array, target: Uint8Array, circles: CircleSpec[], roles: Map<string, OptimizableRole>, settings: GeneratorSettings): ShapeScore {
  let intersection = 0;
  let union = 0;
  let predicted = 0;
  let targetArea = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (let i = 0; i < shape.length; i += 1) {
    const s = shape[i] === 1;
    const t = target[i] === 1;
    if (s) predicted += 1;
    if (t) targetArea += 1;
    if (s && t) intersection += 1;
    if (s || t) union += 1;
    if (s && !t) falsePositive += 1;
    if (!s && t) falseNegative += 1;
  }
  const iou = union === 0 ? 0 : intersection / union;
  const fpRate = falsePositive / Math.max(1, predicted);
  const fnRate = falseNegative / Math.max(1, targetArea);
  const active = circles.filter((circle) => roles.get(circle.id) === 'add' || roles.get(circle.id) === 'subtract');
  const tinyPenalty = active.reduce((sum, circle) => sum + (circle.radius < settings.minRadius * 1.8 ? 0.015 : 0), 0);
  const redundancy = active.reduce((sum, circle, index) => {
    for (let j = index + 1; j < active.length; j += 1) {
      const d = Math.hypot(circle.centerX - active[j].centerX, circle.centerY - active[j].centerY);
      if (d < Math.min(circle.radius, active[j].radius) * 0.35) sum += 0.01;
    }
    return sum;
  }, 0);
  const boundaryMismatch = Math.abs(fpRate - fnRate);
  const circleCountPenalty = active.length * (0.004 + (1 - settings.simplicity / 100) * 0.006);
  return {
    score: iou - fpRate * 0.58 - fnRate * 0.42 - boundaryMismatch * 0.08 - circleCountPenalty - tinyPenalty - redundancy,
    iou,
    falsePositive: fpRate,
    falseNegative: fnRate,
    boundaryMismatch,
  };
}

function errorMasks(shape: Uint8Array, target: Uint8Array) {
  const falsePositive = new Uint8Array(shape.length);
  const falseNegative = new Uint8Array(shape.length);
  for (let i = 0; i < shape.length; i += 1) {
    falsePositive[i] = shape[i] && !target[i] ? 1 : 0;
    falseNegative[i] = !shape[i] && target[i] ? 1 : 0;
  }
  return { falsePositive, falseNegative };
}

function estimateScoreContribution(shape: Uint8Array, target: Uint8Array, circleMask: Uint8Array, role: OptimizableRole) {
  let useful = 0;
  let harmful = 0;
  for (let i = 0; i < shape.length; i += 1) {
    if (!circleMask[i]) continue;
    if (role === 'add') {
      if (target[i]) useful += 1;
      else harmful += 1;
    } else if (role === 'subtract') {
      if (!target[i]) useful += 1;
      else harmful += 1;
    }
  }
  return (useful - harmful) / Math.max(1, useful + harmful);
}

function generateDistancePeakCandidates(
  analysis: ImageAnalysis,
  minRadius: number,
  maxRadius: number,
  settings: GeneratorSettings,
  dist = distanceTransform(analysis.mask, analysis.width, analysis.height),
) {
  const peaks: CircleSpec[] = [];
  const step = Math.max(2, Math.round(5 - (settings.simplicity / 100) * 2));
  for (let y = analysis.bounds.minY; y <= analysis.bounds.maxY; y += step) {
    for (let x = analysis.bounds.minX; x <= analysis.bounds.maxX; x += step) {
      const i = y * analysis.width + x;
      const r = dist[i];
      if (r < Math.max(minRadius * 1.8, settings.minRadius) || r > maxRadius) continue;
      if (!isLocalMaximum(dist, analysis.width, analysis.height, x, y, Math.max(3, Math.round(r * 0.32)))) continue;
      const stats = circleStats(analysis, x, y, r);
      if (settings.contourFirstMode && stats.boundarySupport < settings.minContourSupport * 0.35) continue;
      const radiusScore = Math.min(1, r / Math.max(1, maxRadius));
      const score =
        stats.boundarySupport * 0.5 +
        radiusScore * 0.35 +
        stats.maskCoverage * 0.12 -
        stats.outsidePenalty * 0.5 -
        settings.interiorFillPenaltyWeight * 0.25;
      peaks.push(makeCircle(`fill-${peaks.length}`, x, y, r, 'candidate', 'distance_peak', score, {
        ...stats,
        candidateKind: 'fill',
        contourSupport: stats.boundarySupport,
      }));
    }
  }
  return nmsCircles(peaks.sort((a, b) => b.score - a.score), settings.nmsDistance, Math.max(settings.maxFillCircles * 4, 8));
}

function generateBoundaryCandidates(
  analysis: ImageAnalysis,
  minRadius: number,
  maxRadius: number,
  settings: GeneratorSettings,
  points = getSimplifiedContourPoints(analysis, settings),
) {
  const candidates: CircleSpec[] = [];
  const indexedPoints = points.map((point, index) => ({ ...point, contourIndex: point.contourIndex ?? index }));
  const sourceSegments = analysis.contourSegments.length
    ? analysis.contourSegments.map((segment) => segment.map((index) => ({ ...analysis.contourPoints[index], contourIndex: index })))
    : [indexedPoints];
  for (const contourSegment of sourceSegments) {
    const segmentCandidates = makeSegmentWindows(contourSegment);
    for (const segment of segmentCandidates) {
      const fit = fitCircleLeastSquares(segment) ?? circleFromThreePoints(segment[0], segment[Math.floor(segment.length / 2)], segment[segment.length - 1]);
      if (!fit) continue;
      const metrics = computeArcMetrics(analysis, fit.x, fit.y, fit.radius, segment, settings);
      const rejectionReason = rejectArcCandidate(fit.radius, metrics, minRadius, maxRadius, settings);
      const stats = circleStats(analysis, fit.x, fit.y, fit.radius);
      const score = scoreInitialArcCandidate(fit.radius, metrics, stats, settings, analysis);
      candidates.push(makeCircle(`arc-${candidates.length}`, fit.x, fit.y, fit.radius, 'candidate', 'contour_fit', score, {
        ...stats,
        ...metrics,
        rejectionReason,
        candidateKind: 'arc',
      }));
    }
  }

  for (const segment of makeClosedContourWindows(indexedPoints)) {
    const fit = fitCircleLeastSquares(segment) ?? circleFromThreePoints(segment[0], segment[Math.floor(segment.length / 2)], segment[segment.length - 1]);
    if (!fit) continue;
    const metrics = computeArcMetrics(analysis, fit.x, fit.y, fit.radius, segment, settings);
    const rejectionReason = rejectArcCandidate(fit.radius, metrics, minRadius, maxRadius, settings);
    const stats = circleStats(analysis, fit.x, fit.y, fit.radius);
    const score = scoreInitialArcCandidate(fit.radius, metrics, stats, settings, analysis);
    candidates.push(makeCircle(`arc-${candidates.length}`, fit.x, fit.y, fit.radius, 'candidate', 'contour_fit', score, {
      ...stats,
      ...metrics,
      rejectionReason,
      candidateKind: 'arc',
    }));
  }

  const gap = Math.max(5, Math.round(indexedPoints.length / 60));
  for (let i = 0; i < indexedPoints.length - gap * 2; i += Math.max(3, Math.round(gap * 0.8))) {
    const fit = circleFromThreePoints(indexedPoints[i], indexedPoints[i + gap], indexedPoints[i + gap * 2]);
    if (!fit) continue;
    const segment = indexedPoints.slice(i, i + gap * 2 + 1);
    const metrics = computeArcMetrics(analysis, fit.x, fit.y, fit.radius, segment, settings);
    const rejectionReason = rejectArcCandidate(fit.radius, metrics, minRadius, maxRadius, settings);
    const stats = circleStats(analysis, fit.x, fit.y, fit.radius);
    const score = scoreInitialArcCandidate(fit.radius, metrics, stats, settings, analysis);
    candidates.push(makeCircle(`arc-${candidates.length}`, fit.x, fit.y, fit.radius, 'candidate', 'contour_fit', score, {
      ...stats,
      ...metrics,
      rejectionReason,
      candidateKind: 'arc',
    }));
  }

  const viable = candidates.filter((circle) => !circle.rejectionReason);
  const usable = [
    ...viable,
    ...candidates.filter((circle) => circle.rejectionReason && circle.rejectionReason !== 'too_small_radius'),
  ];
  return nmsCircles(usable.sort((a, b) => b.score - a.score), settings.nmsDistance * 0.25, settings.maxCircles * 8);
}

function greedyContourAdd(
  analysis: ImageAnalysis,
  arcCandidates: CircleSpec[],
  fillCandidates: CircleSpec[],
  settings: GeneratorSettings,
): AddSelectionResult {
  const selected: CircleSpec[] = [];
  const rejected = new Map<string, CircleSpec>();
  const covered = new Uint8Array(analysis.contourPoints.length);
  const steps: SelectionStepDebug[] = [];
  const masks = new Map<string, Uint8Array>();
  const current = new Uint8Array(analysis.mask.length);
  const totalContour = Math.max(1, analysis.contourPoints.length);
  const mainLimit = Math.min(settings.maxMainArcCircles, settings.maxAddCircles, settings.maxCircles);
  const contourTarget = clamp01(settings.targetContourCoverage);

  for (let step = 0; step < mainLimit; step += 1) {
    let best: { circle: CircleSpec; gain: number; score: number; newlyCovered: number; mask: Uint8Array } | null = null;
    for (const candidate of arcCandidates) {
      if (selected.some((circle) => circle.id === candidate.id)) continue;
      const mask = masks.get(candidate.id) ?? rasterizeCircle(candidate, analysis.width, analysis.height);
      masks.set(candidate.id, mask);
      const score = scoreArcCandidate(candidate, covered, current, mask, analysis, settings);
      const newlyCovered = countNewCoverage(candidate.coveredContourIndices, covered);
      const gain = score + newlyCovered / totalContour;
      if (!best || gain > best.gain) best = { circle: candidate, gain, score, newlyCovered, mask };
    }

    if (!best || best.score < -0.18 || best.newlyCovered < Math.max(2, totalContour * 0.01)) {
      if (best) rejected.set(best.circle.id, { ...best.circle, rejectionReason: 'poor_new_coverage' });
      break;
    }

    unionMaskInPlace(current, best.mask);
    for (const index of best.circle.coveredContourIndices) covered[index] = 1;
    selected.push({
      ...best.circle,
      role: 'add',
      usedInFinal: true,
      score: clamp01(best.score),
      selectedStep: step + 1,
      rejectionReason: undefined,
      candidateKind: 'arc',
    });
    const totalCoverage = coverageRatio(covered);
    steps.push({
      step: step + 1,
      candidateId: best.circle.id,
      gain: best.gain,
      newlyCoveredContourCount: best.newlyCovered,
      totalContourCoverage: totalCoverage,
      reason: 'long_arc_new_contour_coverage',
    });
    if (totalCoverage >= contourTarget) break;
  }

  const fillLimit = Math.max(0, Math.min(settings.maxFillCircles, settings.maxAddCircles - selected.length));
  for (let step = 0; step < fillLimit; step += 1) {
    let best: { circle: CircleSpec; gain: number; mask: Uint8Array } | null = null;
    const currentScore = scoreMask(current, analysis.mask, settings) * 0.15;
    for (const candidate of fillCandidates) {
      if (selected.some((circle) => circle.id === candidate.id)) continue;
      const mask = masks.get(candidate.id) ?? rasterizeCircle(candidate, analysis.width, analysis.height);
      masks.set(candidate.id, mask);
      const next = unionMask(current, mask);
      const score = scoreMask(next, analysis.mask, settings) * 0.15 + candidate.boundarySupport * 0.3 - settings.interiorFillPenaltyWeight * 0.12;
      const gain = score - currentScore;
      if (!best || gain > best.gain) best = { circle: candidate, gain, mask };
    }
    if (!best || best.gain < 0.025) break;
    unionMaskInPlace(current, best.mask);
    selected.push({
      ...best.circle,
      role: 'add',
      usedInFinal: true,
      selectedStep: selected.length + 1,
      candidateKind: 'fill',
    });
  }

  const selectedIds = new Set(selected.map((circle) => circle.id));
  for (const candidate of [...arcCandidates, ...fillCandidates]) {
    if (selectedIds.has(candidate.id) || rejected.has(candidate.id)) continue;
    const reason = candidate.rejectionReason ?? (candidate.candidateKind === 'fill' ? 'mostly_interior_fill' : 'not_selected');
    rejected.set(candidate.id, { ...candidate, rejectionReason: reason });
  }

  return { selected, rejected: [...rejected.values()], coverageMask: covered, steps };
}

function greedyFillAdd(analysis: ImageAnalysis, candidates: CircleSpec[], settings: GeneratorSettings): AddSelectionResult {
  const selected: CircleSpec[] = [];
  const current = new Uint8Array(analysis.mask.length);
  const covered = new Uint8Array(analysis.contourPoints.length);
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
    for (const index of best.circle.coveredContourIndices) covered[index] = 1;
    selected.push({ ...best.circle, role: 'add', score: clamp01(best.score), usedInFinal: true, selectedStep: step + 1 });
    used.add(candidates.indexOf(best.circle));
    currentScore = scoreMask(current, analysis.mask, settings);
  }

  return { selected, rejected: candidates.filter((circle) => !selected.some((picked) => picked.id === circle.id)).map((circle) => ({ ...circle, rejectionReason: 'not_selected' })), coverageMask: covered, steps: [] };
}

function generateSubtractCandidates(
  analysis: ImageAnalysis,
  addMask: Uint8Array,
  arcCandidates: CircleSpec[],
  selectedAdd: CircleSpec[],
  minRadius: number,
  maxRadius: number,
  settings: GeneratorSettings,
) {
  const overfill = makeOverfillMask(addMask, analysis.mask);
  const residual = generateResidualSubtractCandidates(analysis, overfill, minRadius, maxRadius, settings);
  const contour = generateContourSubtractCandidates(analysis, addMask, overfill, arcCandidates, selectedAdd, settings);
  return nmsCircles([...contour, ...residual].sort((a, b) => b.score - a.score), settings.nmsDistance, settings.maxSubtractCircles * 6);
}

function generateResidualSubtractCandidates(
  analysis: ImageAnalysis,
  overfill: Uint8Array,
  minRadius: number,
  maxRadius: number,
  settings: GeneratorSettings,
) {
  const dist = distanceTransform(overfill, analysis.width, analysis.height);
  const candidates: CircleSpec[] = [];
  const goodPenalty = settings.contourFirstMode ? 0.95 : 1.8;
  for (let y = 0; y < analysis.height; y += 2) {
    for (let x = 0; x < analysis.width; x += 2) {
      const i = y * analysis.width + x;
      const r = dist[i];
      if (r < minRadius || r > maxRadius) continue;
      if (!isLocalMaximum(dist, analysis.width, analysis.height, x, y, Math.max(2, Math.round(r * 0.25)))) continue;
      const circleMask = rasterizeCircleLike(x, y, r, analysis.width, analysis.height);
      const removesBad = overlapArea(circleMask, overfill);
      const removesGood = overlapArea(circleMask, analysis.mask);
      const goodRatio = removesGood / Math.max(1, areaOf(analysis.mask));
      if (goodRatio > settings.maxGoodRemovalRatio) continue;
      const score = removesBad / Math.max(1, removesBad + removesGood * goodPenalty);
      if (score < 0.12) continue;
      candidates.push(makeCircle(`subtract-residual-${candidates.length}`, x, y, r, 'candidate', 'residual_fit', score, {
        maskCoverage: removesBad / Math.max(1, areaOf(overfill)),
        outsidePenalty: goodRatio,
        boundarySupport: 0,
        candidateKind: 'subtract',
      }));
    }
  }
  return candidates;
}

function generateContourSubtractCandidates(
  analysis: ImageAnalysis,
  addMask: Uint8Array,
  overfill: Uint8Array,
  arcCandidates: CircleSpec[],
  selectedAdd: CircleSpec[],
  settings: GeneratorSettings,
) {
  const candidates: CircleSpec[] = [];
  const selectedAddIds = new Set(selectedAdd.map((circle) => circle.id));
  for (const arc of arcCandidates.slice(0, Math.max(12, settings.maxCircles * 4))) {
    if (selectedAddIds.has(arc.id)) continue;
    const circleMask = rasterizeCircle(arc, analysis.width, analysis.height);
    const removesBad = overlapArea(circleMask, overfill);
    const removesGood = overlapArea(circleMask, analysis.mask);
    const goodRatio = removesGood / Math.max(1, areaOf(analysis.mask));
    if (removesBad < Math.max(8, areaOf(overfill) * 0.015)) continue;
    if (goodRatio > settings.maxGoodRemovalRatio) continue;
    const next = subtractMask(addMask, circleMask);
    const before = scoreMask(addMask, analysis.mask, settings);
    const after = scoreMask(next, analysis.mask, settings);
    const boundaryBonus = arc.arcLength / Math.max(1, Math.hypot(analysis.width, analysis.height));
    const score = (after - before) * 0.35 + removesBad / Math.max(1, areaOf(overfill)) * 0.5 + boundaryBonus * 0.15 - goodRatio * 0.7;
    if (score < 0.02) continue;
    candidates.push(makeCircle(`subtract-contour-${candidates.length}`, arc.centerX, arc.centerY, arc.radius, 'candidate', 'contour_fit', score, {
      ...arc,
      role: 'subtract',
      usedInFinal: false,
      score,
      outsidePenalty: goodRatio,
      maskCoverage: removesBad / Math.max(1, areaOf(overfill)),
      candidateKind: 'subtract',
    }));
  }
  return candidates;
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
      const score = scoreMask(next, analysis.mask, settings) * (settings.contourFirstMode ? 0.35 : 1) + candidates[i].score * 0.65 - countPenalty(step, settings) * 0.45;
      const gain = score - currentScore * (settings.contourFirstMode ? 0.35 : 1);
      if (!best || gain > best.gain) best = { circle: candidates[i], mask: masks[i], score, gain };
    }
    if (!best || best.gain < 0.005) break;
    subtractMaskInPlace(current, best.mask);
    selected.push({ ...best.circle, role: 'subtract', score: clamp01(best.score), usedInFinal: true, selectedStep: step + 1, candidateKind: 'subtract' });
    used.add(candidates.indexOf(best.circle));
    currentScore = scoreMask(current, analysis.mask, settings);
  }
  return selected;
}

function scoreArcCandidate(
  candidate: CircleSpec,
  coveredContour: Uint8Array,
  currentMask: Uint8Array,
  candidateMask: Uint8Array,
  analysis: ImageAnalysis,
  settings: GeneratorSettings,
) {
  const totalContour = Math.max(1, analysis.contourPoints.length);
  const newlyCovered = countNewCoverage(candidate.coveredContourIndices, coveredContour);
  const newContourCoverage = newlyCovered / totalContour;
  const diagonal = Math.hypot(analysis.width, analysis.height);
  const arcLengthScore = clamp01(candidate.arcLength / Math.max(1, diagonal * 0.42));
  const radiusScore = clamp01(candidate.radius / Math.max(1, settings.maxRadius)) * settings.largeRadiusPreference;
  const fitErrorPenalty = clamp01(candidate.fitError / Math.max(2.5, candidate.radius * 0.06));
  const contourSupportScore = clamp01(candidate.contourSupport / Math.max(settings.minContourSupport, 0.01));
  const interiorFillPenalty = clamp01((candidate.maskCoverage - candidate.contourSupport) * settings.interiorFillPenaltyWeight);
  const redundancy = 1 - newlyCovered / Math.max(1, candidate.coveredContourIndices.length);
  const smallCirclePenalty = clamp01((settings.minRadius * 2.4 - candidate.radius) / Math.max(1, settings.minRadius * 2.4));
  const areaScore = scoreMask(unionMask(currentMask, candidateMask), analysis.mask, settings);

  return (
    newContourCoverage * 3.2 +
    arcLengthScore * 0.85 +
    radiusScore * 0.5 +
    contourSupportScore * 0.75 +
    areaScore * 0.12 -
    fitErrorPenalty * 0.8 -
    interiorFillPenalty * 0.55 -
    redundancy * 0.45 -
    smallCirclePenalty * 0.9
  );
}

function scoreInitialArcCandidate(
  radius: number,
  metrics: ArcMetrics,
  stats: CandidateStats,
  settings: GeneratorSettings,
  analysis: ImageAnalysis,
) {
  const diagonal = Math.hypot(analysis.width, analysis.height);
  return (
    clamp01(metrics.arcLength / Math.max(1, diagonal * 0.35)) * 0.85 +
    clamp01(radius / Math.max(1, settings.maxRadius)) * settings.largeRadiusPreference * 0.35 +
    clamp01(metrics.contourSupport / Math.max(0.01, settings.minContourSupport)) * 0.8 -
    clamp01(metrics.fitError / Math.max(2, radius * 0.06)) * 0.75 -
    stats.outsidePenalty * 0.08
  );
}

function rejectArcCandidate(
  radius: number,
  metrics: ArcMetrics,
  minRadius: number,
  maxRadius: number,
  settings: GeneratorSettings,
): RejectionReason | undefined {
  if (radius < Math.max(minRadius, settings.minRadius)) return 'too_small_radius';
  if (radius > maxRadius * 2.1) return 'high_fit_error';
  if (metrics.arcLength < settings.minArcLength) return 'too_short_arc';
  if (metrics.contourSupport < settings.minContourSupport) return 'low_contour_support';
  if (metrics.fitError > Math.max(6, radius * 0.14)) return 'high_fit_error';
  if (metrics.coveredContourIndices.length < 4) return 'poor_new_coverage';
  return undefined;
}

function computeArcMetrics(
  analysis: ImageAnalysis,
  cx: number,
  cy: number,
  radius: number,
  segment: IndexedPoint[],
  settings: GeneratorSettings,
): ArcMetrics {
  const tolerance = Math.max(2.5, radius * 0.045);
  const segmentErrors = segment.map((point) => Math.abs(Math.hypot(point.x - cx, point.y - cy) - radius));
  const fitError = Math.sqrt(segmentErrors.reduce((sum, value) => sum + value * value, 0) / Math.max(1, segmentErrors.length));
  const supportPoints = segment.filter((point, index) => segmentErrors[index] <= tolerance);
  const coveredContourIndices = new Set<number>();
  const coveragePoints = supportPoints.length >= Math.max(4, segment.length * 0.35) ? supportPoints : segment;
  for (const point of coveragePoints) coveredContourIndices.add(point.contourIndex);

  const anglePoints = coveragePoints.length >= 2 ? coveragePoints : segment;
  const angles = anglePoints.map((point) => normalizeAngle((Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI));
  const range = minimalAngleRange(angles);
  const span = angleSpan(range.startAngle, range.endAngle);
  const arcLength = (span / 360) * Math.PI * 2 * radius;
  const contourSupport = coveredContourIndices.size / Math.max(1, analysis.contourPoints.length);
  return {
    startAngle: range.startAngle,
    endAngle: range.endAngle,
    arcLength,
    fitError,
    contourSupport,
    coveredContourIndices: [...coveredContourIndices],
    rejectionReason: arcLength < settings.minArcLength ? 'too_short_arc' : undefined,
  };
}

function fitCircleLeastSquares(points: Point[]): { x: number; y: number; radius: number } | null {
  if (points.length < 3) return null;
  let sumX = 0;
  let sumY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  let sumXY = 0;
  let sumX3 = 0;
  let sumY3 = 0;
  let sumX1Y2 = 0;
  let sumX2Y1 = 0;
  for (const point of points) {
    const x2 = point.x * point.x;
    const y2 = point.y * point.y;
    sumX += point.x;
    sumY += point.y;
    sumX2 += x2;
    sumY2 += y2;
    sumXY += point.x * point.y;
    sumX3 += x2 * point.x;
    sumY3 += y2 * point.y;
    sumX1Y2 += point.x * y2;
    sumX2Y1 += x2 * point.y;
  }
  const n = points.length;
  const c = n * sumX2 - sumX * sumX;
  const d = n * sumXY - sumX * sumY;
  const e = n * (sumX3 + sumX1Y2) - (sumX2 + sumY2) * sumX;
  const g = n * sumY2 - sumY * sumY;
  const h = n * (sumX2Y1 + sumY3) - (sumX2 + sumY2) * sumY;
  const denominator = c * g - d * d;
  if (Math.abs(denominator) < 0.001) return null;
  const x = (e * g - h * d) / (2 * denominator);
  const y = (c * h - d * e) / (2 * denominator);
  const radius = points.reduce((sum, point) => sum + distance({ x, y }, point), 0) / n;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius)) return null;
  return { x, y, radius };
}

function circularSlice(points: IndexedPoint[], start: number, size: number) {
  const out: IndexedPoint[] = [];
  for (let offset = 0; offset < size; offset += 1) out.push(points[(start + offset) % points.length]);
  return out;
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
  const fidelity = settings.contourFirstMode ? 0.2 : settings.simplicity / 100;
  const beta = 0.72 + (1 - fidelity) * 0.38;
  const beta2 = beta * beta;
  const fScore = precision + recall === 0 ? 0 : ((1 + beta2) * precision * recall) / (beta2 * precision + recall);
  const weight = settings.contourFirstMode ? 0.12 : 1;
  return (fScore - (falsePositive / Math.max(1, predicted)) * (0.18 + fidelity * 0.5)) * weight;
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
    const angle = normalizeAngle((Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI);
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

function simplifyPoints(points: Point[], stride: number): IndexedPoint[] {
  const selected: IndexedPoint[] = [];
  const step = Math.max(1, stride);
  for (let index = 0; index < points.length; index += step) {
    const point = points[index] as IndexedPoint;
    selected.push({ ...point, contourIndex: point.contourIndex ?? index });
  }
  return selected;
}

function getSimplifiedContourPoints(analysis: ImageAnalysis, settings: GeneratorSettings) {
  return simplifyPoints(analysis.contourPoints, Math.max(1, Math.round(5 - settings.simplicity / 28)));
}

function makeSegmentWindows(segment: IndexedPoint[]) {
  const windows: IndexedPoint[][] = [];
  if (segment.length < 4) return windows;
  windows.push(segment);
  const sizes = [8, 12, 18, 28, 42, 60].filter((size) => size < segment.length);
  for (const size of sizes) {
    const step = Math.max(2, Math.round(size / 2));
    for (let start = 0; start <= segment.length - size; start += step) {
      windows.push(segment.slice(start, start + size));
    }
  }
  return windows;
}

function makeClosedContourWindows(points: IndexedPoint[]) {
  const windows: IndexedPoint[][] = [];
  if (points.length < 8) return windows;
  const sizes = [10, 14, 18, 24, 32, 44, 60, 80].filter((size) => size < points.length * 0.85);
  for (const size of sizes) {
    const step = Math.max(3, Math.round(size / 3));
    for (let start = 0; start < points.length; start += step) {
      const window: IndexedPoint[] = [];
      for (let offset = 0; offset < size; offset += 1) {
        window.push(points[(start + offset) % points.length]);
      }
      windows.push(window);
    }
  }
  return windows;
}

function pointsToMask(points: Point[], width: number, height: number) {
  const mask = new Uint8Array(width * height);
  for (const point of points) {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x] = 1;
  }
  return mask;
}

function segmentsToMask(points: Point[], segments: number[][], width: number, height: number) {
  const mask = new Uint8Array(width * height);
  segments.forEach((segment, segmentIndex) => {
    for (const pointIndex of segment) {
      const point = points[pointIndex];
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x] = (segmentIndex % 3) + 1;
    }
  });
  return mask;
}

function makeOverfillMask(current: Uint8Array, target: Uint8Array) {
  const overfill = new Uint8Array(current.length);
  for (let i = 0; i < current.length; i += 1) overfill[i] = current[i] && !target[i] ? 1 : 0;
  return overfill;
}

function contourCoverageToMask(analysis: ImageAnalysis, covered: Uint8Array) {
  const mask = new Uint8Array(analysis.width * analysis.height);
  for (let index = 0; index < analysis.contourPoints.length; index += 1) {
    if (!covered[index]) continue;
    const point = analysis.contourPoints[index];
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    if (x >= 0 && x < analysis.width && y >= 0 && y < analysis.height) mask[y * analysis.width + x] = 1;
  }
  return mask;
}

function countNewCoverage(indices: number[], covered: Uint8Array) {
  let count = 0;
  for (const index of indices) if (!covered[index]) count += 1;
  return count;
}

function coverageRatio(covered: Uint8Array) {
  let count = 0;
  for (const value of covered) count += value;
  return count / Math.max(1, covered.length);
}

function circleToDebugRow(circle: CircleSpec): CircleDebugRow {
  return {
    id: circle.id,
    role: circle.role,
    cx: circle.centerX,
    cy: circle.centerY,
    r: circle.radius,
    source: circle.source,
    startAngle: circle.startAngle,
    endAngle: circle.endAngle,
    arcLength: circle.arcLength,
    fitError: circle.fitError,
    contourSupport: circle.contourSupport,
    coveredContourCount: circle.coveredContourIndices.length,
    score: circle.score,
    usedInFinal: circle.usedInFinal,
    boundarySupport: circle.boundarySupport,
    outsidePenalty: circle.outsidePenalty,
    selectedStep: circle.selectedStep,
    candidateKind: circle.candidateKind,
    rejectionReason: circle.rejectionReason,
    initialRole: circle.initialRole,
    finalRole: circle.finalRole,
    scoreContribution: circle.scoreContribution,
    changedInOptimization: circle.changedInOptimization,
  };
}

function circleFromThreePoints(a: Point, b: Point, c: Point): { x: number; y: number; radius: number } | null {
  if (distance(a, b) < 4 || distance(b, c) < 4 || distance(a, c) < 8) return null;
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
      const angle = normalizeAngle((Math.atan2(y - circle.centerY, x - circle.centerX) * 180) / Math.PI);
      bins[Math.floor((angle / 360) * bins.length)] = 1;
    }
  }
  let count = 0;
  for (const bin of bins) count += bin;
  return count / bins.length;
}

function minimalAngleRange(angles: number[]) {
  if (angles.length === 0) return { startAngle: 0, endAngle: 360 };
  const sorted = [...angles].sort((a, b) => a - b);
  let biggestGap = -1;
  let gapIndex = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[(i + 1) % sorted.length] + (i === sorted.length - 1 ? 360 : 0);
    const gap = next - current;
    if (gap > biggestGap) {
      biggestGap = gap;
      gapIndex = i;
    }
  }
  const startAngle = normalizeAngle(sorted[(gapIndex + 1) % sorted.length]);
  const endAngle = normalizeAngle(sorted[gapIndex]);
  return { startAngle, endAngle };
}

function angleSpan(startAngle: number, endAngle: number) {
  const span = (endAngle - startAngle + 360) % 360;
  return span === 0 ? 360 : span;
}

function normalizeAngle(angle: number) {
  return ((angle % 360) + 360) % 360;
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
    arcLength: partial.arcLength ?? 0,
    fitError: partial.fitError ?? 0,
    contourSupport: partial.contourSupport ?? partial.boundarySupport ?? 0,
    coveredContourIndices: partial.coveredContourIndices ?? [],
    maskCoverage: partial.maskCoverage ?? 0,
    outsidePenalty: partial.outsidePenalty ?? 0,
    score,
    scoreContribution: partial.scoreContribution,
    source,
    initialRole: partial.initialRole,
    finalRole: partial.finalRole,
    changedInOptimization: partial.changedInOptimization,
    rejectionReason: partial.rejectionReason,
    selectedStep: partial.selectedStep,
    candidateKind: partial.candidateKind ?? (role === 'helper' || role === 'boundary' ? 'helper' : role === 'subtract' ? 'subtract' : 'arc'),
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
