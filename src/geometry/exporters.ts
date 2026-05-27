import type { CircleRole, ConstructionData } from './types';

export function maskToSvgPath(mask: Uint8Array, width: number, height: number, cell = 2) {
  const commands: string[] = [];
  for (let y = 0; y < height; y += cell) {
    let start = -1;
    for (let x = 0; x <= width; x += cell) {
      const filled = x < width && mask[y * width + x] === 1;
      if (filled && start === -1) start = x;
      if ((!filled || x >= width) && start !== -1) {
        commands.push(`M ${start} ${y} H ${x} V ${Math.min(height, y + cell)} H ${start} Z`);
        start = -1;
      }
    }
  }
  return commands.join(' ');
}

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
            const stroke = circle.role === 'subtract' ? '#9b6b5d' : circle.role === 'add' ? '#747b84' : '#8b9099';
            const dash = circle.role === 'helper' ? ' stroke-dasharray="4 5"' : '';
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
          return `<path d="M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${circle.radius.toFixed(2)} ${circle.radius.toFixed(2)} 0 ${sweep} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}" fill="none" stroke="#5f6570" stroke-width="2.2" vector-effect="non-scaling-stroke" opacity="${Math.min(0.85, helperOpacity + 0.2).toFixed(2)}" />`;
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
  const regionCircles = construction.circles.filter((circle) => circle.role === 'add' || circle.role === 'subtract');

  if (regionCircles.length === 0) return '';

  const orderedMarkup = regionCircles
    .map(
      (circle) =>
        `<circle cx="${circle.centerX.toFixed(2)}" cy="${circle.centerY.toFixed(2)}" r="${circle.radius.toFixed(2)}" fill="${circle.role === 'add' ? 'white' : 'black'}" />`,
    )
    .join('\n');

  return `<defs>
    <mask id="circle-silhouette-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${construction.width}" height="${construction.height}">
      <rect width="${construction.width}" height="${construction.height}" fill="black"/>
      ${orderedMarkup}
    </mask>
  </defs>
  <rect width="${construction.width}" height="${construction.height}" fill="#111111" mask="url(#circle-silhouette-mask)"/>`;
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
