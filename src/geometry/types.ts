export type CircleRole = 'add' | 'subtract' | 'helper' | 'boundary' | 'candidate';
export type CandidateKind = 'arc' | 'fill' | 'subtract' | 'helper';
export type RejectionReason =
  | 'too_small_radius'
  | 'too_short_arc'
  | 'low_contour_support'
  | 'high_fit_error'
  | 'redundant_with_selected_arc'
  | 'mostly_interior_fill'
  | 'poor_new_coverage'
  | 'too_much_good_removal'
  | 'not_selected';
export type CircleSource =
  | 'distance_peak'
  | 'contour_fit'
  | 'residual_fit'
  | 'manual_future'
  | 'contour-fit'
  | 'max-inscribed'
  | 'negative-carve'
  | 'composition'
  | 'component-fit'
  | 'sample';

export interface Point {
  x: number;
  y: number;
}

export interface CircleSpec {
  id: string;
  cx: number;
  cy: number;
  r: number;
  centerX: number;
  centerY: number;
  radius: number;
  role: CircleRole;
  visible: boolean;
  usedInFinal: boolean;
  startAngle: number;
  endAngle: number;
  boundarySupport: number;
  arcLength: number;
  fitError: number;
  contourSupport: number;
  coveredContourIndices: number[];
  maskCoverage: number;
  outsidePenalty: number;
  score: number;
  scoreContribution?: number;
  source: CircleSource;
  initialRole?: CircleRole;
  finalRole?: CircleRole;
  changedInOptimization?: boolean;
  rejectionReason?: RejectionReason;
  selectedStep?: number;
  candidateKind: CandidateKind;
  equation: string;
}

export interface ArcSpec {
  id: string;
  circleId: string;
  startAngle: number;
  endAngle: number;
  usedInSilhouette: boolean;
  usedAsHelperOnly: boolean;
}

export interface RegionCondition {
  circleId: string;
  relation: 'add' | 'subtract';
  expression: string;
}

export interface ArcIntersection {
  id: string;
  x: number;
  y: number;
  arcIds: string[];
}

export interface ArcGraphNode {
  id: string;
  x: number;
  y: number;
  incidentEdges: string[];
}

export interface ArcGraphEdge {
  id: string;
  startNode: string;
  endNode: string;
  sourceArcId: string;
  sourcePieceId: string;
  direction: 'cw' | 'ccw';
  points: Point[];
}

export interface ArcLoopSegment {
  id: string;
  circleId: string;
  cx: number;
  cy: number;
  r: number;
  startAngle: number;
  endAngle: number;
  startPoint: Point;
  endPoint: Point;
  direction: 'cw' | 'ccw';
  contourSupport: number;
  fitError: number;
}

export interface SplitArcPiece {
  id: string;
  parentArcId: string;
  parentCircleId: string;
  sourceArcId: string;
  startNode: string;
  endNode: string;
  startPoint: Point;
  endPoint: Point;
  startAngle: number;
  endAngle: number;
  midpoint: Point;
  length: number;
  selectedAsBoundary: boolean;
  rejectionReason?: 'not_boundary_piece' | 'open_chain' | 'synthetic_closure_required';
  points: Point[];
}

export interface FaceCandidate {
  id: string;
  source: 'vector_loop';
  edgeIds: string[];
  arcPieces: ArcLoopSegment[];
  polygon: Point[];
  samplePoints: Point[];
  area: number;
  centroid: Point;
  numEdges: number;
  insideMaskScore: number;
  winding: 'cw' | 'ccw';
  parentFaceId?: string;
  nestingDepth: number;
  selected: boolean;
  rejectionReason?: 'outside_mask' | 'too_small_area' | 'invalid_loop' | 'low_inside_mask_score' | 'tiny_face_noise';
}

export interface FaceDebugSummary {
  totalArcPieces: number;
  validBoundaryArcPieces: number;
  graphNodesCount: number;
  graphEdgesCount: number;
  closedLoopsCount: number;
  faceCandidatesCount: number;
  selectedFacesCount: number;
  fallbackUsed: boolean;
  emptyReason?: 'no_closed_loops_found' | 'all_faces_rejected_by_inside_score' | 'boundary_arcs_do_not_form_regions' | 'mask_sampling_failed';
}

