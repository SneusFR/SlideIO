/**
 * Injected CSS of the CUSTOMIZE overlay (#customize-menu). Same visual
 * language as the Loadout menu: parchment board, wooden preview panel,
 * leafy green active tabs, chunky blue rarity cards, "Luckiest Guy" titles.
 * Kept in its own module so CustomizeMenu.ts stays about behaviour.
 */

let injected = false;

export function injectCustomizeStyles(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement("style");
  style.textContent = FRAME_CSS + PREVIEW_CSS + BOARD_CSS + CARDS_CSS + FOOTER_CSS + RESPONSIVE_CSS;
  document.head.appendChild(style);
}

const FRAME_CSS = `
  #customize-menu {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(26, 18, 8, 0.72);
    backdrop-filter: blur(7px);
    font-family: "Baloo 2", "Segoe UI", system-ui, sans-serif;
    color: #4a3117;
  }
  #customize-menu.open { display: flex; animation: cz-fade 0.2s ease; }
  @keyframes cz-fade { from { opacity: 0; } to { opacity: 1; } }

  /* One big parchment board: header / body (preview + grid) / footer. */
  #customize-menu .cz-frame {
    position: relative;
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: 14px;
    width: min(1240px, 96vw);
    height: min(840px, 92vh);
    background:
      radial-gradient(120% 90% at 20% 0%, rgba(255, 250, 232, 0.55), transparent 55%),
      linear-gradient(165deg, #f4e8ca 0%, #ecdcb4 60%, #e3d1a4 100%);
    border: 7px solid #6b4a2b;
    border-radius: 30px;
    box-shadow:
      0 18px 50px rgba(0, 0, 0, 0.45),
      inset 0 0 0 3px rgba(255, 248, 226, 0.65),
      inset 0 -14px 30px rgba(107, 74, 43, 0.16);
    padding: 18px 24px 20px;
  }
  #customize-menu .cz-leaf {
    position: absolute;
    width: 36px;
    height: 36px;
    object-fit: contain;
    filter: drop-shadow(0 3px 3px rgba(0, 0, 0, 0.3));
    pointer-events: none;
    user-select: none;
    z-index: 2;
  }
  #customize-menu .cz-leaf-tl { top: 2px; left: 2px; transform: translate(-50%, -50%) rotate(-15deg); }
  #customize-menu .cz-leaf-br { bottom: 2px; right: 2px; transform: translate(50%, 50%) rotate(165deg); }

  /* ---- Header: brand · main tabs · back ---- */
  #customize-menu .cz-header {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 16px;
  }
  #customize-menu .cz-brand { display: flex; align-items: center; gap: 12px; }
  #customize-menu .cz-logo {
    height: 52px;
    width: auto;
    filter: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.3));
    user-select: none;
  }
  #customize-menu .cz-title {
    font-family: "Luckiest Guy", cursive;
    font-size: 32px;
    line-height: 1;
    color: #5b3d21;
    letter-spacing: 0.06em;
    text-shadow: 0 2px 0 rgba(255, 248, 226, 0.9), 0 4px 8px rgba(91, 61, 33, 0.25);
  }
  #customize-menu .cz-subtitle {
    margin-top: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.24em;
    color: #7d9a3c;
  }
  #customize-menu .cz-tabs {
    display: flex;
    gap: 8px;
    padding: 6px;
    background: rgba(107, 74, 43, 0.14);
    border: 3px solid #6b4a2b;
    border-radius: 18px;
  }
  #customize-menu .cz-tab {
    background: transparent;
    border: 3px solid transparent;
    border-radius: 12px;
    color: #6b4a2b;
    font-family: "Luckiest Guy", cursive;
    font-size: 14px;
    letter-spacing: 0.08em;
    padding: 8px 22px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  #customize-menu .cz-tab:hover { background: rgba(255, 248, 226, 0.55); }
  #customize-menu .cz-tab.active {
    background: linear-gradient(180deg, #a8d94a, #78ac1e);
    border-color: #4c6b1f;
    color: #ffffff;
    text-shadow: 0 2px 0 rgba(60, 90, 20, 0.6);
    box-shadow: 0 3px 0 #4c6b1f;
  }
  #customize-menu .cz-back {
    justify-self: end;
    background: linear-gradient(180deg, #7a5533, #5b3d21);
    border: 3px solid #3d2913;
    border-radius: 14px;
    color: #f7ecd2;
    font-family: "Baloo 2", sans-serif;
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 0.18em;
    padding: 9px 18px;
    cursor: pointer;
    box-shadow: 0 4px 0 #3d2913;
    transition: transform 0.1s ease, box-shadow 0.1s ease, filter 0.15s ease;
  }
  #customize-menu .cz-back:hover { filter: brightness(1.12); }
  #customize-menu .cz-back:active { transform: translateY(3px); box-shadow: 0 1px 0 #3d2913; }

  #customize-menu .cz-body {
    display: grid;
    grid-template-columns: 360px 1fr;
    gap: 18px;
    min-height: 0;
  }
`;


