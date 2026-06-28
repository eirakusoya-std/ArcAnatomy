import type { CircleRole, ConstructionData } from './types';

type DisplayHelperCircle = { cx: number; cy: number; r: number; role: CircleRole };

export function buildSvg(
  construction: ConstructionData,
  helperOpacity: number,
  showHelpers = true,
  imageOverlayUrl = '',
  imageOverlayOpacity = 0,
  maskOverlayUrl = '',
  maskOverlayOpacity = 0,
  roleVisibility: Partial<Record<CircleRole, boolean>> = {},
) {
  const silhouetteMarkup = buildVectorSilhouette(construction);
  const imageOverlayMarkup =
    imageOverlayUrl && imageOverlayOpacity > 0
      ? `<image href="${escapeAttribute(imageOverlayUrl)}" x="0" y="0" width="${construction.width}" height="${construction.height}" preserveAspectRatio="none" opacity="${imageOverlayOpacity.toFixed(2)}" />`
      : '';
  const maskOverlayMarkup =
    maskOverlayUrl && maskOverlayOpacity > 0
      ? `<image href="${escapeAttribute(maskOverlayUrl)}" x="0" y="0" width="${construction.width}" height="${construction.height}" preserveAspectRatio="none" opacity="${maskOverlayOpacity.toFixed(2)}" />`
      : '';
  const helperMarkup = showHelpers
    ? buildDisplayedHelperCircles(construction, roleVisibility)
        .map(
          (circle) => {
            const stroke = circle.role === 'subtract' ? '#a34835' : circle.role === 'add' ? '#59616d' : circle.role === 'boundary' ? '#7a8594' : '#9ba0a8';
            const dash = circle.role === 'subtract' ? ' stroke-dasharray="6 4"' : circle.role === 'helper' ? ' stroke-dasharray="4 5"' : '';
            return `<circle cx="${circle.cx.toFixed(2)}" cy="${circle.cy.toFixed(2)}" r="${circle.r.toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="1.4" vector-effect="non-scaling-stroke" opacity="${helperOpacity.toFixed(2)}"${dash} />`;
          },
        )
        .join('\n')
    : '';

  const arcMarkup = showHelpers
    ? construction.faces
        .filter((face) => face.selected)
        .flatMap((face) => face.arcPieces)
        .map((piece) => {
          const circle = construction.circles.find((item) => item.id === piece.circleId);
          if (circle && !(roleVisibility[circle.role] ?? true)) return '';
          return arcPieceToStrokePath(piece, Math.min(0.92, helperOpacity + 0.25));
        })
        .join('\n')
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${construction.width}" height="${construction.height}" viewBox="0 0 ${construction.width} ${construction.height}">
  <rect width="100%" height="100%" fill="#f7f4ed"/>
  ${silhouetteMarkup}
  ${imageOverlayMarkup}
  ${maskOverlayMarkup}
  ${helperMarkup}
  ${arcMarkup}
</svg>`;
}

function buildVectorSilhouette(construction: ConstructionData) {
  const selectedLoops = construction.faces.filter((face) => face.selected && face.arcPieces.length > 0);
  if (selectedLoops.length === 0) return '';
  const paths = selectedLoops.map(arcLoopToPath).filter(Boolean).join('\n');
  return `<path data-fill-mode="arc-loops" data-shape-expression="selected circular arcs -> closed arc loops -> fill inside loops" d="${paths}" fill="#111111" fill-rule="evenodd"/>`;
}

function arcLoopToPath(face: ConstructionData['faces'][number]) {
  if (face.arcPieces.length === 0) return '';
  const first = face.arcPieces[0];
  const commands = [`M ${first.startPoint.x.toFixed(2)} ${first.startPoint.y.toFixed(2)}`];
  for (const piece of face.arcPieces) {
    const span = piece.direction === 'ccw'
      ? ((piece.endAngle - piece.startAngle) % 360 + 360) % 360
      : ((piece.startAngle - piece.endAngle) % 360 + 360) % 360;
    const largeArcFlag = span > 180 ? 1 : 0;
    const sweepFlag = piece.direction === 'ccw' ? 1 : 0;
    commands.push(`A ${piece.r.toFixed(2)} ${piece.r.toFixed(2)} 0 ${largeArcFlag} ${sweepFlag} ${piece.endPoint.x.toFixed(2)} ${piece.endPoint.y.toFixed(2)}`);
  }
  commands.push('Z');
  return commands.join(' ');
}

function arcPieceToStrokePath(piece: ConstructionData['faces'][number]['arcPieces'][number], opacity: number) {
  const span = piece.direction === 'ccw'
    ? ((piece.endAngle - piece.startAngle) % 360 + 360) % 360
    : ((piece.startAngle - piece.endAngle) % 360 + 360) % 360;
  const largeArcFlag = span > 180 ? 1 : 0;
  const sweepFlag = piece.direction === 'ccw' ? 1 : 0;
  return `<path d="M ${piece.startPoint.x.toFixed(2)} ${piece.startPoint.y.toFixed(2)} A ${piece.r.toFixed(2)} ${piece.r.toFixed(2)} 0 ${largeArcFlag} ${sweepFlag} ${piece.endPoint.x.toFixed(2)} ${piece.endPoint.y.toFixed(2)}" fill="none" stroke="#252a31" stroke-width="3.1" vector-effect="non-scaling-stroke" opacity="${opacity.toFixed(2)}" />`;
}

function buildDisplayedHelperCircles(
  construction: ConstructionData,
  roleVisibility: Partial<Record<CircleRole, boolean>>,
) {
  const visibleBoundaryLimit = construction.circles.filter((circle) => circle.visible && circle.role === 'boundary').length;
  const arcDerived = (roleVisibility.boundary ?? true)
    ? uniqueHelperCircles(
        construction.faces
          .filter((face) => face.selected)
          .flatMap((face) => face.arcPieces)
          .map(svgCircleFromArcPiece)
          .filter((circle): circle is DisplayHelperCircle => Boolean(circle)),
      ).slice(0, Math.max(0, visibleBoundaryLimit))
    : [];
  const nonBoundary = construction.circles
    .filter((circle) => circle.visible && circle.role !== 'boundary' && (roleVisibility[circle.role] ?? true))
    .map((circle) => ({ cx: circle.centerX, cy: circle.centerY, r: circle.radius, role: circle.role }));
  return [...arcDerived, ...nonBoundary];
}

function svgCircleFromArcPiece(piece: ConstructionData['faces'][number]['arcPieces'][number]): DisplayHelperCircle | undefined {
  const span = piece.direction === 'ccw'
    ? ((piece.endAngle - piece.startAngle) % 360 + 360) % 360
    : ((piece.startAngle - piece.endAngle) % 360 + 360) % 360;
  const largeArcFlag = span > 180 ? 1 : 0;
  const sweepFlag = piece.direction === 'ccw' ? 1 : 0;
  const circle = svgCircleFromArc(
    piece.startPoint.x,
    piece.startPoint.y,
    piece.endPoint.x,
    piece.endPoint.y,
    piece.r,
    largeArcFlag,
    sweepFlag,
  );
  return circle ? { ...circle, role: 'boundary' as const } : undefined;
}

function svgCircleFromArc(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius: number,
  largeArcFlag: number,
  sweepFlag: number,
) {
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const chordHalfSquared = dx * dx + dy * dy;
  if (chordHalfSquared < 0.000001) return undefined;
  let r = Math.max(0.001, radius);
  const lambda = chordHalfSquared / (r * r);
  if (lambda > 1) r *= Math.sqrt(lambda);
  const numerator = Math.max(0, r * r - chordHalfSquared);
  const coefficient = (largeArcFlag === sweepFlag ? -1 : 1) * Math.sqrt(numerator / chordHalfSquared);
  const cx = (x1 + x2) / 2 + coefficient * dy;
  const cy = (y1 + y2) / 2 - coefficient * dx;
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return undefined;
  return { cx, cy, r };
}

function uniqueHelperCircles(circles: DisplayHelperCircle[]) {
  const out: DisplayHelperCircle[] = [];
  for (const circle of circles) {
    const duplicate = out.some((other) => {
      const minRadius = Math.max(1, Math.min(circle.r, other.r));
      return Math.hypot(circle.cx - other.cx, circle.cy - other.cy) <= Math.max(8, minRadius * 0.08)
        && Math.abs(circle.r - other.r) <= Math.max(4, minRadius * 0.06);
    });
    if (!duplicate) out.push(circle);
  }
  return out;
}

export function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  triggerDownload(filename, url);
  URL.revokeObjectURL(url);
}

export function triggerDownload(filename: string, url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function polar(cx: number, cy: number, radius: number, angle: number) {
  const radians = (angle * Math.PI) / 180;
  return { x: cx + Math.cos(radians) * radius, y: cy + Math.sin(radians) * radius };
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
