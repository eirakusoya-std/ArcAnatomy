import type { ArcLoopSegment, CircleSpec, ConstructionData, GeneratorSettings, Point } from './types';

export type ArcLabelMap = Record<string, string>;
export type ConnectionType = 'smooth' | 'corner' | 'gap' | 'bad_tangent';

export interface FormulaRow {
  arcId: string;
  circleId: string;
  label: string;
  centerX: number;
  centerY: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  direction: 'cw' | 'ccw';
  arcLength: number;
  fitError: number;
  contourSupport: number;
  curvature: number;
  circleEquation: string;
  parametricEquation: string;
  interval: string;
  reportText: string;
}

export interface TangentSample {
  point: Point;
  angle: number;
  tangentVector: Point;
  tangentAngle: number;
  slope: number | null;
  verticalTangent: boolean;
}

export interface DerivativeInfo {
  arcId: string;
  circleId: string;
  label: string;
  curvature: number;
  startTangentVector: Point;
  midTangentVector: Point;
  endTangentVector: Point;
  startTangentAngle: number;
  midTangentAngle: number;
  endTangentAngle: number;
  startSlope: number | null;
  midSlope: number | null;
  endSlope: number | null;
  verticalTangent: boolean;
  start: TangentSample;
  mid: TangentSample;
  end: TangentSample;
  derivativeFormula: string;
  implicitDerivativeFormula: string;
}

export interface ConnectionInfo {
  fromArcId: string;
  toArcId: string;
  positionGap: number;
  fromEndTangentAngle: number;
  toStartTangentAngle: number;
  tangentAngleDelta: number;
  tangentContinuityScore: number;
  connectionType: ConnectionType;
}

export interface ReportData {
  title: string;
  concept: string;
  sourceImageInfo: {
    name: string;
    width: number;
    height: number;
    source: string;
  };
  settings: GeneratorSettings;
  arcs: FormulaRow[];
  circles: CircleSpec[];
  formulaTable: FormulaRow[];
  derivativeInfo: DerivativeInfo[];
  connectionInfo: ConnectionInfo[];
  helperCircles: CircleSpec[];
  processSummary: string[];
  improvementLogTemplate: string[];
  generatedAt: string;
}

interface ReportBuildInput {
  construction: ConstructionData;
  labels: ArcLabelMap;
  settings: GeneratorSettings;
  title: string;
  concept: string;
  sourceImageInfo: ReportData['sourceImageInfo'];
}

interface ArcReportPiece extends ArcLoopSegment {
  arcId: string;
}

const deg = (radians: number) => (radians * 180) / Math.PI;
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const normalizeAngle = (angle: number) => ((angle % 360) + 360) % 360;

export function buildReportData(input: ReportBuildInput): ReportData {
  const formulaTable = buildFormulaTable(input.construction, input.labels);
  return {
    title: input.title,
    concept: input.concept,
    sourceImageInfo: input.sourceImageInfo,
    settings: input.settings,
    arcs: formulaTable,
    circles: input.construction.circles,
    formulaTable,
    derivativeInfo: buildDerivativeInfo(input.construction, input.labels),
    connectionInfo: buildConnectionInfo(input.construction, input.labels),
    helperCircles: input.construction.circles.filter((circle) => !circle.usedInFinal || circle.role === 'helper'),
    processSummary: [
      '入力画像をキャンバスに読み込み、輝度をもとに二値化した。',
      '二値化マスクから境界画素を見つけ、輪郭を抽出した。',
      '輪郭点列を平滑化し、弧長に沿って再サンプリングした。',
      '輪郭の接線方向の変化が大きい点を使ってセグメントに分割した。',
      '各セグメントの点群を円弧に最小二乗フィットした。',
      '中心と半径が近い円を統合し、冗長な補助円を抑制した。',
      '採用した円弧列をSVG pathとして閉じ、内部を塗って完成形にした。',
      '補助円を表示し、作品を構成する親円が分かる設計図として確認した。',
    ],
    improvementLogTemplate: [
      '初期案: 塗り円を足し引きする方法で形を近似したが、輪郭の説明が弱かった。',
      '改善1: 塗り優先から輪郭優先に切り替え、下絵の境界に沿って円弧を選ぶようにした。',
      '改善2: 円の合成結果ではなく、円弧列そのものを閉じたSVG pathに変換する方式にした。',
      '改善3: 数式一覧、微分情報、接続点の接線角度差を出力し、数学的な説明に使えるようにした。',
      '最終確認: 完成作品、補助円つき設計図、下絵/マスク/輪郭の工程画像を分けて保存した。',
    ],
    generatedAt: new Date().toISOString(),
  };
}

