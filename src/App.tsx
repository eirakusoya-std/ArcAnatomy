import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileJson, ImageUp, Play, RefreshCw, Save, SlidersHorizontal } from 'lucide-react';
import { generateCircleCandidatesWithDebug } from './geometry/circleFitting';
import { buildConstruction } from './geometry/reconstruction';
import { imageDataToAnalysis } from './geometry/imageProcessing';
import { buildSvg, downloadText, triggerDownload } from './geometry/exporters';
import type { CircleDebugRow, CircleFittingDebugData, CircleRole, ConstructionData, GeneratorSettings } from './geometry/types';

const defaultSettings: GeneratorSettings = {
  threshold: 118,
  blur: 2,
  edgeStrength: 2,
  maxCircles: 12,
  simplicity: 58,
  helperOpacity: 0.48,
  showHelpers: true,
  showCandidates: false,
  showAddCircles: true,
  showSubtractCircles: true,
  showBoundaryCircles: true,
  showHelperCircles: true,
  showImageOverlay: false,
  imageOverlayOpacity: 0.22,
  showMaskOverlay: false,
  maskOverlayOpacity: 0.28,
  minRadius: 8,
  maxRadius: 180,
  maxAddCircles: 8,
  maxSubtractCircles: 5,
  nmsDistance: 18,
  contourFirstMode: true,
  maxMainArcCircles: 6,
  maxFillCircles: 1,
  minArcLength: 34,
  minContourSupport: 0.018,
  largeRadiusPreference: 1.15,
  interiorFillPenaltyWeight: 1.4,
  targetContourCoverage: 0.72,
  maxGoodRemovalRatio: 0.18,
};

interface ResultState {
  construction: ConstructionData;
  maskOverlayUrl: string;
  debug: CircleFittingDebugData;
  debugImages: DebugImage[];
}

interface DebugImage {
  label: string;
  url: string;
}

