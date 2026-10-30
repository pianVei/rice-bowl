'use strict';
/* Real recorded game music. Asset provenance and unverified audio rights are
   documented in audio/SOURCES.txt; repository code licenses do not license music.
   Existing Bgm.enabled / playing / poke() / toggle() interface is preserved. */
const Bgm = (() => {
  let enabled = true;
  let audio = null, pending = false, revision = 0;
  let track = 'normal';
  try { enabled = localStorage.getItem('ddz_bgm') !== '0'; } catch (e) { }
  const root = new URL('../audio/classic-0d84ff6/', document.currentScript.src);
  const tracks = { normal: 'Normal', intense: 'Exciting' };
  function file(name) { return new URL(name + '/' + name + '.mp3', root).href; }
  function player() {
    if (!audio) {
      audio = new Audio(file(tracks[track]));
      audio.loop = true;
      audio.volume = 0.22;
      audio.preload = 'auto';
    }
    return audio;
  }
  function start() {
    if (!enabled || pending || document.hidden) return;
    const a = player();
    if (!a.paused && !a.ended) return;
    const token = revision;
    pending = true;
    try {
      Promise.resolve(a.play()).then(() => {
        if (!enabled || document.hidden) a.pause();
      }).catch(() => {
        // Autoplay denial or a missing file: retry on the next user gesture.
      }).finally(() => { if (token === revision) pending = false; });
    } catch (e) { pending = false; }
  }
  function stop() {
    revision++;
    pending = false;
    if (audio) audio.pause();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else if (audio && enabled) start();
  });
  return {
    get enabled() { return enabled; },
    get playing() { return !!audio && !audio.paused && !audio.ended && enabled; },
    poke: start,
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem('ddz_bgm', enabled ? '1' : '0'); } catch (e) { }
      if (enabled) start(); else stop();
      return enabled;
    },
    // Optional UI integration: Bgm.setTrack('normal' | 'intense').
    setTrack(name) {
      if (!Object.prototype.hasOwnProperty.call(tracks, name) || name === track) return;
      stop();
      track = name;
      if (audio) { audio.src = file(tracks[track]); audio.load(); }
      if (enabled) start();
    },
  };
})();
