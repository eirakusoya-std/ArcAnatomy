import type { ImageAnalysis, Point } from './types';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function imageDataToAnalysis(
  imageData: ImageData,
  threshold: number,
  blurRadius: number,
  edgeStrength: number,
): ImageAnalysis {
  const { width, height, data } = imageData;
  const gray = new Float32Array(width * height);

  for (let i = 0; i < width * height; i += 1) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3] / 255;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = 255 - (luminance * a + 255 * (1 - a));
  }

  const blurred = boxBlur(gray, width, height, blurRadius);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < blurred.length; i += 1) {
    mask[i] = blurred[i] >= threshold ? 1 : 0;
  }

  const cleanedLines = majorityFilter(mask, width, height, edgeStrength);
  const cleaned = fillLineArtIfNeeded(cleanedLines, width, height);
  const edge = extractEdges(cleaned, width, height);
  const contourPoints = sampleContour(edge, width, height, Math.max(1, Math.round(3 + edgeStrength)));
  const stats = computeStats(cleaned, width, height);

  return {
    width,
    height,
    mask: cleaned,
    edge,
    contourPoints,
    centroid: stats.centroid,
    bounds: stats.bounds,
  };
}

function fillLineArtIfNeeded(mask: Uint8Array, width: number, height: number): Uint8Array {
  const stats = computeStats(mask, width, height);
  const boundsArea = Math.max(1, (stats.bounds.maxX - stats.bounds.minX + 1) * (stats.bounds.maxY - stats.bounds.minY + 1));
  let ink = 0;
  for (const value of mask) ink += value;
  const density = ink / boundsArea;

  // Thin drawings often arrive as outlines. Fill regions not connected to the canvas edge
  // so circle fitting sees the intended shape instead of only the stroke pixels.
  if (density > 0.18) return mask;

  const outside = new Uint8Array(mask.length);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * width + x;
    if (outside[i] || mask[i]) return;
    outside[i] = 1;
    queue.push(i);
  };

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  for (let head = 0; head < queue.length; head += 1) {
    const i = queue[head];
    const x = i % width;
    const y = Math.floor(i / width);
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }

  const filled = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    filled[i] = mask[i] || !outside[i] ? 1 : 0;
  }
  return majorityFilter(filled, width, height, 1);
}

function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.round(radius);
  if (r <= 0) return src;
  const dst = new Float32Array(src.length);
  const area = (r * 2 + 1) * (r * 2 + 1);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let yy = -r; yy <= r; yy += 1) {
        for (let xx = -r; xx <= r; xx += 1) {
          const sx = clamp(x + xx, 0, width - 1);
          const sy = clamp(y + yy, 0, height - 1);
          sum += src[sy * width + sx];
        }
      }
      dst[y * width + x] = sum / area;
    }
  }

  return dst;
}

function majorityFilter(mask: Uint8Array, width: number, height: number, passes: number): Uint8Array {
  let current = mask;
  const count = Math.max(1, Math.round(passes));
  for (let pass = 0; pass < count; pass += 1) {
    const next = new Uint8Array(current.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let neighbors = 0;
        for (let yy = -1; yy <= 1; yy += 1) {
          for (let xx = -1; xx <= 1; xx += 1) {
            const sx = x + xx;
            const sy = y + yy;
            if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
              neighbors += current[sy * width + sx];
            }
          }
        }
        next[y * width + x] = neighbors >= 5 ? 1 : 0;
      }
    }
    current = next;
  }
  return current;
}

function extractEdges(mask: Uint8Array, width: number, height: number): Uint8Array {
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

function sampleContour(edge: Uint8Array, width: number, height: number, step: number): Point[] {
  const points: Point[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (edge[y * width + x]) points.push({ x, y });
    }
  }
  return points;
}

function computeStats(mask: Uint8Array, width: number, height: number) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      sumX += x;
      sumY += y;
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (count === 0) {
    return {
      centroid: { x: width / 2, y: height / 2 },
      bounds: { minX: width * 0.25, minY: height * 0.25, maxX: width * 0.75, maxY: height * 0.75 },
    };
  }

  return {
    centroid: { x: sumX / count, y: sumY / count },
    bounds: { minX, minY, maxX, maxY },
  };
}