const PREVIEW_CSS = `
  /* ============ LEFT: wooden preview panel ============ */
  #customize-menu .cz-preview {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background:
      radial-gradient(140% 60% at 50% 0%, rgba(255, 220, 160, 0.14), transparent 60%),
      linear-gradient(170deg, #6a4a2a 0%, #543a1f 55%, #46301a 100%);
    border: 7px solid #3a2814;
    border-radius: 28px;
    box-shadow:
      0 18px 50px rgba(0, 0, 0, 0.5),
      inset 0 0 0 2px rgba(255, 226, 178, 0.14),
      inset 0 -18px 36px rgba(0, 0, 0, 0.28);
    padding: 16px 16px 18px;
    color: #f5ead2;
  }
  #customize-menu .cz-preview-badge {
    position: absolute;
    top: 12px;
    left: 16px;
    z-index: 2;
    padding: 4px 12px;
    background: linear-gradient(180deg, #a8d94a, #78ac1e);
    border: 2px solid #4c6b1f;
    border-radius: 10px;
    font-family: "Luckiest Guy", cursive;
    font-size: 11px;
    letter-spacing: 0.16em;
    color: #fff;
    text-shadow: 0 2px 0 rgba(60, 90, 20, 0.6);
  }
  #customize-menu .cz-preview-stage {
    position: relative;
    flex: 1;
    min-height: 0;
    border-radius: 20px;
    background:
      radial-gradient(60% 55% at 50% 60%, rgba(255, 240, 200, 0.16), transparent 75%),
      linear-gradient(180deg, rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.32));
    box-shadow: inset 0 0 0 2px rgba(255, 226, 178, 0.1), inset 0 8px 24px rgba(0, 0, 0, 0.35);
    overflow: hidden;
    cursor: grab;
  }
  #customize-menu .cz-preview-stage:active { cursor: grabbing; }
  #customize-menu .cz-preview-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }
  #customize-menu .cz-preview-fallback {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 30px;
  }
  #customize-menu .cz-preview-fallback img {
    max-width: 85%;
    max-height: 85%;
    object-fit: contain;
    opacity: 0;
    transform: scale(0.85) rotate(-3deg);
    transition: opacity 0.25s ease, transform 0.3s cubic-bezier(0.2, 1.5, 0.4, 1);
    filter: drop-shadow(0 8px 10px rgba(0, 0, 0, 0.5));
  }
  #customize-menu .cz-preview-fallback img.ready { opacity: 1; transform: scale(1) rotate(0deg); }
  #customize-menu .cz-preview-bean { animation: cz-bob 2.4s ease-in-out infinite; }
  @keyframes cz-bob { 0%, 100% { translate: 0 0; } 50% { translate: 0 -8px; } }

  #customize-menu .cz-preview-caption { margin-top: 12px; text-align: center; }
  #customize-menu .cz-preview-name {
    font-family: "Luckiest Guy", cursive;
    font-size: 22px;
    line-height: 1.05;
    color: #fff6e0;
    text-shadow: 0 3px 0 rgba(40, 26, 10, 0.65), 0 0 16px rgba(255, 214, 140, 0.25);
  }
  #customize-menu .cz-preview-sub {
    margin-top: 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.16em;
    color: var(--rarity, #ffd98a);
  }

  /* Cosmetic charge slider (0..1 → emissive / aura intensity). */
  #customize-menu .cz-charge {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.22);
    border-radius: 12px;
  }
  #customize-menu .cz-charge-label,
  #customize-menu .cz-charge-value {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.2em;
    color: #ffd98a;
    min-width: 42px;
  }
  #customize-menu .cz-charge-value { text-align: right; }
  #customize-menu .cz-charge-input {
    flex: 1;
    appearance: none;
    height: 8px;
    border-radius: 4px;
    background: linear-gradient(90deg, #78ac1e, #ffd75e 60%, #ff8a3a);
    outline: none;
    cursor: pointer;
  }
  #customize-menu .cz-charge-input::-webkit-slider-thumb {
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff6e0;
    border: 3px solid #5b3d21;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
  }

  #customize-menu .cz-turn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-top: 10px;
  }
  #customize-menu .cz-turn-label {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.22em;
    color: rgba(245, 234, 210, 0.8);
  }
  #customize-menu .cz-turn-btn {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 3px solid #3a2814;
    background: linear-gradient(180deg, #a8d94a, #78ac1e);
    color: #fff;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 3px 0 #4c6b1f;
    transition: transform 0.1s ease, box-shadow 0.1s ease, filter 0.15s ease;
  }
  #customize-menu .cz-turn-btn:hover { filter: brightness(1.1); }
  #customize-menu .cz-turn-btn:active { transform: translateY(2px); box-shadow: 0 1px 0 #4c6b1f; }
  #customize-menu .cz-reset {
    margin-top: 10px;
    background: rgba(255, 248, 226, 0.08);
    border: 2px solid rgba(255, 226, 178, 0.35);
    border-radius: 12px;
    color: #f5ead2;
    font-family: "Baloo 2", sans-serif;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.16em;
    padding: 8px 12px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  #customize-menu .cz-reset:hover { background: rgba(255, 248, 226, 0.18); border-color: #ffd98a; }
`;