export function buildFormulaTable(construction: ConstructionData, labels: ArcLabelMap): FormulaRow[] {
  return getSelectedArcPieces(construction).map((piece, index) => {
    const label = labels[piece.arcId]?.trim() || defaultArcLabel(index);
    const curvature = 1 / Math.max(0.000001, piece.r);
    const circleEquation = `(x - ${format(piece.cx)})^2 + (y - ${format(piece.cy)})^2 = ${format(piece.r)}^2`;
    const parametricEquation = `x = ${format(piece.cx)} + ${format(piece.r)} cos(theta), y = ${format(piece.cy)} + ${format(piece.r)} sin(theta)`;
    const interval = `${format(piece.startAngle)} deg <= theta <= ${format(piece.endAngle)} deg`;
    return {
      arcId: piece.arcId,
      circleId: piece.circleId,
      label,
      centerX: piece.cx,
      centerY: piece.cy,
      radius: piece.r,
      startAngle: piece.startAngle,
      endAngle: piece.endAngle,
      direction: piece.direction,
      arcLength: arcLength(piece),
      fitError: piece.fitError,
      contourSupport: piece.contourSupport,
      curvature,
      circleEquation,
      parametricEquation,
      interval,
      reportText: `Circle equation: ${circleEquation}\nParametric equation: ${parametricEquation}\nInterval: ${interval}`,
    };
  });
}

export function buildDerivativeInfo(construction: ConstructionData, labels: ArcLabelMap): DerivativeInfo[] {
  return getSelectedArcPieces(construction).map((piece, index) => {
    const label = labels[piece.arcId]?.trim() || defaultArcLabel(index);
    const start = tangentSample(piece, piece.startAngle);
    const mid = tangentSample(piece, midpointAngle(piece));
    const end = tangentSample(piece, piece.endAngle);
    return {
      arcId: piece.arcId,
      circleId: piece.circleId,
      label,
      curvature: 1 / Math.max(0.000001, piece.r),
      startTangentVector: start.tangentVector,
      midTangentVector: mid.tangentVector,
      endTangentVector: end.tangentVector,
      startTangentAngle: start.tangentAngle,
      midTangentAngle: mid.tangentAngle,
      endTangentAngle: end.tangentAngle,
      startSlope: start.slope,
      midSlope: mid.slope,
      endSlope: end.slope,
      verticalTangent: start.verticalTangent || mid.verticalTangent || end.verticalTangent,
      start,
      mid,
      end,
      derivativeFormula: 'dx/dtheta = -r sin(theta), dy/dtheta = r cos(theta), tangent vector = (-r sin(theta), r cos(theta))',
      implicitDerivativeFormula: 'dy/dx = -(x-a)/(y-b)',
    };
  });
}

export function buildConnectionInfo(construction: ConstructionData, labels: ArcLabelMap): ConnectionInfo[] {
  const pieces = getSelectedArcPieces(construction);
  if (pieces.length < 2) return [];
  return pieces.map((piece, index) => {
    const next = pieces[(index + 1) % pieces.length];
    const fromEnd = tangentSample(piece, piece.endAngle);
    const toStart = tangentSample(next, next.startAngle);
    const positionGap = Math.hypot(piece.endPoint.x - next.startPoint.x, piece.endPoint.y - next.startPoint.y);
    const tangentAngleDelta = smallestAngleDifference(fromEnd.tangentAngle, toStart.tangentAngle);
    const tangentContinuityScore = Math.max(0, 1 - tangentAngleDelta / 90) * Math.max(0, 1 - positionGap / 24);
    return {
      fromArcId: piece.arcId,
      toArcId: next.arcId,
      positionGap,
      fromEndTangentAngle: fromEnd.tangentAngle,
      toStartTangentAngle: toStart.tangentAngle,
      tangentAngleDelta,
      tangentContinuityScore,
      connectionType: classifyConnection(positionGap, tangentAngleDelta, labels[piece.arcId], labels[next.arcId]),
    };
  });
}

