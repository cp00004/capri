/* CAPRI // STORIES renderer
   Cinematic 3D-explainer shorts drawn frame by frame: miniature CGI scenes,
   slow dolly moves, volumetric light, film grain, documentary subtitles.
   No external renders, no slideshows - all local canvas. */
(() => {
  "use strict";

  const FONT = '"Inter","Segoe UI",Helvetica,Arial,sans-serif';
  const MONO = '"JetBrains Mono","Cascadia Mono",Consolas,monospace';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  function hash(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < String(text).length; i += 1) {
      h ^= String(text).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hexToRgb(hex) {
    const v = /^#[0-9a-f]{6}$/i.test(String(hex)) ? String(hex) : "#ff8a3d";
    return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
  }

  function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function mix(hex, target, amount) {
    const a = hexToRgb(hex);
    const b = hexToRgb(target);
    const c = a.map((v, i) => Math.round(lerp(v, b[i], amount)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  function rrect(ctx, x, y, w, h, r) {
    const k = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + k, y);
    ctx.lineTo(x + w - k, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + k);
    ctx.lineTo(x + w, y + h - k);
    ctx.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
    ctx.lineTo(x + k, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - k);
    ctx.lineTo(x, y + k);
    ctx.quadraticCurveTo(x, y, x + k, y);
    ctx.closePath();
  }

  const THEMES = {
    whatif: { bg0: "#03060c", bg1: "#0b1424", accent: "#ff8a3d", hot: "#ffd166", label: "WHAT IF", cool: "#5a7bb5" },
    how: { bg0: "#020a10", bg1: "#062230", accent: "#35d6ff", hot: "#b5f5ff", label: "HOW IT WORKS", cool: "#2f8fa8" },
    truestory: { bg0: "#0a0704", bg1: "#1f160c", accent: "#ffcf7a", hot: "#ffe9c4", label: "TRUE STORY", cool: "#8a6f4d" },
  };

  function themeFor(type) {
    return THEMES[type] || THEMES.whatif;
  }

  /* ------------------------------------------------------------ camera */

  function cameraAt(idx, st, dur, W, H) {
    const p = clamp(st / Math.max(0.1, dur), 0, 1);
    const push = easeOutCubic(p);
    const zoom = 1.05 + 0.12 * push + (idx % 2 ? 0.015 * Math.sin(st * 2.1) : 0);
    const dir = idx % 2 ? 1 : -1;
    const dx = dir * (p - 0.5) * W * 0.03 + Math.sin(st * 0.7 + idx) * W * 0.004;
    const dy = Math.sin(st * 0.9 + idx * 2) * H * 0.003;
    const shake = st < 0.26 ? (1 - st / 0.26) * 7 : 0;
    return {
      zoom,
      dx: dx + Math.sin(st * 61 + idx) * shake,
      dy: dy + Math.cos(st * 47 + idx) * shake * 0.6,
    };
  }

  /* ------------------------------------------------------------ environments */

  function sky(ctx, W, H, th, horizon, topTint) {
    const g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, th.bg0);
    g.addColorStop(0.72, mix(th.bg1, topTint || "#000000", 0.15));
    g.addColorStop(1, mix(th.bg1, th.cool, 0.32));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizon);
    const glow = ctx.createRadialGradient(W * 0.5, horizon, 0, W * 0.5, horizon, W * 0.85);
    glow.addColorStop(0, rgba(th.accent, 0.16));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, horizon);
  }

  function floorPlane(ctx, W, H, th, horizon, t, tone) {
    const g = ctx.createLinearGradient(0, horizon, 0, H);
    g.addColorStop(0, mix(th.bg1, th.cool, 0.28));
    g.addColorStop(0.4, tone || "#11161d");
    g.addColorStop(1, "#04060a");
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, W, H - horizon);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, horizon, W, H - horizon);
    ctx.clip();
    ctx.strokeStyle = rgba(th.cool, 0.22);
    ctx.lineWidth = 1.4;
    const vpX = W * 0.5 + Math.sin(t * 0.2) * W * 0.01;
    for (let i = -9; i <= 9; i += 1) {
      ctx.beginPath();
      ctx.moveTo(vpX + i * W * 0.012, horizon + 2);
      ctx.lineTo(W / 2 + i * W * 0.16, H + 40);
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(th.cool, 0.16);
    for (let k = 1; k <= 11; k += 1) {
      const q = Math.pow(k / 11, 2.1);
      const y = horizon + (H - horizon) * q;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();
    const fog = ctx.createLinearGradient(0, horizon, 0, horizon + (H - horizon) * 0.35);
    fog.addColorStop(0, rgba(th.cool, 0.3));
    fog.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = fog;
    ctx.fillRect(0, horizon, W, (H - horizon) * 0.35);
  }

  function skyline(ctx, W, H, th, horizon, seed, t) {
    const rand = rng(seed);
    for (let layer = 0; layer < 2; layer += 1) {
      const alpha = layer ? 0.85 : 0.45;
      let x = -40;
      while (x < W + 60) {
        const bw = W * (0.045 + rand() * 0.075);
        const bh = H * (0.08 + rand() * (layer ? 0.2 : 0.12));
        ctx.fillStyle = rgba(layer ? "#070b12" : mix(th.bg1, th.cool, 0.18), alpha);
        ctx.fillRect(x, horizon - bh, bw, bh);
        if (layer) {
          ctx.fillStyle = rgba(th.hot, 0.32);
          const cols = Math.max(2, Math.floor(bw / (W * 0.016)));
          const rows = Math.max(3, Math.floor(bh / (H * 0.028)));
          for (let c = 0; c < cols; c += 1) {
            for (let r = 0; r < rows; r += 1) {
              if (rand() < 0.32) {
                ctx.globalAlpha = 0.25 + rand() * 0.5;
                ctx.fillRect(x + bw * (0.15 + (c / cols) * 0.7), horizon - bh + bh * (0.12 + (r / rows) * 0.78), W * 0.006, H * 0.007);
                ctx.globalAlpha = 1;
              }
            }
          }
        }
        x += bw + W * 0.012;
      }
    }
  }

  function envFor(kind) {
    const env = {
      horizon: 0.6,
      draw(ctx, W, H, th, t, seed) {
        sky(ctx, W, H, th, H * env.horizon);
        floorPlane(ctx, W, H, th, H * env.horizon, t);
      },
    };
    if (kind === "city" || kind === "street" || kind === "crowd") {
      env.horizon = kind === "crowd" ? 0.62 : 0.58;
      env.draw = (ctx, W, H, th, t, seed) => {
        sky(ctx, W, H, th, H * env.horizon, "#1a2438");
        skyline(ctx, W, H, th, H * env.horizon, seed, t);
        if (kind === "street") {
          floorPlane(ctx, W, H, th, H * env.horizon, t, "#0d1218");
          for (let i = 0; i < 3; i += 1) {
            const x = W * (0.2 + i * 0.3) + Math.sin(t * 0.6 + i) * W * 0.01;
            ctx.strokeStyle = rgba(th.cool, 0.5);
            ctx.lineWidth = W * 0.004;
            ctx.beginPath();
            ctx.moveTo(x, H * 0.6);
            ctx.lineTo(x, H * 0.38);
            ctx.stroke();
            ctx.fillStyle = rgba(th.hot, 0.55);
            ctx.beginPath();
            ctx.arc(x, H * 0.38, W * 0.012, 0, Math.PI * 2);
            ctx.fill();
            const cone = ctx.createLinearGradient(x, H * 0.38, x, H * 0.62);
            cone.addColorStop(0, rgba(th.hot, 0.18));
            cone.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = cone;
            ctx.beginPath();
            ctx.moveTo(x - W * 0.01, H * 0.39);
            ctx.lineTo(x + W * 0.01, H * 0.39);
            ctx.lineTo(x + W * 0.09, H * 0.64);
            ctx.lineTo(x - W * 0.09, H * 0.64);
            ctx.closePath();
            ctx.fill();
          }
          ctx.fillStyle = rgba(th.hot, 0.22);
          for (let i = 0; i < 8; i += 1) {
            const y = H * (0.66 + i * 0.045);
            const w = W * (0.02 + i * 0.006);
            ctx.fillRect(W * 0.5 - w / 2, y, w, H * 0.012);
          }
        } else {
          floorPlane(ctx, W, H, th, H * env.horizon, t);
        }
        if (kind === "crowd") {
          const rand = rng(seed + 4);
          for (let i = 0; i < 9; i += 1) {
            figure(ctx, W * (0.08 + i * 0.105) + rand() * W * 0.02, H * 0.9, H * (0.1 + rand() * 0.03), th, t + rand() * 9, i);
          }
        }
      };
    } else if (kind === "room" || kind === "lab") {
      env.horizon = 0.66;
      env.draw = (ctx, W, H, th, t, seed) => {
        sky(ctx, W, H, th, H * env.horizon, kind === "lab" ? "#10222c" : "#201a14");
        if (kind === "lab") {
          ctx.strokeStyle = rgba(th.cool, 0.18);
          ctx.lineWidth = 1;
          const step = W * 0.085;
          for (let x = 0; x < W; x += step) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H * env.horizon); ctx.stroke();
          }
          for (let y = 0; y < H * env.horizon; y += step) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
          }
          ctx.fillStyle = rgba(th.accent, 0.25);
          rrect(ctx, W * 0.66, H * 0.1, W * 0.3, H * 0.32, 12);
          ctx.fill();
          ctx.strokeStyle = rgba(th.accent, 0.6);
          ctx.lineWidth = 2;
          for (let i = 0; i < 4; i += 1) {
            ctx.beginPath();
            ctx.moveTo(W * 0.68, H * (0.16 + i * 0.06));
            ctx.lineTo(W * 0.68 + W * 0.2 * (0.4 + 0.5 * Math.abs(Math.sin(t * 2 + i))), H * (0.16 + i * 0.06));
            ctx.stroke();
          }
        } else {
          ctx.fillStyle = rgba(th.hot, 0.1);
          const win = ctx.createLinearGradient(W * 0.6, H * 0.1, W * 0.95, H * 0.4);
          win.addColorStop(0, rgba(th.hot, 0.35));
          win.addColorStop(1, "rgba(0,0,0,0)");
          rrect(ctx, W * 0.6, H * 0.08, W * 0.34, H * 0.3, 10);
          ctx.fillStyle = win;
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.5)";
          ctx.lineWidth = 10;
          ctx.stroke();
        }
        floorPlane(ctx, W, H, th, H * env.horizon, t, kind === "lab" ? "#0a1418" : "#14100b");
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, H * env.horizon - H * 0.008, W, H * 0.012);
      };
    } else if (kind === "ocean") {
      env.horizon = 0.56;
      env.draw = (ctx, W, H, th, t, seed) => {
        sky(ctx, W, H, th, H * env.horizon, "#0d1a2e");
        const g = ctx.createLinearGradient(0, H * env.horizon, 0, H);
        g.addColorStop(0, mix(th.bg1, th.cool, 0.5));
        g.addColorStop(0.55, "#0a1c28");
        g.addColorStop(1, "#030a10");
        ctx.fillStyle = g;
        ctx.fillRect(0, H * env.horizon, W, H);
        ctx.strokeStyle = rgba(th.hot, 0.22);
        for (let i = 0; i < 7; i += 1) {
          ctx.lineWidth = 1.5 + i * 0.4;
          ctx.beginPath();
          const y = H * (env.horizon + 0.06 + i * 0.055);
          for (let x = 0; x <= W; x += W / 24) {
            const yy = y + Math.sin(x / W * 9 + t * (1.4 + i * 0.2) + i) * (3 + i * 2);
            if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
          }
          ctx.stroke();
        }
        const moon = ctx.createRadialGradient(W * 0.74, H * 0.2, 0, W * 0.74, H * 0.2, H * 0.06);
        moon.addColorStop(0, rgba(th.hot, 0.9));
        moon.addColorStop(0.5, rgba(th.hot, 0.35));
        moon.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = moon;
        ctx.beginPath();
        ctx.arc(W * 0.74, H * 0.2, H * 0.06, 0, Math.PI * 2);
        ctx.fill();
      };
    } else if (kind === "desert") {
      env.horizon = 0.6;
      env.draw = (ctx, W, H, th, t, seed) => {
        sky(ctx, W, H, th, H * env.horizon, "#2a1808");
        const rand = rng(seed + 9);
        for (let i = 0; i < 3; i += 1) {
          ctx.fillStyle = rgba(mix(th.bg1, th.accent, 0.08 + i * 0.06), 0.9);
          ctx.beginPath();
          ctx.moveTo(0, H * (0.64 + i * 0.09));
          ctx.bezierCurveTo(W * (0.2 + rand() * 0.2), H * (0.56 + i * 0.09), W * (0.6 + rand() * 0.2), H * (0.7 + i * 0.08), W, H * (0.62 + i * 0.09));
          ctx.lineTo(W, H);
          ctx.lineTo(0, H);
          ctx.closePath();
          ctx.fill();
        }
        const sun = ctx.createRadialGradient(W * 0.32, H * 0.36, 0, W * 0.32, H * 0.36, H * 0.09);
        sun.addColorStop(0, rgba(th.hot, 0.95));
        sun.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = sun;
        ctx.beginPath();
        ctx.arc(W * 0.32, H * 0.36, H * 0.09, 0, Math.PI * 2);
        ctx.fill();
      };
    } else if (kind === "space") {
      env.horizon = 0.68;
      env.draw = (ctx, W, H, th, t, seed) => {
        sky(ctx, W, H, th, H, "#050b1c");
        const rand = rng(seed + 3);
        for (let i = 0; i < 110; i += 1) {
          const x = rand() * W;
          const y = rand() * H * 0.85;
          const a = 0.3 + 0.7 * Math.abs(Math.sin(t * 1.3 + i));
          ctx.fillStyle = `rgba(220,235,255,${a * 0.7})`;
          ctx.fillRect(x, y, 1.6, 1.6);
        }
        const pg = ctx.createRadialGradient(W * 0.76, H * 0.2, W * 0.02, W * 0.76, H * 0.2, W * 0.3);
        pg.addColorStop(0, rgba(th.cool, 0.85));
        pg.addColorStop(0.65, rgba(th.cool, 0.3));
        pg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = pg;
        ctx.beginPath();
        ctx.arc(W * 0.76, H * 0.2, W * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgba(th.accent, 0.12);
        ctx.fillRect(0, H * env.horizon, W, H - H * env.horizon);
        for (let i = 0; i < 4; i += 1) {
          ctx.fillStyle = rgba(th.hot, 0.16);
          ctx.fillRect(0, H * (env.horizon + 0.04 + i * 0.07), W, 2);
        }
      };
    } else if (kind === "body") {
      env.horizon = 0.7;
      env.draw = (ctx, W, H, th, t, seed) => {
        const g = ctx.createRadialGradient(W * 0.5, H * 0.3, 10, W * 0.5, H * 0.55, W * 0.9);
        g.addColorStop(0, "#4a1018");
        g.addColorStop(0.5, "#240a10");
        g.addColorStop(1, "#080203");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = rgba("#ff6b6b", 0.22);
        for (let i = 0; i < 6; i += 1) {
          const x = W * (0.15 + i * 0.14);
          const w = W * (0.05 + 0.02 * Math.sin(t + i));
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(x, -20);
          ctx.bezierCurveTo(x + W * 0.05 * Math.sin(t * 0.7 + i), H * 0.3, x - W * 0.05, H * 0.7, x, H + 20);
          ctx.stroke();
        }
        const fog = ctx.createLinearGradient(0, H * 0.5, 0, H);
        fog.addColorStop(0, "rgba(0,0,0,0)");
        fog.addColorStop(1, "rgba(0,0,0,0.6)");
        ctx.fillStyle = fog;
        ctx.fillRect(0, 0, W, H);
      };
    } else if (kind === "machine") {
      env.horizon = 0.64;
      env.draw = (ctx, W, H, th, t, seed) => {
        sky(ctx, W, H, th, H * env.horizon, "#0a1a24");
        const rand = rng(seed + 11);
        for (let i = 0; i < 5; i += 1) {
          const cx = W * (0.12 + i * 0.2);
          const cy = H * (0.2 + rand() * 0.25);
          const r = W * (0.04 + rand() * 0.03);
          ctx.strokeStyle = rgba(th.cool, 0.5);
          ctx.lineWidth = W * 0.008;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(t * (0.6 + rand()));
          ctx.strokeStyle = rgba(th.cool, 0.55);
          for (let k = 0; k < 8; k += 1) {
            ctx.beginPath();
            ctx.moveTo(r * 0.7, 0);
            ctx.lineTo(r * 1.25, 0);
            ctx.stroke();
            ctx.rotate(Math.PI / 4);
          }
          ctx.restore();
        }
        ctx.strokeStyle = rgba(th.cool, 0.35);
        ctx.lineWidth = W * 0.02;
        ctx.beginPath();
        ctx.moveTo(0, H * 0.5);
        ctx.lineTo(W, H * 0.5);
        ctx.stroke();
        floorPlane(ctx, W, H, th, H * env.horizon, t, "#090d12");
      };
    } else if (kind === "jungle") {
      env.horizon = 0.64;
      env.draw = (ctx, W, H, th, t, seed) => {
        sky(ctx, W, H, th, H * env.horizon, "#0c1a10");
        const rand = rng(seed + 13);
        for (let i = 0; i < 7; i += 1) {
          const x = W * (0.06 + i * 0.15) + rand() * W * 0.04;
          const h = H * (0.16 + rand() * 0.14);
          ctx.fillStyle = "rgba(3,10,6,0.9)";
          ctx.fillRect(x, H * env.horizon - h, W * 0.012, h);
          ctx.fillStyle = "rgba(6,20,12,0.95)";
          for (let k = 0; k < 4; k += 1) {
            ctx.beginPath();
            ctx.ellipse(x + Math.sin(k + i) * W * 0.05, H * env.horizon - h + k * H * 0.02, W * 0.09, H * 0.03, k * 0.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        floorPlane(ctx, W, H, th, H * env.horizon, t, "#08130c");
        for (let i = 0; i < 20; i += 1) {
          ctx.fillStyle = `rgba(180,255,170,${0.08 + 0.2 * Math.abs(Math.sin(t + i))})`;
          ctx.beginPath();
          ctx.arc(rand() * W, H * (0.3 + rand() * 0.6), 2, 0, Math.PI * 2);
          ctx.fill();
        }
      };
    } else if (kind === "ice") {
      env.horizon = 0.6;
      env.draw = (ctx, W, H, th, t, seed) => {
        sky(ctx, W, H, th, H * env.horizon, "#0d2230");
        const g = ctx.createLinearGradient(0, H * env.horizon, 0, H);
        g.addColorStop(0, "#1b3a4c");
        g.addColorStop(1, "#081820");
        ctx.fillStyle = g;
        ctx.fillRect(0, H * env.horizon, W, H);
        ctx.strokeStyle = rgba(th.hot, 0.3);
        ctx.lineWidth = 2;
        const rand = rng(seed + 17);
        for (let i = 0; i < 7; i += 1) {
          const x = rand() * W;
          const y = H * (env.horizon + rand() * 0.3);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + W * (rand() * 0.12 - 0.06), y + H * 0.06);
          ctx.lineTo(x + W * (rand() * 0.16 - 0.08), y + H * 0.13);
          ctx.stroke();
        }
        for (let i = 0; i < 40; i += 1) {
          const y = (rand() * H + t * 40) % H;
          ctx.fillStyle = "rgba(255,255,255,0.5)";
          ctx.fillRect(rand() * W, y, 2, 2);
        }
      };
    } else if (kind === "volcano") {
      env.horizon = 0.66;
      env.draw = (ctx, W, H, th, t, seed) => {
        sky(ctx, W, H, th, H * env.horizon, "#2a0d05");
        ctx.fillStyle = "#120a08";
        ctx.beginPath();
        ctx.moveTo(0, H * env.horizon);
        ctx.lineTo(W * 0.36, H * 0.2);
        ctx.lineTo(W * 0.5, H * 0.34);
        ctx.lineTo(W * 0.64, H * 0.2);
        ctx.lineTo(W, H * env.horizon);
        ctx.closePath();
        ctx.fill();
        const lava = ctx.createLinearGradient(0, H * 0.3, 0, H);
        lava.addColorStop(0, rgba(th.accent, 0.95));
        lava.addColorStop(1, "rgba(120,20,0,0.9)");
        ctx.fillStyle = lava;
        ctx.beginPath();
        ctx.ellipse(W * 0.5, H * 0.33, W * 0.09, H * 0.018, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(30,10,4,0.85)";
        for (let i = 0; i < 4; i += 1) {
          ctx.beginPath();
          ctx.ellipse(W * (0.44 + i * 0.04) + Math.sin(t + i) * 8, H * (0.12 + i * 0.03), W * 0.06, H * 0.018, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        floorPlane(ctx, W, H, th, H * env.horizon, t, "#140a06");
      };
    } else if (kind === "sky") {
      env.horizon = 0.9;
      env.draw = (ctx, W, H, th, t, seed) => {
        sky(ctx, W, H, th, H, "#16324a");
        const rand = rng(seed + 19);
        for (let i = 0; i < 6; i += 1) {
          const x = (rand() * W + t * W * 0.006 * (i + 1)) % W;
          const y = H * (0.15 + rand() * 0.5);
          ctx.fillStyle = `rgba(200,220,240,${0.05 + rand() * 0.06})`;
          ctx.beginPath();
          ctx.ellipse(x, y, W * (0.14 + rand() * 0.1), H * 0.03, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      };
    }
    return env;
  }

  /* ------------------------------------------------------------ figures */

  function figure(ctx, x, ground, h, th, t, phase, flip) {
    const w = h * 0.3;
    const sway = Math.sin(t * 1.5 + phase) * h * 0.012;
    ctx.save();
    ctx.translate(x, ground);
    if (flip) ctx.scale(-1, 1);
    // contact shadow
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 1.1, h * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
    // legs
    ctx.fillStyle = "#05070a";
    ctx.fillRect(-w * 0.36, -h * 0.42, w * 0.26, h * 0.42);
    ctx.fillRect(w * 0.1, -h * 0.42, w * 0.26, h * 0.42);
    // body
    const g = ctx.createLinearGradient(-w, 0, w, 0);
    g.addColorStop(0, "#04060a");
    g.addColorStop(0.55, "#0b0f16");
    g.addColorStop(1, rgba(th.accent, 0.32));
    ctx.fillStyle = g;
    rrect(ctx, -w * 0.52 + sway * 0.2, -h, w * 1.04, h * 0.62, w * 0.42);
    ctx.fill();
    // arms
    ctx.fillStyle = "#070a10";
    ctx.save();
    ctx.translate(-w * 0.52, -h * 0.86);
    ctx.rotate(0.18 + Math.sin(t * 1.2 + phase) * 0.05);
    ctx.fillRect(-w * 0.14, 0, w * 0.16, h * 0.34);
    ctx.restore();
    ctx.save();
    ctx.translate(w * 0.5, -h * 0.86);
    ctx.rotate(-0.16 - Math.sin(t * 1.4 + phase) * 0.05);
    ctx.fillRect(-w * 0.02, 0, w * 0.16, h * 0.34);
    ctx.restore();
    // head
    const hg = ctx.createRadialGradient(-w * 0.1, -h * 1.06, 0, 0, -h, w * 0.36);
    hg.addColorStop(0, "#111722");
    hg.addColorStop(0.7, "#070a10");
    hg.addColorStop(1, rgba(th.accent, 0.35));
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(sway * 0.3, -h * 1.0, w * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* ------------------------------------------------------------ objects */

  function contactShadow(ctx, x, ground, s, th) {
    const g = ctx.createRadialGradient(x, ground, 0, x, ground, s * 1.8);
    g.addColorStop(0, "rgba(0,0,0,0.65)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, ground, s * 1.8, s * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function object3D(ctx, kind, x, y, s, t, th) {
    const rim = rgba(th.accent, 0.8);
    ctx.save();
    ctx.translate(x, y);
    if (kind === "sphere") {
      const g = ctx.createRadialGradient(-s * 0.25, -s * 0.3, s * 0.08, 0, 0, s);
      g.addColorStop(0, th.hot);
      g.addColorStop(0.22, th.accent);
      g.addColorStop(0.7, mix(th.accent, "#120a14", 0.82));
      g.addColorStop(1, "#07050a");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, s, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rim;
      ctx.lineWidth = s * 0.02;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.beginPath();
      ctx.ellipse(-s * 0.32, -s * 0.4, s * 0.26, s * 0.13, -0.5, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 3; i += 1) {
        ctx.strokeStyle = rgba(th.accent, 0.18);
        ctx.lineWidth = s * 0.05;
        ctx.beginPath();
        ctx.ellipse(0, 0, s * (0.75 + i * 0.12), s * 0.28, t * 0.05 + i * 0.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (kind === "cube" || kind === "money") {
      const h = s * 1.1;
      const d = s * 0.42;
      // top
      ctx.fillStyle = mix(th.accent, "#ffffff", 0.25);
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.lineTo(s, -h + d);
      ctx.lineTo(0, -h + d * 2);
      ctx.lineTo(-s, -h + d);
      ctx.closePath();
      ctx.fill();
      // left
      ctx.fillStyle = mix(th.accent, "#000000", 0.45);
      ctx.beginPath();
      ctx.moveTo(-s, -h + d);
      ctx.lineTo(0, -h + d * 2);
      ctx.lineTo(0, d);
      ctx.lineTo(-s, 0);
      ctx.closePath();
      ctx.fill();
      // right
      ctx.fillStyle = mix(th.accent, "#000000", 0.18);
      ctx.beginPath();
      ctx.moveTo(s, -h + d);
      ctx.lineTo(0, -h + d * 2);
      ctx.lineTo(0, d);
      ctx.lineTo(s, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba(th.hot, 0.5);
      ctx.lineWidth = 2;
      ctx.stroke();
      if (kind === "money") {
        ctx.fillStyle = "rgba(10, 40, 20, 0.65)";
        ctx.font = `700 ${s * 0.5}px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("$", 0, -h * 0.45);
      }
      for (let i = 0; i < 3; i += 1) {
        ctx.strokeStyle = rgba(th.hot, 0.25);
        ctx.beginPath();
        ctx.ellipse(0, -s * (0.1 + i * 0.32), s * 0.9, s * 0.16, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (kind === "ring") {
      ctx.strokeStyle = rgba(th.accent, 0.9);
      ctx.lineWidth = s * 0.22;
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 0.9, s * 0.62, 0.1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = rgba(th.hot, 0.55);
      ctx.lineWidth = s * 0.06;
      ctx.beginPath();
      ctx.ellipse(-s * 0.12, -s * 0.08, s * 0.9, s * 0.62, 0.1, Math.PI * 0.9, Math.PI * 1.7);
      ctx.stroke();
    } else if (kind === "wave") {
      for (let i = 0; i < 3; i += 1) {
        const g = ctx.createLinearGradient(0, -s, 0, s);
        g.addColorStop(0, rgba(th.hot, 0.85 - i * 0.2));
        g.addColorStop(1, rgba(th.accent, 0.15));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-s * 1.1, s * 0.2);
        for (let px = -s * 1.1; px <= s * 1.1; px += s * 0.1) {
          const py = -s * (0.55 - i * 0.22) + Math.sin(px / s * 3 + t * (2 + i) + i) * s * 0.16;
          ctx.lineTo(px, py);
        }
        ctx.lineTo(s * 1.1, s * 0.8);
        ctx.lineTo(-s * 1.1, s * 0.8);
        ctx.closePath();
        ctx.fill();
      }
    } else if (kind === "flame") {
      for (let i = 0; i < 3; i += 1) {
        const h = s * (1.5 - i * 0.28);
        const g = ctx.createLinearGradient(0, -h, 0, s * 0.3);
        g.addColorStop(0, i === 2 ? "#fff3d6" : th.hot);
        g.addColorStop(0.5, th.accent);
        g.addColorStop(1, "rgba(120,20,0,0.1)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, -h);
        ctx.bezierCurveTo(s * (0.5 - i * 0.12), -h * 0.5 + Math.sin(t * 6 + i) * s * 0.06, s * (0.35 - i * 0.1), s * 0.1, 0, s * 0.35);
        ctx.bezierCurveTo(-s * (0.35 - i * 0.1), s * 0.1, -s * (0.5 - i * 0.12), -h * 0.5, 0, -h);
        ctx.fill();
      }
    } else if (kind === "bolt") {
      ctx.shadowColor = th.hot;
      ctx.shadowBlur = s * 0.8;
      ctx.fillStyle = th.hot;
      ctx.beginPath();
      ctx.moveTo(s * 0.1, -s);
      ctx.lineTo(-s * 0.35, s * 0.1);
      ctx.lineTo(0, s * 0.05);
      ctx.lineTo(-s * 0.08, s);
      ctx.lineTo(s * 0.4, -s * 0.1);
      ctx.lineTo(s * 0.02, -s * 0.02);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
    } else if (kind === "phone") {
      ctx.fillStyle = "#0a0c12";
      rrect(ctx, -s * 0.55, -s, s * 1.1, s * 2, s * 0.16);
      ctx.fill();
      ctx.strokeStyle = rgba(th.hot, 0.8);
      ctx.lineWidth = 3;
      ctx.stroke();
      const g = ctx.createLinearGradient(0, -s * 0.9, 0, s * 0.9);
      g.addColorStop(0, rgba(th.accent, 0.75));
      g.addColorStop(1, rgba(th.cool, 0.25));
      ctx.fillStyle = g;
      rrect(ctx, -s * 0.46, -s * 0.88, s * 0.92, s * 1.7, s * 0.1);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(-s * 0.2, -s * 0.96, s * 0.4, s * 0.04);
    } else if (kind === "drop") {
      const g = ctx.createRadialGradient(-s * 0.2, -s * 0.3, 0, 0, 0, s);
      g.addColorStop(0, th.hot);
      g.addColorStop(0.4, th.accent);
      g.addColorStop(1, "rgba(10,30,60,0.2)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -s * 1.2);
      ctx.bezierCurveTo(s * 0.5, -s * 0.3, s * 0.62, s * 0.4, 0, s * 0.9);
      ctx.bezierCurveTo(-s * 0.62, s * 0.4, -s * 0.5, -s * 0.3, 0, -s * 1.2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.beginPath();
      ctx.ellipse(-s * 0.16, s * 0.1, s * 0.09, s * 0.2, 0.2, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === "tree") {
      ctx.fillStyle = "#1c120a";
      ctx.fillRect(-s * 0.08, -s * 0.5, s * 0.16, s * 1.1);
      const g = ctx.createRadialGradient(-s * 0.2, -s * 0.7, 0, 0, -s * 0.4, s);
      g.addColorStop(0, mix(th.accent, "#ffffff", 0.2));
      g.addColorStop(1, mix(th.accent, "#000000", 0.6));
      ctx.fillStyle = g;
      for (const [dx, dy, r] of [[0, -0.8, 0.6], [-0.3, -0.45, 0.45], [0.32, -0.5, 0.42], [0, -0.35, 0.5]]) {
        ctx.beginPath();
        ctx.arc(s * dx, s * dy, s * r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === "building") {
      const g = ctx.createLinearGradient(-s, 0, s, 0);
      g.addColorStop(0, mix(th.accent, "#000000", 0.55));
      g.addColorStop(1, mix(th.accent, "#000000", 0.2));
      ctx.fillStyle = g;
      ctx.fillRect(-s * 0.45, -s * 1.4, s * 0.9, s * 1.4);
      ctx.fillStyle = rgba(th.hot, 0.55);
      for (let r = 0; r < 7; r += 1) {
        for (let c = 0; c < 4; c += 1) {
          if ((r * 4 + c) % 5 !== 0) ctx.fillRect(-s * 0.36 + c * s * 0.2, -s * 1.32 + r * s * 0.17, s * 0.1, s * 0.08);
        }
      }
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 2;
      ctx.strokeRect(-s * 0.45, -s * 1.4, s * 0.9, s * 1.4);
    } else if (kind === "clock") {
      const g = ctx.createRadialGradient(-s * 0.2, -s * 0.2, 0, 0, 0, s);
      g.addColorStop(0, mix(th.accent, "#ffffff", 0.3));
      g.addColorStop(1, mix(th.accent, "#000000", 0.55));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, s, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = s * 0.03;
      for (let i = 0; i < 12; i += 1) {
        const a = i * Math.PI / 6;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * s * 0.82, Math.sin(a) * s * 0.82);
        ctx.lineTo(Math.cos(a) * s * 0.93, Math.sin(a) * s * 0.93);
        ctx.stroke();
      }
      ctx.strokeStyle = "#0a0c12";
      ctx.lineWidth = s * 0.06;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(t * 0.9 - Math.PI / 2) * s * 0.55, Math.sin(t * 0.9 - Math.PI / 2) * s * 0.55);
      ctx.stroke();
      ctx.lineWidth = s * 0.04;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(t * 2.4 - Math.PI / 2) * s * 0.75, Math.sin(t * 2.4 - Math.PI / 2) * s * 0.75);
      ctx.stroke();
    } else if (kind === "rocket") {
      ctx.fillStyle = "#cfd8e3";
      rrect(ctx, -s * 0.25, -s * 1.2, s * 0.5, s * 1.6, s * 0.2);
      ctx.fill();
      ctx.fillStyle = th.accent;
      ctx.beginPath();
      ctx.moveTo(-s * 0.25, -s * 0.9);
      ctx.lineTo(0, -s * 1.55);
      ctx.lineTo(s * 0.25, -s * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = mix(th.accent, "#000000", 0.5);
      ctx.beginPath();
      ctx.moveTo(-s * 0.25, s * 0.1);
      ctx.lineTo(-s * 0.5, s * 0.5);
      ctx.lineTo(-s * 0.25, s * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s * 0.25, s * 0.1);
      ctx.lineTo(s * 0.5, s * 0.5);
      ctx.lineTo(s * 0.25, s * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = rgba(th.hot, 0.9);
      ctx.beginPath();
      ctx.arc(0, -s * 0.62, s * 0.1, 0, Math.PI * 2);
      ctx.fill();
      const fg = ctx.createLinearGradient(0, s * 0.4, 0, s * 1.3 + Math.sin(t * 15) * s * 0.1);
      fg.addColorStop(0, th.hot);
      fg.addColorStop(1, "rgba(255,120,40,0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(-s * 0.14, s * 0.4);
      ctx.lineTo(s * 0.14, s * 0.4);
      ctx.lineTo(0, s * 1.35 + Math.sin(t * 15) * s * 0.1);
      ctx.closePath();
      ctx.fill();
    } else if (kind === "skull") {
      ctx.fillStyle = "#d8d2c4";
      ctx.beginPath();
      ctx.arc(0, -s * 0.2, s * 0.7, Math.PI * 0.92, Math.PI * 2.08);
      ctx.fill();
      rrect(ctx, -s * 0.36, s * 0.15, s * 0.72, s * 0.55, s * 0.12);
      ctx.fill();
      ctx.fillStyle = "#0a0a0c";
      ctx.beginPath();
      ctx.ellipse(-s * 0.26, -s * 0.2, s * 0.16, s * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(s * 0.26, -s * 0.2, s * 0.16, s * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(th.accent, 0.7);
      ctx.beginPath();
      ctx.arc(0, s * 0.02, s * 0.06, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0a0a0c";
      for (let i = 0; i < 4; i += 1) ctx.fillRect(-s * 0.3 + i * s * 0.17, s * 0.5, s * 0.1, s * 0.2);
    } else if (kind === "heart") {
      const g = ctx.createRadialGradient(-s * 0.2, -s * 0.25, 0, 0, 0, s);
      g.addColorStop(0, mix(th.hot, "#ffffff", 0.3));
      g.addColorStop(0.55, th.accent);
      g.addColorStop(1, "#4a0b12");
      ctx.fillStyle = g;
      const beat = 1 + Math.sin(t * 6) * 0.04;
      ctx.scale(beat, beat);
      ctx.beginPath();
      ctx.moveTo(0, s * 0.65);
      ctx.bezierCurveTo(-s * 1.1, -s * 0.05, -s * 0.55, -s * 0.95, 0, -s * 0.35);
      ctx.bezierCurveTo(s * 0.55, -s * 0.95, s * 1.1, -s * 0.05, 0, s * 0.65);
      ctx.fill();
    } else {
      // person: a giant statue-like figure
      figure(ctx, 0, s * 0.9, s * 2.2, th, t, 0);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ overlays */

  function lightCone(ctx, W, H, x, th) {
    const g = ctx.createLinearGradient(x, 0, x, H * 0.75);
    g.addColorStop(0, rgba(th.hot, 0.14));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - W * 0.06, 0);
    ctx.lineTo(x + W * 0.06, 0);
    ctx.lineTo(x + W * 0.32, H * 0.8);
    ctx.lineTo(x - W * 0.32, H * 0.8);
    ctx.closePath();
    ctx.fill();
  }

  function dust(ctx, W, H, t, th, seed) {
    const rand = rng(seed + 31);
    for (let i = 0; i < 36; i += 1) {
      const x = (rand() * W + Math.sin(t * 0.4 + i) * W * 0.01) % W;
      const y = (H * 0.95 - ((t * (8 + rand() * 22) + rand() * H) % (H * 0.7)));
      const a = 0.06 + 0.18 * Math.abs(Math.sin(t * 1.1 + i));
      ctx.fillStyle = rgba(th.hot, a);
      ctx.beginPath();
      ctx.arc(x, y, 1 + rand() * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function kicker(ctx, W, H, text, th, alpha) {
    if (!text || alpha <= 0) return;
    const size = Math.max(14, W * 0.022);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${size}px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = String(text).toUpperCase().slice(0, 24);
    const tw = ctx.measureText(label).width;
    const y = H * 0.13;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    rrect(ctx, W / 2 - tw / 2 - size, y - size, tw + size * 2, size * 2, size);
    ctx.fill();
    ctx.fillStyle = th.accent;
    ctx.beginPath();
    ctx.arc(W / 2 - tw / 2 - size * 0.4, y, size * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, W / 2 + size * 0.2, y + 1);
    ctx.restore();
  }

  function subtitles(ctx, W, H, text, age, th, vertical) {
    const size = (vertical ? W : H) * 0.052;
    ctx.save();
    ctx.font = `600 ${size}px ${FONT}`;
    const maxW = W * (vertical ? 0.84 : 0.66);
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = [];
    for (const w of words) {
      const attempt = [...line, w].join(" ");
      if (line.length && ctx.measureText(attempt).width > maxW) {
        lines.push(line);
        line = [w];
      } else line.push(w);
    }
    if (line.length) lines.push(line);
    const shown = lines.slice(-3);
    const lineH = size * 1.3;
    const baseY = H * (vertical ? 0.845 : 0.82);
    const fade = clamp(age / 0.18, 0, 1) * clamp((1.5 - age) * 4 + 0.3, 0, 1);
    const back = ctx.createLinearGradient(0, baseY - lineH * shown.length - size, 0, baseY + size);
    back.addColorStop(0, "rgba(2,4,8,0)");
    back.addColorStop(1, "rgba(2,4,8,0.72)");
    ctx.fillStyle = back;
    ctx.fillRect(0, baseY - lineH * shown.length - size * 1.4, W, lineH * shown.length + size * 2.2);
    let idx = 0;
    shown.forEach((ln, li) => {
      const y = baseY - (shown.length - 1 - li) * lineH;
      const textLine = ln.join(" ");
      const tw = ctx.measureText(textLine).width;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ln.forEach((word, wi) => {
        const before = ln.slice(0, wi).join(" ");
        const ww = ctx.measureText(word).width;
        const offset = (before ? ctx.measureText(`${before} `).width : 0);
        const p = clamp((age - 0.12 - idx * 0.055) / 0.2, 0, 1);
        if (p <= 0) { idx += 1; return; }
        ctx.globalAlpha = fade * p;
        ctx.fillStyle = "rgba(2,4,8,0.85)";
        ctx.fillText(word, W / 2 - tw / 2 + offset + ww / 2 + 2, y + 2);
        ctx.fillStyle = "#f4f7fb";
        ctx.fillText(word, W / 2 - tw / 2 + offset + ww / 2, y);
        idx += 1;
      });
    });
    ctx.restore();
  }

  function tag(ctx, W, H, th, alpha) {
    if (alpha <= 0) return;
    const size = Math.max(13, W * 0.019);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${size}px ${MONO}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const label = th.label;
    const tw = ctx.measureText(label).width;
    const x = W * 0.055;
    const y = H * 0.055;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    rrect(ctx, x, y - size, tw + size * 3, size * 2, size);
    ctx.fill();
    ctx.fillStyle = th.accent;
    ctx.beginPath();
    ctx.arc(x + size * 1.1, y, size * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, x + size * 1.9, y + 1);
    ctx.restore();
  }

  function brand(ctx, W, H, alpha) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    const size = Math.max(11, W * 0.014);
    ctx.font = `600 ${size}px ${MONO}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("CAPRI FILMS", W * 0.945, H * 0.055);
    ctx.restore();
  }

  function progress(ctx, W, H, p, th) {
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(0, H - 5, W, 5);
    ctx.fillStyle = th.accent;
    ctx.fillRect(0, H - 5, W * clamp(p, 0, 1), 5);
  }

  function grain(ctx, W, H, frame, amount) {
    const rand = rng(frame * 7919 + 13);
    ctx.save();
    ctx.globalAlpha = amount;
    for (let i = 0; i < 220; i += 1) {
      const v = rand();
      ctx.fillStyle = v > 0.5 ? "#ffffff" : "#000000";
      ctx.globalAlpha = amount * (0.25 + rand() * 0.75);
      ctx.fillRect(rand() * W, rand() * H, 1.5, 1.5);
    }
    ctx.restore();
  }

  function vignette(ctx, W, H, strength) {
    const v = ctx.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.25, W / 2, H * 0.5, Math.max(W, H) * 0.72);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(0.75, `rgba(0,0,0,${0.18 * strength})`);
    v.addColorStop(1, `rgba(0,0,0,${0.62 * strength})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  /* ------------------------------------------------------------ frame */

  function drawFrame(ctx, opt) {
    const { W, H, script, t, seconds } = opt;
    const scenes = script?.scenes?.length ? script.scenes : [{ narration: "This is how it works.", visual: "room", symbol: "sphere", focus: "START", caption: "START" }];
    const th = themeFor(script?.type);
    const dur = Math.max(1, Number(seconds) || 20);
    const sceneDur = dur / scenes.length;
    const idx = clamp(Math.floor(t / sceneDur), 0, scenes.length - 1);
    const st = t - idx * sceneDur;
    const scene = scenes[idx];
    const seed = script?.seed || 7;

    const env = envFor(scene.visual || "room");
    const cam = cameraAt(idx, st, sceneDur, W, H);

    ctx.save();
    ctx.translate(W / 2 + cam.dx, H / 2 + cam.dy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-W / 2, -H / 2);

    env.draw(ctx, W, H, th, t, seed + idx);

    const ground = H * (env.horizon + 0.14);
    const objX = W * (0.5 + Math.sin(idx * 1.7 + t * 0.15) * 0.05);
    const objY = H * 0.46;
    const objS = Math.min(W, H) * 0.2;

    if (idx === 0 || idx % 3 === 0) lightCone(ctx, W, H, objX, th);
    contactShadow(ctx, objX, ground, objS, th);
    object3D(ctx, scene.symbol || "sphere", objX, objY - Math.sin(t * 0.8) * objS * 0.04, objS, t, th);

    const rand = rng(seed + idx * 17);
    const cast = 3 + (hash(String(scene.narration)) % 3);
    for (let i = 0; i < cast; i += 1) {
      const side = i % 2 ? 1 : -1;
      const depth = 0.6 + rand() * 0.8;
      const fh = H * (0.1 + rand() * 0.06) * depth;
      const fx = W * 0.5 + side * W * (0.18 + rand() * 0.22);
      figure(ctx, fx, ground + H * (0.02 + rand() * 0.06), fh, th, t + rand() * 5, i, side > 0);
    }
    dust(ctx, W, H, t, th, seed + idx);
    ctx.restore();

    // scene-cut dip
    if (t > 0.02 && st < 0.24) {
      ctx.fillStyle = `rgba(2,3,6,${(1 - st / 0.24) * 0.85})`;
      ctx.fillRect(0, 0, W, H);
    }

    // intro hook card
    if (t < 2.2) {
      const pin = clamp(t / 0.4, 0, 1);
      const pout = clamp((2.2 - t) / 0.35, 0, 1);
      const a = Math.min(pin, pout);
      ctx.save();
      ctx.fillStyle = `rgba(2,4,8,${0.62 * a})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = a;
      const size = W * (H > W ? 0.075 : 0.05);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `700 ${Math.max(12, W * 0.02)}px ${MONO}`;
      ctx.fillStyle = th.accent;
      const tagText = th.label.split("").join(" ");
      ctx.fillText(tagText, W / 2, H * 0.4);
      ctx.font = `800 ${size}px ${FONT}`;
      ctx.fillStyle = "#ffffff";
      const hook = String(script?.hook || scene.narration || "").toUpperCase();
      const words = hook.split(" ");
      const lines = [];
      let line = [];
      for (const w of words) {
        if (line.length && ctx.measureText([...line, w].join(" ")).width > W * 0.82) {
          lines.push(line.join(" "));
          line = [w];
        } else line.push(w);
      }
      if (line.length) lines.push(line.join(" "));
      lines.slice(0, 3).forEach((ln, i) => {
        ctx.fillText(ln, W / 2, H * 0.47 + i * size * 1.14 - (lines.length - 1) * size * 0.57);
      });
      ctx.strokeStyle = th.accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(W * 0.5 - W * 0.08, H * 0.57);
      ctx.lineTo(W * 0.5 + W * 0.08, H * 0.57);
      ctx.stroke();
      ctx.restore();
    }

    // tag + scene kicker
    tag(ctx, W, H, th, clamp((t - 0.4) / 0.5, 0, 1));
    const kickA = clamp((st - 0.1) / 0.3, 0, 1) * clamp((sceneDur - st) / 0.25, 0, 1);
    kicker(ctx, W, H, scene.caption || scene.focus, th, kickA * 0.95);
    brand(ctx, W, H, 0.9);
    subtitles(ctx, W, H, scene.narration, st, th, H > W);
    progress(ctx, W, H, t / dur, th);

    // grade + grain + vignette
    const grade = ctx.createLinearGradient(0, 0, 0, H);
    grade.addColorStop(0, rgba(th.cool, 0.1));
    grade.addColorStop(0.5, "rgba(0,0,0,0)");
    grade.addColorStop(1, rgba(th.accent, 0.07));
    ctx.fillStyle = grade;
    ctx.fillRect(0, 0, W, H);
    grain(ctx, W, H, Math.floor(t * 30), 0.05);
    vignette(ctx, W, H, 1);

    // outro
    const outroLen = 1.8;
    if (t > dur - outroLen) {
      const p = easeOutCubic(clamp((t - (dur - outroLen)) / 0.4, 0, 1));
      ctx.save();
      ctx.fillStyle = `rgba(2,4,8,${0.6 * p})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = p;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = th.accent;
      ctx.font = `700 ${Math.max(12, W * 0.02)}px ${MONO}`;
      ctx.fillText(th.label.split("").join(" "), W / 2, H * 0.42);
      ctx.font = `800 ${W * (H > W ? 0.085 : 0.06)}px ${FONT}`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText("PART 2", W / 2, H * 0.49);
      ctx.font = `600 ${W * (H > W ? 0.036 : 0.028)}px ${FONT}`;
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText("FOLLOW FOR THE REST", W / 2, H * 0.55);
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------ score */

  function makeScore(seconds, type) {
    const rate = 44100;
    const dur = Math.max(2, Number(seconds) || 20);
    const total = Math.floor(dur * rate);
    const out = new Float32Array(total);
    const th = themeFor(type);
    const rand = rng(hash(th.label));
    const low = type === "truestory" ? 65.4 : type === "how" ? 73.4 : 55;
    for (let i = 0; i < total; i += 1) {
      const t = i / rate;
      const swell = 0.5 + 0.5 * Math.sin(t * 0.35);
      let v = Math.sin(2 * Math.PI * low * t) * 0.16 * (0.6 + swell * 0.4);
      v += Math.sin(2 * Math.PI * low * 1.5 * t + 0.4) * 0.07;
      v += Math.sin(2 * Math.PI * low * 2.02 * t) * 0.035 * (0.5 + 0.5 * Math.sin(t * 0.7));
      out[i] = v;
    }
    const add = (start, pat) => {
      const from = Math.max(0, Math.floor(start * rate));
      const to = Math.min(total, Math.floor((start + 0.6) * rate));
      for (let i = from; i < to; i += 1) {
        const t = i / rate - start;
        out[i] += pat(t);
      }
    };
    for (let at = 0.9; at < dur - 0.5; at += 1.05) {
      add(at, (t) => Math.sin(2 * Math.PI * (70 * Math.exp(-t * 20) + 38) * t) * 0.34 * Math.exp(-t * 16));
      add(at + 0.52, (t) => (rand() * 2 - 1) * 0.035 * Math.exp(-t * 90));
    }
    add(0.05, (t) => Math.sin(2 * Math.PI * 220 * t) * 0.1 * Math.exp(-t * 1.6));
    add(0.05, (t) => Math.sin(2 * Math.PI * 330.5 * t) * 0.06 * Math.exp(-t * 1.8));
    if (type === "truestory") {
      for (let i = 0; i < total; i += 1) {
        if (rand() < 0.0009) {
          for (let k = 0; k < 90 && i + k < total; k += 1) out[i + k] += (rand() * 2 - 1) * 0.05 * Math.exp(-k / 24);
        }
      }
    }
    for (let i = 0; i < total; i += 1) {
      const t = i / rate;
      const fade = Math.min(1, t / 0.3) * Math.min(1, (dur - t) / 0.5);
      out[i] = Math.tanh(out[i] * 1.25) * 0.8 * Math.max(0, fade);
    }
    const data = new Uint8Array(44 + total * 2);
    const view = new DataView(data.buffer);
    const writeStr = (at, str) => { for (let i = 0; i < str.length; i += 1) view.setUint8(at + i, str.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + total * 2, true);
    writeStr(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, total * 2, true);
    for (let i = 0; i < total; i += 1) {
      view.setInt16(44 + i * 2, clamp(out[i], -1, 1) * 32767, true);
    }
    return { wavBuf: data, seconds: dur };
  }

  /* ------------------------------------------------------------ render */

  function blobToBytes(blob) {
    return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
  }

  function bitsFor(seconds) {
    if (seconds <= 60) return 9_000_000;
    if (seconds <= 150) return 6_500_000;
    if (seconds <= 300) return 5_000_000;
    return 3_500_000;
  }

  async function renderStory(opt) {
    const { script, seconds, aspect, host, onProgress } = opt;
    const vertical = String(aspect || "vertical") !== "wide";
    const W = vertical ? 1080 : 1920;
    const H = vertical ? 1920 : 1080;
    const dur = clamp(Number(seconds) || 20, 8, 180);
    if (!window.MediaRecorder) throw new Error("This build cannot record video.");
    if (host) {
      host.textContent = "";
      host.classList.remove("hidden");
    }
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    canvas.className = "toon-canvas";
    if (host) host.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const draw = (at) => {
      try {
        drawFrame(ctx, { W, H, script, t: at, seconds: dur });
      } catch (err) {
        console.error("story frame", err);
      }
    };
    draw(0);
    const stream = canvas.captureStream(30);
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find((m) => MediaRecorder.isTypeSupported(m)) || "";
    if (!mime) throw new Error("No webm encoder on this build.");
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsFor(dur) });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });
    rec.start(250);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const loop = () => {
        const elapsed = (performance.now() - t0) / 1000;
        const at = Math.min(elapsed, dur);
        draw(at);
        if (onProgress) onProgress(Math.min(0.98, at / dur));
        if (elapsed >= dur) {
          draw(dur);
          resolve();
          return;
        }
        // rAF freezes in hidden windows; timers keep long renders moving
        if (document.hidden) setTimeout(loop, 33);
        else requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) throw new Error("The recorder wrote zero bytes.");
    return {
      videoBuf: await blobToBytes(blob),
      width: W,
      height: H,
      seconds: dur,
      aspect: vertical ? "9:16" : "16:9",
    };
  }

  window.CapriZdf = { drawFrame, renderStory, makeScore };
})();
