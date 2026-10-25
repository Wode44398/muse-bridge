// visualize 的 read_me 指南（bridge 自写，模型读的部分保持英文）。
//
// 结构对齐官方 Claude Desktop 的 visualize（read_me 按 modules + platform 拼段落、去重、首尾固定），
// 但文字是 bridge 自己写的精简版——官方指南与 widget 壳是专有代码 / 文案，不搬原文（见调研报告 A3 §4、B3 §6）。
// 宿主接口名（CSS 变量、c-* 色带类、t/ts/th 文本类、#arrow 箭头、sendPrompt/openLink）与官方同名：模型按这些
// 名字写代码，前端壳（web/src/lib/widgetShell.js）提供同一套名字。
//
// bridge 的特殊约束写在 BASE 最前面：手机 apk 里图表【不运行脚本】（原生桥注入所有帧，见 WidgetFrame.svelte），
// 所以先用纯 SVG / HTML+CSS 画出完整静态结果，脚本只做增强。

export const MODULES = ['diagram', 'mockup', 'interactive', 'data_viz', 'art', 'chart', 'elicitation'];
export const PLATFORMS = ['mobile', 'desktop', 'unknown'];

// 色带（9 条 × 7 档：50 最浅 → 900 最深）。前端壳的 c-* 类用同一张表（widgetShell.js RAMPS），改一处记得改另一处。
export const RAMPS = {
  purple: ['#F0EEFB', '#D6D1F5', '#B6AEEB', '#8A7FD8', '#5E52B5', '#3F3687', '#29235A'],
  teal: ['#E3F4EE', '#A9DFCB', '#6CC6A6', '#2A9D78', '#157055', '#0B4F3D', '#06342A'],
  coral: ['#FBEDE7', '#F4C8B6', '#EC9F80', '#D86B45', '#A64A27', '#763318', '#4C200F'],
  pink: ['#FBECF1', '#F2C3D3', '#E897B4', '#D25E87', '#9E3B5D', '#712A43', '#49192B'],
  gray: ['#F2F1EC', '#D8D6CE', '#BAB8AF', '#8C8A83', '#63615C', '#464542', '#2D2C2A'],
  blue: ['#E8F1FB', '#BAD5F2', '#89B7E8', '#4189D6', '#1F62A6', '#12467A', '#0A2E51'],
  green: ['#ECF4E2', '#C5DEA2', '#9BC56A', '#69992F', '#426D18', '#2D4F0E', '#1B3407'],
  amber: ['#FBF0DC', '#F6CC85', '#EBA53A', '#BC7A1C', '#8A540F', '#653C08', '#432804'],
  red: ['#FCEDEC', '#F5C5C3', '#EC9995', '#DC5550', '#A93432', '#7C2322', '#521716'],
};
export const RAMP_STOPS = [50, 100, 200, 400, 600, 800, 900];

