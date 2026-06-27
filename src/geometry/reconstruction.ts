import type {
  ArcGraphEdge,
  ArcGraphNode,
  ArcIntersection,
  ArcLoopSegment,
  ArcSpec,
  CircleSpec,
  ConstructionData,
  FaceCandidate,
  FaceDebugSummary,
  ImageAnalysis,
  Point,
  RegionCondition,
  SplitArcPiece,
} from './types';

export function buildConstruction(
  analysis: ImageAnalysis,
  circles: CircleSpec[],
): ConstructionData {
  const contourChain = buildContourOrderedArcChain(analysis, circles);
  const selectedLoopIds = contourChain.faces.filter((face) => face.selected).map((face) => face.id);
  const conditions: RegionCondition[] = [];
  const expression = selectedLoopIds.length > 0
    ? `Fill inside closed circular arc loops: ${selectedLoopIds.join(', ')}`
    : 'No closed circular arc loop selected.';
  const finalShape = {
    type: 'arc_loop_fill' as const,
    expression: 'selected circular arcs -> closed arc loops -> fill inside loops' as const,
    loopIds: selectedLoopIds,
  };
  return {
    width: analysis.width,
    height: analysis.height,
    circles: contourChain.circles,
    arcs: contourChain.arcs,
    finalShape,
    intersections: contourChain.intersections,
    splitArcPieces: contourChain.splitArcPieces,
    graphNodes: contourChain.graphNodes,
    graphEdges: contourChain.graphEdges,
    faces: contourChain.faces,
    faceDebug: contourChain.faceDebug,
    conditions,
    expression,
    generatedAt: new Date().toISOString(),
  };
}