export function App() {
  const [settings, setSettings] = useState<GeneratorSettings>(defaultSettings);
  const [imageUrl, setImageUrl] = useState('');
  const [imageName, setImageName] = useState('sample-motif');
  const [result, setResult] = useState<ResultState | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const url = createSampleImage();
    setImageUrl(url);
  }, []);

  useEffect(() => {
    if (imageUrl) {
      void generate();
    }
  }, [imageUrl]);

  const usedCircles = useMemo(
    () => result?.construction.circles.filter((circle) => circle.role !== 'candidate') ?? [],
    [result],
  );
  const previewSvg = useMemo(() => {
    if (!result) return '';
    return buildSvg(
      result.construction,
      settings.helperOpacity,
      settings.showHelpers,
      settings.showImageOverlay ? imageUrl : '',
      settings.imageOverlayOpacity,
      settings.showMaskOverlay ? result.maskOverlayUrl : '',
      settings.maskOverlayOpacity,
      roleVisibility(settings),
    );
  }, [result, settings, imageUrl]);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImageName(file.name.replace(/\.[^.]+$/, '') || 'arc-anatomy');
    const reader = new FileReader();
    reader.onload = () => setImageUrl(String(reader.result));
    reader.readAsDataURL(file);
  }

  async function generate() {
    if (!imageUrl || !canvasRef.current) return;
    const image = await loadImage(imageUrl);
    imageRef.current = image;
    const canvas = canvasRef.current;
    const maxSide = 860;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const analysis = imageDataToAnalysis(imageData, settings.threshold, settings.blur, settings.edgeStrength);
    const { circles, debug } = generateCircleCandidatesWithDebug(analysis, settings);
    const construction = buildConstruction(analysis, circles);
    const maskOverlayUrl = maskToOverlayDataUrl(analysis.mask, analysis.width, analysis.height);
    const debugImages = makeDebugImages(debug, construction, analysis.width, analysis.height);
    const debugReport = makeDebugReport(construction, debug);
    (window as Window & { __arcAnatomyDebug?: ReturnType<typeof makeDebugReport> }).__arcAnatomyDebug = debugReport;
    console.info('Arc Anatomy debug', debugReport);
    setResult({ construction, maskOverlayUrl, debug, debugImages });
  }

  function updateSetting<K extends keyof GeneratorSettings>(key: K, value: GeneratorSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function exportJson() {
    if (!result) return;
    downloadText(`${imageName}-circle-construction.json`, JSON.stringify(makeDebugReport(result.construction, result.debug), null, 2), 'application/json');
  }

  function exportSvg() {
    if (!result) return;
    downloadText(`${imageName}-arc-anatomy.svg`, previewSvg, 'image/svg+xml');
  }

  async function exportPng() {
    if (!result) return;
    const blob = new Blob([previewSvg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = result.construction.width;
    canvas.height = result.construction.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((png) => {
      if (!png) return;
      const pngUrl = URL.createObjectURL(png);
      triggerDownload(`${imageName}-arc-anatomy.png`, pngUrl);
      URL.revokeObjectURL(pngUrl);
    }, 'image/png');
  }

  return (
    <main className="app-shell">
      <aside className="panel left-panel">
        <div>
          <p className="eyebrow">Arc Anatomy</p>
          <h1>円だけで再設計する関数グラフアート生成器</h1>
        </div>

        <label className="upload-button">
          <ImageUp size={18} />
          画像を入力
          <input type="file" accept="image/*" onChange={handleFile} />
        </label>

        <button className="primary-button" onClick={generate}>
          <Play size={17} />
          自動生成
        </button>
        <button className="ghost-button" onClick={generate}>
          <RefreshCw size={16} />
          再生成
        </button>

        <section className="control-group">
          <h2><SlidersHorizontal size={16} /> 前処理</h2>
          <Range label="しきい値" min={30} max={220} value={settings.threshold} onChange={(v) => updateSetting('threshold', v)} />
          <Range label="ぼかし" min={0} max={5} value={settings.blur} onChange={(v) => updateSetting('blur', v)} />
          <Range label="輪郭抽出強度" min={1} max={5} value={settings.edgeStrength} onChange={(v) => updateSetting('edgeStrength', v)} />
        </section>

        <section className="control-group">
          <h2>構成</h2>
          <Range label="候補円数の上限" min={6} max={28} value={settings.maxCircles} onChange={(v) => updateSetting('maxCircles', v)} />
          <Range label="忠実さ" min={0} max={100} value={settings.simplicity} onChange={(v) => updateSetting('simplicity', v)} />
          <Range label="最小半径" min={2} max={60} value={settings.minRadius} onChange={(v) => updateSetting('minRadius', v)} />
          <Range label="最大半径" min={20} max={420} value={settings.maxRadius} onChange={(v) => updateSetting('maxRadius', v)} />
          <Range label="最大add円数" min={1} max={18} value={settings.maxAddCircles} onChange={(v) => updateSetting('maxAddCircles', v)} />
          <Range label="最大subtract円数" min={0} max={12} value={settings.maxSubtractCircles} onChange={(v) => updateSetting('maxSubtractCircles', v)} />
          <Range label="NMS距離" min={4} max={80} value={settings.nmsDistance} onChange={(v) => updateSetting('nmsDistance', v)} />
          <Toggle label="contour-first mode" checked={settings.contourFirstMode} onChange={(v) => updateSetting('contourFirstMode', v)} />
          <Range label="主円弧の最大数" min={1} max={12} value={settings.maxMainArcCircles} onChange={(v) => updateSetting('maxMainArcCircles', v)} />
          <Range label="fill円の最大数" min={0} max={4} value={settings.maxFillCircles} onChange={(v) => updateSetting('maxFillCircles', v)} />
          <Range label="最小円弧長" min={10} max={180} value={settings.minArcLength} onChange={(v) => updateSetting('minArcLength', v)} />
          <Range label="最小輪郭支持" min={0.005} max={0.12} step={0.005} value={settings.minContourSupport} onChange={(v) => updateSetting('minContourSupport', v)} />
          <Range label="大半径優先度" min={0.2} max={2} step={0.05} value={settings.largeRadiusPreference} onChange={(v) => updateSetting('largeRadiusPreference', v)} />
          <Range label="内部fill減点" min={0} max={3} step={0.05} value={settings.interiorFillPenaltyWeight} onChange={(v) => updateSetting('interiorFillPenaltyWeight', v)} />
          <Range label="目標輪郭カバー" min={0.3} max={0.95} step={0.01} value={settings.targetContourCoverage} onChange={(v) => updateSetting('targetContourCoverage', v)} />
          <Range label="削り許容量" min={0.02} max={0.4} step={0.01} value={settings.maxGoodRemovalRatio} onChange={(v) => updateSetting('maxGoodRemovalRatio', v)} />
          <Range label="補助円の濃さ" min={0} max={1} step={0.01} value={settings.helperOpacity} onChange={(v) => updateSetting('helperOpacity', v)} />
          <Toggle label="補助円を表示" checked={settings.showHelpers} onChange={(v) => updateSetting('showHelpers', v)} />
          <Toggle label="add 円を表示" checked={settings.showAddCircles} onChange={(v) => updateSetting('showAddCircles', v)} />
          <Toggle label="subtract 円を表示" checked={settings.showSubtractCircles} onChange={(v) => updateSetting('showSubtractCircles', v)} />
          <Toggle label="boundary 円を表示" checked={settings.showBoundaryCircles} onChange={(v) => updateSetting('showBoundaryCircles', v)} />
          <Toggle label="helper 円を表示" checked={settings.showHelperCircles} onChange={(v) => updateSetting('showHelperCircles', v)} />
          <Toggle label="元画像を薄く重ねる" checked={settings.showImageOverlay} onChange={(v) => updateSetting('showImageOverlay', v)} />
          <Range label="元画像の濃さ" min={0.05} max={0.6} step={0.01} value={settings.imageOverlayOpacity} onChange={(v) => updateSetting('imageOverlayOpacity', v)} />
          <Toggle label="二値化マスクを重ねる" checked={settings.showMaskOverlay} onChange={(v) => updateSetting('showMaskOverlay', v)} />
          <Range label="二値化マスクの濃さ" min={0.05} max={0.7} step={0.01} value={settings.maskOverlayOpacity} onChange={(v) => updateSetting('maskOverlayOpacity', v)} />
        </section>
      </aside>

      <section className="preview-stage">
        <div className="preview-toolbar">
          <span>{imageName}</span>
          <span>{result ? `${result.construction.circles.length} circles / ${result.construction.arcs.length} arcs` : 'ready'}</span>
        </div>
        <div className="artboard">
          {result ? (
            <div className="svg-wrap" dangerouslySetInnerHTML={{ __html: previewSvg }} />
          ) : (
            <div className="empty-state">画像を読み込み中</div>
          )}
        </div>
        <canvas ref={canvasRef} className="hidden-canvas" />
      </section>

      <aside className="panel right-panel">
        <div className="export-row">
          <button className="icon-button" onClick={exportJson} title="JSONを保存"><FileJson size={17} /></button>
          <button className="icon-button" onClick={exportSvg} title="SVGを保存"><Save size={17} /></button>
          <button className="icon-button" onClick={exportPng} title="PNGを保存"><Download size={17} /></button>
        </div>

        <section className="control-group">
          <h2>使用円一覧</h2>
          <div className="circle-list">
            {usedCircles.map((circle) => (
              <article className="circle-item" key={circle.id}>
                <div>
                  <strong>{circle.id}</strong>
                  <span className={`role-pill role-${circle.role}`}>{circle.role} / {circle.source}</span>
                </div>
                <code>{circle.equation}</code>
                <small>
                  center ({circle.centerX.toFixed(1)}, {circle.centerY.toFixed(1)}) · r {circle.radius.toFixed(1)} · score {circle.score.toFixed(2)}
                </small>
                <small>
                  final {circle.usedInFinal ? 'yes' : 'no'} · coverage {circle.maskCoverage.toFixed(2)} · outside {circle.outsidePenalty.toFixed(2)} · boundary {circle.boundarySupport.toFixed(2)}
                </small>
              </article>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>構成条件</h2>
          <div className="formula-box">
            <strong>{result?.construction.expression ?? '未生成'}</strong>
            {result?.construction.conditions.map((condition) => (
              <code key={`${condition.circleId}-${condition.relation}`}>{condition.circleId}: {condition.expression}</code>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>採用円弧</h2>
          <div className="arc-list">
            {result?.construction.arcs.slice(0, 12).map((arc) => (
              <span key={arc.id}>{arc.circleId}: {arc.startAngle.toFixed(0)}° - {arc.endAngle.toFixed(0)}°</span>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>デバッグ画像</h2>
          <div className="debug-grid">
            {result?.debugImages.map((image) => (
              <figure className="debug-tile" key={image.label}>
                <img src={image.url} alt={image.label} />
                <figcaption>{image.label}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>Shape Optimization Debug</h2>
          <div className="debug-table">
            {result && (
              <>
                <code>initial={result.debug.shapeOptimization.initialScore.toFixed(3)} optimized={result.debug.shapeOptimization.optimizedScore.toFixed(3)} iterations={result.debug.shapeOptimization.iterations} flips={result.debug.shapeOptimization.acceptedRoleFlips.length} additions={result.debug.shapeOptimization.acceptedAdditions} removals={result.debug.shapeOptimization.acceptedRemovals}</code>
                {result.debug.shapeOptimization.acceptedRoleFlips.slice(0, 16).map((flip) => (
                  <code key={`${flip.circleId}-${flip.to}-${flip.score}`}>{flip.circleId}: {flip.from} -&gt; {flip.to} delta={flip.delta.toFixed(3)} score={flip.score.toFixed(3)}</code>
                ))}
              </>
            )}
          </div>
        </section>

        <section className="control-group">
          <h2>selected circle debug</h2>
          <div className="debug-table">
            {result && [...result.debug.selectedAddCircles, ...result.debug.selectedSubtractCircles].map((circle) => (
              <code key={`${circle.role}-${circle.id}`}>{formatCircleDebug(circle)}</code>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>Arc Candidates</h2>
          <div className="debug-table">
            {result?.debug.arcCandidates.slice(0, 18).map((circle) => (
              <code key={circle.id}>{formatCandidateDebug(circle)}</code>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>Selection Steps</h2>
          <div className="debug-table">
            {result?.debug.selectionSteps.map((step) => (
              <code key={step.step}>#{step.step} {step.candidateId} gain={step.gain.toFixed(3)} new={step.newlyCoveredContourCount} coverage={(step.totalContourCoverage * 100).toFixed(1)}% {step.reason}</code>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>Arc Loop Debug</h2>
          <div className="debug-table">
            {result && (
              <code>
                selectedArcs={result.construction.splitArcPieces.filter((piece) => piece.selectedAsBoundary).length} snappedNodes={result.construction.faceDebug.graphNodesCount} graphEdges={result.construction.faceDebug.graphEdgesCount} closedLoops={result.construction.faceDebug.closedLoopsCount} selectedFillLoops={result.construction.faceDebug.selectedFacesCount} fallback={String(result.construction.faceDebug.fallbackUsed)} reason={result.construction.faceDebug.emptyReason ?? '-'}
              </code>
            )}
          </div>
        </section>

        <section className="control-group">
          <h2>Contour Ordered Arc Chain</h2>
          <div className="debug-table">
            {result?.construction.circles.filter((circle) => circle.id.startsWith('OC')).map((circle, index) => (
              <code key={circle.id}>#{index + 1} {circle.id} cx={circle.centerX.toFixed(1)} cy={circle.centerY.toFixed(1)} r={circle.radius.toFixed(1)} start={circle.startAngle.toFixed(1)} end={circle.endAngle.toFixed(1)} fitError={circle.fitError.toFixed(2)} arcLength={circle.arcLength.toFixed(1)} support={circle.contourSupport.toFixed(2)} selected</code>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>Loop Table</h2>
          <div className="debug-table">
            {result?.construction.faces.map((face) => (
              <code key={face.id}>{face.id} source={face.source} closed=true area={face.area.toFixed(1)} centroid=({face.centroid.x.toFixed(1)}, {face.centroid.y.toFixed(1)}) edges={face.numEdges} insideMaskScore={face.insideMaskScore.toFixed(2)} depth={face.nestingDepth ?? 0} parent={face.parentFaceId ?? '-'} {face.selected ? 'selected' : `rejected:${face.rejectionReason}`}</code>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>Rejected Arc Pieces</h2>
          <div className="debug-table">
            {result?.construction.splitArcPieces.filter((piece) => !piece.selectedAsBoundary).slice(0, 32).map((piece) => (
              <code key={piece.id}>{piece.id} parentArc={piece.parentArcId} parentCircle={piece.parentCircleId} reason={piece.rejectionReason ?? 'not_boundary_piece'}</code>
            ))}
          </div>
        </section>
      </aside>
    </main>
  );
}

function roleVisibility(settings: GeneratorSettings): Partial<Record<CircleRole, boolean>> {
  return {
    add: settings.showAddCircles,
    subtract: settings.showSubtractCircles,
    boundary: settings.showBoundaryCircles,
    helper: settings.showHelperCircles,
    candidate: settings.showCandidates,
  };
}

function maskToOverlayDataUrl(mask: Uint8Array, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const imageData = ctx.createImageData(width, height);
  for (let i = 0; i < mask.length; i += 1) {
    const offset = i * 4;
    if (mask[i]) {
      imageData.data[offset] = 14;
      imageData.data[offset + 1] = 165;
      imageData.data[offset + 2] = 233;
      imageData.data[offset + 3] = 255;
    } else {
      imageData.data[offset + 3] = 0;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

function makeDebugImages(debug: CircleFittingDebugData, construction: ConstructionData, width: number, height: number): DebugImage[] {
  return [
    { label: 'cleaned mask', url: maskToDebugDataUrl(debug.cleanedMask, width, height, '#111111') },
    { label: 'extracted contour', url: maskToDebugDataUrl(debug.extractedContour, width, height, '#0f766e') },
    { label: 'contour image', url: maskToDebugDataUrl(debug.contourImage, width, height, '#1d4ed8') },
    { label: 'smoothed contour', url: maskToDebugDataUrl(debug.smoothedContour, width, height, '#7c3aed') },
    { label: 'contour segments', url: segmentMaskToDebugDataUrl(debug.contourSegments, width, height) },
    { label: 'simplified contour', url: maskToDebugDataUrl(debug.simplifiedContour, width, height, '#dc2626') },
    { label: 'distance transform image', url: scalarToDebugDataUrl(debug.distanceTransform, width, height) },
    { label: 'all raw circle candidates', url: circlesToDebugDataUrl(debug.allRawCircleCandidates, width, height) },
    { label: 'selected add circles', url: circlesToDebugDataUrl(debug.selectedAddCircles, width, height) },
    { label: 'selected subtract circles', url: circlesToDebugDataUrl(debug.selectedSubtractCircles, width, height) },
    { label: 'selected raw arcs', url: graphEdgesToDataUrl(construction.arcs.filter((arc) => arc.usedInSilhouette).map((arc) => {
      const circle = construction.circles.find((item) => item.id === arc.circleId);
      return circle ? sampleDebugArc(circle.centerX, circle.centerY, circle.radius, arc.startAngle, arc.endAngle) : [];
    }), width, height) },
    { label: 'circle-circle intersections', url: intersectionsToDataUrl(construction.intersections, width, height) },
    { label: 'split arc pieces', url: graphEdgesToDataUrl(construction.splitArcPieces.map((piece) => piece.points), width, height) },
    { label: 'valid boundary arc pieces', url: graphEdgesToDataUrl(construction.splitArcPieces.filter((piece) => piece.selectedAsBoundary).map((piece) => piece.points), width, height) },
    { label: 'rejected arc pieces', url: graphEdgesToDataUrl(construction.splitArcPieces.filter((piece) => !piece.selectedAsBoundary).map((piece) => piece.points), width, height) },
    { label: 'planar graph nodes', url: graphNodesToDataUrl(construction.graphNodes, width, height) },
    { label: 'planar graph edges', url: graphEdgesToDataUrl(construction.graphEdges.map((edge) => edge.points), width, height) },
    { label: 'face candidates', url: facesToDataUrl(construction.faces, width, height, false) },
    { label: 'selected faces', url: facesToDataUrl(construction.faces, width, height, true) },
    { label: 'contour coverage', url: coverageMaskToDataUrl(debug.contourImage, debug.contourCoverageImage, width, height) },
    { label: 'final geometry before subtract', url: maskToDebugDataUrl(debug.finalGeometryBeforeSubtract, width, height, '#111111') },
    { label: 'overfill region', url: maskToDebugDataUrl(debug.overfillRegion, width, height, '#e11d48') },
    { label: 'false positive overlay', url: maskToDebugDataUrl(debug.falsePositiveRegion, width, height, '#e11d48') },
    { label: 'false negative overlay', url: maskToDebugDataUrl(debug.falseNegativeRegion, width, height, '#2563eb') },
    { label: 'final geometry after subtract', url: maskToDebugDataUrl(debug.finalGeometryAfterSubtract, width, height, '#111111') },
  ];
}

function intersectionsToDataUrl(points: Array<{ x: number; y: number }>, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#db2777';
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas.toDataURL('image/png');
}

function graphNodesToDataUrl(nodes: Array<{ x: number; y: number }>, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#111111';
  for (const node of nodes) ctx.fillRect(node.x - 3, node.y - 3, 6, 6);
  return canvas.toDataURL('image/png');
}

function graphEdgesToDataUrl(paths: Array<Array<{ x: number; y: number }>>, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  for (const points of paths) {
    if (points.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
  return canvas.toDataURL('image/png');
}

function sampleDebugArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number) {
  const span = ((endAngle - startAngle) % 360 + 360) % 360 || 360;
  const steps = Math.max(8, Math.ceil((span / 360) * Math.PI * 2 * radius / 8));
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = startAngle + (span * i) / steps;
    const radians = (angle * Math.PI) / 180;
    points.push({ x: cx + Math.cos(radians) * radius, y: cy + Math.sin(radians) * radius });
  }
  return points;
}

function facesToDataUrl(
  faces: Array<{ polygon: Array<{ x: number; y: number }>; selected: boolean; samplePoints?: Array<{ x: number; y: number }> }>,
  width: number,
  height: number,
  selectedOnly: boolean,
) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, width, height);
  for (const face of faces) {
    if (selectedOnly && !face.selected) continue;
    ctx.fillStyle = face.selected ? 'rgba(17, 17, 17, 0.82)' : 'rgba(220, 38, 38, 0.22)';
    if (face.polygon.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(face.polygon[0].x, face.polygon[0].y);
      for (const point of face.polygon.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = face.selected ? '#111111' : '#dc2626';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = '#f59e0b';
    for (const point of face.samplePoints ?? []) ctx.fillRect(point.x - 2, point.y - 2, 4, 4);
  }
  return canvas.toDataURL('image/png');
}

function segmentMaskToDebugDataUrl(mask: Uint8Array, width: number, height: number) {
  const colors = ['#2563eb', '#dc2626', '#16a34a'];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = mask[y * width + x];
      if (!value) continue;
      ctx.fillStyle = colors[(value - 1) % colors.length];
      ctx.fillRect(x, y, 2, 2);
    }
  }
  return canvas.toDataURL('image/png');
}

function coverageMaskToDataUrl(contour: Uint8Array, coverage: Uint8Array, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < contour.length; i += 1) {
    if (!contour[i]) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    ctx.fillStyle = coverage[i] ? '#16a34a' : '#dc2626';
    ctx.fillRect(x, y, 2, 2);
  }
  return canvas.toDataURL('image/png');
}

function maskToDebugDataUrl(mask: Uint8Array, width: number, height: number, color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = color;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas.toDataURL('image/png');
}

function scalarToDebugDataUrl(values: Float32Array, width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const imageData = ctx.createImageData(width, height);
  let max = 0;
  for (const value of values) if (value < 1_000_000) max = Math.max(max, value);
  for (let i = 0; i < values.length; i += 1) {
    const value = max > 0 && values[i] < 1_000_000 ? Math.round((values[i] / max) * 255) : 0;
    const offset = i * 4;
    imageData.data[offset] = value;
    imageData.data[offset + 1] = value;
    imageData.data[offset + 2] = value;
    imageData.data[offset + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

function circlesToDebugDataUrl(circles: CircleDebugRow[], width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#f7f4ed';
  ctx.fillRect(0, 0, width, height);
  for (const circle of circles) {
    ctx.beginPath();
    ctx.arc(circle.cx, circle.cy, circle.r, 0, Math.PI * 2);
    ctx.strokeStyle = circle.role === 'subtract' ? '#dc2626' : circle.role === 'boundary' ? '#2563eb' : '#111111';
    ctx.lineWidth = circle.usedInFinal ? 2 : 1;
    ctx.stroke();
  }
  return canvas.toDataURL('image/png');
}

function makeDebugReport(construction: ConstructionData, debug: CircleFittingDebugData) {
  return {
    construction,
    debug: {
      images: {
        cleanedMask: maskStats(debug.cleanedMask),
        extractedContour: maskStats(debug.extractedContour),
        contourImage: maskStats(debug.contourImage),
        smoothedContour: maskStats(debug.smoothedContour),
        contourSegments: maskStats(debug.contourSegments),
        simplifiedContour: maskStats(debug.simplifiedContour),
        distanceTransform: scalarStats(debug.distanceTransform),
        finalGeometryBeforeSubtract: maskStats(debug.finalGeometryBeforeSubtract),
        overfillRegion: maskStats(debug.overfillRegion),
        falsePositiveRegion: maskStats(debug.falsePositiveRegion),
        falseNegativeRegion: maskStats(debug.falseNegativeRegion),
        finalGeometryAfterSubtract: maskStats(debug.finalGeometryAfterSubtract),
      },
      allRawCircleCandidates: debug.allRawCircleCandidates,
      arcCandidates: debug.arcCandidates,
      fillCandidates: debug.fillCandidates,
      selectedAddCircles: debug.selectedAddCircles,
      selectedSubtractCircles: debug.selectedSubtractCircles,
      rejectedCandidates: debug.rejectedCandidates,
      selectionSteps: debug.selectionSteps,
      intersections: construction.intersections,
      splitArcPieces: construction.splitArcPieces,
      graphNodes: construction.graphNodes,
      graphEdges: construction.graphEdges,
      faces: construction.faces,
      shapeOptimization: debug.shapeOptimization,
    },
  };
}

function maskStats(mask: Uint8Array) {
  let filled = 0;
  for (const value of mask) filled += value;
  return { filledPixels: filled };
}

function scalarStats(values: Float32Array) {
  let max = 0;
  let nonZero = 0;
  for (const value of values) {
    if (value > 0 && value < 1_000_000) {
      nonZero += 1;
      max = Math.max(max, value);
    }
  }
  return { nonZeroPixels: nonZero, max };
}

function formatCircleDebug(circle: CircleDebugRow) {
  return `${circle.id} ${circle.initialRole ?? '-'}->${circle.finalRole ?? circle.role} cx=${circle.cx.toFixed(1)} cy=${circle.cy.toFixed(1)} r=${circle.r.toFixed(1)} angle=${circle.startAngle.toFixed(0)}-${circle.endAngle.toFixed(0)} arc=${circle.arcLength.toFixed(1)} fit=${circle.fitError.toFixed(2)} support=${circle.contourSupport.toFixed(3)} boundary=${circle.boundarySupport.toFixed(3)} contribution=${(circle.scoreContribution ?? 0).toFixed(3)} changed=${Boolean(circle.changedInOptimization)} used=${circle.usedInFinal} reason=${circle.rejectionReason ?? 'selected'}`;
}

function formatCandidateDebug(circle: CircleDebugRow) {
  return `${circle.id} ${circle.source}/${circle.candidateKind} cx=${circle.cx.toFixed(1)} cy=${circle.cy.toFixed(1)} r=${circle.r.toFixed(1)} start=${circle.startAngle.toFixed(0)} end=${circle.endAngle.toFixed(0)} arc=${circle.arcLength.toFixed(1)} fit=${circle.fitError.toFixed(2)} support=${circle.contourSupport.toFixed(3)} covered=${circle.coveredContourCount} score=${circle.score.toFixed(3)} ${circle.rejectionReason ?? 'available'}`;
}

function Range(props: { label: string; min: number; max: number; value: number; step?: number; onChange: (value: number) => void }) {
  return (
    <label className="range-control">
      <span>{props.label}<b>{Number(props.value).toFixed(props.step ? 2 : 0)}</b></span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle-control">
      <span>{props.label}</span>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
    </label>
  );
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function createSampleImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 760;
  canvas.height = 560;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#fbf7ef';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#101114';
  ctx.beginPath();
  ctx.moveTo(184, 346);
  ctx.bezierCurveTo(155, 253, 217, 157, 329, 145);
  ctx.bezierCurveTo(418, 135, 501, 181, 531, 255);
  ctx.bezierCurveTo(585, 251, 626, 278, 642, 321);
  ctx.bezierCurveTo(590, 317, 548, 337, 515, 382);
  ctx.bezierCurveTo(443, 471, 265, 458, 184, 346);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(408, 218, 18, 0, Math.PI * 2);
  ctx.fillStyle = '#fbf7ef';
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = '#101114';
  ctx.moveTo(252, 164);
  ctx.bezierCurveTo(222, 98, 249, 66, 312, 137);
  ctx.closePath();
  ctx.fill();
  return canvas.toDataURL('image/png');
}
