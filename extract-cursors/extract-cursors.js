import fs from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { svgPathBbox } from 'svg-path-bbox';
import svgpath from 'svgpath';
import { optimize } from 'svgo';

const BASE_URL = 'https://raw.githubusercontent.com/phosphor-icons/core/main';

// In-memory cache to prevent re-downloading the same base SVGs
/** @type {Map<string, string>} */
const svgCache = new Map();

const $defaultCursor = cheerio.load(
  await fetchSvg('raw/duotone/cursor-duotone.svg'),
  { xml: true }
);
const defaultCursorBBox = getBBox($defaultCursor, $defaultCursor('svg'));
$defaultCursor('[d]').each((_, el) => {
  const $el = $defaultCursor(el);
  const d = $el.attr('d');
  if (d) {
    $el.attr('d', svgpath(d)
      .rotate(18, defaultCursorBBox.minX, defaultCursorBBox.minY)
      .toString()
    );
  }
});
svgCache.set('<cursor>', $defaultCursor.html('svg'));

/**
 * @typedef {(
 *  {
 *    id: string, filename: string, hotspot: 'center' | 'top-left' | 'pointer',
 *    overlay?: string, rotate?: number, empty?: boolean,
 *    multitone?: boolean, overlayMultitone?: boolean
 *  } | { id: string, empty: true }
 * )} CursorConfig
 */

/**
 * @type {CursorConfig[]}
 */
const cursorConfig = [
  { id: 'default', filename: '<cursor>', hotspot: 'top-left' },
  { id: 'none', empty: true },
  { id: 'context-menu', filename: '<cursor>', hotspot: 'top-left', overlay: 'raw/duotone/article-duotone.svg' },
  { id: 'help', filename: 'assets/duotone/question-duotone.svg', hotspot: 'center' },
  { id: 'pointer', filename: 'raw/duotone/hand-pointing-duotone.svg', hotspot: 'pointer' },
  { id: 'progress', filename: '<cursor>', hotspot: 'top-left', overlay: 'raw/bold/spinner-gap-bold.svg' },
  { id: 'wait', filename: 'raw/duotone/spinner-ball-duotone.svg', hotspot: 'center', multitone: true },
  { id: 'cell', filename: 'assets/regular/grid-four.svg', hotspot: 'center' },
  { id: 'crosshair', filename: 'assets/thin/plus-thin.svg', hotspot: 'center' },
  { id: 'text', filename: 'raw/light/cursor-text-light.svg', hotspot: 'center' },
  { id: 'vertical-text', filename: 'raw/light/cursor-text-light.svg', hotspot: 'center', rotate: 90 },
  { id: 'alias', filename: '<cursor>', hotspot: 'top-left', overlay: 'raw/bold/arrow-u-up-right-bold.svg', overlayMultitone: true },
  { id: "copy", filename: "<cursor>", hotspot: "top-left", overlay: "raw/duotone/copy-duotone.svg", overlayMultitone: true },
  { id: 'move', filename: 'assets/regular/arrows-out-cardinal.svg', hotspot: 'center' },
  { id: 'no-drop', filename: 'assets/regular/prohibit-inset.svg', hotspot: 'center' },
  { id: 'not-allowed', filename: 'assets/regular/prohibit.svg', hotspot: 'center' },
  { id: 'grab', filename: 'assets/duotone/hand-duotone.svg', hotspot: 'center' },
  { id: 'grabbing', filename: 'assets/duotone/hand-grabbing-duotone.svg', hotspot: 'center' },
  { id: 'all-scroll', filename: 'assets/regular/arrows-out-cardinal.svg', hotspot: 'center' },
  { id: 'col-resize', filename: 'assets/regular/arrows-horizontal.svg', hotspot: 'center' },
  { id: 'row-resize', filename: 'assets/regular/arrows-vertical.svg', hotspot: 'center' },
  { id: 'n-resize', filename: 'assets/regular/arrow-up.svg', hotspot: 'center' },
  { id: 'e-resize', filename: 'assets/regular/arrow-right.svg', hotspot: 'center' },
  { id: 's-resize', filename: 'assets/regular/arrow-down.svg', hotspot: 'center' },
  { id: 'w-resize', filename: 'assets/regular/arrow-left.svg', hotspot: 'center' },
  { id: 'ne-resize', filename: 'assets/regular/arrow-up-right.svg', hotspot: 'center' },
  { id: 'nw-resize', filename: 'assets/regular/arrow-up-left.svg', hotspot: 'center' },
  { id: 'se-resize', filename: 'assets/regular/arrow-down-right.svg', hotspot: 'center' },
  { id: 'sw-resize', filename: 'assets/regular/arrow-down-left.svg', hotspot: 'center' },
  { id: 'ew-resize', filename: 'assets/regular/arrows-horizontal.svg', hotspot: 'center' },
  { id: 'ns-resize', filename: 'assets/regular/arrows-vertical.svg', hotspot: 'center' },
  { id: 'nesw-resize', filename: 'assets/regular/arrows-vertical.svg', hotspot: 'center', rotate: 45 },
  { id: 'nwse-resize', filename: 'assets/regular/arrows-vertical.svg', hotspot: 'center', rotate: -45 },
  { id: 'zoom-in', filename: 'assets/duotone/magnifying-glass-plus-duotone.svg', hotspot: 'center' },
  { id: 'zoom-out', filename: 'assets/duotone/magnifying-glass-minus-duotone.svg', hotspot: 'center' }
];