function buildContourOrderedArcChain(analysis: ImageAnalysis, helperCircles: CircleSpec[]) {
  const contourCircles: CircleSpec[] = [];
  const arcs: ArcSpec[] = [];
  const splitArcPieces: SplitArcPiece[] = [];
  const graphNodes: ArcGraphNode[] = [];
  const graphEdges: ArcGraphEdge[] = [];
  const faces: FaceCandidate[] = [];
  const sourceLoops = analysis.contourLoops.length
    ? analysis.contourLoops
    : [{ id: 'component-1', points: analysis.contourPoints, segments: analysis.contourSegments, bounds: analysis.bounds, area: analysis.mask.reduce((sum, value) => sum + value, 0) }];

  sourceLoops.forEach((loop, loopIndex) => {
    const prefix = `L${loopIndex + 1}`;
    const segments = makeContourArcSegments(loop.points, loop.segments);
    const arcPieces: ArcLoopSegment[] = [];
    segments.forEach((indices, segmentIndex) => {
      const points = pointsForContourSegment(loop.points, indices);
      if (points.length < 3) return;
      const fit = fitCircleToPoints(points) ?? fallbackCircleForPoints(points);
      const startPoint = points[0];
      const endPoint = points[points.length - 1];
      const startAngle = pointAngleFromCenter(startPoint, fit.cx, fit.cy);
      const endAngle = pointAngleFromCenter(endPoint, fit.cx, fit.cy);
      const middleAngle = pointAngleFromCenter(points[Math.floor(points.length / 2)], fit.cx, fit.cy);
      const direction: 'cw' | 'ccw' = angleInArc(middleAngle, startAngle, endAngle) ? 'ccw' : 'cw';
      const span = direction === 'ccw' ? angleSpan(startAngle, endAngle) : angleSpan(endAngle, startAngle);
      const arcLength = (span / 360) * Math.PI * 2 * fit.r;
      const contourSupport = points.length / Math.max(1, loop.points.length);
      const circleId = `OC${loopIndex + 1}-${segmentIndex + 1}`;
      const arcId = `OA${loopIndex + 1}-${segmentIndex + 1}`;
      const pieceId = `OP${loopIndex + 1}-${segmentIndex + 1}`;
      const circle: CircleSpec = {
        id: circleId,
        cx: fit.cx,
        cy: fit.cy,
        r: fit.r,
        centerX: fit.cx,
        centerY: fit.cy,
        radius: fit.r,
        role: 'boundary',
        visible: true,
        usedInFinal: true,
        startAngle,
        endAngle,
        boundarySupport: contourSupport,
        arcLength,
        fitError: fit.error,
        contourSupport,
        coveredContourIndices: indices,
        maskCoverage: 0,
        outsidePenalty: fit.error,
        score: Math.max(0, 1 - fit.error / Math.max(1, fit.r)),
        source: 'contour_fit',
        candidateKind: 'arc',
        equation: `(x - ${fit.cx.toFixed(1)})^2 + (y - ${fit.cy.toFixed(1)})^2 = ${fit.r.toFixed(1)}^2`,
      };
      contourCircles.push(circle);
      arcs.push({ id: arcId, circleId, startAngle, endAngle, usedInSilhouette: true, usedAsHelperOnly: false });
      const startNode = `${prefix}-N${segmentIndex + 1}`;
      const endNode = `${prefix}-N${((segmentIndex + 1) % segments.length) + 1}`;
      const segment: ArcLoopSegment = {
        id: pieceId,
        circleId,
        cx: fit.cx,
        cy: fit.cy,
        r: fit.r,
        startAngle,
        endAngle,
        startPoint,
        endPoint,
        direction,
        contourSupport,
        fitError: fit.error,
      };
      const sampledPoints = sampleArcLoopSegment(segment);
      const piece: SplitArcPiece = {
        id: pieceId,
        parentArcId: arcId,
        parentCircleId: circleId,
        sourceArcId: arcId,
        startNode,
        endNode,
        startPoint,
        endPoint,
        startAngle,
        endAngle,
        midpoint: sampledPoints[Math.floor(sampledPoints.length / 2)],
        length: polylineLength(sampledPoints),
        selectedAsBoundary: true,
        points: sampledPoints,
      };
      splitArcPieces.push(piece);
      graphEdges.push({ id: `${prefix}-E${segmentIndex + 1}`, startNode, endNode, sourceArcId: arcId, sourcePieceId: pieceId, direction, points: sampledPoints });
      arcPieces.push(segment);
    });

    for (let i = 0; i < segments.length; i += 1) {
      const point = loop.points[segments[i][0] ?? 0] ?? { x: 0, y: 0 };
      graphNodes.push({
        id: `${prefix}-N${i + 1}`,
        x: point.x,
        y: point.y,
        incidentEdges: [`${prefix}-E${((i - 1 + segments.length) % segments.length) + 1}`, `${prefix}-E${i + 1}`],
      });
    }

    const polygon = arcPieces.flatMap((piece, index) => {
      const points = sampleArcLoopSegment(piece);
      return index === 0 ? points : points.slice(1);
    });
    const signedArea = polygon.length >= 3 ? polygonArea(polygon) : 0;
    const area = Math.abs(signedArea);
    const centroid = polygon.length >= 3 ? polygonCentroid(polygon) : analysis.centroid;
    const insideMaskScore = sampleFaceInsideMask(analysis, polygon, centroid);
    const closureGap = arcPieces.length > 1
      ? Math.hypot(arcPieces[0].startPoint.x - arcPieces[arcPieces.length - 1].endPoint.x, arcPieces[0].startPoint.y - arcPieces[arcPieces.length - 1].endPoint.y)
      : Number.POSITIVE_INFINITY;
    const rejectionReason =
      arcPieces.length < 3 ? 'invalid_loop'
        : closureGap > 14 ? 'invalid_loop'
          : area <= 24 ? 'tiny_face_noise'
            : insideMaskScore < 0.35 ? 'low_inside_mask_score'
              : undefined;
    faces.push({
      id: `contour-loop-${loopIndex + 1}`,
      source: 'vector_loop',
      edgeIds: arcPieces.map((piece) => piece.id),
      arcPieces,
      polygon,
      samplePoints: sampleFacePoints(polygon, centroid),
      area,
      centroid,
      numEdges: arcPieces.length,
      insideMaskScore,
      winding: signedArea >= 0 ? 'ccw' : 'cw',
      nestingDepth: 0,
      selected: !rejectionReason,
      rejectionReason,
    });
  });
  assignFaceNesting(faces);
  const helperOnlyCircles = helperCircles.map((circle) => ({
    ...circle,
    role: circle.role === 'candidate' ? 'helper' as const : circle.role,
    usedInFinal: false,
  }));
  const faceDebug: FaceDebugSummary = {
    totalArcPieces: splitArcPieces.length,
    validBoundaryArcPieces: splitArcPieces.length,
    graphNodesCount: graphNodes.length,
    graphEdgesCount: graphEdges.length,
    closedLoopsCount: faces.length,
    faceCandidatesCount: faces.length,
    selectedFacesCount: faces.filter((face) => face.selected).length,
    fallbackUsed: false,
    emptyReason: faces.some((face) => face.selected) ? undefined : 'mask_sampling_failed',
  };
  return {
    circles: [...contourCircles, ...helperOnlyCircles],
    arcs,
    intersections: [] as ArcIntersection[],
    splitArcPieces,
    graphNodes,
    graphEdges,
    faces,
    faceDebug,
  };
}

function makeContourArcSegments(contour: Point[], contourSegments: number[][]) {
  if (contour.length < 12) return [contour.map((_, index) => index)];
  const targetSegmentCount = Math.max(8, Math.min(18, Math.round(contour.length / 6)));
  const baseSegments = contourSegments.length >= 6
    ? contourSegments
    : chunkContourIndices(contour.length, targetSegmentCount);
  const out: number[][] = [];
  const maxSegmentLength = Math.max(5, Math.round(contour.length / targetSegmentCount));
  for (const segment of baseSegments) {
    if (segment.length <= maxSegmentLength) {
      out.push(segment);
      continue;
    }
    const chunks = Math.ceil(segment.length / maxSegmentLength);
    const size = Math.ceil(segment.length / chunks);
    for (let i = 0; i < segment.length; i += size) {
      const chunk = segment.slice(i, i + size);
      if (chunk.length >= 4) out.push(chunk);
    }
  }
  return out.length >= 6 ? out : chunkContourIndices(contour.length, targetSegmentCount);
}

