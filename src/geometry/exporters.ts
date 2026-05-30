import type { CircleRole, ConstructionData } from './types';

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
    ? construction.circles
        .filter((circle) => circle.visible && (roleVisibility[circle.role] ?? true))
        .map(
          (circle) => {
            const stroke = circle.role === 'subtract' ? '#a34835' : circle.role === 'add' ? '#59616d' : circle.role === 'boundary' ? '#7a8594' : '#9ba0a8';
            const dash = circle.role === 'subtract' ? ' stroke-dasharray="6 4"' : circle.role === 'helper' ? ' stroke-dasharray="4 5"' : '';
            return `<circle cx="${circle.centerX.toFixed(2)}" cy="${circle.centerY.toFixed(2)}" r="${circle.radius.toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="1.4" vector-effect="non-scaling-stroke" opacity="${helperOpacity.toFixed(2)}"${dash} />`;
          },
        )
        .join('\n')
    : '';

  const arcMarkup = showHelpers
    ? construction.arcs
        .map((arc) => {
          const circle = construction.circles.find((item) => item.id === arc.circleId);
          if (!circle) return '';
          if (!(roleVisibility[circle.role] ?? true)) return '';
          const start = polar(circle.centerX, circle.centerY, circle.radius, arc.startAngle);
          const end = polar(circle.centerX, circle.centerY, circle.radius, arc.endAngle);
          const sweep = ((arc.endAngle - arc.startAngle + 360) % 360) > 180 ? 1 : 0;
          const stroke = circle.role === 'subtract' ? '#b44732' : circle.usedInFinal ? '#252a31' : '#6f7680';
          const width = circle.usedInFinal ? 3.1 : 2.1;
          const dash = circle.role === 'subtract' ? ' stroke-dasharray="7 4"' : '';
          return `<path d="M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${circle.radius.toFixed(2)} ${circle.radius.toFixed(2)} 0 ${sweep} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="${width}" vector-effect="non-scaling-stroke" opacity="${Math.min(0.92, helperOpacity + 0.25).toFixed(2)}"${dash} />`;
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
