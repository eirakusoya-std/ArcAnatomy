export type CircleRole = 'add' | 'subtract' | 'helper' | 'boundary' | 'candidate';
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
  maskCoverage: number;
  outsidePenalty: number;
  score: number;
  source: CircleSource;
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

export interface ConstructionData {
  width: number;
  height: number;
  circles: CircleSpec[];
  arcs: ArcSpec[];
  conditions: RegionCondition[];
  expression: string;
  generatedAt: string;
}

export interface ImageAnalysis {
  width: number;
  height: number;
  mask: Uint8Array;
  edge: Uint8Array;
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
}