function chunkContourIndices(length: number, count: number) {
  return Array.from({ length: count }, (_, chunkIndex) => {
    const start = Math.round((chunkIndex / count) * length);
    const end = Math.round(((chunkIndex + 1) / count) * length);
    const indices: number[] = [];
    for (let i = start; i < end; i += 1) indices.push(i % length);
    return indices;
  }).filter((segment) => segment.length >= 4);
}

function pointsForContourSegment(contour: Point[], indices: number[]) {
  const points = indices.map((index) => contour[index]).filter(Boolean);
  if (indices.length > 0) {
    const nextIndex = (indices[indices.length - 1] + 1) % contour.length;
    points.push(contour[nextIndex]);
  }
  return points;
}

function fitCircleToPoints(points: Point[]) {
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  let sumXXX = 0;
  let sumYYY = 0;
  let sumXYY = 0;
  let sumXXY = 0;
  for (const point of points) {
    const x = point.x;
    const y = point.y;
    const xx = x * x;
    const yy = y * y;
    sumX += x;
    sumY += y;
    sumXX += xx;
    sumYY += yy;
    sumXY += x * y;
    sumXXX += xx * x;
    sumYYY += yy * y;
    sumXYY += x * yy;
    sumXXY += xx * y;
  }
  const n = points.length;
  const solution = solve3x3(
    [
      [sumXX, sumXY, sumX],
      [sumXY, sumYY, sumY],
      [sumX, sumY, n],
    ],
    [-(sumXXX + sumXYY), -(sumXXY + sumYYY), -(sumXX + sumYY)],
  );
  if (!solution) return undefined;
  const [a, b, c] = solution;
  const cx = -a / 2;
  const cy = -b / 2;
  const r2 = cx * cx + cy * cy - c;
  if (!Number.isFinite(r2) || r2 <= 1) return undefined;
  const r = Math.sqrt(r2);
  const error = points.reduce((sum, point) => sum + Math.abs(Math.hypot(point.x - cx, point.y - cy) - r), 0) / points.length;
  if (!Number.isFinite(error)) return undefined;
  return { cx, cy, r, error };
}

function fallbackCircleForPoints(points: Point[]) {
  const first = points[0];
  const middle = points[Math.floor(points.length / 2)];
  const last = points[points.length - 1];
  const fit = circleThroughThreePoints(first, middle, last);
  if (fit) {
    const error = points.reduce((sum, point) => sum + Math.abs(Math.hypot(point.x - fit.cx, point.y - fit.cy) - fit.r), 0) / points.length;
    return { ...fit, error };
  }
  const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const r = Math.max(4, points.reduce((sum, point) => sum + Math.hypot(point.x - cx, point.y - cy), 0) / points.length);
  return { cx, cy, r, error: r };
}

function solve3x3(matrix: number[][], vector: number[]) {
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return undefined;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let i = col; i < 4; i += 1) a[col][i] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let i = col; i < 4; i += 1) a[row][i] -= factor * a[col][i];
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

function pointAngleFromCenter(point: Point, cx: number, cy: number) {
  return normalizeAngle((Math.atan2(point.y - cy, point.x - cx) * 180) / Math.PI);
}

