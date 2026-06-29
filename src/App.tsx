import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileJson, ImageUp, Play, RefreshCw, Save, SlidersHorizontal } from 'lucide-react';
import { buildConstruction } from './geometry/reconstruction';
import { imageDataToAnalysis } from './geometry/imageProcessing';
import { buildSvg, downloadText, triggerDownload } from './geometry/exporters';
import { buildConnectionInfo, buildDerivativeInfo, buildFormulaTable, buildReportData } from './geometry/reporting';
import type { CircleDebugRow, CircleFittingDebugData, CircleRole, ConstructionData, GeneratorSettings } from './geometry/types';
import type { ArcLabelMap } from './geometry/reporting';

const defaultSettings: GeneratorSettings = {
  threshold: 118,
  blur: 2,
  edgeStrength: 2,
  targetArcCount: 14,
  arcMergeAggressiveness: 62,
  visibleParentCircleLimit: 6,
  minFittedRadius: 5,
  maxFittedRadius: 520,
  duplicateCenterTolerance: 18,
  duplicateRadiusTolerance: 0.12,
  loopClosureTolerance: 14,
  minLoopInsideScore: 0.35,
  minLoopArea: 24,
  arcSampleSpacing: 5,
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
  enableArcGroupMerging: true,
  maxMergeGroupSize: 4,
  tangentMergeThreshold: 24,
  refitErrorThreshold: 5.4,
  errorIncreaseThreshold: 1.8,
  simplicityWeight: 0.72,
  tangentWeight: 0.52,
  errorWeight: 0.64,
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
  const [reportTitle, setReportTitle] = useState('Arc Anatomy: 円弧だけで描くシルエット');
  const [reportConcept, setReportConcept] = useState('下絵の輪郭を円弧の集合として近似し、補助円と微分情報で構造を説明できる関数グラフアート。');
  const [arcLabels, setArcLabels] = useState<ArcLabelMap>({});
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
    () => result?.construction.circles.filter((circle) => circle.visible && circle.role !== 'candidate') ?? [],
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
  const formulaTable = useMemo(
    () => result ? buildFormulaTable(result.construction, arcLabels) : [],
    [result, arcLabels],
  );
  const derivativeInfo = useMemo(
    () => result ? buildDerivativeInfo(result.construction, arcLabels) : [],
    [result, arcLabels],
  );
  const connectionInfo = useMemo(
    () => result ? buildConnectionInfo(result.construction, arcLabels) : [],
    [result, arcLabels],
  );
  const reportData = useMemo(() => {
    if (!result) return null;
    return buildReportData({
      construction: result.construction,
      labels: arcLabels,
      settings,
      title: reportTitle,
      concept: reportConcept,
      sourceImageInfo: {
        name: imageName,
        width: result.construction.width,
        height: result.construction.height,
        source: imageUrl.startsWith('data:') ? 'embedded-data-url' : imageUrl,
      },
    });
  }, [result, arcLabels, settings, reportTitle, reportConcept, imageName, imageUrl]);

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
    const maxSide = 720;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const analysis = imageDataToAnalysis(imageData, settings.threshold, settings.blur, settings.edgeStrength);
    const debug = makeLightweightDebug(analysis);
    const construction = buildConstruction(analysis, [], settings);
    const maskOverlayUrl = maskToOverlayDataUrl(analysis.mask, analysis.width, analysis.height);
    const debugImages = makeLightweightDebugImages(debug, construction, analysis.width, analysis.height);
    const debugReport = makeDebugReport(construction, debug);
    (window as Window & { __arcAnatomyDebug?: ReturnType<typeof makeDebugReport> }).__arcAnatomyDebug = debugReport;
    console.info('Arc Anatomy debug summary', {
      circles: construction.circles.length,
      visibleCircles: construction.circles.filter((circle) => circle.visible).length,
      arcs: construction.arcs.length,
      loops: construction.faces.length,
    });
    setResult({ construction, maskOverlayUrl, debug, debugImages });
  }

  function updateSetting<K extends keyof GeneratorSettings>(key: K, value: GeneratorSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function updateArcLabel(arcId: string, label: string) {
    setArcLabels((current) => ({ ...current, [arcId]: label }));
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
    await downloadSvgAsPng(previewSvg, result.construction.width, result.construction.height, `${imageName}-arc-anatomy.png`);
  }

  function exportReportData() {
    if (!reportData) return;
    downloadText(`${imageName}-report-data.json`, JSON.stringify(reportData, null, 2), 'application/json');
  }

  function exportVariantSvg(kind: 'final' | 'blueprint' | 'process') {
    if (!result) return;
    downloadText(`${imageName}-${kind}.svg`, svgForExportKind(kind, result), 'image/svg+xml');
  }

  async function exportVariantPng(kind: 'final' | 'blueprint' | 'process') {
    if (!result) return;
    await downloadSvgAsPng(svgForExportKind(kind, result), result.construction.width, result.construction.height, `${imageName}-${kind}.png`);
  }

  function svgForExportKind(kind: 'final' | 'blueprint' | 'process', state: ResultState) {
    if (kind === 'final') {
      return buildSvg(state.construction, 0, false);
    }
    if (kind === 'blueprint') {
      return buildSvg(state.construction, 0.62, true, '', 0, '', 0, {
        add: true,
        subtract: true,
        boundary: true,
        helper: true,
        candidate: false,
      });
    }
    return buildSvg(state.construction, 0.66, true, imageUrl, 0.28, state.maskOverlayUrl, 0.24, {
      add: true,
      subtract: true,
      boundary: true,
      helper: true,
      candidate: false,
    });
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
          <h2>提出情報</h2>
          <label className="text-control">
            <span>作品タイトル</span>
            <input value={reportTitle} onChange={(event) => setReportTitle(event.target.value)} />
          </label>
          <label className="text-control">
            <span>コンセプト</span>
            <textarea value={reportConcept} onChange={(event) => setReportConcept(event.target.value)} />
          </label>
        </section>

        <section className="control-group">
          <h2><SlidersHorizontal size={16} /> 前処理</h2>
          <Range label="しきい値" min={30} max={220} value={settings.threshold} onChange={(v) => updateSetting('threshold', v)} />
          <Range label="ぼかし" min={0} max={5} value={settings.blur} onChange={(v) => updateSetting('blur', v)} />
          <Range label="輪郭抽出強度" min={1} max={5} value={settings.edgeStrength} onChange={(v) => updateSetting('edgeStrength', v)} />
        </section>

        <section className="control-group">
          <h2>構成</h2>
          <Range label="目標円弧数" min={4} max={32} value={settings.targetArcCount} onChange={(v) => updateSetting('targetArcCount', v)} />
          <Range label="円弧の統合強度" min={0} max={100} value={settings.arcMergeAggressiveness} onChange={(v) => updateSetting('arcMergeAggressiveness', v)} />
          <Range label="表示する親円数" min={0} max={16} value={settings.visibleParentCircleLimit} onChange={(v) => updateSetting('visibleParentCircleLimit', v)} />
          <Range label="最小親円半径" min={2} max={120} value={settings.minFittedRadius} onChange={(v) => updateSetting('minFittedRadius', v)} />
          <Range label="最大親円半径" min={40} max={1200} value={settings.maxFittedRadius} onChange={(v) => updateSetting('maxFittedRadius', v)} />
          <Range label="冗長中心距離" min={4} max={80} value={settings.duplicateCenterTolerance} onChange={(v) => updateSetting('duplicateCenterTolerance', v)} />
          <Range label="冗長半径差" min={0.03} max={0.3} step={0.01} value={settings.duplicateRadiusTolerance} onChange={(v) => updateSetting('duplicateRadiusTolerance', v)} />
          <Range label="ループ閉鎖許容" min={2} max={40} value={settings.loopClosureTolerance} onChange={(v) => updateSetting('loopClosureTolerance', v)} />
          <Range label="ループ内側判定" min={0.05} max={0.9} step={0.01} value={settings.minLoopInsideScore} onChange={(v) => updateSetting('minLoopInsideScore', v)} />
          <Range label="最小ループ面積" min={0} max={600} value={settings.minLoopArea} onChange={(v) => updateSetting('minLoopArea', v)} />
          <Range label="円弧サンプル間隔" min={2} max={14} value={settings.arcSampleSpacing} onChange={(v) => updateSetting('arcSampleSpacing', v)} />
          <Toggle label="滑らかな円弧群を統合" checked={settings.enableArcGroupMerging} onChange={(v) => updateSetting('enableArcGroupMerging', v)} />
          <Range label="最大統合グループ数" min={2} max={5} value={settings.maxMergeGroupSize} onChange={(v) => updateSetting('maxMergeGroupSize', v)} />
          <Range label="接線統合しきい値" min={6} max={60} value={settings.tangentMergeThreshold} onChange={(v) => updateSetting('tangentMergeThreshold', v)} />
          <Range label="再フィット誤差しきい値" min={1} max={16} step={0.1} value={settings.refitErrorThreshold} onChange={(v) => updateSetting('refitErrorThreshold', v)} />
          <Range label="誤差悪化率しきい値" min={1} max={4} step={0.05} value={settings.errorIncreaseThreshold} onChange={(v) => updateSetting('errorIncreaseThreshold', v)} />
          <Range label="簡潔さ重み" min={0} max={2} step={0.01} value={settings.simplicityWeight} onChange={(v) => updateSetting('simplicityWeight', v)} />
          <Range label="接線重み" min={0} max={2} step={0.01} value={settings.tangentWeight} onChange={(v) => updateSetting('tangentWeight', v)} />
          <Range label="誤差重み" min={0} max={2} step={0.01} value={settings.errorWeight} onChange={(v) => updateSetting('errorWeight', v)} />
          <Range label="補助円の濃さ" min={0} max={1} step={0.01} value={settings.helperOpacity} onChange={(v) => updateSetting('helperOpacity', v)} />
          <Toggle label="補助円を表示" checked={settings.showHelpers} onChange={(v) => updateSetting('showHelpers', v)} />
          <Toggle label="親円を表示" checked={settings.showBoundaryCircles} onChange={(v) => updateSetting('showBoundaryCircles', v)} />
          <Toggle label="薄い補助円を表示" checked={settings.showHelperCircles} onChange={(v) => updateSetting('showHelperCircles', v)} />
          <Toggle label="元画像を薄く重ねる" checked={settings.showImageOverlay} onChange={(v) => updateSetting('showImageOverlay', v)} />
          <Range label="元画像の濃さ" min={0.05} max={0.6} step={0.01} value={settings.imageOverlayOpacity} onChange={(v) => updateSetting('imageOverlayOpacity', v)} />
          <Toggle label="二値化マスクを重ねる" checked={settings.showMaskOverlay} onChange={(v) => updateSetting('showMaskOverlay', v)} />
          <Range label="二値化マスクの濃さ" min={0.05} max={0.7} step={0.01} value={settings.maskOverlayOpacity} onChange={(v) => updateSetting('maskOverlayOpacity', v)} />
        </section>
      </aside>

      <section className="preview-stage">
        <div className="preview-toolbar">
          <span>{imageName}</span>
          <span>{result ? `${result.construction.circles.filter((circle) => circle.visible).length} visible circles / ${result.construction.arcs.length} arcs` : 'ready'}</span>
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
          <h2>提出用エクスポート</h2>
          <div className="export-grid">
            <button onClick={() => exportVariantSvg('final')}>完成SVG</button>
            <button onClick={() => void exportVariantPng('final')}>完成PNG</button>
            <button onClick={() => exportVariantSvg('blueprint')}>設計図SVG</button>
            <button onClick={() => void exportVariantPng('blueprint')}>設計図PNG</button>
            <button onClick={() => exportVariantSvg('process')}>工程SVG</button>
            <button onClick={() => void exportVariantPng('process')}>工程PNG</button>
            <button className="wide-button" onClick={exportReportData}>Report Data JSON</button>
          </div>
        </section>

        <section className="control-group">
          <h2>数式一覧 / 手動ラベル</h2>
          <div className="report-table formula-table">
            {formulaTable.map((row) => (
              <article className="report-row" key={row.arcId}>
                <label className="label-editor">
                  <span>{row.arcId}</span>
                  <input
                    value={arcLabels[row.arcId] ?? ''}
                    placeholder={row.label}
                    onChange={(event) => updateArcLabel(row.arcId, event.target.value)}
                  />
                </label>
                <code>{row.circleEquation}</code>
                <code>{row.parametricEquation}</code>
                <small>
                  {row.circleId} · theta {row.startAngle.toFixed(1)}-{row.endAngle.toFixed(1)} deg · {row.direction} ·
                  center=({row.centerX.toFixed(1)},{row.centerY.toFixed(1)}) · r={row.radius.toFixed(1)} ·
                  arc={row.arcLength.toFixed(1)} · k={row.curvature.toFixed(4)} · fit={row.fitError.toFixed(2)} · support={row.contourSupport.toFixed(2)}
                </small>
              </article>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>微分情報</h2>
          <div className="debug-table">
            {derivativeInfo.map((item) => (
              <code key={item.arcId}>
                {item.arcId} {item.label}: k={item.curvature.toFixed(4)} startVec=({item.startTangentVector.x.toFixed(1)},{item.startTangentVector.y.toFixed(1)}) midVec=({item.midTangentVector.x.toFixed(1)},{item.midTangentVector.y.toFixed(1)}) endVec=({item.endTangentVector.x.toFixed(1)},{item.endTangentVector.y.toFixed(1)}) slopes={formatSlope(item.startSlope)}/{formatSlope(item.midSlope)}/{formatSlope(item.endSlope)}
              </code>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>接続チェック</h2>
          <div className="debug-table">
            {connectionInfo.map((item) => (
              <code key={`${item.fromArcId}-${item.toArcId}`}>
                {item.fromArcId} -&gt; {item.toArcId}: gap={item.positionGap.toFixed(2)} angleDelta={item.tangentAngleDelta.toFixed(1)}deg score={item.tangentContinuityScore.toFixed(2)} {item.connectionType}
              </code>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>Arc Group Merge Debug</h2>
          <div className="debug-table">
            {result?.construction.arcGroupMergeDebug.slice(0, 36).map((group) => (
              <code key={group.groupId}>
                {group.groupId} [{group.memberArcIds.join(', ')}] range={group.contourRange.startIndex}-{group.contourRange.endIndex} original={group.originalError.toFixed(2)} refit={group.refitError.toFixed(2)} ratio={group.errorIncreaseRatio.toFixed(2)} tangent={group.meanTangentDelta.toFixed(1)}/{group.maxTangentDelta.toFixed(1)} score={group.mergeScore.toFixed(2)} {group.merged ? 'merged' : `rejected:${group.rejectionReason}`}
              </code>
            ))}
          </div>
        </section>

        <section className="control-group">
          <h2>Merged Arc Info</h2>
          <div className="debug-table">
            {result?.construction.mergedArcInfo.map((arc) => (
              <code key={arc.newArcId}>
                {arc.newArcId} from=[{arc.mergedFromArcIds.join(', ')}] cx={arc.centerX.toFixed(1)} cy={arc.centerY.toFixed(1)} r={arc.radius.toFixed(1)} start={arc.startAngle.toFixed(1)} end={arc.endAngle.toFixed(1)} fit={arc.fitError.toFixed(2)} arc={arc.arcLength.toFixed(1)}
              </code>
            ))}
          </div>
        </section>

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
                selectedArcs={result.construction.splitArcPieces.filter((piece) => piece.selectedAsBoundary).length} snappedNodes={result.construction.faceDebug.graphNodesCount} graphEdges={result.construction.faceDebug.graphEdgesCount} detectedLoops={result.construction.faceDebug.closedLoopsCount} selectedFillLoops={result.construction.faceDebug.selectedFacesCount} rejectedLoops={result.construction.faceDebug.faceCandidatesCount - result.construction.faceDebug.selectedFacesCount} fallback={String(result.construction.faceDebug.fallbackUsed)} reason={result.construction.faceDebug.emptyReason ?? '-'}
              </code>
            )}
          </div>
        </section>

        <section className="control-group">
          <h2>Redundancy Debug</h2>
          <div className="debug-table">
            {result && (
              <>
                <code>raw={result.construction.faceDebug.rawCandidatesCount ?? 0} afterNms={result.construction.faceDebug.candidatesAfterNms ?? 0} beforeClustering={result.construction.faceDebug.selectedBeforeClustering ?? 0} afterClustering={result.construction.faceDebug.selectedAfterClustering ?? 0} suppressed={result.construction.faceDebug.suppressedCandidates ?? 0} mergedClusters={result.construction.faceDebug.mergedClusters ?? 0}</code>
                {result.construction.circles.filter((circle) => circle.id.startsWith('OC') && (circle.selectedStep ?? 1) > 0).slice(0, 18).map((circle) => (
                  <code key={`cluster-${circle.id}`}>cluster={circle.id} representative={circle.id} cx={circle.centerX.toFixed(1)} cy={circle.centerY.toFixed(1)} r={circle.radius.toFixed(1)} score={circle.score.toFixed(2)} segment={circle.selectedStep ?? '-'} reason=representative_after_redundancy_nms</code>
                ))}
              </>
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
              <code key={face.id}>{face.id} source={face.source} closed=true disconnected={face.parentFaceId ? 'false' : 'true'} area={face.area.toFixed(1)} centroid=({face.centroid.x.toFixed(1)}, {face.centroid.y.toFixed(1)}) edges={face.numEdges} insideMaskScore={face.insideMaskScore.toFixed(2)} nestingDepth={face.nestingDepth ?? 0} parent={face.parentFaceId ?? '-'} {face.selected ? 'selected' : `rejected:${face.rejectionReason}`}</code>
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

function makeLightweightDebug(analysis: ReturnType<typeof imageDataToAnalysis>): CircleFittingDebugData {
  const contourMask = pointsToMask(analysis.contourPoints, analysis.width, analysis.height);
  const segmentMask = segmentsToMask(analysis.contourPoints, analysis.contourSegments, analysis.width, analysis.height);
  const emptyMask = new Uint8Array(analysis.width * analysis.height);
  return {
    cleanedMask: analysis.mask,
    extractedContour: analysis.edge,
    contourImage: contourMask,
    smoothedContour: contourMask,
    contourSegments: segmentMask,
    simplifiedContour: contourMask,
    distanceTransform: new Float32Array(analysis.width * analysis.height),
    allRawCircleCandidates: [],
    arcCandidates: [],
    fillCandidates: [],
    selectedAddCircles: [],
    selectedSubtractCircles: [],
    rejectedCandidates: [],
    contourCoverage: contourMask,
    contourCoverageImage: contourMask,
    finalGeometryBeforeSubtract: emptyMask,
    overfillRegion: emptyMask,
    falsePositiveRegion: emptyMask,
    falseNegativeRegion: emptyMask,
    finalGeometryAfterSubtract: emptyMask,
    shapeOptimization: {
      initialAddCircleIds: [],
      initialSubtractCircleIds: [],
      optimizedAddCircleIds: [],
      optimizedSubtractCircleIds: [],
      initialScore: 0,
      optimizedScore: 0,
      iterations: 0,
      acceptedRoleFlips: [],
      acceptedAdditions: 0,
      acceptedRemovals: 0,
    },
    selectionSteps: [],
  };
}

function makeLightweightDebugImages(debug: CircleFittingDebugData, construction: ConstructionData, width: number, height: number): DebugImage[] {
  return [
    { label: 'cleaned mask', url: maskToDebugDataUrl(debug.cleanedMask, width, height, '#111111') },
    { label: 'extracted contour', url: maskToDebugDataUrl(debug.extractedContour, width, height, '#0f766e') },
    { label: 'contour segments', url: segmentMaskToDebugDataUrl(debug.contourSegments, width, height) },
    { label: 'selected faces', url: facesToDataUrl(construction.faces, width, height, true) },
  ];
}

function pointsToMask(points: Array<{ x: number; y: number }>, width: number, height: number) {
  const mask = new Uint8Array(width * height);
  for (const point of points) {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x] = 1;
  }
  return mask;
}

function segmentsToMask(points: Array<{ x: number; y: number }>, segments: number[][], width: number, height: number) {
  const mask = new Uint8Array(width * height);
  segments.forEach((segment, segmentIndex) => {
    for (const index of segment) {
      const point = points[index];
      if (!point) continue;
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x] = (segmentIndex % 3) + 1;
    }
  });
  return mask;
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
      arcGroupMergeDebug: construction.arcGroupMergeDebug,
      mergedArcInfo: construction.mergedArcInfo,
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

async function downloadSvgAsPng(svg: string, width: number, height: number, filename: string) {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    URL.revokeObjectURL(url);
    return;
  }
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
  canvas.toBlob((png) => {
    if (!png) return;
    const pngUrl = URL.createObjectURL(png);
    triggerDownload(filename, pngUrl);
    URL.revokeObjectURL(pngUrl);
  }, 'image/png');
}

function formatSlope(value: number | null) {
  return value === null ? 'vertical' : value.toFixed(2);
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