const BOARD_CSS = `
  /* ============ RIGHT: sub-tabs · toolbar · grid ============ */
  #customize-menu .cz-board {
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: 12px;
  }
  #customize-menu .cz-sub {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  #customize-menu .cz-subtab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(255, 248, 226, 0.5);
    border: 2px solid #c9b48a;
    border-radius: 14px;
    color: #7a5b33;
    font-family: "Baloo 2", sans-serif;
    font-weight: 800;
    font-size: 11px;
    letter-spacing: 0.12em;
    padding: 6px 14px 6px 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  #customize-menu .cz-subtab:hover { border-color: #6b4a2b; background: rgba(255, 248, 226, 0.85); }
  #customize-menu .cz-subtab.active {
    background: rgba(168, 217, 74, 0.28);
    border-color: #78ac1e;
    color: #4c6b1f;
  }
  #customize-menu .cz-subtab-icon {
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    background: linear-gradient(160deg, #35618d 0%, #234666 55%, #1b3852 100%);
    border: 2px solid #6fa8d6;
    overflow: hidden;
  }
  #customize-menu .cz-subtab-icon img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  #customize-menu .cz-subtab-icon img.ready { opacity: 1; }
  #customize-menu .cz-subtab-svg { width: 20px; height: 20px; fill: currentColor; }
  #customize-menu .cz-subtab-badge {
    min-width: 20px;
    padding: 1px 6px;
    border-radius: 10px;
    background: linear-gradient(180deg, #ffd75e, #e0a72e);
    border: 2px solid #8a6414;
    color: #4a3117;
    font-size: 10px;
    text-align: center;
  }
  #customize-menu .cz-sub-note {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: #7a5b33;
    padding: 8px 4px;
  }

  #customize-menu .cz-toolbar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 6px 4px 0;
    border-top: 2px dashed rgba(107, 74, 43, 0.25);
    padding-top: 12px;
  }
  #customize-menu .cz-search {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    background: rgba(255, 248, 226, 0.85);
    border: 2px solid #c9b48a;
    border-radius: 14px;
    color: #7a5b33;
    transition: border-color 0.15s ease;
  }
  #customize-menu .cz-search:focus-within { border-color: #78ac1e; }
  #customize-menu .cz-search svg { width: 16px; height: 16px; flex-shrink: 0; }
  #customize-menu .cz-search input {
    flex: 1;
    background: transparent;
    border: 0;
    outline: none;
    color: #4a3117;
    font-family: "Baloo 2", sans-serif;
    font-weight: 700;
    font-size: 13px;
    user-select: text;
  }
  #customize-menu .cz-count,
  #customize-menu .cz-sort {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.14em;
    color: #7a5b33;
    white-space: nowrap;
  }
  #customize-menu .cz-count b,
  #customize-menu .cz-sort b { color: #4c6b1f; }
`;


