async function init() {
  const grid = document.getElementById('cursor-grid');
  if (!grid)
    throw new Error(`No grid element!`);

  try {
    const response = await fetch('./cursors.json');

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    /** @type {Record<string, { url: string, x: number, y: number }>} */
    const generatedCursors = await response.json();

    Object.entries(generatedCursors).forEach(([cursorName, data]) => {
      // 1. Build standard CSS cursor string: url('...data...') x y, fallback
      const cssCursorString = `url("${data.url}") ${data.x} ${data.y}, ${cursorName}`;

      // 2. Create the wrapper box element
      const box = document.createElement('div');
      box.className = 'cursor-box';
      box.style.cursor = cssCursorString;

      // 3. Populate inner HTML with the SVG image and the absolute-positioned red dot
      box.innerHTML = `
            <div class="visual-preview">
              <img src="${data.url}" alt="${cursorName} preview" />
              <div class="hotspot-dot" style="left: ${data.x}px; top: ${data.y}px;"></div>
            </div>
            <div class="cursor-name">${cursorName}</div>
            <div class="cursor-meta">x: ${data.x}, y: ${data.y}</div>
          `;

      grid.appendChild(box);
    });

  } catch (error) {
    console.error("Failed to load cursors.json:", error);
    grid.innerHTML = `<div class="error-msg">Failed to load cursors.json.<br><br>Make sure you are running a local web server (e.g., npx serve or python -m http.server) and not just opening the file via file:// protocol.</div>`;
  }
}

init();
