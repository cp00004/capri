/* CAPRI // toon studio
   A tiny animation house in the browser: a storyboard becomes rigged canvas
   characters in painted worlds, drawn frame by frame and recorded to video.
   No image APIs, no slideshows - every frame is animated here. */
(() => {
  "use strict";

  const FONT = '"Segoe UI Black","Arial Black","Arial Rounded MT Bold","Segoe UI",sans-serif';
  let STYLE = "cocomelon";
  const INK = "#26172e";

  /* ------------------------------------------------------------ helpers */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutBack = (t) => {
    const c = 1.9;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  };
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

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
    const v = /^#[0-9a-f]{6}$/i.test(String(hex)) ? String(hex) : "#ff8fab";
    return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
  }

  function mix(hex, target, amount) {
    const a = hexToRgb(hex);
    const b = hexToRgb(target);
    const c = a.map((v, i) => Math.round(lerp(v, b[i], amount)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function rrect(ctx, x, y, w, h, r) {
    const k = Math.min(r, w / 2, h / 2);
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

  function setFont(ctx, size) {
    ctx.font = `900 ${Math.round(size)}px ${FONT}`;
  }

  function shade(hex, amount) {
    return amount >= 0 ? mix(hex, "#ffffff", amount) : mix(hex, "#000000", -amount);
  }

  function star(ctx, x, y, r, points = 5) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i += 1) {
      const rad = i % 2 ? r * 0.45 : r;
      const a = (Math.PI * i) / points - Math.PI / 2;
      const px = x + Math.cos(a) * rad;
      const py = y + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function layout(W, H) {
    const vertical = H > W;
    if (vertical) {
      return {
        vertical, W, H,
        r: W * 0.215,
        heroX: W * 0.5,
        heroY: H * 0.585,
        propX: W * 0.80,
        propY: H * 0.55,
        captionY: H * 0.885,
        photoX: W * 0.18,
        photoY: H * 0.255,
        photoSize: W * 0.30,
      };
    }
    return {
      vertical, W, H,
      r: H * 0.225,
      heroX: W * 0.71,
      heroY: H * 0.585,
      propX: W * 0.48,
      propY: H * 0.52,
      captionY: H * 0.84,
      captionX: W * 0.29,
      photoX: W * 0.115,
      photoY: H * 0.245,
      photoSize: H * 0.34,
    };
  }

  /* ------------------------------------------------------------ worlds */

  function cloud(ctx, x, y, s, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, s * 0.42, 0, Math.PI * 2);
    ctx.arc(x + s * 0.42, y - s * 0.16, s * 0.34, 0, Math.PI * 2);
    ctx.arc(x + s * 0.82, y, s * 0.4, 0, Math.PI * 2);
    ctx.arc(x + s * 0.42, y + s * 0.2, s * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function sun(ctx, x, y, r, t) {
    ctx.save();
    const glow = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * 2.4);
    glow.addColorStop(0, "rgba(255,236,150,0.9)");
    glow.addColorStop(1, "rgba(255,236,150,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(x, y);
    ctx.rotate(t * 0.12);
    ctx.fillStyle = "rgba(255,224,102,0.85)";
    for (let i = 0; i < 10; i += 1) {
      ctx.rotate((Math.PI * 2) / 10);
      ctx.beginPath();
      ctx.moveTo(r * 1.15, -r * 0.14);
      ctx.lineTo(r * 1.72, 0);
      ctx.lineTo(r * 1.15, r * 0.14);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "#ffe066";
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff3bf";
    ctx.beginPath();
    ctx.arc(-r * 0.25, -r * 0.25, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function sky(ctx, W, H, top, bottom) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function hills(ctx, W, H, base, colors, t, amp = 1) {
    colors.forEach((color, i) => {
      const y = H * base + i * H * 0.075;
      const wave = Math.sin(t * 0.5 + i) * H * 0.008 * amp;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(0, y + wave);
      ctx.bezierCurveTo(W * 0.25, y - H * 0.09 + wave, W * 0.4, y + H * 0.07, W * 0.62, y - H * 0.02 + wave);
      ctx.bezierCurveTo(W * 0.8, y - H * 0.1 + wave, W * 0.9, y + H * 0.05, W, y - H * 0.02 + wave);
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    });
  }

  function flowers(ctx, W, H, t, pal) {
    const rand = rng(77);
    for (let i = 0; i < 12; i += 1) {
      const x = rand() * W;
      const y = H * (0.86 + rand() * 0.11);
      const sway = Math.sin(t * 2 + i) * 3;
      const color = pal[i % pal.length];
      ctx.strokeStyle = "#3f9e64";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + sway, y - H * 0.035);
      ctx.stroke();
      ctx.fillStyle = color;
      for (let p = 0; p < 5; p += 1) {
        const a = (p / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(x + sway + Math.cos(a) * 9, y - H * 0.035 + Math.sin(a) * 9, 8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#ffe066";
      ctx.beginPath();
      ctx.arc(x + sway, y - H * 0.035, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function stars(ctx, W, H, t, seed) {
    const rand = rng(seed + 9);
    for (let i = 0; i < 46; i += 1) {
      const x = rand() * W;
      const y = rand() * H * 0.7;
      const tw = 0.55 + 0.45 * Math.sin(t * 2 + i * 1.7);
      ctx.fillStyle = `rgba(255,255,255,${tw})`;
      const s = 2 + rand() * 4;
      star(ctx, x, y, s * 1.6);
      ctx.fill();
    }
  }

  function moon(ctx, x, y, r, t) {
    ctx.save();
    const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2.2);
    glow.addColorStop(0, "rgba(255,249,219,0.45)");
    glow.addColorStop(1, "rgba(255,249,219,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff9db";
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(214,201,154,0.55)";
    for (const c of [[-0.35, -0.2, 0.2], [0.25, 0.3, 0.14], [0.1, -0.45, 0.1]]) {
      ctx.beginPath();
      ctx.arc(x + c[0] * r, y + c[1] * r, c[2] * r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function planet(ctx, x, y, r, t) {
    ctx.save();
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.2, x, y, r);
    g.addColorStop(0, "#b197fc");
    g.addColorStop(1, "#6741d9");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,224,130,0.9)";
    ctx.lineWidth = r * 0.1;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.35);
    ctx.scale(1, 0.32);
    ctx.beginPath(); ctx.arc(0, 0, r * 1.55, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  function backdrop(ctx, opt) {
    const { W, H, bg, t, pal, seed } = opt;
    const p = pal;
    if (bg === "park") {
      sky(ctx, W, H, "#9ad9ff", "#e7f9ff");
      sun(ctx, W * 0.82, H * 0.16, H * 0.055, t);
      cloud(ctx, ((W * 0.1 + t * W * 0.012) % (W * 1.3)) - W * 0.1, H * 0.16, W * 0.12, 0.9);
      cloud(ctx, ((W * 0.55 + t * W * 0.008) % (W * 1.3)) - W * 0.1, H * 0.24, W * 0.09, 0.8);
      hills(ctx, W, H, 0.62, ["#8ce99a", "#69db7c", "#51cf66"], t);
      flowers(ctx, W, H, t, p);
    } else if (bg === "home") {
      sky(ctx, W, H, "#ffe8d6", "#ffd0b5");
      ctx.fillStyle = "#f8d3b0";
      ctx.fillRect(0, H * 0.72, W, H * 0.28);
      ctx.fillStyle = "#eeb98f";
      ctx.fillRect(0, H * 0.72, W, H * 0.02);
      // window
      ctx.fillStyle = "#bde0fe";
      rrect(ctx, W * 0.63, H * 0.12, W * 0.26, H * 0.22, 18);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 14;
      ctx.stroke();
      sun(ctx, W * 0.74, H * 0.17, H * 0.032, t);
      cloud(ctx, W * 0.665 + Math.sin(t * 0.4) * W * 0.01, H * 0.26, W * 0.07, 0.95);
      // frames
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(W * 0.755, H * 0.12, 10, H * 0.22);
      ctx.fillRect(W * 0.63, H * 0.22, W * 0.26, 10);
      // wall art
      ctx.fillStyle = rgba(p[1], 0.9);
      rrect(ctx, W * 0.14, H * 0.14, W * 0.16, H * 0.12, 14);
      ctx.fill();
      ctx.fillStyle = p[2];
      star(ctx, W * 0.22, H * 0.2, H * 0.028);
      ctx.fill();
      // rug
      ctx.fillStyle = rgba(p[0], 0.65);
      ctx.beginPath();
      ctx.ellipse(W * 0.5, H * 0.9, W * 0.42, H * 0.05, 0, 0, Math.PI * 2);
      ctx.fill();
      // plant
      ctx.fillStyle = "#e8590c";
      rrect(ctx, W * 0.06, H * 0.7, W * 0.09, H * 0.1, 12);
      ctx.fill();
      ctx.fillStyle = "#51cf66";
      for (let i = -1; i <= 1; i += 1) {
        ctx.beginPath();
        ctx.ellipse(W * 0.105 + i * W * 0.03 + Math.sin(t + i) * 4, H * 0.65 - Math.abs(i) * H * 0.03, W * 0.028, H * 0.05, i * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (bg === "beach") {
      sky(ctx, W, H, "#8ed7ff", "#ffe9c9");
      sun(ctx, W * 0.78, H * 0.17, H * 0.06, t);
      cloud(ctx, ((W * 0.2 + t * W * 0.01) % (W * 1.3)) - W * 0.1, H * 0.13, W * 0.1, 0.9);
      ctx.fillStyle = "#4dabf7";
      ctx.fillRect(0, H * 0.47, W, H * 0.23);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      for (let i = 0; i < 4; i += 1) {
        ctx.beginPath();
        for (let x = 0; x <= W; x += W / 12) {
          const y = H * (0.52 + i * 0.045) + Math.sin(x / W * 10 + t * 2 + i) * 8;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 6;
        ctx.stroke();
      }
      ctx.fillStyle = "#ffe8b3";
      ctx.beginPath();
      ctx.moveTo(0, H * 0.68);
      ctx.bezierCurveTo(W * 0.3, H * 0.64, W * 0.7, H * 0.72, W, H * 0.67);
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.fill();
      const rand = rng(seed + 3);
      for (let i = 0; i < 10; i += 1) {
        ctx.fillStyle = i % 2 ? "#ffd8a8" : "#fab1a0";
        ctx.beginPath();
        ctx.ellipse(rand() * W, H * (0.86 + rand() * 0.1), 10, 6, rand() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (bg === "night") {
      sky(ctx, W, H, "#141a3d", "#3b2f6b");
      stars(ctx, W, H, t, seed);
      moon(ctx, W * 0.8, H * 0.17, H * 0.055, t);
      hills(ctx, W, H, 0.64, ["#231f4d", "#2e2a5e", "#3a3570"], t, 0.6);
      const rand = rng(seed + 5);
      for (let i = 0; i < 14; i += 1) {
        const x = rand() * W;
        const y = H * (0.6 + rand() * 0.3);
        const a = 0.35 + 0.55 * Math.abs(Math.sin(t * 1.6 + i));
        ctx.fillStyle = `rgba(255,236,150,${a})`;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (bg === "space") {
      sky(ctx, W, H, "#0b1030", "#241a5e");
      stars(ctx, W, H, t, seed + 2);
      planet(ctx, W * 0.8, H * 0.2, H * 0.07, t);
      const rand = rng(seed + 7);
      for (let i = 0; i < 3; i += 1) {
        const x = (rand() * W + t * 40 * (i + 1)) % (W * 1.2) - W * 0.1;
        const y = H * (0.3 + rand() * 0.5);
        ctx.fillStyle = i % 2 ? "#ffd43b" : "#ff8fab";
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      hills(ctx, W, H, 0.72, ["#1c1745", "#251e57", "#2f2769"], t, 0.5);
    } else {
      // school
      sky(ctx, W, H, "#fff4e6", "#ffe8cc");
      ctx.fillStyle = "#e9d8a6";
      ctx.fillRect(0, H * 0.7, W, H * 0.3);
      ctx.fillStyle = "#2f6f4f";
      rrect(ctx, W * 0.09, H * 0.13, W * 0.62, H * 0.3, 16);
      ctx.fill();
      ctx.strokeStyle = "#b07d4f";
      ctx.lineWidth = 16;
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(W * 0.15, H * 0.22);
      ctx.quadraticCurveTo(W * 0.3, H * 0.18, W * 0.45, H * 0.24);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(W * 0.15, H * 0.3);
      ctx.quadraticCurveTo(W * 0.33, H * 0.34, W * 0.52, H * 0.28);
      ctx.stroke();
      ctx.fillStyle = "#ced4da";
      rrect(ctx, W * 0.78, H * 0.5, W * 0.16, H * 0.06, 10);
      ctx.fill();
      ctx.fillStyle = "#ff8787";
      rrect(ctx, W * 0.06, H * 0.82, W * 0.1, H * 0.07, 8);
      ctx.fill();
      ctx.fillStyle = "#74c0fc";
      rrect(ctx, W * 0.17, H * 0.8, W * 0.08, H * 0.07, 8);
      ctx.fill();
    }
  }

  /* ------------------------------------------------------------ hero */

  function ears(ctx, kind, r, fur, t, mood) {
    const outline = rgba(INK, 0.8);
    ctx.lineWidth = r * 0.045;
    ctx.strokeStyle = outline;
    if (kind === "bunny") {
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.translate(s * r * 0.34, -r * 0.78);
        ctx.rotate(s * (0.18 + Math.sin(t * 3) * 0.03));
        ctx.fillStyle = fur;
        ctx.beginPath();
        ctx.ellipse(0, -r * 0.34, r * 0.2, r * 0.62, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#ffc9d6";
        ctx.beginPath();
        ctx.ellipse(0, -r * 0.34, r * 0.1, r * 0.44, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    } else if (kind === "cat") {
      for (const s of [-1, 1]) {
        ctx.fillStyle = fur;
        ctx.beginPath();
        ctx.moveTo(s * r * 0.3, -r * 0.72);
        ctx.lineTo(s * r * 0.72, -r * 1.18);
        ctx.lineTo(s * r * 0.82, -r * 0.58);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#ffc9d6";
        ctx.beginPath();
        ctx.moveTo(s * r * 0.44, -r * 0.78);
        ctx.lineTo(s * r * 0.66, -r * 1.04);
        ctx.lineTo(s * r * 0.7, -r * 0.68);
        ctx.closePath();
        ctx.fill();
      }
    } else if (kind === "bear") {
      for (const s of [-1, 1]) {
        ctx.fillStyle = fur;
        ctx.beginPath();
        ctx.arc(s * r * 0.68, -r * 0.62, r * 0.26, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#ffc9d6";
        ctx.beginPath();
        ctx.arc(s * r * 0.68, -r * 0.62, r * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === "dog") {
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.translate(s * r * 0.82, -r * 0.35);
        ctx.rotate(s * (0.35 + Math.sin(t * 4 + s) * 0.08));
        ctx.fillStyle = shade(fur, -0.18);
        ctx.beginPath();
        ctx.ellipse(0, r * 0.22, r * 0.22, r * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    } else {
      // kid: hair cap + tuft
      ctx.fillStyle = shade(fur, -0.35);
      ctx.beginPath();
      ctx.arc(0, -r * 0.18, r * 1.02, Math.PI * 0.98, Math.PI * 2.02);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(r * 0.05, -r * 1.02, r * 0.16, r * 0.3, 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function face(ctx, r, kind, mood, t, blink, look) {
    const eyeY = -r * 0.06;
    const eyeX = r * 0.38;
    const open = mood === "surprised" ? 1.18 : mood === "excited" ? 1.05 : 1;
    const eyeH = r * 0.27 * open * (1 - 0.92 * blink);

    // brows
    ctx.strokeStyle = INK;
    ctx.lineWidth = r * 0.05;
    ctx.lineCap = "round";
    for (const s of [-1, 1]) {
      ctx.beginPath();
      const by = -r * 0.42 + (mood === "sad" ? r * 0.04 : 0);
      ctx.moveTo(s * eyeX - r * 0.14, by + (mood === "sad" ? -r * 0.03 : r * 0.02));
      ctx.quadraticCurveTo(s * eyeX, by - r * 0.05, s * eyeX + r * 0.14, by);
      ctx.stroke();
    }

    for (const s of [-1, 1]) {
      // whites
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(s * eyeX, eyeY, r * 0.21, Math.max(2, eyeH), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.75);
      ctx.lineWidth = r * 0.035;
      ctx.stroke();
      if (eyeH > r * 0.07) {
        // glossy pupil
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(s * eyeX + (look?.x || 0) * r * 0.06, eyeY + (look?.y || 0) * r * 0.05, r * 0.105, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.beginPath();
        ctx.arc(s * eyeX + (look?.x || 0) * r * 0.06 - r * 0.035, eyeY - r * 0.04 + (look?.y || 0) * r * 0.05, r * 0.035, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // cheeks
    ctx.fillStyle = "rgba(255,120,160,0.42)";
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * r * 0.56, r * 0.24, r * 0.12, r * 0.075, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // muzzle + mouth
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.ellipse(0, r * 0.34, r * 0.3, r * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = r * 0.045;
    ctx.lineCap = "round";
    if (mood === "sad") {
      ctx.beginPath();
      ctx.arc(0, r * 0.44, r * 0.14, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    } else if (mood === "surprised") {
      ctx.fillStyle = "#8c1c3a";
      ctx.beginPath();
      ctx.ellipse(0, r * 0.36, r * 0.09, r * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (mood === "excited" || mood === "happy") {
      ctx.fillStyle = "#8c1c3a";
      ctx.beginPath();
      ctx.arc(0, r * 0.3, r * 0.17, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#ff8fab";
      ctx.beginPath();
      ctx.ellipse(0, r * 0.42, r * 0.07, r * 0.035, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.beginPath();
      ctx.arc(0, r * 0.3, r * 0.17, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(-r * 0.08, r * 0.36);
      ctx.quadraticCurveTo(0, r * 0.42, r * 0.08, r * 0.36);
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(INK, 0.5);
    ctx.lineWidth = r * 0.02;
    ctx.beginPath();
    ctx.moveTo(0, r * 0.24);
    ctx.lineTo(0, r * 0.3);
    ctx.stroke();
  }

  function hero(ctx, st, story) {
    const { x, y, r, rot = 0, armL = 0.5, armR = 0.5, legSwing = 0, eyeOpen = 1, mood = "happy", blink = 0, look } = st;
    const pal = story.palette;
    const kind = story.hero.kind;
    const fur = story.hero.color;
    const skin = kind === "kid" ? "#ffd8b5" : fur;
    const outline = rgba(INK, 0.82);
    const OW = STYLE === "flat" ? 1.6 : 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);

    // legs
    ctx.strokeStyle = outline;
    ctx.lineWidth = r * 0.2;
    ctx.lineCap = "round";
    for (const s of [-1, 1]) {
      const swing = legSwing * s;
      const footX = s * r * 0.24 + Math.sin(swing) * r * 0.2;
      const footY = r * 1.86 + Math.abs(Math.cos(swing)) * r * 0.05;
      ctx.beginPath();
      ctx.moveTo(s * r * 0.24, r * 1.42);
      ctx.lineTo(footX, footY);
      ctx.stroke();
      ctx.strokeStyle = skin;
      ctx.lineWidth = r * 0.14;
      ctx.beginPath();
      ctx.moveTo(s * r * 0.24, r * 1.42);
      ctx.lineTo(footX, footY);
      ctx.stroke();
      ctx.strokeStyle = outline;
      ctx.lineWidth = r * 0.2;
    }

    // arms (drawn after the head so waves read)
    const arm = (side, angle) => {
      ctx.strokeStyle = outline;
      ctx.lineWidth = r * 0.19;
      ctx.lineCap = "round";
      const sx = side * r * 0.58;
      const sy = r * 1.0;
      const hx = sx + Math.cos(angle) * side * r * 0.8;
      const hy = sy + Math.sin(angle) * r * 0.8;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.strokeStyle = side < 0 ? shade(pal[2], -0.15) : shade(pal[2], -0.05);
      ctx.lineWidth = r * 0.13;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(hx, hy, r * 0.12, 0, Math.PI * 2);
      ctx.fill();
    };

    // body
    ctx.fillStyle = pal[2];
    rrect(ctx, -r * 0.54, r * 0.55, r * 1.08, r * 1.0, r * 0.42);
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = r * 0.045 * OW;
    ctx.stroke();
    // overalls
    ctx.fillStyle = shade(pal[3], -0.05);
    rrect(ctx, -r * 0.46, r * 1.02, r * 0.92, r * 0.48, r * 0.2);
    ctx.fill();
    ctx.stroke();
    // straps
    ctx.strokeStyle = shade(pal[3], -0.05);
    ctx.lineWidth = r * 0.09;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * r * 0.3, r * 0.6);
      ctx.lineTo(s * r * 0.36, r * 1.02);
      ctx.stroke();
    }
    // buttons
    ctx.fillStyle = "#ffd43b";
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * r * 0.33, r * 1.01, r * 0.045, 0, Math.PI * 2);
      ctx.fill();
    }

    // ears / hair
    ears(ctx, kind, r, fur, st.t || 0, mood);
    // head
    ctx.fillStyle = kind === "kid" ? skin : fur;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = r * 0.05 * OW;
    ctx.stroke();
    // light forehead patch
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.ellipse(-r * 0.28, -r * 0.42, r * 0.4, r * 0.24, -0.4, 0, Math.PI * 2);
    ctx.fill();

    if (kind === "cat") {
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = r * 0.018;
      for (const s of [-1, 1]) {
        for (let i = 0; i < 3; i += 1) {
          ctx.beginPath();
          ctx.moveTo(s * r * 0.5, r * 0.22 + i * r * 0.05);
          ctx.lineTo(s * r * 0.86, r * 0.14 + i * r * 0.075);
          ctx.stroke();
        }
      }
    }
    if (kind === "dog" || kind === "bear") {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.ellipse(0, r * 0.3, r * 0.34, r * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.19, r * 0.09, r * 0.065, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    face(ctx, r, kind, mood, st.t || 0, blink, look);
    arm(-1, armL);
    arm(1, armR);

    // bow / cap accessory
    if (kind !== "kid" && story.seed % 2 === 0) {
      ctx.save();
      ctx.translate(-r * 0.62, -r * 0.55);
      ctx.rotate(-0.35);
      ctx.fillStyle = "#ff5d8f";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-r * 0.22, -r * 0.14);
      ctx.lineTo(-r * 0.22, r * 0.12);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(r * 0.2, -r * 0.12);
      ctx.lineTo(r * 0.2, r * 0.14);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.06, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd43b";
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ props */

  function prop(ctx, kind, x, y, s, t, pal) {
    if (!kind || kind === "none") return;
    ctx.save();
    ctx.translate(x, y);
    if (kind === "ball") {
      const bounce = Math.abs(Math.sin(t * 3.2)) * s * 0.7;
      ctx.translate(0, -bounce);
      ctx.rotate(t * 2);
      const g = ctx.createRadialGradient(-s * 0.2, -s * 0.25, s * 0.1, 0, 0, s);
      g.addColorStop(0, "#ff8787");
      g.addColorStop(1, "#e03131");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(0, 0, s, -Math.PI / 2, -Math.PI / 2 + Math.PI); ctx.arc(0, 0, s, Math.PI / 2, Math.PI); ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.35);
      ctx.lineWidth = s * 0.06;
      ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.stroke();
    } else if (kind === "icecream") {
      const bob = Math.sin(t * 2.2) * s * 0.1;
      ctx.translate(0, bob);
      ctx.fillStyle = "#e8b06a";
      ctx.beginPath();
      ctx.moveTo(-s * 0.45, 0);
      ctx.lineTo(s * 0.45, 0);
      ctx.lineTo(0, s * 1.15);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.5);
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
      for (let i = 0; i < 3; i += 1) {
        ctx.fillStyle = pal[i % pal.length];
        ctx.beginPath();
        ctx.arc((i - 1) * s * 0.32, -s * 0.28 - (i === 1 ? s * 0.3 : 0), s * 0.34, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = "#e03131";
      ctx.beginPath(); ctx.arc(0, -s * 0.95, s * 0.12, 0, Math.PI * 2); ctx.fill();
    } else if (kind === "star") {
      const pulse = 1 + Math.sin(t * 4) * 0.08;
      ctx.rotate(Math.sin(t) * 0.2);
      ctx.scale(pulse, pulse);
      const g = ctx.createRadialGradient(0, 0, s * 0.2, 0, 0, s * 1.5);
      g.addColorStop(0, "rgba(255,236,150,0.8)");
      g.addColorStop(1, "rgba(255,236,150,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, s * 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffd43b";
      star(ctx, 0, 0, s);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.4);
      ctx.lineWidth = s * 0.06;
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.beginPath(); ctx.arc(-s * 0.12, 0, s * 0.06, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.12, 0, s * 0.06, 0, Math.PI * 2); ctx.fill();
    } else if (kind === "kite") {
      const sway = Math.sin(t * 1.8) * s * 0.25;
      ctx.rotate(sway * 0.02);
      ctx.translate(sway * 0.1, -s * 0.2 + Math.sin(t * 2.4) * s * 0.12);
      ctx.fillStyle = pal[0];
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.7, 0);
      ctx.lineTo(0, s * 1.1);
      ctx.lineTo(-s * 0.7, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.5);
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
      ctx.fillStyle = pal[1];
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.32, 0);
      ctx.lineTo(0, s * 0.5);
      ctx.lineTo(-s * 0.32, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = s * 0.04;
      ctx.beginPath();
      ctx.moveTo(0, s * 1.1);
      ctx.quadraticCurveTo(s * 0.4, s * 1.8, Math.sin(t * 3) * s * 0.3, s * 2.4);
      ctx.stroke();
    } else if (kind === "balloon") {
      const bob = Math.sin(t * 1.6) * s * 0.14;
      ctx.translate(0, bob - s * 0.5);
      const g = ctx.createRadialGradient(-s * 0.25, -s * 0.35, s * 0.15, 0, 0, s);
      g.addColorStop(0, shade(pal[0], 0.4));
      g.addColorStop(1, pal[0]);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 0.75, s * 0.95, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.4);
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
      ctx.fillStyle = shade(pal[0], -0.3);
      ctx.beginPath();
      ctx.moveTo(-s * 0.1, s * 0.9);
      ctx.lineTo(s * 0.1, s * 0.9);
      ctx.lineTo(0, s * 1.02);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = s * 0.035;
      ctx.beginPath();
      ctx.moveTo(0, s * 1.02);
      ctx.bezierCurveTo(s * 0.3, s * 1.6, -s * 0.3, s * 2.1, s * 0.08, s * 2.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------ caption */

  function wrapLines(ctx, words, maxW) {
    const lines = [];
    let line = [];
    for (const word of words) {
      const attempt = [...line, word].join(" ");
      if (line.length && ctx.measureText(attempt).width > maxW) {
        lines.push(line);
        line = [word];
      } else {
        line.push(word);
      }
    }
    if (line.length) lines.push(line);
    return lines;
  }

  function caption(ctx, text, opt) {
    const { W, H, y, age, pal, capWidth } = opt;
    const capX = opt.cx || W / 2;
    const words = String(text || "").toUpperCase().split(/\s+/).filter(Boolean).slice(0, 10);
    if (!words.length) return;
    let size = W * 0.072;
    const maxW = capWidth || W * 0.86;
    setFont(ctx, size);
    while (ctx.measureText(words.join(" ")).width > maxW * 1.35 && size > W * 0.045) {
      size -= 3;
      setFont(ctx, size);
    }
    const lines = wrapLines(ctx, words, maxW);
    const lineH = size * 1.18;
    const shades = ["#ffffff", "#ffe066", "#a8f0d0", "#d0e6ff"];
    let index = 0;
    const total = words.length;
    lines.forEach((line, li) => {
      const lineWidth = ctx.measureText(line.join(" ")).width;
      let cx = capX - lineWidth / 2;
      const cy = y - (lines.length - 1 - li) * lineH;
      for (const word of line) {
        const w = ctx.measureText(word).width;
        const start = 0.08 + index * 0.09;
        const p = clamp((age - start) / 0.34, 0, 1);
        const pop = p <= 0 ? 0 : easeOutBack(p);
        const wob = Math.sin(age * 4 + index * 1.7) * 0.02;
        const sc = 0.5 + 0.5 * pop;
        ctx.save();
        ctx.translate(cx + w / 2, cy);
        ctx.rotate(wob);
        ctx.scale(sc, sc);
        ctx.globalAlpha = clamp(p * 2, 0, 1);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(24,12,32,0.92)";
        ctx.lineWidth = size * (STYLE === "flat" ? 0.24 : 0.19);
        ctx.strokeText(word, 0, 0);
        ctx.fillStyle = shades[index % shades.length];
        ctx.fillText(word, 0, 0);
        ctx.restore();
        cx += w + ctx.measureText(" ").width;
        index += 1;
      }
    });
    // progress underline
    const p = clamp(age / 2.6, 0, 1);
    if (p < 1) {
      const barW = W * 0.5;
      const bx = clamp(capX, barW / 2 + 8, W - barW / 2 - 8) - barW / 2;
      const by = y + size * 0.9;
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      rrect(ctx, bx, by, barW, size * 0.12, size * 0.06);
      ctx.fill();
      ctx.fillStyle = rgba(pal[1], 0.85);
      rrect(ctx, bx, by, barW * p, size * 0.12, size * 0.06);
      ctx.fill();
    }
  }

  /* ------------------------------------------------------------ scene */

  function pose(scene, sceneTime, sceneDur, t, seed, L) {
    const rand = rng(seed + hash(scene.caption) % 999);
    const beat = Math.sin(t * 5 + rand() * 2);
    const bounce = Math.abs(beat) * L.r * 0.08;
    let x = L.heroX + Math.sin(t * 0.9 + rand()) * L.W * 0.012;
    let lift = bounce;
    let rot = Math.sin(t * 2.2 + rand()) * 0.02;
    let armL = 0.6 + Math.sin(t * 2 + rand()) * 0.15;
    let armR = 0.6 + Math.sin(t * 2 + 1 + rand()) * 0.15;
    let legSwing = 0;
    let look = { x: 0, y: 0 };
    const action = scene.action || "wave";
    if (action === "walk") {
      const eased = easeOutCubic(clamp(sceneTime / Math.max(0.1, sceneDur - 0.5), 0, 1));
      x = L.heroX + (eased - 0.5) * L.W * 0.16 + Math.sin(t * 3) * L.W * 0.01;
      legSwing = t * 7;
      armL = 0.5 + Math.sin(t * 7) * 0.4;
      armR = 0.5 - Math.sin(t * 7) * 0.4;
      look = { x: 1, y: 0 };
    } else if (action === "jump") {
      const cyc = (sceneTime % 1.15) / 1.15;
      lift = -Math.sin(cyc * Math.PI) * L.r * 0.75;
      legSwing = cyc > 0.4 ? 0.5 : 0;
      armL = -1.0;
      armR = -1.0;
    } else if (action === "wave") {
      armR = -0.65 + Math.sin(t * 9) * 0.35;
      rot = Math.sin(t * 2) * 0.03;
    } else if (action === "dance") {
      rot = Math.sin(t * 7) * 0.09;
      x = L.heroX + Math.sin(t * 3.5) * L.W * 0.05;
      armL = -0.7 + Math.sin(t * 7) * 0.55;
      armR = -0.7 - Math.sin(t * 7) * 0.55;
      lift = Math.abs(Math.sin(t * 7)) * L.r * 0.12;
      legSwing = t * 8;
    } else if (action === "point") {
      look = { x: 1, y: -0.6 };
      const dx = L.propX - L.heroX;
      const dy = L.propY - (L.heroY + L.r * 1.0);
      armR = Math.atan2(dy, dx);
      rot = -0.02;
    } else if (action === "cheer") {
      armL = -1.05 + Math.sin(t * 8) * 0.2;
      armR = -1.05 - Math.sin(t * 8) * 0.2;
      lift = Math.abs(beat) * L.r * 0.14;
    }
    // blink every ~2.8s
    const phase = (t + (seed % 31) * 0.11) % 2.8;
    const blink = phase < 0.12 ? Math.sin((phase / 0.12) * Math.PI) : 0;
    return {
      x, y: L.heroY - lift, r: L.r, rot, armL, armR, legSwing,
      blink, look, mood: scene.mood || "happy", t,
    };
  }

  function confetti(ctx, W, H, t, pal, amount = 26) {
    const rand = rng(31);
    for (let i = 0; i < amount; i += 1) {
      const speed = 80 + rand() * 140;
      const drift = Math.sin(t * 2 + i) * 30;
      const x = ((rand() * W + drift) % W + W) % W;
      const y = (rand() * H + t * speed) % (H * 1.05);
      const r = 5 + rand() * 7;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(t * 3 + i);
      ctx.fillStyle = pal[i % pal.length];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(-r, -r * 0.6, r * 2, r * 1.2);
      ctx.restore();
    }
  }

  function photoCard(ctx, img, x, y, size, t, accent) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(t * 1.2) * 0.05 - 0.04);
    ctx.shadowColor = "rgba(0,0,0,0.28)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = "#ffffff";
    rrect(ctx, -size / 2, -size * 0.42, size, size * 0.84, 18);
    ctx.fill();
    ctx.shadowColor = "transparent";
    const iw = size * 0.9;
    const ih = size * 0.68;
    ctx.save();
    rrect(ctx, -iw / 2, -ih / 2 - size * 0.03, iw, ih, 12);
    ctx.clip();
    try {
      ctx.drawImage(img, -iw / 2, -ih / 2 - size * 0.03, iw, ih);
    } catch { /* image not ready */ }
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 4;
    rrect(ctx, -iw / 2, -ih / 2 - size * 0.03, iw, ih, 12);
    ctx.stroke();
    // tape
    ctx.fillStyle = rgba(accent, 0.85);
    ctx.save();
    ctx.rotate(-0.2);
    ctx.fillRect(-size * 0.13, -size * 0.5, size * 0.26, size * 0.09);
    ctx.restore();
    ctx.restore();
  }

  function hud(ctx, W, H, story, sceneIndex, prog, vertical) {
    const scale = W / 1080;
    const pad = 34 * scale;
    // logo chip
    const chipW = 300 * scale;
    const chipH = 74 * scale;
    ctx.fillStyle = "rgba(20,12,30,0.55)";
    rrect(ctx, pad, pad, chipW, chipH, chipH / 2);
    ctx.fill();
    ctx.fillStyle = story.palette[1];
    star(ctx, pad + chipH / 2, pad + chipH / 2, 20 * scale);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    setFont(ctx, 30 * scale);
    ctx.fillText("CAPRI TOONS", pad + chipH + 8 * scale, pad + chipH / 2 + 1);

    // scene dots
    const n = story.scenes.length;
    const dot = 12 * scale;
    const gap = 18 * scale;
    const totalW = n * dot + (n - 1) * gap;
    const dx = W - pad - totalW;
    for (let i = 0; i < n; i += 1) {
      ctx.fillStyle = i === sceneIndex ? story.palette[1] : "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.arc(dx + i * (dot + gap) + dot / 2, pad + chipH / 2, i === sceneIndex ? dot * 0.7 : dot * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
    // progress bar
    const barY = pad + chipH + 14 * scale;
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    rrect(ctx, pad, barY, W - pad * 2, 6 * scale, 3 * scale);
    ctx.fill();
    const p = clamp(Number(prog) || 0, 0, 1);
    if (p > 0) {
      ctx.fillStyle = rgba(story.palette[1], 0.9);
      rrect(ctx, pad, barY, (W - pad * 2) * p, 6 * scale, 3 * scale);
      ctx.fill();
    }
  }

  function drawFrame(ctx, opt) {
    const { W, H, story, t, seconds, img } = opt;
    const scenes = story.scenes && story.scenes.length ? story.scenes : [{ caption: "Hello!", action: "wave", bg: "park", prop: "balloon", mood: "happy" }];
    const sceneDur = seconds / scenes.length;
    const idx = clamp(Math.floor(t / sceneDur), 0, scenes.length - 1);
    const sceneTime = t - idx * sceneDur;
    const scene = scenes[idx];
    STYLE = story.style || "cocomelon";
    const L = layout(W, H);
    if (STYLE === "chibi") L.r *= 1.1;
    const pal = story.palette;
    const seed = story.seed || 7;

    backdrop(ctx, { W, H, bg: scene.bg, t, pal, seed: seed + idx });
    // ground shadow under hero
    const poseNow = pose(scene, sceneTime, sceneDur, t, seed + idx, L);
    const shadowY = Math.min(L.heroY + L.r * 1.95, H * 0.97);
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    ctx.beginPath();
    ctx.ellipse(L.heroX, shadowY, L.r * (1.1 - (L.heroY - poseNow.y) / (L.r * 6)), L.r * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    // prop first when it should sit behind
    prop(ctx, scene.prop, L.propX, L.propY, L.r * 0.55, t, pal);
    if (scene.action === "cheer" || scene.mood === "excited") confetti(ctx, W, H, t, pal, 30);
    if (img) photoCard(ctx, img, L.photoX, L.photoY, L.photoSize, t, pal[1]);
    if (STYLE === "sticker") {
      ctx.save();
      ctx.shadowColor = "rgba(255,255,255,0.95)";
      ctx.shadowBlur = 26;
      hero(ctx, poseNow, story);
      ctx.restore();
    }
    hero(ctx, poseNow, story);
    if (scene.action === "cheer") confetti(ctx, W, H, t + 0.6, pal, 18);

    // captions in the safe area
    caption(ctx, scene.caption, { W, H, y: L.captionY, age: sceneTime + 0.15, pal, capWidth: W * (L.vertical ? 0.86 : 0.52), cx: L.captionX });

    // global intro title
    if (t < 1.9) {
      const p = clamp(t / 0.5, 0, 1);
      const out = clamp((1.9 - t) / 0.25, 0, 1);
      const sc = 0.6 + 0.4 * easeOutBack(p);
      ctx.save();
      ctx.translate(W / 2, H * (L.vertical ? 0.17 : 0.19));
      ctx.scale(sc, sc);
      ctx.globalAlpha = Math.min(p * 2, 1) * out;
      const title = String(story.title || "Toon Time").toUpperCase().slice(0, 22);
      setFont(ctx, W * (L.vertical ? 0.085 : 0.062));
      const maxW = W * 0.86;
      let size = W * (L.vertical ? 0.085 : 0.062);
      while (ctx.measureText(title).width > maxW && size > W * 0.04) {
        size -= 3;
        setFont(ctx, size);
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(24,12,32,0.92)";
      ctx.lineWidth = size * 0.2;
      ctx.strokeText(title, 0, 0);
      ctx.fillStyle = "#ffe066";
      ctx.fillText(title, 0, 0);
      ctx.restore();
    }

    // outro card
    const outro = 1.9;
    const outP = t > seconds - outro ? easeOutCubic(clamp((t - (seconds - outro)) / 0.35, 0, 1)) : 0;
    return finishFrame(ctx, { W, H, story, t, seconds, sceneDur, idx, pal, L, p: outP });
  }

  function finishFrame(ctx, opt) {
    const { W, H, story, t, idx, pal, L, p, seconds } = opt;
    // scene-cut flash + ring
    const sceneDur = opt.sceneDur;
    if (idx > 0 && t - idx * sceneDur < 0.42) {
      const q = (t - idx * sceneDur) / 0.42;
      ctx.save();
      ctx.globalAlpha = (1 - q) * 0.32;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    if (p > 0) {
      // outro panel
      ctx.save();
      ctx.fillStyle = "rgba(16,8,26,0.42)";
      ctx.fillRect(0, 0, W, H);
      const bob = Math.sin((Date.now() / 1000) * 5) * 8;
      ctx.globalAlpha = p;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      setFont(ctx, W * 0.075);
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(24,12,32,0.9)";
      ctx.lineWidth = W * 0.075 * 0.2;
      ctx.strokeText("FOLLOW FOR", W / 2, H * 0.44 - 70 + bob);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("FOLLOW FOR", W / 2, H * 0.44 - 70 + bob);
      setFont(ctx, W * 0.115);
      ctx.strokeText("PART 2!", W / 2, H * 0.44 + 40 + bob);
      ctx.fillStyle = "#ffe066";
      ctx.fillText("PART 2!", W / 2, H * 0.44 + 40 + bob);
      setFont(ctx, W * 0.045);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText("new toon every day", W / 2, H * 0.44 + 130 + bob);
      ctx.restore();
    }
    // brand + dots
    hud(ctx, W, H, story, idx, t / Math.max(1, seconds), L.vertical);
    // vignette
    if (STYLE !== "flat") {
      const v = ctx.createRadialGradient(W / 2, H * 0.5, H * 0.3, W / 2, H * 0.5, H * 0.75);
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(1, "rgba(20,8,30,0.18)");
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ------------------------------------------------------------ thumbs */

  function drawThumb(canvas, story, img, vertical) {
    STYLE = story.style || "cocomelon";
    const W = canvas.width;
    const H = canvas.height;
    const ctx = canvas.getContext("2d");
    const pal = story.palette;
    const rand = rng((story.seed || 3) + (vertical ? 5 : 11));
    // background
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, shade(pal[3], 0.55));
    g.addColorStop(1, shade(pal[0], 0.35));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // rays
    ctx.save();
    ctx.translate(W / 2, H / 2);
    for (let i = 0; i < 18; i += 1) {
      ctx.rotate((Math.PI * 2) / 18);
      ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.03)";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.max(W, H) * 1.2, -W * 0.12);
      ctx.lineTo(Math.max(W, H) * 1.2, W * 0.12);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // sparkles
    for (let i = 0; i < 26; i += 1) {
      const x = rand() * W;
      const y = rand() * H;
      ctx.fillStyle = i % 3 ? "rgba(255,255,255,0.55)" : pal[1];
      star(ctx, x, y, 4 + rand() * 9);
      ctx.fill();
    }

    // hero
    const L = vertical
      ? { r: W * 0.24, heroX: W * 0.5, heroY: H * 0.69, vertical: true, W, H }
      : { r: H * 0.225, heroX: W * 0.72, heroY: H * 0.607, vertical: false, W, H };
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.beginPath();
    ctx.ellipse(L.heroX, L.heroY + L.r * 1.75, L.r * 1.1, L.r * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    hero(ctx, {
      x: L.heroX, y: L.heroY - L.r * 0.25, r: L.r, rot: 0.04,
      armL: -2.2, armR: -2.4, legSwing: 0.4, blink: 0, look: { x: 0, y: -1 },
      mood: "surprised", t: 1.2,
    }, story);

    if (img) {
      const size = vertical ? W * 0.26 : H * 0.25;
      photoCard(ctx, img, vertical ? W * 0.08 : W * 0.035, vertical ? H * 0.33 : H * 0.06, size, 0.7, pal[1]);
    }

    // big words
    const text = String(story.thumbText || "WATCH THIS").toUpperCase().replace(/[!?]+$/, "");
    const words = text.split(/\s+/).filter(Boolean).slice(0, 4);
    const maxW = vertical ? W * 0.9 : W * 0.5;
    let size = vertical ? W * 0.17 : H * 0.16;
    setFont(ctx, size);
    while (ctx.measureText(words.join(" ")).width > maxW && size > 40) {
      size -= 4;
      setFont(ctx, size);
    }
    const lines = wrapLines(ctx, words, maxW);
    const lineH = size * 1.05;
    const cx = vertical ? W / 2 : W * 0.29;
    const startY = vertical ? H * 0.16 : H * 0.5 - (lines.length - 1) * lineH * 0.5;
    lines.forEach((line, li) => {
      const lineText = line.join(" ");
      const w = ctx.measureText(lineText).width;
      ctx.save();
      ctx.translate(cx + Math.sin(li * 2.1) * 10, startY + li * lineH);
      ctx.rotate((li % 2 ? 0.03 : -0.03));
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 10;
      ctx.strokeStyle = "#1b1024";
      ctx.lineWidth = size * 0.24;
      ctx.strokeText(lineText, 0, 0);
      ctx.shadowColor = "transparent";
      ctx.fillStyle = li % 2 ? "#ffffff" : "#ffe066";
      ctx.fillText(lineText, 0, 0);
      // accent swoosh underline on last line
      if (li === lines.length - 1) {
        ctx.strokeStyle = pal[1];
        ctx.lineWidth = size * 0.09;
        ctx.beginPath();
        ctx.moveTo(-w / 2 + 10, size * 0.62);
        ctx.quadraticCurveTo(0, size * 0.78, w / 2 - 10, size * 0.58);
        ctx.stroke();
      }
      ctx.restore();
    });

    // red arrow
    ctx.save();
    ctx.strokeStyle = "#ff2d55";
    ctx.fillStyle = "#ff2d55";
    ctx.lineWidth = (vertical ? W : H) * 0.018;
    ctx.lineCap = "round";
    const ax = vertical ? W * 0.82 : W * 0.53;
    const ay = vertical ? H * 0.44 : H * 0.55;
    const bx = vertical ? L.heroX + L.r * 0.55 : L.heroX - L.r * 0.95;
    const by = vertical ? L.heroY - L.r * 1.1 : L.heroY - L.r * 0.62;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(ax - (ax - bx) * 0.25, ay + (by - ay) * 0.55, bx, by);
    ctx.stroke();
    const ang = Math.atan2(by - ay, bx - ax);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - Math.cos(ang - 0.5) * W * 0.055, by - Math.sin(ang - 0.5) * W * 0.055);
    ctx.lineTo(bx - Math.cos(ang + 0.5) * W * 0.055, by - Math.sin(ang + 0.5) * W * 0.055);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // "?!" kicker
    ctx.save();
    ctx.translate(vertical ? W * 0.83 : W * 0.93, vertical ? H * 0.1 : H * 0.12);
    ctx.rotate(0.25);
    setFont(ctx, (vertical ? W : H) * 0.14);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1b1024";
    ctx.lineWidth = (vertical ? W : H) * 0.03;
    ctx.strokeText("?!", 0, 0);
    ctx.fillStyle = "#ffe066";
    ctx.fillText("?!", 0, 0);
    ctx.restore();

    // brand chip
    const chipH = (vertical ? W : H) * 0.06;
    ctx.fillStyle = "rgba(20,12,30,0.65)";
    rrect(ctx, 24, H - chipH - 24, (vertical ? W : H) * 0.34, chipH, chipH / 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    setFont(ctx, chipH * 0.42);
    ctx.fillText("CAPRI TOONS", 24 + chipH * 0.45, H - 24 - chipH / 2 + 2);
    return canvas;
  }

  /* ------------------------------------------------------------ music */

  function toB64(bytes) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function makeMusic(seconds) {
    const rate = 44100;
    const total = Math.max(1, Math.floor(seconds * rate));
    const out = new Float32Array(total);
    const beat = 0.5;
    const semis = (n) => 261.63 * Math.pow(2, n / 12);
    const chords = [0, 7, 9, 5];
    const melody = [12, 16, 19, 21, 19, 16, 14, 12];
    const rand = rng(42);

    const add = (start, dur, freq, amp, decay, type) => {
      const from = Math.max(0, Math.floor(start * rate));
      const to = Math.min(total, Math.floor((start + dur) * rate));
      for (let i = from; i < to; i += 1) {
        const t = (i / rate) - start;
        const env = Math.exp(-t * decay);
        const ph = 2 * Math.PI * freq * t;
        let v = Math.sin(ph);
        if (type === "pluck") v = Math.sin(ph) + 0.35 * Math.sin(ph * 2);
        if (type === "soft") v = Math.sin(ph) * 0.8 + 0.2 * Math.sin(ph * 3);
        out[i] += v * amp * env;
      }
    };

    for (let bar = 0; bar * 2 < seconds; bar += 1) {
      const root = chords[bar % chords.length];
      for (let b = 0; b < 4; b += 1) {
        const at = bar * 2 + b * beat;
        if (at > seconds) break;
        // kick
        const kf = 120 * Math.exp(-8 * 0) ;
        const kFrom = Math.max(0, Math.floor(at * rate));
        const kTo = Math.min(total, Math.floor((at + 0.14) * rate));
        for (let i = kFrom; i < kTo; i += 1) {
          const t = i / rate - at;
          const f = kf * Math.exp(-t * 18) + 45;
          out[i] += Math.sin(2 * Math.PI * f * t) * 0.42 * Math.exp(-t * 22);
        }
        // bass
        add(at, 0.42, semis(root - 24), 0.16, 5, "soft");
        // pluck melody on 8ths
        add(at, 0.32, semis(melody[(bar * 4 + b) % melody.length]), 0.12, 7, "pluck");
        add(at + beat / 2, 0.28, semis(melody[(bar * 4 + b + 3) % melody.length] + 12), 0.08, 8, "pluck");
        // hat
        const hFrom = Math.max(0, Math.floor((at + beat / 2) * rate));
        const hTo = Math.min(total, Math.floor((at + beat / 2 + 0.05) * rate));
        for (let i = hFrom; i < hTo; i += 1) {
          const t = i / rate - (at + beat / 2);
          out[i] += (rand() * 2 - 1) * 0.05 * Math.exp(-t * 70);
        }
        // chord pad
        for (const note of [root, root + 4, root + 7]) add(at, 1.9, semis(note - 12), 0.05, 1.4, "soft");
      }
    }

    // gentle master: fade + soft clip
    for (let i = 0; i < total; i += 1) {
      const t = i / rate;
      const fade = Math.min(1, t / 0.15) * Math.min(1, (seconds - t) / 0.25);
      out[i] = Math.tanh(out[i] * 1.5) * 0.75 * Math.max(0, fade);
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
    return { wavB64: toB64(data), seconds };
  }

  /* ------------------------------------------------------------ render */

  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").replace(/^data:[^,]*,/, ""));
      reader.onerror = () => reject(new Error("Could not read the recording."));
      reader.readAsDataURL(blob);
    });
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function renderShort(opt) {
    const { story, seconds, aspect, host, imageDataUrl, onProgress } = opt;
    const vertical = String(aspect || "vertical") !== "wide";
    const W = vertical ? 1080 : 1920;
    const H = vertical ? 1920 : 1080;
    const dur = clamp(Number(seconds) || 15, 6, 30);
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
    const img = imageDataUrl ? await loadImage(imageDataUrl) : null;
    const draw = (at) => {
      try {
        drawFrame(ctx, { W, H, story, t: at, seconds: dur, img });
      } catch (err) {
        console.error("toon frame", err);
      }
    };
    draw(0);
    const stream = canvas.captureStream(30);
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find((m) => MediaRecorder.isTypeSupported(m)) || "";
    if (!mime) throw new Error("No webm encoder on this build.");
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
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
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) throw new Error("The recorder wrote zero bytes.");
    return {
      videoB64: await blobToB64(blob),
      width: W,
      height: H,
      seconds: dur,
      aspect: vertical ? "9:16" : "16:9",
    };
  }

  function renderThumbs(opt) {
    const { story, imageDataUrl } = opt;
    return loadImage(imageDataUrl || "").then((img) => {
      const specs = [
        { W: 1280, H: 720, suffix: "youtube-wide", vertical: false },
        { W: 1080, H: 1920, suffix: "shorts-cover", vertical: true },
      ];
      const pngs = [];
      for (const spec of specs) {
        const canvas = document.createElement("canvas");
        canvas.width = spec.W;
        canvas.height = spec.H;
        drawThumb(canvas, story, img, spec.vertical);
        pngs.push({
          b64: canvas.toDataURL("image/png"),
          width: spec.W,
          height: spec.H,
          suffix: spec.suffix,
        });
      }
      return { pngs };
    });
  }

  window.CapriToon = { renderShort, renderThumbs, makeMusic, drawFrame };
})();