/**
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function fetchSvg(filename) {
  const cached = svgCache.get(filename);
  if (cached != undefined) return cached;

  const response = await fetch(`${BASE_URL}/${filename}`);
  if (!response.ok) throw new Error(`Failed to fetch ${filename}: ${response.statusText}`);
  const text = await response.text();
  svgCache.set(filename, text);
  return text;
}

/**
 * @param {cheerio.CheerioAPI} $
 * @param {boolean | undefined} isMultitone 
 */
function handleOpacity($, isMultitone) {
  // --- Handle Base SVG coloring & transparency ---
  if (isMultitone) {
    const $layer2 = $('svg').clone();
    $('path, rect, circle, polyline, polygon, line').each((_, el) => {
      const $el = $(el);
      const stroke = $el.closest('[stroke]').attr('stroke');
      if (stroke) {
        $el.attr('fill', 'white');
        return;
      }
    });
    $layer2.find('[opacity]').removeAttr('opacity').attr('fill', 'gray');
    $('svg').append($layer2.children());
  } else {
    $('[opacity]').removeAttr('opacity').attr('fill', 'white');
  }
  // ----------------------------------------------------
}

/**
 * @param {cheerio.CheerioAPI} $ 
 * @param {cheerio.Cheerio<import('domhandler').AnyNode>} $el 
 */
function getBBox($, $el) {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  // 1. Calculate Bounding Box of Base Paths
  $el.find('[d]').each((_, el) => {
    const $el = $(el);
    const d = $el.attr('d');
    if (d) {
      const [pMinX, pMinY, pMaxX, pMaxY] = svgPathBbox(d);
      let padding = 0;
      if (
        ($el.closest('[stroke]')
          .attr('stroke') || 'none') !== 'none'
      ) {
        padding = parseFloat(
          $el.closest('[stroke-width]')
            .attr('stroke-width') || '1'
        ) / 2;
      }
      minX = Math.min(minX, pMinX - padding);
      minY = Math.min(minY, pMinY - padding);
      maxX = Math.max(maxX, pMaxX + padding);
      maxY = Math.max(maxY, pMaxY + padding);
    }
  });

  if (maxX === -Infinity)
    maxX = 256;
  if (maxY === -Infinity)
    maxY = 256;
  if (minX === Infinity)
    minX = 0;
  if (minY === Infinity)
    minY = 0;

  return { minX, minY, maxX, maxY };
}