const CARDS_CSS = `
  /* ---- Skin grid: chunky blue cards, rarity-tinted border ---- */
  #customize-menu .cz-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 16px;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 12px 6px 6px 4px;
    min-height: 0;
    align-content: start;
  }
  #customize-menu .cz-empty {
    grid-column: 1 / -1;
    padding: 30px;
    text-align: center;
    font-weight: 700;
    color: #7a5b33;
  }
  #customize-menu .cz-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    background: linear-gradient(160deg, #35618d 0%, #234666 55%, #1b3852 100%);
    border: 3px solid #6fa8d6;
    border-radius: 20px;
    padding: 14px 10px 10px;
    cursor: pointer;
    color: #f2f8ff;
    box-shadow:
      inset 0 0 22px rgba(10, 25, 40, 0.55),
      0 6px 0 rgba(20, 40, 60, 0.55);
    transition: transform 0.12s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  #customize-menu .cz-card::after {
    /* Rarity ribbon along the bottom edge. */
    content: "";
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: -3px;
    height: 5px;
    border-radius: 3px;
    background: var(--rarity);
    box-shadow: 0 0 10px var(--rarity);
  }
  #customize-menu .cz-card:hover { transform: translateY(-3px); border-color: #a5d3f5; }
  #customize-menu .cz-card.inspected {
    border-color: #ffffff;
    box-shadow:
      inset 0 0 22px rgba(10, 25, 40, 0.55),
      0 6px 0 rgba(20, 40, 60, 0.55),
      0 0 22px var(--rarity);
  }
  #customize-menu .cz-card.locked { filter: grayscale(0.7); opacity: 0.7; }

  #customize-menu .cz-card-icon {
    position: relative;
    width: 100%;
    height: 108px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #customize-menu .cz-card-icon img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    opacity: 0;
    transform: scale(0.85);
    transition: opacity 0.25s ease, transform 0.25s ease;
    filter: drop-shadow(0 6px 8px rgba(0, 0, 0, 0.45));
  }
  #customize-menu .cz-card-icon img.ready { opacity: 1; transform: scale(1); }
  #customize-menu .cz-icon-placeholder { opacity: 0.55 !important; filter: grayscale(0.4) drop-shadow(0 6px 8px rgba(0,0,0,0.45)); }
  #customize-menu .cz-icon-soon {
    position: absolute;
    bottom: 6px;
    padding: 2px 8px;
    border-radius: 8px;
    background: var(--rarity);
    color: #10240c;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.18em;
  }
  #customize-menu .cz-icon-emoji { font-size: 52px; filter: drop-shadow(0 5px 6px rgba(0, 0, 0, 0.4)); }
  #customize-menu .cz-card-name {
    font-family: "Baloo 2", sans-serif;
    font-weight: 800;
    font-size: 13px;
    letter-spacing: 0.08em;
    text-align: center;
    text-shadow: 0 2px 3px rgba(0, 0, 0, 0.5);
  }
  #customize-menu .cz-card-rarity {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.22em;
    color: var(--rarity);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  }
  #customize-menu .cz-card-check {
    position: absolute;
    top: -10px;
    right: -8px;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(180deg, #a8d94a, #78ac1e);
    border: 3px solid #ffffff;
    border-radius: 50%;
    color: #fff;
    font-size: 14px;
    box-shadow: 0 3px 6px rgba(0, 0, 0, 0.35);
    z-index: 1;
  }
  #customize-menu .cz-card-lock { position: absolute; top: 8px; right: 10px; font-size: 16px; z-index: 1; }
`;