function buildArcFaces(analysis: ImageAnalysis, circles: CircleSpec[], arcs: ArcSpec[]) {
  const selectedArcs = arcs
    .map((arc) => ({ arc, circle: circles.find((circle) => circle.id === arc.circleId) }))
    .filter((item): item is { arc: ArcSpec; circle: CircleSpec } => Boolean(item.circle && (item.arc.usedInSilhouette || item.arc.usedAsHelperOnly)))
    .sort((a, b) => contourOrder(a.circle) - contourOrder(b.circle));

  const intersections = computeArcIntersections(selectedArcs);
  const nodes: ArcGraphNode[] = [];
  const edges: ArcGraphEdge[] = [];
  const splitArcPieces: SplitArcPiece[] = [];
  const snapTolerance = Math.max(4, Math.min(14, Math.min(analysis.width, analysis.height) * 0.018));
  const nodeFor = (point: Point) => {
    const existing = nodes.find((node) => Math.hypot(node.x - point.x, node.y - point.y) <= snapTolerance);
    if (existing) return existing.id;
    const id = `N${nodes.length + 1}`;
    nodes.push({ id, x: point.x, y: point.y, incidentEdges: [] });
    return id;
  };

  for (const { arc, circle } of selectedArcs) {
    const splitAngles = splitAnglesForArc(arc, circle, intersections);
    for (let i = 0; i < splitAngles.length - 1; i += 1) {
      const startAngle = splitAngles[i];
      const endAngle = splitAngles[i + 1];
      const rawPoints = sampleArc(circle, startAngle, endAngle);
      const points = orientArcToContour(rawPoints, circle, analysis);
      if (points.length < 2) continue;
      const startPoint = points[0];
      const endPoint = points[points.length - 1];
      const midpoint = points[Math.floor(points.length / 2)];
      const length = polylineLength(points);
      const boundary = classifyBoundaryPiece(analysis, circle, midpoint);
      const selectedAsBoundary = boundary.selected || circle.usedInFinal || (circle.contourSupport > 0.02 && circle.arcLength > 8);
      const startNode = nodeFor(startPoint);
      const endNode = nodeFor(endPoint);
      const piece: SplitArcPiece = {
        id: `P${splitArcPieces.length + 1}`,
        parentArcId: arc.id,
        parentCircleId: circle.id,
        sourceArcId: arc.id,
        startNode,
        endNode,
        startPoint,
        endPoint,
        startAngle,
        endAngle,
        midpoint,
        length,
        selectedAsBoundary,
        rejectionReason: selectedAsBoundary ? undefined : 'not_boundary_piece',
        points,
      };
      splitArcPieces.push(piece);
      if (!piece.selectedAsBoundary) continue;
      const edgeId = `E${edges.length + 1}`;
      edges.push({ id: edgeId, startNode, endNode, sourceArcId: arc.id, sourcePieceId: piece.id, direction: 'ccw', points });
      nodes.find((node) => node.id === startNode)?.incidentEdges.push(edgeId);
      nodes.find((node) => node.id === endNode)?.incidentEdges.push(edgeId);
    }
  }

  const pieceById = new Map(splitArcPieces.map((piece) => [piece.id, piece]));
  const circleById = new Map(circles.map((circle) => [circle.id, circle]));
  const vectorFaces = extractArcLoopFaces(analysis, edges, pieceById, circleById);
  const stitchedFaces = vectorFaces.some((face) => face.selected)
    ? []
    : buildStitchedArcLoopFace(analysis, splitArcPieces, circleById);
  const faces = [...vectorFaces, ...stitchedFaces];
  const selectedFacesCount = faces.filter((face) => face.selected).length;
  const emptyReason = makeFaceEmptyReason(vectorFaces, faces, edges);
  const faceDebug: FaceDebugSummary = {
    totalArcPieces: splitArcPieces.length,
    validBoundaryArcPieces: splitArcPieces.filter((piece) => piece.selectedAsBoundary).length,
    graphNodesCount: nodes.length,
    graphEdgesCount: edges.length,
    closedLoopsCount: faces.length,
    faceCandidatesCount: faces.length,
    selectedFacesCount,
    fallbackUsed: false,
    emptyReason,
  };
  return { intersections, splitArcPieces, graphNodes: nodes, graphEdges: edges, faces, faceDebug };
}

function contourOrder(circle: CircleSpec) {
  if (!circle.coveredContourIndices.length) return Number.POSITIVE_INFINITY;
  return Math.min(...circle.coveredContourIndices);
}

function computeArcIntersections(items: Array<{ arc: ArcSpec; circle: CircleSpec }>): ArcIntersection[] {
  const out: ArcIntersection[] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const points = circleCircleIntersections(items[i].circle, items[j].circle);
      for (const point of points) {
        if (!angleInArc(pointAngle(point, items[i].circle), items[i].arc.startAngle, items[i].arc.endAngle)) continue;
        if (!angleInArc(pointAngle(point, items[j].circle), items[j].arc.startAngle, items[j].arc.endAngle)) continue;
        out.push({ id: `I${out.length + 1}`, x: point.x, y: point.y, arcIds: [items[i].arc.id, items[j].arc.id] });
      }
    }
  }
  return out;
}

function splitAnglesForArc(arc: ArcSpec, circle: CircleSpec, intersections: ArcIntersection[]) {
  const angles = [arc.startAngle, arc.endAngle];
  for (const intersection of intersections) {
    if (!intersection.arcIds.includes(arc.id)) continue;
    const angle = pointAngle(intersection, circle);
    if (angleInArc(angle, arc.startAngle, arc.endAngle)) angles.push(angle);
  }
  const start = arc.startAngle;
  const span = angleSpan(arc.startAngle, arc.endAngle);
  const ordered = [...new Set(angles.map((angle) => Number(normalizeAngle(angle).toFixed(4))))]
    .sort((a, b) => normalizeAngle(a - start) - normalizeAngle(b - start))
    .filter((angle) => normalizeAngle(angle - start) <= span + 0.001);
  if (span >= 359.999) {
    const interior = ordered.filter((angle) => normalizeAngle(angle - start) > 0.001);
    return [arc.startAngle, ...interior, arc.startAngle + 360];
  }
  return ordered;
}

function circleCircleIntersections(a: CircleSpec, b: CircleSpec): Point[] {
  const dx = b.centerX - a.centerX;
  const dy = b.centerY - a.centerY;
  const d = Math.hypot(dx, dy);
  if (d < 0.001 || d > a.radius + b.radius || d < Math.abs(a.radius - b.radius)) return [];
  const along = (a.radius * a.radius - b.radius * b.radius + d * d) / (2 * d);
  const h2 = a.radius * a.radius - along * along;
  if (h2 < 0) return [];
  const h = Math.sqrt(h2);
  const xm = a.centerX + (along * dx) / d;
  const ym = a.centerY + (along * dy) / d;
  const rx = (-dy * h) / d;
  const ry = (dx * h) / d;
  return [{ x: xm + rx, y: ym + ry }, { x: xm - rx, y: ym - ry }];
}