export interface ConstructionData {
  width: number;
  height: number;
  circles: CircleSpec[];
  arcs: ArcSpec[];
  finalShape: {
    type: 'arc_loop_fill';
    expression: 'selected circular arcs -> closed arc loops -> fill inside loops';
    loopIds: string[];
  };
  intersections: ArcIntersection[];
  splitArcPieces: SplitArcPiece[];
  graphNodes: ArcGraphNode[];
  graphEdges: ArcGraphEdge[];
  faces: FaceCandidate[];
  faceDebug: FaceDebugSummary;
  conditions: RegionCondition[];
  expression: string;
  generatedAt: string;
}

export interface CircleDebugRow {
  id: string;
  role: CircleRole;
  cx: number;
  cy: number;
  r: number;
  source: CircleSource;
  startAngle: number;
  endAngle: number;
  arcLength: number;
  fitError: number;
  contourSupport: number;
  coveredContourCount: number;
  score: number;
  usedInFinal: boolean;
  boundarySupport: number;
  outsidePenalty: number;
  selectedStep?: number;
  candidateKind: CandidateKind;
  rejectionReason?: RejectionReason;
  initialRole?: CircleRole;
  finalRole?: CircleRole;
  scoreContribution?: number;
  changedInOptimization?: boolean;
}

export interface ShapeOptimizationDebug {
  initialAddCircleIds: string[];
  initialSubtractCircleIds: string[];
  optimizedAddCircleIds: string[];
  optimizedSubtractCircleIds: string[];
  initialScore: number;
  optimizedScore: number;
  iterations: number;
  acceptedRoleFlips: Array<{ circleId: string; from: CircleRole; to: CircleRole; score: number; delta: number }>;
  acceptedAdditions: number;
  acceptedRemovals: number;
}

export interface SelectionStepDebug {
  step: number;
  candidateId: string;
  gain: number;
  newlyCoveredContourCount: number;
  totalContourCoverage: number;
  reason: string;
}

export interface CircleFittingDebugData {
  cleanedMask: Uint8Array;
  extractedContour: Uint8Array;
  contourImage: Uint8Array;
  smoothedContour: Uint8Array;
  contourSegments: Uint8Array;
  simplifiedContour: Uint8Array;
  distanceTransform: Float32Array;
  allRawCircleCandidates: CircleDebugRow[];
  arcCandidates: CircleDebugRow[];
  fillCandidates: CircleDebugRow[];
  selectedAddCircles: CircleDebugRow[];
  selectedSubtractCircles: CircleDebugRow[];
  rejectedCandidates: CircleDebugRow[];
  contourCoverage: Uint8Array;
  contourCoverageImage: Uint8Array;
  selectionSteps: SelectionStepDebug[];
  finalGeometryBeforeSubtract: Uint8Array;
  overfillRegion: Uint8Array;
  falsePositiveRegion: Uint8Array;
  falseNegativeRegion: Uint8Array;
  finalGeometryAfterSubtract: Uint8Array;
  shapeOptimization: ShapeOptimizationDebug;
}

export interface ImageAnalysis {
  width: number;
  height: number;
  mask: Uint8Array;
  edge: Uint8Array;
  rawContourPoints: Point[];
  smoothedContourPoints: Point[];
  contourSegments: number[][];
  contourPoints: Point[];
  centroid: Point;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface GeneratorSettings {
  threshold: number;
  blur: number;
  edgeStrength: number;
  maxCircles: number;
  simplicity: number;
  helperOpacity: number;
  showHelpers: boolean;
  showCandidates: boolean;
  showAddCircles: boolean;
  showSubtractCircles: boolean;
  showBoundaryCircles: boolean;
  showHelperCircles: boolean;
  showImageOverlay: boolean;
  imageOverlayOpacity: number;
  showMaskOverlay: boolean;
  maskOverlayOpacity: number;
  minRadius: number;
  maxRadius: number;
  maxAddCircles: number;
  maxSubtractCircles: number;
  nmsDistance: number;
  contourFirstMode: boolean;
  maxMainArcCircles: number;
  maxFillCircles: number;
  minArcLength: number;
  minContourSupport: number;
  largeRadiusPreference: number;
  interiorFillPenaltyWeight: number;
  targetContourCoverage: number;
  maxGoodRemovalRatio: number;
}