const BASE = (w) => `# Inline visuals — drawing guide

You draw SVG diagrams and small HTML widgets with show_widget; they render inside the conversation, exactly where you call the tool. Treat a visual as part of your reply, not as a separate page.

## Modules
Call read_me again with \`modules\` for detailed guidance — pick every one that fits:
- \`diagram\` — flowcharts, architecture / structural diagrams, illustrative diagrams (SVG)
- \`mockup\` — UI mockups, cards, forms, dashboards (HTML)
- \`interactive\` — explainers with controls: sliders, toggles, steppers (HTML + JS)
- \`chart\` / \`data_viz\` — charts and data displays
- \`art\` — illustration and generative art
- \`elicitation\` — a small form that collects the user's choices and hands them back with sendPrompt

## Where it renders — read this first
- Web and desktop: the widget runs in a sandboxed frame. Scripts run once, after the code has finished streaming.
- The phone app NEVER runs widget scripts: the user sees a static render of your markup (inline styles, <style>, SVG and CSS animations still work).
- So: draw the complete result in plain SVG or HTML+CSS first, and let scripts only enhance it (interaction, animation, recalculation). With scripts off the visual must still make sense. Never leave an empty <canvas> or a blank box that only a script fills — put the default state in the markup.
- Width is the chat column: about ${w}px. Height follows your content automatically.

## Principles
- Text goes in your reply, the visual goes in the tool. No headings, intros, captions or paragraphs of explanation inside the widget — write them as normal response text around the call.
- Seamless: the widget should look like part of the chat. Flat surfaces only: no gradients, drop shadows, blur, glow or decorative textures.
- Compact: show the essentials; explain the rest in prose.
- Complexity budget: box subtitles at most 5 words; at most 2 color ramps per diagram (add a one-line legend when colors carry meaning); at most 4 boxes per horizontal row at full width (5+ → narrower boxes, two rows, or an overview plus a detail diagram). If you catch yourself promising "click to learn more", the visual itself must actually be sparse.

## Streaming
The code streams to the user token by token and is rendered while it arrives, so order it for early value:
- HTML: a short <style> → content → <script> last.
- SVG: <defs> (if any) → visual elements right away.
- Prefer inline style="…" over <style> rules so controls look right mid-stream; keep any <style> under ~15 lines.
- No tabs, carousels or display:none sections — hidden content streams invisibly and is lost on the phone. Stack everything vertically. A script-driven stepper is fine, but its markup must show step one.

## Rules
- No comments in the code (<!-- --> or /* */): they waste tokens and break streaming.
- Font sizes ≥ 11px. Two weights only: 400 and 500 (never 600/700). Headings: h1 22px, h2 18px, h3 16px, weight 500, color already set. Body text 16px, line-height 1.7.
- Sentence case everywhere, SVG labels included — never Title Case or ALL CAPS. No mid-sentence bold; names of code things go in \`code\`.
- No emoji. Icons: the Tabler outline webfont is loaded — \`<i class="ti ti-chart-bar" aria-hidden="true"></i>\` (outline names only, never \`-filled\`; 16–20px inline, 24px max). The font may be missing offline, so an icon is never the only label. Don't hand-draw icon paths.
- A fragment only: no DOCTYPE, <html>, <head> or <body>. The container is display:block, full width — start with your content, no wrapper needed. For vertical breathing room put \`padding: 1rem 0\` on the first element.
- Outer background stays transparent: never paint the outer container dark or colored — the host provides the page.
- Never \`position: fixed\` (the frame sizes itself to in-flow content, fixed elements collapse it). Modal mockups go inside a normal-flow faux viewport: \`<div style="min-height:400px;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center">\`.
- No fullscreen APIs. An "expand" control is a synchronous CSS class toggle that makes in-flow content taller, with its label updated in the same handler.
- No nested scrolling regions. No alert(), confirm(), prompt() or popups.
- Corners: \`border-radius: var(--radius)\` for controls, 12px for cards; SVG rects default to rx="4". A one-sided border (border-left accent etc.) gets border-radius: 0.
- Text on a colored fill uses a dark stop of the same ramp (see the palette), never plain black or gray.
- Interactive widgets validate input: show an inline error (13px, \`color: var(--text-danger)\`) next to the control and stop until it is fixed; clear it when the user edits.
- Accessibility: an HTML widget starts with \`<h2 class="sr-only">one-sentence summary</h2>\`; an SVG root carries role="img" with <title> and <desc> as its first children.
- Network: resources load only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh, fonts.googleapis.com and fonts.gstatic.com (enforced by CSP; anything else silently fails). Load a library with \`<script src="https://cdnjs.cloudflare.com/ajax/libs/…">\` (UMD global) placed BEFORE the inline script that uses it. localStorage is in-memory only — don't rely on it.

## CSS variables (the host switches light/dark for you)
- Surfaces: \`--surface-0\` (page), \`--surface-1\` (card), \`--surface-2\` (raised); role tints \`--bg-accent\`, \`--bg-danger\`, \`--bg-success\`, \`--bg-warning\`
- Text: \`--text-primary\`, \`--text-secondary\`, \`--text-muted\`; roles \`--text-accent\`, \`--text-danger\`, \`--text-success\`, \`--text-warning\`
- Borders: \`--border\` (hairline), \`--border-strong\` (hover), \`--border-stronger\`; roles \`--border-accent\`, \`--border-danger\`, \`--border-success\`, \`--border-warning\`
- Type: \`--font-sans\`, \`--font-voice\` (serif, for the rare quote), \`--font-mono\`
- Layout: \`--radius\` (8px), \`--pad-sm|md|lg|xl\`, \`--gap-xs|sm|md|lg|xl\`
- Short aliases: \`--p\` (= --text-primary), \`--s\` (= --text-secondary), \`--t\` (= --text-muted), \`--bg2\` (= --surface-1), \`--b\` (= --border)

Dark mode is mandatory: every color must read on a near-black page too. In HTML use these variables for text and borders — never hard-code #333. In SVG use the c-* ramp classes and the t / ts / th text classes. Test in your head: if the page were near-black, would every label still be readable? The root element carries \`data-mode="light|dark"\`.

## sendPrompt(text)
A global function that sends \`text\` to the chat as if the user typed it; you then answer it. It only works from a real user click (calls without one are dropped). Use it when the next step needs you to think — "explain this stage ↗", "compare these two ↗"; end such button labels with ↗. Filtering, sorting, toggling and arithmetic happen in JS instead.

## Links
\`<a href="https://…">\` works: the click is handed to the host, which opens it in the user's browser. \`openLink(url)\` does the same from script.

## When nothing fits
Pick the closest module and adapt. Explanatory content → editorial layout (the prose in your reply, one clear visual in the widget). A bounded object (a record, an option, a plan) → a card. All the rules above still apply. Keep the planning short: if a visual needs a lot of thought, make it smaller and say more in text.`;

