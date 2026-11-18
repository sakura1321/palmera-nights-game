// audio.js — all sound is synthesized with WebAudio: a sawtooth engine hum whose pitch
// follows speed, a two-tone police siren, noise-burst collision thuds and small UI
// jingles. No audio files exist. The context is created on the first user gesture
// (the start screen click), as browsers require.
'use strict';

NV.Sound = {
  ctx: null,
  master: null,
  muted: false,
  engineOsc: null,
  engineGain: null,
  engineFilter: null,
  sirenOsc: null,
  sirenGain: null,
  sirenLfo: null,

  init: function () {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  },

  toggleMute: function () {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  },

  // Engine: one sawtooth through a lowpass, started/stopped with driving.
  engine: function (on, speed01, dt) {
    if (!this.ctx) return;
    if (on && !this.engineOsc) {
      this.engineOsc = this.ctx.createOscillator();
      this.engineOsc.type = 'sawtooth';
      this.engineFilter = this.ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0.0;
      this.engineOsc.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);
      this.engineOsc.start();
    }
    if (this.engineOsc) {
      var t = this.ctx.currentTime;
      var target = on ? 0.05 + speed01 * 0.05 : 0.0;
      this.engineGain.gain.setTargetAtTime(target, t, 0.08);
      this.engineOsc.frequency.setTargetAtTime(55 + speed01 * 165, t, 0.05);
      this.engineFilter.frequency.setTargetAtTime(300 + speed01 * 900, t, 0.05);
      if (!on && this.engineGain.gain.value < 0.002) {
        // Let the gain envelope finish before tearing the nodes down.
        var osc = this.engineOsc;
        this.engineOsc = null;
        window.setTimeout(function () { try { osc.stop(); } catch (e) { /* already stopped */ } }, 250);
      }
    }
  },

  // Siren: triangle wave whose frequency an LFO sweeps between two tones.
  siren: function (on, volume) {
    if (!this.ctx) return;
    if (on && !this.sirenOsc) {
      this.sirenOsc = this.ctx.createOscillator();
      this.sirenOsc.type = 'triangle';
      this.sirenOsc.frequency.value = 800;
      this.sirenLfo = this.ctx.createOscillator();
      this.sirenLfo.type = 'square';
      this.sirenLfo.frequency.value = 0.7;
      var lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 160;
      this.sirenLfo.connect(lfoGain);
      lfoGain.connect(this.sirenOsc.frequency);
      this.sirenGain = this.ctx.createGain();
      this.sirenGain.gain.value = 0.0;
      this.sirenOsc.connect(this.sirenGain);
      this.sirenGain.connect(this.master);
      this.sirenOsc.start();
      this.sirenLfo.start();
    }
    if (this.sirenGain) {
      var target = on ? NV.clamp(volume, 0, 0.06) : 0.0;
      this.sirenGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.15);
      if (!on && target === 0) {
        var osc = this.sirenOsc, lfo = this.sirenLfo;
        this.sirenOsc = null; this.sirenLfo = null;
        window.setTimeout(function () {
          try { osc.stop(); lfo.stop(); } catch (e) { /* already stopped */ }
        }, 400);
      }
    }
  },

  // Thud: a short burst of filtered noise; intensity 0..1 scales volume and brightness.
  thud: function (intensity) {
    if (!this.ctx || this.muted) return;
    var dur = 0.12 + intensity * 0.1;
    var len = Math.floor(this.ctx.sampleRate * dur);
    var buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = this.ctx.createBufferSource();
    src.buffer = buffer;
    var filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 200 + intensity * 500;
    var gain = this.ctx.createGain();
    gain.gain.value = 0.15 + intensity * 0.4;
    src.connect(filter); filter.connect(gain); gain.connect(this.master);
    src.start();
  },

  // Gunshot: a crack of broadband noise through a highpass, over a low sine
  // thump that decays fast. Loud and short, like the real thing at a distance.
  gunshot: function () {
    if (!this.ctx || this.muted) return;
    var t = this.ctx.currentTime;
    var len = Math.floor(this.ctx.sampleRate * 0.16);
    var buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
    var src = this.ctx.createBufferSource();
    src.buffer = buffer;
    var hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 700;
    var gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.65, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(hp); hp.connect(gain); gain.connect(this.master);
    src.start();
    var osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.1);
    var og = this.ctx.createGain();
    og.gain.setValueAtTime(0.35, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(og); og.connect(this.master);
    osc.start(t); osc.stop(t + 0.13);
  },

  // Reload: two small metallic clicks, bolt back then bolt home.
  reloadClick: function () {
    if (!this.ctx || this.muted) return;
    for (var i = 0; i < 2; i++) {
      var len = Math.floor(this.ctx.sampleRate * 0.03);
      var buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      var data = buffer.getChannelData(0);
      for (var j = 0; j < len; j++) data[j] = (Math.random() * 2 - 1) * (1 - j / len);
      var src = this.ctx.createBufferSource();
      src.buffer = buffer;
      var bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      var gain = this.ctx.createGain();
      gain.gain.value = 0.22;
      src.connect(bp); bp.connect(gain); gain.connect(this.master);
      src.start(this.ctx.currentTime + i * 0.16);
    }
  },

  // Three-note success jingle for mission rewards.
  jingle: function () {
    if (!this.ctx || this.muted) return;
    var notes = [523.25, 659.25, 783.99];
    for (var i = 0; i < notes.length; i++) {
      var osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = notes[i];
      var gain = this.ctx.createGain();
      var t0 = this.ctx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      osc.connect(gain); gain.connect(this.master);
      osc.start(t0); osc.stop(t0 + 0.3);
    }
  }
};