function sampleArc(circle: CircleSpec, startAngle: number, endAngle: number): Point[] {
  const span = angleSpan(startAngle, endAngle);
  const steps = Math.max(8, Math.ceil((span / 360) * Math.PI * 2 * circle.radius / 8));
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = normalizeAngle(startAngle + (span * i) / steps);
    const radians = (angle * Math.PI) / 180;
    points.push({ x: circle.centerX + Math.cos(radians) * circle.radius, y: circle.centerY + Math.sin(radians) * circle.radius });
  }
  return points;
}

function classifyBoundaryPiece(analysis: ImageAnalysis, circle: CircleSpec, midpoint: Point) {
  const nx = (midpoint.x - circle.centerX) / Math.max(1, circle.radius);
  const ny = (midpoint.y - circle.centerY) / Math.max(1, circle.radius);
  const offset = 3;
  const a = sampleMask(analysis, { x: midpoint.x + nx * offset, y: midpoint.y + ny * offset });
  const b = sampleMask(analysis, { x: midpoint.x - nx * offset, y: midpoint.y - ny * offset });
  return { selected: a !== b, insideA: a, insideB: b };
}

function sampleMask(analysis: ImageAnalysis, point: Point) {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  return x >= 0 && x < analysis.width && y >= 0 && y < analysis.height && analysis.mask[y * analysis.width + x] === 1;
}

function extractArcLoopFaces(
  analysis: ImageAnalysis,
  edges: ArcGraphEdge[],
  pieceById: Map<string, SplitArcPiece>,
  circleById: Map<string, CircleSpec>,
): FaceCandidate[] {
  type DirectedEdge = {
    id: string;
    baseId: string;
    sourcePieceId: string;
    startNode: string;
    endNode: string;
    direction: 'cw' | 'ccw';
    points: Point[];
  };

  const directed = edges.flatMap<DirectedEdge>((edge) => [
    { id: `${edge.id}:f`, baseId: edge.id, sourcePieceId: edge.sourcePieceId, startNode: edge.startNode, endNode: edge.endNode, direction: edge.direction, points: edge.points },
    { id: `${edge.id}:r`, baseId: edge.id, sourcePieceId: edge.sourcePieceId, startNode: edge.endNode, endNode: edge.startNode, direction: edge.direction === 'ccw' ? 'cw' : 'ccw', points: [...edge.points].reverse() },
  ]);
  const byStart = new Map<string, DirectedEdge[]>();
  directed.forEach((edge) => {
    byStart.set(edge.startNode, [...(byStart.get(edge.startNode) ?? []), edge]);
  });

  const faces: FaceCandidate[] = [];
  const seen = new Set<string>();
  const maxDepth = Math.min(14, Math.max(2, edges.length));

  const visit = (startNode: string, currentNode: string, path: DirectedEdge[], usedBaseIds: Set<string>) => {
    if (path.length > maxDepth) return;
    for (const next of byStart.get(currentNode) ?? []) {
      if (usedBaseIds.has(next.baseId)) continue;
      if (next.endNode === startNode && path.length >= 1) {
        const cycle = [...path, next];
        if (new Set(cycle.map((edge) => edge.baseId)).size < 3) continue;
        const key = [...cycle.map((edge) => edge.baseId)].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const face = makeArcLoopFace(analysis, cycle, faces.length + 1, pieceById, circleById);
        faces.push(face);
        continue;
      }
      if (path.some((edge) => edge.startNode === next.endNode)) continue;
      visit(startNode, next.endNode, [...path, next], new Set([...usedBaseIds, next.baseId]));
    }
  };

  for (const edge of directed) {
    visit(edge.startNode, edge.endNode, [edge], new Set([edge.baseId]));
  }

  assignFaceNesting(faces);
  return faces;
}

function makeFaceEmptyReason(
  vectorFaces: FaceCandidate[],
  faces: FaceCandidate[],
  edges: ArcGraphEdge[],
): FaceDebugSummary['emptyReason'] {
  if (faces.some((face) => face.selected)) return undefined;
  if (edges.length === 0) return 'boundary_arcs_do_not_form_regions';
  if (vectorFaces.length === 0) return 'no_closed_loops_found';
  if (faces.length > 0 && faces.every((face) => face.insideMaskScore < 0.35)) return 'all_faces_rejected_by_inside_score';
  return 'mask_sampling_failed';
}

