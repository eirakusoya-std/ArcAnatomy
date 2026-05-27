import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileJson, ImageUp, Play, RefreshCw, Save, SlidersHorizontal } from 'lucide-react';
import { generateCircleCandidates } from './geometry/circleFitting';
import { buildConstruction } from './geometry/reconstruction';
import { imageDataToAnalysis } from './geometry/imageProcessing';
import { buildSvg, downloadText, triggerDownload } from './geometry/exporters';
import type { CircleRole, ConstructionData, GeneratorSettings } from './geometry/types';

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
};

interface ResultState {
  construction: ConstructionData;
  maskOverlayUrl: string;
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
    const circles = generateCircleCandidates(analysis, settings);
    const construction = buildConstruction(analysis, circles);
    const maskOverlayUrl = maskToOverlayDataUrl(analysis.mask, analysis.width, analysis.height);
    setResult({ construction, maskOverlayUrl });
  }

  function updateSetting<K extends keyof GeneratorSettings>(key: K, value: GeneratorSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function exportJson() {
    if (!result) return;
    downloadText(`${imageName}-circle-construction.json`, JSON.stringify(result.construction, null, 2), 'application/json');
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