/**
 * 
 * @param {CursorConfig} config 
 * @param {*} padding 
 * @returns 
 */
async function processCursor(config, padding = 4) {
  // Handle empty cursor (none)
  if (config.empty) {
    return {
      url: "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'/%3E",
      x: 0,
      y: 0
    };
  }

  const svgContent = await fetchSvg(config.filename);
  const $ = cheerio.load(svgContent, { xml: true });
  const $svg = $('svg');

  handleOpacity($, config.multitone);

  const { minX, minY, maxX, maxY } = getBBox($, $svg);

  const width = maxX - minX;
  const height = maxY - minY;
  const size = Math.max(width, height);
  const cx = minX + width / 2;
  const cy = minY + height / 2;

  // 2. Handle Rotations
  if (config.rotate) {
    const $children = $svg.children();
    $svg.empty();
    const $g = $('<g>').attr('transform', `rotate(${config.rotate}, ${cx}, ${cy})`);
    $g.append($children);
    $svg.append($g);
  }

  // 3. Handle Overlays
  if (config.overlay) {
    const overlaySvg = await fetchSvg(config.overlay);
    const $overlayDoc = cheerio.load(overlaySvg, { xml: true });

    handleOpacity($overlayDoc, config.overlayMultitone);

    $overlayDoc('svg, [stroke-width]').each((_, el) => {
      const $el = $overlayDoc(el);
      $el.attr('stroke-width',
        String(parseFloat($el.attr('stroke-width') || '1') * 1.5)
      );
    })
    const $overlay = $overlayDoc('svg');
    const oBBox = getBBox($overlayDoc, $overlay);
    const oWidth = oBBox.maxX - oBBox.minX;

    // Scale down to 50% and move to top right quadrant
    const $g = $('<g>').attr(
      'transform',
      `translate(-20, 20) translate(${oWidth}, 0) scale(0.6) translate(${-oWidth}, 0)`
    );
    $g.append($overlay.children());
    $svg.append($g);
  }

  // 4. Calculate Final ViewBox (Perfect Square)
  const vMinX = (minX + maxX) / 2 - size / 2 - padding;
  const vMinY = (minY + maxY) / 2 - size / 2 - padding;
  const vSize = size + padding * 2;

  $svg.attr('viewBox', `${vMinX} ${vMinY} ${vSize} ${vSize}`);
  $svg.attr('width', '16');
  $svg.attr('height', '16');
  $svg.removeAttr('fill');

  // 5. Generate Safe Data URL
  const finalSvgString = $.html('svg');
  const optimizedSvgURL = optimize(finalSvgString, {
    multipass: true,
    datauri: 'enc'
  }).data;

  // 6. Map Hotspots
  const scale = 16 / vSize;
  let hotspotX = 8, hotspotY = 8; // Default Center

  if (config.hotspot === 'top-left') {
    hotspotX = Math.round((minX - vMinX) * scale);
    hotspotY = Math.round((minY - vMinY) * scale);
  } else if (config.hotspot === 'pointer') {
    hotspotX = 7;
    hotspotY = Math.round((minY - vMinY) * scale);
  }

  return {
    url: optimizedSvgURL,
    x: hotspotX,
    y: hotspotY
  };
}

async function build() {
  /** @type {Record<string, { url: string, x: number, y: number }>} */
  const finalOutput = {};
  console.log('Downloading and compiling cursors...\n');

  for (const config of cursorConfig) {
    try {
      const cursorData = await processCursor(config);
      finalOutput[config.id] = cursorData;
      console.log(`✅ Processed: ${config.id}`);
    } catch (err) {
      console.error(`❌ Error on ${config.id}:`, String(err));
    }
  }

  await fs.writeFile('cursors.json', JSON.stringify(finalOutput));
  console.log('\nSuccess! Complete cursor map saved to cursors.json');
}

build();
