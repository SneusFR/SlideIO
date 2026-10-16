// Avatars de secours : un petit fruit cartoon (style autocollant) dans la couleur du joueur.
// Remplacés par player.avatar (URL d'image) quand il est fourni.

let uid = 0;

function shade(hex, amt) {
  const n = parseInt(hex.replace('#', ''), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const f = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  r = Math.round((f - r) * p + r);
  g = Math.round((f - g) * p + g);
  b = Math.round((f - b) * p + b);
  return `rgb(${r},${g},${b})`;
}

const BODY = 'M50 17c-9.5 0-13.6 8.6-14.6 18.4-.9 8.4-14.9 14.6-14.9 33.6 0 15.9 12.6 26 29.5 26s29.5-10.1 29.5-26c0-19-14-25.2-14.9-33.6C63.6 25.6 59.5 17 50 17z';

const EYES = {
  happy: `
    <circle cx="41.5" cy="52" r="7.4" fill="#fff" stroke="#15131f" stroke-width="2.6"/>
    <circle cx="58.5" cy="52" r="7.4" fill="#fff" stroke="#15131f" stroke-width="2.6"/>
    <circle cx="42.6" cy="53" r="3.4" fill="#15131f"/><circle cx="57.4" cy="53" r="3.4" fill="#15131f"/>
    <circle cx="43.6" cy="51.8" r="1.1" fill="#fff"/><circle cx="58.4" cy="51.8" r="1.1" fill="#fff"/>`,
  smug: `
    <circle cx="41.5" cy="53" r="7" fill="#fff" stroke="#15131f" stroke-width="2.6"/>
    <circle cx="58.5" cy="53" r="7" fill="#fff" stroke="#15131f" stroke-width="2.6"/>
    <circle cx="43.4" cy="55" r="3.2" fill="#15131f"/><circle cx="60.2" cy="55" r="3.2" fill="#15131f"/>
    <path d="M33.6 51.6h15.6v-6H33.6zM50.8 51.6h15.6v-6H50.8z" fill="currentColor"/>
    <path d="M34 51.4c4.6 1.3 10 1.3 15 0M51 51.4c4.6 1.3 10 1.3 15 0" stroke="#15131f" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <path d="M33 42.5l14 4.6M67 42.5l-14 4.6" stroke="#15131f" stroke-width="3.4" stroke-linecap="round"/>`,
  ko: `
    <path d="M36.5 47l10 10M46.5 47l-10 10M53.5 47l10 10M63.5 47l-10 10" stroke="#15131f" stroke-width="3.6" stroke-linecap="round"/>`,
  sad: `
    <circle cx="41.5" cy="53" r="7" fill="#fff" stroke="#15131f" stroke-width="2.6"/>
    <circle cx="58.5" cy="53" r="7" fill="#fff" stroke="#15131f" stroke-width="2.6"/>
    <circle cx="41.5" cy="55" r="3.2" fill="#15131f"/><circle cx="58.5" cy="55" r="3.2" fill="#15131f"/>
    <path d="M34 44.5l11-3.6M66 44.5l-11-3.6" stroke="#15131f" stroke-width="3.2" stroke-linecap="round"/>`,
  cool: `
    <path d="M31 47.5h38v3.5c0 5.6-4 9-9.2 9-4.8 0-8.2-3-8.6-7.4h-2.4c-.4 4.4-3.8 7.4-8.6 7.4-5.2 0-9.2-3.4-9.2-9z" fill="#15131f"/>
    <path d="M35.5 51l4-3M56 51l4-3" stroke="#5de8f5" stroke-width="2.2" stroke-linecap="round"/>`,
};

const MOUTHS = {
  happy: `
    <path d="M40 64.5c2.6 7.6 17.4 7.6 20 0z" fill="#15131f" stroke="#15131f" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M44.6 68.6c2.4 1.6 8.4 1.6 10.8 0-1.6-1.6-9.2-1.6-10.8 0z" fill="#ff7f8a"/>
    <path d="M45.4 64.8h4.2v4.2h-4.2zM50.4 64.8h4.2v4.2h-4.2z" fill="#fff"/>`,
  smug: `
    <path d="M41 66.5c6 3.2 13 2.6 19-3" stroke="#15131f" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M51.4 67.4h4v3.6h-4z" fill="#fff" stroke="#15131f" stroke-width="1.2"/>`,
  ko: `
    <ellipse cx="50" cy="68" rx="4.6" ry="5.4" fill="#15131f"/>`,
  sad: `
    <path d="M41.5 70c4.4-5.4 12.6-5.4 17 0" stroke="#15131f" stroke-width="3" fill="none" stroke-linecap="round"/>`,
  cool: `
    <path d="M40.5 65c3 6.2 16 6.2 19 0z" fill="#15131f"/>
    <path d="M45 65.2h4.4v3.6H45zM50.6 65.2H55v3.6h-4.4z" fill="#fff"/>`,
};

export function avatarSVG(color = '#F27A3A', mood = 'happy') {
  const id = `esav${++uid}`;
  const eyes = EYES[mood] ?? EYES.happy;
  const mouth = MOUTHS[mood] ?? MOUTHS.happy;
  return `<svg viewBox="0 0 100 100" aria-hidden="true" style="color:${color}">
  <defs>
    <radialGradient id="${id}g" cx="36%" cy="40%" r="70%">
      <stop offset="0" stop-color="${shade(color, 0.35)}"/>
      <stop offset=".55" stop-color="${color}"/>
      <stop offset="1" stop-color="${shade(color, -0.32)}"/>
    </radialGradient>
  </defs>
  <path d="${BODY}" fill="#15131f" stroke="#15131f" stroke-width="15" stroke-linejoin="round"/>
  <path d="${BODY}" fill="#f7f0e2" stroke="#f7f0e2" stroke-width="9" stroke-linejoin="round"/>
  <path d="M50 18c-1.5-6 .5-10.5 4.5-13" stroke="#15131f" stroke-width="3.2" fill="none" stroke-linecap="round"/>
  <path d="M53.5 11.5c3.6-6.6 11.4-8 16.6-5.4-2.4 6.6-10.4 9.6-16.6 5.4z" fill="#7cc63a" stroke="#15131f" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="${BODY}" fill="url(#${id}g)" stroke="#15131f" stroke-width="2.6" stroke-linejoin="round"/>
  <ellipse cx="38" cy="38" rx="4.2" ry="7.5" transform="rotate(24 38 38)" fill="#fff" opacity=".35"/>
  ${eyes}
  ${mouth}
</svg>`;
}

// Élément avatar : image fournie ou fruit procédural
export function avatarEl(player, mood = 'happy', className = 'es-avatar') {
  const wrap = document.createElement('span');
  wrap.className = className;
  if (player && player.avatar) {
    const img = document.createElement('img');
    img.src = player.avatar;
    img.alt = '';
    img.draggable = false;
    wrap.appendChild(img);
  } else {
    wrap.innerHTML = avatarSVG(player?.color, mood);
  }
  return wrap;
}