const PALETTE = () => {
  const rows = Object.entries(RAMPS).map(([k, v]) => `| \`c-${k}\` | ${v.join(' | ')} |`).join('\n');
  return `## Color palette

Nine ramps with seven stops each, lightest to darkest: 50 = lightest fill, 100–200 = light fills, 400 = mid tone, 600 = strong / border, 800–900 = text on light fills.

| Class | ${RAMP_STOPS.join(' | ')} |
|---|${RAMP_STOPS.map(() => '---').join('|')}|
${rows}

Color encodes meaning, never sequence:
- Group by category — every node of one kind shares a color (e.g. all services teal, all data stores purple, all external actors coral). Don't cycle through hues step by step.
- Gray is for neutral or structural nodes (start, end, generic steps).
- Use 2–3 colors per diagram. Gray + purple + teal reads cleaner than six ramps.
- Prefer purple, teal, coral and pink for general categories. Keep blue, green, amber and red for things that really are informational, success, warning or error. (Illustrations may use blue / amber / red for physical properties such as cold, heat or pressure.)
- For status in UI (success, warning, danger) use the CSS role variables; for categories use the ramps.

Text on a colored fill: title one stop darker than the subtitle — light mode 50 fill + 600 stroke + 800 title + 600 subtitle; dark mode 800 fill + 200 stroke + 100 title + 200 subtitle. The c-* classes do exactly this automatically in both modes:
- Put \`class="c-teal"\` on a <g> that directly contains the shape and its texts, or directly on a <rect>/<circle>/<ellipse>/<polygon>. Not on <path> (paths get no ramp fill).
- The selectors are direct-child only: a <g> nested inside a <g class="c-teal"> makes its shapes grandchildren — they lose the fill and render black. Put c-* on the innermost group holding the shapes. Click handlers go on that same group.
- Colored connector lines: an inline mid-ramp hex stroke (the 400 or 600 stop) works in both modes.`;
};