const FOOTER_CSS = `
  /* ============ BOTTOM: inspected item · ÉQUIPER ============ */
  #customize-menu .cz-footer {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 16px;
    background: rgba(107, 74, 43, 0.14);
    border: 3px solid #6b4a2b;
    border-radius: 20px;
    min-height: 82px;
  }
  #customize-menu .cz-footer.pop { animation: cz-pop 0.28s cubic-bezier(0.2, 1.4, 0.4, 1); }
  @keyframes cz-pop {
    from { transform: translateY(8px) scale(0.985); opacity: 0.5; }
    to { transform: translateY(0) scale(1); opacity: 1; }
  }
  #customize-menu .cz-footer-icon {
    position: relative;
    width: 72px;
    height: 58px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 14px;
    background: linear-gradient(160deg, #35618d 0%, #234666 55%, #1b3852 100%);
    border: 3px solid var(--rarity, #6fa8d6);
    box-shadow: 0 0 14px color-mix(in srgb, var(--rarity, #6fa8d6) 55%, transparent);
    overflow: hidden;
  }
  #customize-menu .cz-footer-icon img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    opacity: 0;
    transition: opacity 0.2s ease;
    filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.45));
  }
  #customize-menu .cz-footer-icon img.ready { opacity: 1; }
  #customize-menu .cz-footer-icon .cz-icon-soon { bottom: 3px; font-size: 7px; padding: 1px 5px; }
  #customize-menu .cz-footer-icon .cz-icon-emoji { font-size: 30px; }
  #customize-menu .cz-footer-text { flex: 1; min-width: 0; }
  #customize-menu .cz-footer-name {
    font-family: "Luckiest Guy", cursive;
    font-size: 22px;
    line-height: 1;
    color: #5b3d21;
    text-shadow: 0 2px 0 rgba(255, 248, 226, 0.9);
  }
  #customize-menu .cz-footer-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin-top: 5px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: #7a5b33;
  }
  #customize-menu .cz-footer-rarity {
    padding: 2px 10px;
    border-radius: 9px;
    background: var(--rarity);
    color: #10240c;
    letter-spacing: 0.18em;
    font-size: 10px;
  }
  #customize-menu .cz-footer-tagline { font-weight: 600; letter-spacing: 0.02em; opacity: 0.85; }

  #customize-menu .cz-equip {
    flex-shrink: 0;
    background: linear-gradient(180deg, #a8d94a, #78ac1e);
    border: 3px solid #4c6b1f;
    border-radius: 16px;
    color: #ffffff;
    font-family: "Luckiest Guy", cursive;
    font-size: 16px;
    letter-spacing: 0.12em;
    padding: 12px 28px;
    cursor: pointer;
    box-shadow: 0 5px 0 #4c6b1f;
    text-shadow: 0 2px 0 rgba(60, 90, 20, 0.6);
    transition: transform 0.1s ease, box-shadow 0.1s ease, filter 0.15s ease;
  }
  #customize-menu .cz-equip:hover:not(:disabled) { filter: brightness(1.1); }
  #customize-menu .cz-equip:active:not(:disabled) { transform: translateY(4px); box-shadow: 0 1px 0 #4c6b1f; }
  #customize-menu .cz-equip:disabled { cursor: default; }
  #customize-menu .cz-equip.equipped {
    background: linear-gradient(180deg, #ffd75e, #e0a72e);
    border-color: #8a6414;
    box-shadow: 0 5px 0 #8a6414;
    color: #4a3117;
    text-shadow: 0 2px 0 rgba(120, 84, 12, 0.55);
  }
  #customize-menu .cz-equip:disabled:not(.equipped) { filter: grayscale(0.7); opacity: 0.65; }
`;

const RESPONSIVE_CSS = `
  @media (max-width: 980px) {
    #customize-menu .cz-frame { width: 96vw; height: 94vh; padding: 14px; gap: 10px; }
    #customize-menu .cz-header { grid-template-columns: 1fr auto; }
    #customize-menu .cz-tabs { grid-column: 1 / -1; justify-content: center; order: 3; }
    #customize-menu .cz-body { grid-template-columns: 1fr; grid-template-rows: 260px 1fr; }
    #customize-menu .cz-subtitle { display: none; }
    #customize-menu .cz-turn, #customize-menu .cz-reset { display: none; }
    #customize-menu .cz-footer-tagline { display: none; }
  }
`;

