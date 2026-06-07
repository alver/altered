// bg_slideshow.js — animated, randomized background for the deck-select screen.
// Crossfades between the optimized Altered key-art with a random Ken-Burns
// pan/zoom on each frame. Pure vanilla; runs on its own once the DOM is ready.
(() => {
  const IMAGES = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `assets/backgrounds/altered${n}.jpg`);
  const KB_VARIANTS = 6;                 // matches .kb1..kb6 keyframes in css
  const DWELL_MIN = 7000, DWELL_MAX = 11000;   // ms a frame stays before the next fade

  const reduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function start() {
    const stage = document.getElementById('bg-stage');
    if (!stage) return;

    // Preload so the first swap doesn't flash.
    IMAGES.forEach(src => { const im = new Image(); im.src = src; });

    // Two stacked layers we ping-pong between for crossfades.
    const layers = [0, 1].map(() => {
      const slide = document.createElement('div');
      slide.className = 'bg-slide';
      const kb = document.createElement('div');
      kb.className = 'kb';
      slide.appendChild(kb);
      stage.appendChild(slide);
      return { slide, kb };
    });

    let queue = shuffled(IMAGES);
    let qi = 0;
    let lastKb = -1;
    let front = 0;            // index of the currently-visible layer

    const nextImage = () => {
      if (qi >= queue.length) { queue = shuffled(IMAGES); qi = 0; }
      return queue[qi++];
    };
    const nextKb = () => {
      let k;
      do { k = 1 + Math.floor(Math.random() * KB_VARIANTS); } while (k === lastKb);
      lastKb = k;
      return k;
    };

    const show = (layerIdx, src) => {
      const { slide, kb } = layers[layerIdx];
      kb.style.backgroundImage = `url("${src}")`;
      for (let k = 1; k <= KB_VARIANTS; k++) kb.classList.remove('kb' + k);
      // reflow so the same kb class can re-trigger its animation later
      void kb.offsetWidth;
      if (!reduced) kb.classList.add('kb' + nextKb());
      slide.classList.add('active');
    };

    // First frame, no fade.
    front = 0;
    show(0, nextImage());

    if (reduced) {
      // Static: just swap the single image on a slow timer, no motion.
      setInterval(() => { show(0, nextImage()); }, 12000);
      return;
    }

    const advance = () => {
      const back = front ^ 1;
      show(back, nextImage());      // fade the hidden layer in
      layers[front].slide.classList.remove('active');
      front = back;
      setTimeout(advance, DWELL_MIN + Math.random() * (DWELL_MAX - DWELL_MIN));
    };
    setTimeout(advance, DWELL_MIN + Math.random() * (DWELL_MAX - DWELL_MIN));
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start);
  else start();
})();