function buildStitchedArcLoopFace(
  analysis: ImageAnalysis,
  pieces: SplitArcPiece[],
  circleById: Map<string, CircleSpec>,
): FaceCandidate[] {
  const rawUsable = pieces
    .filter((piece) => piece.selectedAsBoundary)
    .map((piece) => ({ piece, circle: circleById.get(piece.parentCircleId), order: pieceContourOrder(piece, circleById) }))
    .filter((item): item is { piece: SplitArcPiece; circle: CircleSpec; order: number } => Boolean(item.circle && Number.isFinite(item.order)))
    .sort((a, b) => a.order - b.order);
  const dedupedUsable = rawUsable.filter((item, index, items) => {
      const key = circleGeometryKey(item.circle);
      return items.findIndex((other) => circleGeometryKey(other.circle) === key) === index;
    });
  const usable = dedupedUsable.length >= 3 ? dedupedUsable : rawUsable;
  if (usable.length < 3) return [];

  const arcPieces: ArcLoopSegment[] = [];
  for (let i = 0; i < usable.length; i += 1) {
    const current = usable[i];
    const next = usable[(i + 1) % usable.length];
    arcPieces.push(makeLoopSegment({ sourcePieceId: current.piece.id, direction: inferArcDirection(current.piece.points, current.circle), points: current.piece.points }, new Map(pieces.map((piece) => [piece.id, piece])), circleById));
    const connector = makeConnectorArcSegment(analysis, current, next, i + 1);
    if (connector) arcPieces.push(connector);
  }

  const polygon = arcPieces.flatMap((piece, index) => {
    const points = sampleArcLoopSegment(piece);
    return index === 0 ? points : points.slice(1);
  });
  const closureGap = polygon.length > 1 ? Math.hypot(polygon[0].x - polygon[polygon.length - 1].x, polygon[0].y - polygon[polygon.length - 1].y) : Number.POSITIVE_INFINITY;
  const signedArea = polygon.length >= 3 && closureGap <= 12 ? polygonArea(polygon) : 0;
  const area = Math.abs(signedArea);
  const centroid = polygon.length >= 3 ? polygonCentroid(polygon) : { x: 0, y: 0 };
  const samplePoints = sampleFacePoints(polygon, centroid);
  const insideMaskScore = sampleFaceInsideMask(analysis, polygon, centroid);
  const rejectionReason =
    closureGap > 12 ? 'invalid_loop'
      : area <= 24 ? 'tiny_face_noise'
        : insideMaskScore < 0.35 ? 'low_inside_mask_score'
          : undefined;
  return [{
    id: 'F-stitched-1',
    source: 'vector_loop',
    edgeIds: arcPieces.map((piece) => piece.id),
    arcPieces,
    polygon,
    samplePoints,
    area,
    centroid,
    numEdges: arcPieces.length,
    insideMaskScore,
    winding: signedArea >= 0 ? 'ccw' : 'cw',
    nestingDepth: 0,
    selected: !rejectionReason,
    rejectionReason,
  }];
}

function circleGeometryKey(circle: CircleSpec) {
  return [
    Math.round(circle.centerX * 10),
    Math.round(circle.centerY * 10),
    Math.round(circle.radius * 10),
  ].join(':');
}

function pieceContourOrder(piece: SplitArcPiece, circleById: Map<string, CircleSpec>) {
  const circle = circleById.get(piece.parentCircleId);
  if (!circle?.coveredContourIndices.length) return Number.POSITIVE_INFINITY;
  return Math.min(...circle.coveredContourIndices);
}

function makeConnectorArcSegment(
  analysis: ImageAnalysis,
  current: { piece: SplitArcPiece; circle: CircleSpec; order: number },
  next: { piece: SplitArcPiece; circle: CircleSpec; order: number },
  index: number,
): ArcLoopSegment | undefined {
  const startPoint = current.piece.endPoint;
  const endPoint = next.piece.startPoint;
  const gap = Math.hypot(startPoint.x - endPoint.x, startPoint.y - endPoint.y);
  if (gap < 3) return undefined;
  const fromIndex = Math.max(...current.circle.coveredContourIndices);
  const toIndex = Math.min(...next.circle.coveredContourIndices);
  const guide = contourMidpoint(analysis, fromIndex, toIndex);
  const connector = circleThroughThreePoints(startPoint, guide, endPoint) ?? circleThroughEndpoints(startPoint, endPoint, guide);
  if (!connector) return undefined;
  const startAngle = normalizeAngle((Math.atan2(startPoint.y - connector.cy, startPoint.x - connector.cx) * 180) / Math.PI);
  const endAngle = normalizeAngle((Math.atan2(endPoint.y - connector.cy, endPoint.x - connector.cx) * 180) / Math.PI);
  const guideAngle = normalizeAngle((Math.atan2(guide.y - connector.cy, guide.x - connector.cx) * 180) / Math.PI);
  const direction: 'cw' | 'ccw' = angleInArc(guideAngle, startAngle, endAngle) ? 'ccw' : 'cw';
  return {
    id: `connector-arc-${index}`,
    circleId: `connector-circle-${index}`,
    cx: connector.cx,
    cy: connector.cy,
    r: connector.r,
    startAngle,
    endAngle,
    startPoint,
    endPoint,
    direction,
    contourSupport: Math.min(current.circle.contourSupport, next.circle.contourSupport),
    fitError: Math.max(current.circle.fitError, next.circle.fitError),
  };
}