function getSelectedArcPieces(construction: ConstructionData): ArcReportPiece[] {
  const selected = construction.faces.filter((face) => face.selected).flatMap((face) => face.arcPieces);
  const source = selected.length ? selected : construction.splitArcPieces.filter((piece) => piece.selectedAsBoundary).map((piece) => ({
    id: piece.id,
    circleId: piece.parentCircleId,
    cx: construction.circles.find((circle) => circle.id === piece.parentCircleId)?.centerX ?? 0,
    cy: construction.circles.find((circle) => circle.id === piece.parentCircleId)?.centerY ?? 0,
    r: construction.circles.find((circle) => circle.id === piece.parentCircleId)?.radius ?? 0,
    startAngle: piece.startAngle,
    endAngle: piece.endAngle,
    startPoint: piece.startPoint,
    endPoint: piece.endPoint,
    direction: inferDirection(piece.startAngle, piece.endAngle),
    contourSupport: construction.circles.find((circle) => circle.id === piece.parentCircleId)?.contourSupport ?? 0,
    fitError: construction.circles.find((circle) => circle.id === piece.parentCircleId)?.fitError ?? 0,
  }));

  return source.map((piece) => {
    const splitPiece = construction.splitArcPieces.find((item) => item.id === piece.id || item.parentCircleId === piece.circleId);
    return {
      ...piece,
      arcId: splitPiece?.parentArcId ?? piece.id,
    };
  });
}

function tangentSample(piece: ArcLoopSegment, angle: number): TangentSample {
  const theta = rad(angle);
  const directionSign = piece.direction === 'ccw' ? 1 : -1;
  const baseVector = { x: -piece.r * Math.sin(theta), y: piece.r * Math.cos(theta) };
  const tangentVector = { x: baseVector.x * directionSign, y: baseVector.y * directionSign };
  const point = { x: piece.cx + piece.r * Math.cos(theta), y: piece.cy + piece.r * Math.sin(theta) };
  const verticalTangent = Math.abs(point.y - piece.cy) < 0.000001 || Math.abs(tangentVector.x) < 0.000001;
  const slope = verticalTangent ? null : -(point.x - piece.cx) / (point.y - piece.cy);
  return {
    point,
    angle: normalizeAngle(angle),
    tangentVector,
    tangentAngle: normalizeAngle(deg(Math.atan2(tangentVector.y, tangentVector.x))),
    slope,
    verticalTangent,
  };
}

function midpointAngle(piece: ArcLoopSegment) {
  const span = piece.direction === 'ccw'
    ? angleSpan(piece.startAngle, piece.endAngle)
    : angleSpan(piece.endAngle, piece.startAngle);
  return piece.direction === 'ccw'
    ? normalizeAngle(piece.startAngle + span / 2)
    : normalizeAngle(piece.startAngle - span / 2);
}

function arcLength(piece: ArcLoopSegment) {
  const span = piece.direction === 'ccw'
    ? angleSpan(piece.startAngle, piece.endAngle)
    : angleSpan(piece.endAngle, piece.startAngle);
  return (span / 360) * Math.PI * 2 * piece.r;
}

function classifyConnection(positionGap: number, angleDelta: number, fromLabel = '', toLabel = ''): ConnectionType {
  const labelText = `${fromLabel} ${toLabel}`;
  const intentionalCorner = /角|corner|くびれ|先端/.test(labelText);
  if (positionGap > 14) return 'gap';
  if (angleDelta <= 18) return 'smooth';
  if (intentionalCorner || angleDelta <= 55) return 'corner';
  return 'bad_tangent';
}

function smallestAngleDifference(a: number, b: number) {
  const delta = Math.abs(normalizeAngle(a - b));
  return Math.min(delta, 360 - delta);
}

function angleSpan(startAngle: number, endAngle: number) {
  const span = normalizeAngle(endAngle - startAngle);
  return span === 0 ? 360 : span;
}

function inferDirection(startAngle: number, endAngle: number): 'cw' | 'ccw' {
  return angleSpan(startAngle, endAngle) <= 180 ? 'ccw' : 'cw';
}

function defaultArcLabel(index: number) {
  return `円弧${index + 1}`;
}

function format(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}