const SVG = (w) => `## SVG setup

Root: \`<svg width="100%" viewBox="0 0 ${w} H" role="img"><title>…</title><desc>…</desc>…</svg>\` — ${w} units wide, so SVG units render 1:1 with CSS pixels in the ${w}px column and the text sizes below hold. Keep the width at ${w} even when the content is narrow: center the content instead of shrinking the viewBox (a smaller viewBox scales everything up). Set H to the bottom of the lowest element + 20–40. No negative coordinates; safe area x = 20…${w - 20}. One <svg> per call; never leave a broken attempt behind — replace it whole. Don't wrap the SVG in a colored <div>.

Before you finish, check:
1. Every element stays inside 0…${w} horizontally and 0…H vertically (text-anchor="end" grows to the left — make sure it doesn't cross x = 0).
2. Nothing overlaps unless it is meant to (a label centered in its own box, an arrowhead touching its target, a highlight behind its subject). Shift, shorten or add a row instead.
3. In a row of boxes, each box's right edge is at least 20 left of the next box's x.

Host classes (already loaded — don't redefine them):
- Text: \`class="t"\` 14px primary, \`class="ts"\` 12px secondary, \`class="th"\` 14px weight 500. Every <text> carries one of these; only these two sizes (14 for labels, 12 for subtitles and notes).
- \`class="box"\` neutral rect (surface-1 fill, strong border); \`class="node"\` clickable group (pointer cursor, dims on hover); \`class="arr"\` connector line (1.5px, muted); \`class="leader"\` dashed thin leader line; \`class="c-{ramp}"\` colored node (see the palette).
- Arrowheads: the host defines \`#arrow\` — \`marker-end="url(#arrow)"\` on a line or path gives an open chevron in the line's own color. Don't define other markers or filters. <defs> may hold a <clipPath> or a subtle <pattern> (hatching as a second cue beside color); illustrations may add one <linearGradient>.

Drawing rules:
- Strokes 0.5px for borders and edges (1.5px for arrows via .arr). Connector <path>/<polyline> always \`fill="none"\` — the default black fill turns a curve into a blob.
- Lines stop at a component's edge; compute the endpoints instead of hiding a line behind a fill.
- rx="4" for subtle corners, 8 max; rx ≥ half the height makes a pill — only when you mean a pill.
- SVG <text> never wraps: every extra line is an explicit \`<tspan x="…" dy="1.2em">\`. Needing a wrap usually means the label is too long.
- Width estimate at 14px: about 8px per Latin character (7.5 for lowercase, 9 for capitals and weight 500), 14px per CJK character; 12px text ≈ 0.86 × that. A box needs text width + 2 × 16 padding.
- Every <text> sits inside a box or in a legend; floating labels collide. Arrow labels are rarely needed — put the meaning in the target's subtitle or the prose.
- No rotated text, no decorative step numbers, no icons inside diagram boxes.
- Schematic containers are dashed rects with a label, not drawn shapes (no cloud outlines, server towers or organelle ovals).
- Physical scenes (sky, water, skin, materials) use hard-coded hex for the whole scene — don't mix with c-* classes. A dark variant may key on the root: \`[data-mode="dark"] .scene { … }\`.`;

const DIAGRAM = (w) => `## Diagrams

Pick the type first:
- Flowchart — steps and decisions in order. One direction (top → bottom for long sequences, left → right for 3–4 steps). Decisions are short questions in a box with two labelled exits.
- Structural — what contains or connects to what (architecture, layers, org charts). Group with dashed container rects labelled in their top-left corner (ts class, 12px inside the border).
- Illustrative — how something physically works (a pump, a cell, a circuit). Simple shapes, physical colors allowed, a few short callouts with .leader lines.

Layout recipe (do the arithmetic, don't eyeball):
1. List the boxes and their longest label; size each box from that (width estimate in the SVG section). Use one width per row or per column so the grid looks deliberate.
2. Place rows on a fixed rhythm: box height 44 (one line) or 56 (title + subtitle), vertical gap 36–48 between rows so arrows have room.
3. Center each row in the ${w}px width: x0 = (${w} − row width) / 2.
4. Arrows run between box edges: from (cx, y + h) to (cx', y') for vertical links; side links leave from the middle of the right edge. An arrow must never pass through another box — route it around with a <path> elbow (fill="none") or reorder the boxes.
5. Title in a box: th class at the vertical middle (y + h/2 + 5); with a subtitle, title at y + 22 and subtitle (ts) at y + 40.
6. Fan-out of more than four children: two rows, or summarise as "+3 more" and describe them in prose.

Common failures to check before sending: an arrow crossing a box; a label wider than its box; boxes in one row touching; a legend overlapping the drawing; the viewBox cutting off the last row.

Interactive diagrams: make a node clickable with \`class="node"\` on its c-* group plus \`onclick="sendPrompt('Explain the … stage')"\`. The drawing itself stays complete without scripts.

Steppers (walking through stages): draw the whole diagram, then (in script) dim the inactive stages and add prev / next buttons. Without scripts the user sees every stage at once, which is fine.`;