function contourMidpoint(analysis: ImageAnalysis, fromIndex: number, toIndex: number) {
  const contour = analysis.contourPoints;
  if (!contour.length) return { x: 0, y: 0 };
  const n = contour.length;
  const distance = (toIndex - fromIndex + n) % n;
  return contour[(fromIndex + Math.floor(distance / 2)) % n];
}

function circleThroughEndpoints(start: Point, end: Point, guide: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 0.001) return undefined;
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  const radius = Math.max(chord * 0.62, 18);
  const h2 = radius * radius - (chord / 2) ** 2;
  if (h2 <= 0) return undefined;
  const h = Math.sqrt(h2);
  const nx = -dy / chord;
  const ny = dx / chord;
  const a = { cx: mx + nx * h, cy: my + ny * h, r: radius };
  const b = { cx: mx - nx * h, cy: my - ny * h, r: radius };
  return Math.hypot(a.cx - guide.x, a.cy - guide.y) < Math.hypot(b.cx - guide.x, b.cy - guide.y) ? a : b;
}

function circleThroughThreePoints(a: Point, b: Point, c: Point) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 0.001) return undefined;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  if (!Number.isFinite(r) || r < 4 || r > 2000) return undefined;
  return { cx, cy, r };
}

function makeArcLoopFace(
  analysis: ImageAnalysis,
  cycle: Array<{ baseId: string; sourcePieceId: string; direction: 'cw' | 'ccw'; points: Point[] }>,
  index: number,
  pieceById: Map<string, SplitArcPiece>,
  circleById: Map<string, CircleSpec>,
): FaceCandidate {
  const polygon: Point[] = [];
  for (const edge of cycle) {
    const points = polygon.length ? edge.points.slice(1) : edge.points;
    polygon.push(...points);
  }
  const closureGap = polygon.length > 1 ? Math.hypot(polygon[0].x - polygon[polygon.length - 1].x, polygon[0].y - polygon[polygon.length - 1].y) : Number.POSITIVE_INFINITY;
  const signedArea = polygon.length >= 3 && closureGap <= 3 ? polygonArea(polygon) : 0;
  const area = Math.abs(signedArea);
  const centroid = polygon.length >= 3 ? polygonCentroid(polygon) : { x: 0, y: 0 };
  const samplePoints = sampleFacePoints(polygon, centroid);
  const insideMaskScore = sampleFaceInsideMask(analysis, polygon, centroid);
  const arcPieces = cycle.map((edge) => makeLoopSegment(edge, pieceById, circleById));
  const rejectionReason =
    closureGap > 3 ? 'invalid_loop'
      : area <= 24 ? 'tiny_face_noise'
        : insideMaskScore < 0.35 ? 'low_inside_mask_score'
          : undefined;
  return {
    id: `F${index}`,
    source: 'vector_loop',
    edgeIds: cycle.map((edge) => edge.baseId),
    arcPieces,
    polygon,
    samplePoints,
    area,
    centroid,
    numEdges: cycle.length,
    insideMaskScore,
    winding: signedArea >= 0 ? 'ccw' : 'cw',
    nestingDepth: 0,
    selected: !rejectionReason,
    rejectionReason,
  };
}

function makeLoopSegment(
  edge: { sourcePieceId: string; direction: 'cw' | 'ccw'; points: Point[] },
  pieceById: Map<string, SplitArcPiece>,
  circleById: Map<string, CircleSpec>,
): ArcLoopSegment {
  const piece = pieceById.get(edge.sourcePieceId);
  const circle = piece ? circleById.get(piece.parentCircleId) : undefined;
  const startPoint = edge.points[0];
  const endPoint = edge.points[edge.points.length - 1];
  const startAngle = circle ? pointAngle(startPoint, circle) : 0;
  const endAngle = circle ? pointAngle(endPoint, circle) : 0;
  return {
    id: edge.sourcePieceId,
    circleId: piece?.parentCircleId ?? '',
    cx: circle?.centerX ?? 0,
    cy: circle?.centerY ?? 0,
    r: circle?.radius ?? 0,
    startAngle,
    endAngle,
    startPoint,
    endPoint,
    direction: edge.direction,
    contourSupport: circle?.contourSupport ?? 0,
    fitError: circle?.fitError ?? 0,
  };
}

function inferArcDirection(points: Point[], circle: CircleSpec): 'cw' | 'ccw' {
  if (points.length < 2) return 'ccw';
  const start = pointAngle(points[0], circle);
  const end = pointAngle(points[points.length - 1], circle);
  const mid = pointAngle(points[Math.floor(points.length / 2)], circle);
  return angleInArc(mid, start, end) ? 'ccw' : 'cw';
}