const UI = (w) => `## UI components

Layout:
- Grids: \`display:grid; grid-template-columns: repeat(auto-fit, minmax(${w < 550 ? 140 : 160}px, 1fr)); gap: var(--gap-md)\`.${w < 550 ? ' On this narrow column use at most two columns.' : ''}
- Cards: \`background: var(--surface-1); border: 0.5px solid var(--border); border-radius: 12px; padding: var(--pad-lg)\`. Hover may move to --border-strong; no shadows.
- Editorial layout (explanation): mostly prose in your reply, the widget holds one focused visual. Card layout (a bounded object): one card or a small grid of cards.
- Real tabular data belongs in your reply as a markdown table, not in the widget.

Controls are pre-styled by the host (font, 0.5px border, var(--radius), focus ring): <button>, <input> (text, number, range, checkbox, radio), <select>, <textarea>. Add only what you need. A primary button: \`class="primary"\`. Keep them in normal flow.

Metric cards: a 13px --text-secondary label above a 24px weight-500 number; group 2–4 per row. Round every displayed number (\`toFixed\`, \`toLocaleString\`) — never show 0.30000000000000004.

Interactive explainer: controls on top (a slider, a toggle, a select), the result below (numbers, a small SVG). Compute in JS on input. The markup ships with the default values already rendered so the phone shows a correct static state.

Compare options: one card per option side by side (stack on mobile), the same rows in each card, the recommended one marked with --border-accent and a small "recommended" pill (--bg-accent fill, --text-accent text).

Data record: a card with label / value rows (label 13px secondary, value 14px primary), status as a pill using the role variables.

Mockups of app screens: draw them at a believable size inside the column, with a 0.5px --border frame and 12px radius; content uses the same variables, so it works in dark mode too.`;

const CDS = `## Tokens and restraint

- Use the CSS variables for every surface, text and border color; ramp hex values only for categorical color.
- Muted text is --text-secondary (supporting) or --text-muted (hints, timestamps). Don't fade text with opacity.
- Accent (--text-accent / --bg-accent / --border-accent) is for one thing per widget: the primary action or the recommended option.
- Elevation is shown with surface steps (surface-0 → surface-1 → surface-2) and hairline borders, never shadows.
- Spacing comes from --pad-* and --gap-*; don't invent odd pixel values.
- Serif (--font-voice) is reserved for a short quote or a single editorial line.`;

const CHART = (w) => `## Charts

Default: draw the chart yourself in SVG. Bars, lines, areas, dots, slopes, stacked bars, donuts and small multiples are a few dozen elements and render everywhere — including the phone, where scripts never run. Compute the scales in your head: pick a round axis max, map values linearly to pixels, label 3–5 ticks.

SVG chart recipe (viewBox width ${w}):
- Plot area: left margin 44 for y labels, right 16, top 16, bottom 32 for x labels.
- Gridlines: horizontal only, 0.5px, stroke var(--border); axis labels ts class (12px, secondary). No vertical gridlines, no chart border box.
- Bars start at zero, gap ≈ 30% of the band; sort bars by value unless the order is meaningful (time, ranking scale). Label values directly at the bar end when there are ≤ 12 bars.
- Lines 2px, round joins; mark only the last point (and notable ones) with a 3px dot and a direct label instead of a legend.
- Series colors: take the 400 or 600 stop of one ramp per series in a fixed order — teal, purple, coral, pink, blue, amber — and never cycle a rainbow. Pair color with a second cue (dash, marker shape) when there are 3+ series.
- Hover tooltips are an enhancement: give each mark a <title> (shows natively), and optionally a small script that highlights on hover.

Chart.js (only when the interaction is the point — e.g. hundreds of points to inspect): load \`https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js\`, put the <canvas> inside \`<div style="position:relative;height:300px">\`, use \`responsive:true, maintainAspectRatio:false\`, read colors with \`getComputedStyle(document.documentElement).getPropertyValue('--text-secondary')\`. Because the phone shows no canvas, also put the key numbers in the markup (a small summary row or a static SVG of the main series).

Maps: a choropleth needs D3 + topojson from cdn.jsdelivr.net and only renders with scripts — say in your reply that it is interactive on the computer, and state the headline numbers in text.`;