function sampleArcLoopSegment(piece: ArcLoopSegment): Point[] {
  const span = piece.direction === 'ccw'
    ? angleSpan(piece.startAngle, piece.endAngle)
    : angleSpan(piece.endAngle, piece.startAngle);
  const steps = Math.max(4, Math.ceil((span / 360) * Math.PI * 2 * piece.r / 8));
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const delta = (span * i) / steps;
    const angle = piece.direction === 'ccw'
      ? normalizeAngle(piece.startAngle + delta)
      : normalizeAngle(piece.startAngle - delta);
    const radians = (angle * Math.PI) / 180;
    points.push({ x: piece.cx + Math.cos(radians) * piece.r, y: piece.cy + Math.sin(radians) * piece.r });
  }
  points[0] = piece.startPoint;
  points[points.length - 1] = piece.endPoint;
  return points;
}

function samplePixelsAsPoints(pixels: number[], width: number, limit: number) {
  const step = Math.max(1, Math.floor(pixels.length / limit));
  const out: Point[] = [];
  for (let i = 0; i < pixels.length && out.length < limit; i += step) {
    const pixel = pixels[i];
    out.push({ x: pixel % width, y: Math.floor(pixel / width) });
  }
  return out;
}

function sampleFacePoints(polygon: Point[], centroid: Point) {
  return [centroid, ...polygon.filter((_, index) => index % Math.max(1, Math.floor(polygon.length / 12)) === 0)];
}

function assignFaceNesting(faces: FaceCandidate[]) {
  for (const face of faces) {
    const containers = faces.filter((other) => other.id !== face.id && pointInPolygon(face.centroid, other.polygon));
    face.nestingDepth = containers.length;
    face.parentFaceId = containers.sort((a, b) => a.area - b.area)[0]?.id;
  }
}

function polylineLength(points: Point[]) {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / Math.max(0.0001, b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function drawPolyline(mask: Uint8Array, width: number, height: number, points: Point[], radius: number) {
  for (let i = 0; i < points.length - 1; i += 1) drawLine(mask, width, height, points[i], points[i + 1], radius);
}

function drawLine(mask: Uint8Array, width: number, height: number, a: Point, b: Point, radius: number) {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    for (let yy = y - radius; yy <= y + radius; yy += 1) {
      for (let xx = x - radius; xx <= x + radius; xx += 1) {
        if (xx >= 0 && xx < width && yy >= 0 && yy < height && Math.hypot(xx - x, yy - y) <= radius) mask[yy * width + xx] = 1;
      }
    }
  }
}

function orientArcToContour(points: Point[], circle: CircleSpec, analysis: ImageAnalysis) {
  if (circle.coveredContourIndices.length < 2) return points;
  const first = analysis.contourPoints[Math.min(...circle.coveredContourIndices)];
  const last = analysis.contourPoints[Math.max(...circle.coveredContourIndices)];
  const forward = Math.hypot(points[0].x - first.x, points[0].y - first.y) + Math.hypot(points[points.length - 1].x - last.x, points[points.length - 1].y - last.y);
  const backward = Math.hypot(points[0].x - last.x, points[0].y - last.y) + Math.hypot(points[points.length - 1].x - first.x, points[points.length - 1].y - first.y);
  return backward < forward ? [...points].reverse() : points;
}

function sampleFaceInsideMask(analysis: ImageAnalysis, polygon: Point[], centroid: Point) {
  const samples = [centroid, ...polygon.filter((_, index) => index % Math.max(1, Math.floor(polygon.length / 12)) === 0).map((point) => ({
    x: centroid.x * 0.65 + point.x * 0.35,
    y: centroid.y * 0.65 + point.y * 0.35,
  }))];
  let inside = 0;
  for (const sample of samples) {
    const x = Math.round(sample.x);
    const y = Math.round(sample.y);
    if (x >= 0 && x < analysis.width && y >= 0 && y < analysis.height && analysis.mask[y * analysis.width + x]) inside += 1;
  }
  return inside / Math.max(1, samples.length);
}

function polygonArea(points: Point[]) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function polygonCentroid(points: Point[]) {
  let x = 0;
  let y = 0;
  let areaFactor = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
    areaFactor += cross;
  }
  if (Math.abs(areaFactor) < 0.001) {
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
  }
  return { x: x / (3 * areaFactor), y: y / (3 * areaFactor) };
}

function pointAngle(point: Point, circle: CircleSpec) {
  return normalizeAngle((Math.atan2(point.y - circle.centerY, point.x - circle.centerX) * 180) / Math.PI);
}

function angleInArc(angle: number, start: number, end: number) {
  const span = angleSpan(start, end);
  const delta = normalizeAngle(angle - start);
  return delta <= span + 0.5;
}

function angleSpan(start: number, end: number) {
  const span = normalizeAngle(end - start);
  return span === 0 ? 360 : span;
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
    if (circle.arcLength > 0 && (circle.startAngle !== 0 || circle.endAngle !== 360)) {
      arcs.push({
        id: `A-${circle.id}-selected`,
        circleId: circle.id,
        startAngle: circle.startAngle,
        endAngle: circle.endAngle,
        usedInSilhouette,
        usedAsHelperOnly: circle.role === 'helper' || circle.role === 'boundary',
      });
      return;
    }
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