const DATAVIZ = `## Data visualization — choosing the form

- Compare amounts → bars (horizontal when labels are long). Change over time → line or area. Part of a whole → a single stacked bar or a donut with ≤ 5 slices (otherwise bars). Relationship → scatter. Distribution → histogram or dot strip. Ranking change → slope chart.
- One message per chart; put that message in your reply, not as a chart title.
- No 3D, no dual y-axes, no pie with 8 slices, no truncated bar axes, no decorative icons in the plot.
- Annotate the one thing that matters (a highlighted bar in the accent ramp, the rest gray) rather than coloring everything.
- Units in the axis label or the tick text (12k, 35%), not repeated on every value.
- Numbers you show are rounded to a sensible precision, and totals add up.`;

const ART = `## Illustration and generative art

- SVG with hand-placed shapes; physical colors as hard-coded hex for the whole scene (sky, ground, materials). Keep it flat: solid fills, no filters; one <linearGradient> is allowed for a sky or a liquid.
- If the scene should change in dark mode, key a variant on the root: \`[data-mode="dark"] .scene { … }\`.
- Motion: prefer CSS @keyframes on SVG elements (it plays on the phone too); JS animation (requestAnimationFrame) is desktop-only, so the first frame must already look finished.
- Generative patterns: compute them in your head into static SVG when small; a script may add variation on desktop. Respect \`prefers-reduced-motion\`.
- Keep everything inside the viewBox; no text unless it is part of the picture.`;

const ELICIT = `## Elicitation — collecting choices

Use a small form when you need a few decisions from the user before doing the work (style, scope, audience, options).
- Infer first: pre-fill every field with your best guess so the user can just confirm. Ask 2–5 things, never a questionnaire.
- Each question is one short line; options as radio buttons or toggle chips (\`<button aria-pressed>\` styled with --border / --border-accent), free text only where options can't work.
- One primary button at the end, e.g. "Continue ↗". Its click handler validates (inline 13px --text-danger error, stop if a required field is empty) and then calls sendPrompt with a plain summary: "Make it: tone = friendly, length = short, audience = engineers".
- Also offer a quiet "Skip ↗" that calls sendPrompt('Skip the form — use your defaults').
- The phone shows the form without scripts, so in your reply also say the user can simply answer in text.
- After a submit, disable the button and show a one-line "Sent" state.`;

const END = `Remember: explanation goes in your reply; the widget holds only the visual. Don't describe the read_me step to the user.`;

// 拼装：BASE + 所选模块的段落（按出现顺序去重）+ END。官方同样「基础 + 模块段 + 结尾」。
function sections(w) {
  return {
    diagram: [PALETTE(), SVG(w), DIAGRAM(w)],
    mockup: [UI(w), PALETTE(), CDS],
    interactive: [UI(w), PALETTE(), CDS],
    data_viz: [UI(w), PALETTE(), CHART(w), DATAVIZ],
    chart: [UI(w), PALETTE(), CHART(w), DATAVIZ],
    art: [SVG(w), ART],
    elicitation: [UI(w), ELICIT],
  };
}

export const widthFor = (platform) => (platform === 'mobile' ? 380 : 680);

/** read_me 的返回文本。modules 不认识的忽略；platform 缺省按 desktop。 */
export function guideFor(modules, platform) {
  const w = widthFor(platform);
  const map = sections(w);
  const out = [BASE(w)];
  const seen = new Set();
  for (const m of Array.isArray(modules) ? modules : []) {
    for (const part of map[m] || []) {
      if (seen.has(part)) continue;
      seen.add(part);
      out.push(part);
    }
  }
  out.push(END);
  return out.join('\n\n');
}
