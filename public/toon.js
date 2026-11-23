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

  const BG_IDS = new Set([
    "park", "home", "beach", "night", "space", "school", "city", "forest", "mountain",
    "desert", "snow", "castle", "dojo", "arena", "cave", "ocean", "jungle",
    "library", "cafe", "lab", "stadium", "temple", "factory", "subway", "rooftop",
    "garden", "volcano", "ship", "mall",
  ]);
  const BG_WORDS = [
    ["library", /(librar|book|shelf|archive|study|scroll)/],
    ["cafe", /(cafe|coffee|bakery|restaurant|diner|food|market|shop)/],
    ["lab", /(lab|science|experiment|robot|inventor|computer|techno|gadget)/],
    ["stadium", /(stadium|field|sport|soccer|football|race|track|gym|court)/],
    ["temple", /(temple|shrine|palace|throne|pyramid|egypt|ruin|ancient)/],
    ["factory", /(factory|workshop|machine|gear|industrial|forge|mine)/],
    ["subway", /(subway|train|metro|station|platform)/],
    ["rooftop", /(roof|skyline|balcony|apartment|penthouse)/],
    ["garden", /(garden|meadow|flower|picnic|farm|barn|orchard)/],
    ["volcano", /(volcano|lava|erupt|magma)/],
    ["ship", /(ship|boat|deck|sail|harbor|dock|pirate ship)/],
    ["mall", /(mall|arcade|store|boutique)/],
    ["beach", /(beach|sea|ocean|sand|island|harbor)/],
    ["space", /(space|moon|planet|rocket|alien|galaxy|orbit)/],
    ["night", /(night|bed|dream|sleep|dark|shadow)/],
    ["school", /(school|class|teacher|student|locker)/],
    ["home", /(home|house|room|kitchen|family|living)/],
    ["city", /(city|street|town|building|traffic|downtown)/],
    ["forest", /(forest|tree|woods|jungle|monkey|bamboo)/],
    ["mountain", /(mountain|cliff|snow|ice|peak|glacier)/],
    ["desert", /(desert|cactus|dune|sahara)/],
    ["castle", /(castle|kingdom|king|queen|knight|dragon)/],
    ["arena", /(fight|arena|ring|battle|boxing|dojo|training)/],
    ["cave", /(cave|underground|tunnel|cavern)/],
  ];

  function backdropKey(raw) {
    const text = String(raw || "").toLowerCase().replace(/[^a-z0-9 '-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return "park";
    if (BG_IDS.has(text)) return text;
    for (const [id, re] of BG_WORDS) if (re.test(text)) return id;
    const pool = ["park", "city", "library", "cafe", "forest", "rooftop", "garden", "arena"];
    return pool[hash(text) % pool.length];
  }

  function backdrop(ctx, opt) {
    const { W, H, t, pal, seed } = opt;
    const bg = backdropKey(opt.bg);
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
    } else if (bg === "school") {
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
    } else if (bg === "city") {
      sky(ctx, W, H, "#ffc9a8", "#ffe3d1");
      sun(ctx, W * 0.5, H * 0.44, H * 0.09, t);
      const rand = rng(seed + 21);
      for (let layer = 0; layer < 3; layer += 1) {
        let x = -W * 0.05;
        while (x < W) {
          const bw = W * (0.08 + rand() * 0.09);
          const bh = H * (0.14 + rand() * 0.24) * (1 - layer * 0.18);
          ctx.fillStyle = ["#b78b8f", "#8f6a78", "#5f4557"][layer];
          ctx.fillRect(x, H * 0.72 - bh, bw, bh + H * 0.2);
          if (layer === 2) {
            ctx.fillStyle = "rgba(255,236,170,0.75)";
            for (let wy = H * 0.72 - bh + 20; wy < H * 0.7; wy += 26) {
              for (let wx = x + 10; wx < x + bw - 12; wx += 20) {
                if (rand() < 0.45) ctx.fillRect(wx, wy, 8, 12);
              }
            }
          }
          x += bw + W * 0.012;
        }
      }
      ctx.fillStyle = "#4a3b45";
      ctx.fillRect(0, H * 0.86, W, H * 0.14);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 6;
      for (let i = 0; i < 4; i += 1) ctx.strokeRect(W * (0.1 + i * 0.25), H * 0.9, W * 0.08, H * 0.02);
    } else if (bg === "forest") {
      sky(ctx, W, H, "#a8e6a1", "#e5ffd9");
      const rand = rng(seed + 23);
      for (let layer = 0; layer < 3; layer += 1) {
        for (let i = 0; i < 5; i += 1) {
          const x = W * (0.05 + i * 0.22) + rand() * W * 0.06;
          const h = H * (0.2 + rand() * 0.16) * (1 - layer * 0.15);
          ctx.fillStyle = ["#3f8f4f", "#2f6f3f", "#1d4d2e"][layer];
          ctx.fillRect(x, H * 0.78 - h, W * 0.035, h);
          for (let k = 0; k < 3; k += 1) {
            ctx.beginPath();
            ctx.ellipse(x + W * 0.017 + Math.sin(k + i) * W * 0.02, H * 0.78 - h + k * H * 0.045, W * 0.1, H * 0.05, k * 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.fillStyle = "#67b96f";
      ctx.fillRect(0, H * 0.86, W, H * 0.14);
      flowers(ctx, W, H, t, pal);
    } else if (bg === "mountain") {
      sky(ctx, W, H, "#a5d8ff", "#ffe8f6");
      sun(ctx, W * 0.76, H * 0.16, H * 0.05, t);
      ctx.fillStyle = "#8a9bb8";
      ctx.beginPath();
      ctx.moveTo(-W * 0.1, H * 0.72); ctx.lineTo(W * 0.3, H * 0.24); ctx.lineTo(W * 0.58, H * 0.72); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#6c7d9c";
      ctx.beginPath();
      ctx.moveTo(W * 0.22, H * 0.72); ctx.lineTo(W * 0.62, H * 0.18); ctx.lineTo(W * 1.05, H * 0.72); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(W * 0.52, H * 0.33); ctx.lineTo(W * 0.62, H * 0.18); ctx.lineTo(W * 0.72, H * 0.33);
      ctx.lineTo(W * 0.66, H * 0.3); ctx.lineTo(W * 0.6, H * 0.36); ctx.lineTo(W * 0.56, H * 0.3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#7fb069";
      ctx.fillRect(0, H * 0.72, W, H * 0.28);
    } else if (bg === "desert") {
      sky(ctx, W, H, "#ffd08a", "#ffe9c9");
      sun(ctx, W * 0.7, H * 0.22, H * 0.08, t);
      const rand = rng(seed + 27);
      for (let i = 0; i < 3; i += 1) {
        ctx.fillStyle = ["#f4c27a", "#e8b06a", "#d99a55"][i];
        ctx.beginPath();
        ctx.moveTo(0, H * (0.62 + i * 0.08));
        ctx.bezierCurveTo(W * (0.2 + rand() * 0.2), H * (0.56 + i * 0.08), W * (0.6 + rand() * 0.2), H * (0.68 + i * 0.07), W, H * (0.6 + i * 0.09));
        ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = "#4f9c56";
      ctx.fillRect(W * 0.12, H * 0.72, W * 0.03, H * 0.12);
      ctx.fillRect(W * 0.085, H * 0.74, W * 0.02, H * 0.05);
      ctx.fillRect(W * 0.165, H * 0.75, W * 0.02, H * 0.045);
    } else if (bg === "snow") {
      sky(ctx, W, H, "#cfe8ff", "#f4fbff");
      hills(ctx, W, H, 0.6, ["#e9f4ff", "#d7e9ff", "#c3dcfb"], t, 0.8);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, H * 0.82, W, H * 0.18);
      const rand = rng(seed + 29);
      for (let i = 0; i < 40; i += 1) {
        const y = (rand() * H + t * 30 + i * 7) % H;
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.beginPath(); ctx.arc(rand() * W, y, 3 + rand() * 3, 0, Math.PI * 2); ctx.fill();
      }
    } else if (bg === "castle") {
      sky(ctx, W, H, "#7b6cb8", "#e2b8f0");
      moon(ctx, W * 0.2, H * 0.16, H * 0.05, t);
      ctx.fillStyle = "#6b5a8a";
      ctx.fillRect(W * 0.3, H * 0.5, W * 0.4, H * 0.36);
      for (const x of [0.24, 0.36, 0.64, 0.76]) {
        ctx.fillStyle = "#5a4a78";
        ctx.fillRect(W * x, H * 0.42, W * 0.06, H * 0.44);
        ctx.beginPath();
        ctx.moveTo(W * x - W * 0.02, H * 0.42);
        ctx.lineTo(W * x + W * 0.03, H * 0.32);
        ctx.lineTo(W * x + W * 0.08, H * 0.42);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = "#3d3252";
      ctx.beginPath();
      ctx.moveTo(W * 0.45, H * 0.86); ctx.lineTo(W * 0.45, H * 0.66);
      ctx.arc(W * 0.5, H * 0.66, W * 0.05, Math.PI, 0); ctx.lineTo(W * 0.55, H * 0.86); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#556b3f";
      ctx.fillRect(0, H * 0.86, W, H * 0.14);
    } else if (bg === "dojo") {
      sky(ctx, W, H, "#f6e2c4", "#e8c9a0");
      ctx.fillStyle = "#c99b6a";
      ctx.fillRect(0, H * 0.7, W, H * 0.3);
      ctx.strokeStyle = "#a87a4d";
      ctx.lineWidth = 6;
      for (let i = 0; i < 9; i += 1) { ctx.beginPath(); ctx.moveTo(0, H * (0.72 + i * 0.03)); ctx.lineTo(W, H * (0.72 + i * 0.03)); ctx.stroke(); }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(W * 0.34, H * 0.14, W * 0.32, H * 0.3);
      ctx.strokeStyle = "#3d2a1a";
      ctx.lineWidth = 10;
      ctx.strokeRect(W * 0.34, H * 0.14, W * 0.32, H * 0.3);
      setFont(ctx, W * 0.07);
      ctx.fillStyle = "#2a1a10";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("道", W * 0.5, H * 0.29);
      ctx.fillStyle = "#b5835a";
      ctx.fillRect(W * 0.1, H * 0.62, W * 0.8, H * 0.04);
    } else if (bg === "arena") {
      sky(ctx, W, H, "#1a1230", "#3a2450");
      const spot = ctx.createRadialGradient(W * 0.5, H * 0.2, 0, W * 0.5, H * 0.2, W * 0.7);
      spot.addColorStop(0, "rgba(255,230,180,0.35)");
      spot.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = spot; ctx.fillRect(0, 0, W, H);
      const rand = rng(seed + 33);
      // crowd silhouette: a dark mound with heads poking over the top
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.beginPath();
      ctx.ellipse(W * 0.5, H * 0.68, W * 0.74, H * 0.1, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 26; i += 1) {
        const hx = rand() * W;
        const hy = H * (0.55 + rand() * 0.06) + Math.sin(hx * 0.02) * H * 0.01;
        ctx.beginPath();
        ctx.arc(hx, hy, W * 0.017, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(hx - W * 0.028, hy, W * 0.056, H * 0.03);
      }
      ctx.fillStyle = "#c9a36a";
      ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.83, W * 0.42, H * 0.12, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#8a6a3d"; ctx.lineWidth = 8; ctx.stroke();
    } else if (bg === "cave") {
      sky(ctx, W, H, "#241a14", "#0d0906");
      const rand = rng(seed + 37);
      for (let i = 0; i < 9; i += 1) {
        const x = rand() * W;
        ctx.fillStyle = "#3a2a1e";
        ctx.beginPath(); ctx.moveTo(x - W * 0.04, 0); ctx.lineTo(x + W * 0.05, 0); ctx.lineTo(x + W * 0.01, H * (0.2 + rand() * 0.18)); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = "#2c1f16";
      ctx.fillRect(0, H * 0.82, W, H * 0.18);
      for (const x of [0.15, 0.85]) {
        const glow = ctx.createRadialGradient(W * x, H * 0.5, 0, W * x, H * 0.5, W * 0.16);
        glow.addColorStop(0, "rgba(255,180,80,0.5)"); glow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(W * x, H * 0.5, W * 0.16, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#ffb347"; ctx.beginPath(); ctx.ellipse(W * x, H * 0.5, W * 0.02, H * 0.035, 0, 0, Math.PI * 2); ctx.fill();
      }
    } else if (bg === "ocean") {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#1d7fa8");
      g.addColorStop(0.6, "#0c5677");
      g.addColorStop(1, "#052f45");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const rays = ctx.createLinearGradient(0, 0, 0, H * 0.6);
      rays.addColorStop(0, "rgba(255,255,255,0.28)"); rays.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = rays;
      for (let i = 0; i < 4; i += 1) {
        ctx.beginPath();
        ctx.moveTo(W * (0.2 + i * 0.2), 0);
        ctx.lineTo(W * (0.28 + i * 0.2), 0);
        ctx.lineTo(W * (0.36 + i * 0.2), H * 0.65);
        ctx.lineTo(W * (0.18 + i * 0.2), H * 0.65);
        ctx.closePath(); ctx.fill();
      }
      const rand = rng(seed + 41);
      for (let i = 0; i < 16; i += 1) {
        const x = rand() * W;
        const y = H - ((t * (20 + rand() * 30) + rand() * H) % H);
        ctx.strokeStyle = "rgba(220,250,255,0.5)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 4 + rand() * 7, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = "#0a3a2a";
      for (let i = 0; i < 8; i += 1) {
        const x = (i * W) / 8 + 30;
        ctx.beginPath();
        ctx.moveTo(x, H);
        for (let k = 0; k < 5; k += 1) ctx.quadraticCurveTo(x + Math.sin(t * 1.5 + k + i) * 26, H - k * H * 0.07, x, H - (k + 1) * H * 0.07);
        ctx.lineTo(x + 26, H); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = "#c9b083"; ctx.fillRect(0, H * 0.9, W, H * 0.1);
    } else if (bg === "library") {
      sky(ctx, W, H, "#6b4a34", "#3d2a1e");
      const rand = rng(seed + 51);
      for (let row = 0; row < 4; row += 1) {
        const y = H * (0.16 + row * 0.17);
        ctx.fillStyle = "#4a3121";
        ctx.fillRect(W * 0.05, y, W * 0.9, H * 0.02);
        for (let i = 0; i < 22; i += 1) {
          const bw = W * (0.012 + rand() * 0.012);
          const bh = H * (0.09 + rand() * 0.05);
          ctx.fillStyle = ["#b23a48", "#2a9d8f", "#e9c46a", "#457b9d", "#8d5a97"][i % 5];
          ctx.fillRect(W * 0.05 + i * ((W * 0.9) / 22), y - bh, bw, bh);
        }
      }
      ctx.fillStyle = "#5a3a26";
      ctx.fillRect(0, H * 0.84, W, H * 0.16);
      const glow = ctx.createRadialGradient(W * 0.5, H * 0.1, 0, W * 0.5, H * 0.1, W * 0.35);
      glow.addColorStop(0, "rgba(255,220,150,0.5)");
      glow.addColorStop(1, "rgba(255,220,150,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H * 0.5);
      ctx.fillStyle = "#e8c87a";
      ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.06, W * 0.07, H * 0.02, 0, 0, Math.PI * 2); ctx.fill();
    } else if (bg === "cafe") {
      sky(ctx, W, H, "#ffe6c7", "#f7cfa3");
      ctx.fillStyle = "#d9a066";
      ctx.fillRect(0, H * 0.74, W, H * 0.26);
      ctx.fillStyle = "#c98a4b";
      for (let i = 0; i < 7; i += 1) ctx.fillRect(W * (0.04 + i * 0.14), H * 0.74, W * 0.02, H * 0.26);
      ctx.fillStyle = "#bfe6ff";
      rrect(ctx, W * 0.08, H * 0.12, W * 0.34, H * 0.3, 16);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 12;
      ctx.stroke();
      cloud(ctx, W * 0.16 + Math.sin(t * 0.5) * W * 0.01, H * 0.22, W * 0.08, 0.95);
      ctx.fillStyle = "#a86a3a";
      rrect(ctx, W * 0.56, H * 0.5, W * 0.38, H * 0.2, 10);
      ctx.fill();
      for (let i = 0; i < 3; i += 1) {
        ctx.fillStyle = ["#ffffff", pal[0], "#f5e0c3"][i];
        rrect(ctx, W * (0.6 + i * 0.1), H * 0.46, W * 0.05, H * 0.05, 8);
        ctx.fill();
        ctx.strokeStyle = "rgba(90,60,40,0.5)";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      for (const x of [0.28, 0.72]) {
        ctx.strokeStyle = "#6b4a34";
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(W * x, 0); ctx.lineTo(W * x, H * 0.12); ctx.stroke();
        ctx.fillStyle = "#ffd66b";
        ctx.beginPath(); ctx.arc(W * x, H * 0.14, W * 0.03, 0, Math.PI * 2); ctx.fill();
      }
    } else if (bg === "lab") {
      sky(ctx, W, H, "#12303d", "#071a24");
      ctx.strokeStyle = "rgba(90,230,220,0.18)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 8; i += 1) {
        ctx.beginPath(); ctx.moveTo(0, H * (0.7 + i * 0.045)); ctx.lineTo(W, H * (0.7 + i * 0.045)); ctx.stroke();
      }
      for (let i = 0; i < 7; i += 1) {
        ctx.beginPath(); ctx.moveTo(W * (0.1 + i * 0.14), H * 0.7); ctx.lineTo(W * (0.02 + i * 0.16), H); ctx.stroke();
      }
      for (const [x, y, w, h] of [[0.08, 0.14, 0.2, 0.16], [0.31, 0.1, 0.16, 0.12], [0.72, 0.14, 0.22, 0.16]]) {
        ctx.fillStyle = "#0e2a33";
        rrect(ctx, W * x, H * y, W * w, H * h, 8);
        ctx.fill();
        ctx.strokeStyle = "#49d6c8";
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = "rgba(90,240,220,0.5)";
        for (let i = 0; i < 4; i += 1) ctx.fillRect(W * (x + 0.02), H * (y + 0.03 + i * 0.025), W * (w * 0.5 + (i % 2) * 0.08), H * 0.012);
      }
      for (let i = 0; i < 3; i += 1) {
        const x = W * (0.5 + i * 0.08);
        ctx.fillStyle = "rgba(200,250,255,0.25)";
        rrect(ctx, x, H * 0.56, W * 0.05, H * 0.1, 6);
        ctx.fill();
        ctx.fillStyle = pal[i % pal.length];
        ctx.fillRect(x + 3, H * (0.6 + i * 0.012), W * 0.05 - 6, H * 0.05);
      }
    } else if (bg === "stadium") {
      sky(ctx, W, H, "#7ec8ff", "#dff3ff");
      sun(ctx, W * 0.82, H * 0.14, H * 0.045, t);
      ctx.fillStyle = "#8892a6";
      ctx.beginPath();
      ctx.moveTo(0, H * 0.62); ctx.lineTo(W, H * 0.62); ctx.lineTo(W, H * 0.36);
      ctx.quadraticCurveTo(W * 0.5, H * 0.24, 0, H * 0.36);
      ctx.closePath();
      ctx.fill();
      const rand = rng(seed + 61);
      ctx.globalAlpha = 0.8;
      for (let i = 0; i < 70; i += 1) {
        ctx.fillStyle = pal[i % pal.length];
        ctx.fillRect(rand() * W, H * (0.38 + rand() * 0.2), W * 0.012, H * 0.012);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#4fb45f";
      ctx.fillRect(0, H * 0.62, W, H * 0.38);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.84, W * 0.2, H * 0.06, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, H * 0.74); ctx.lineTo(W, H * 0.74); ctx.stroke();
    } else if (bg === "temple") {
      sky(ctx, W, H, "#ff9e6d", "#ffd9a8");
      ctx.fillStyle = "#c9b18c";
      ctx.fillRect(0, H * 0.7, W, H * 0.3);
      for (const x of [0.12, 0.3, 0.7, 0.88]) {
        ctx.fillStyle = "#e6d2ab";
        ctx.fillRect(W * x, H * 0.3, W * 0.07, H * 0.42);
        ctx.fillStyle = "#b99c6f";
        ctx.fillRect(W * (x - 0.01), H * 0.29, W * 0.09, H * 0.03);
      }
      ctx.fillStyle = "#d8c29a";
      ctx.fillRect(W * 0.08, H * 0.26, W * 0.84, H * 0.05);
      for (const x of [0.2, 0.8]) {
        const f = 1 + Math.sin(t * 6 + x) * 0.15;
        const glow = ctx.createRadialGradient(W * x, H * 0.56, 0, W * x, H * 0.56, W * 0.1);
        glow.addColorStop(0, "rgba(255,150,60,0.55)");
        glow.addColorStop(1, "rgba(255,150,60,0)");
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(W * x, H * 0.56, W * 0.1, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#ffa94d";
        ctx.beginPath(); ctx.ellipse(W * x, H * 0.54, W * 0.018 * f, H * 0.03 * f, 0, 0, Math.PI * 2); ctx.fill();
      }
    } else if (bg === "factory") {
      sky(ctx, W, H, "#3b3f52", "#191c28");
      ctx.fillStyle = "#2a2e3d";
      ctx.fillRect(0, H * 0.78, W, H * 0.22);
      ctx.strokeStyle = "#4d5568";
      ctx.lineWidth = 14;
      ctx.beginPath(); ctx.moveTo(0, H * 0.2); ctx.lineTo(W * 0.6, H * 0.2); ctx.lineTo(W * 0.6, H * 0.55); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W, H * 0.3); ctx.lineTo(W * 0.75, H * 0.3); ctx.stroke();
      for (const [x, y, r] of [[0.82, 0.62, 0.11], [0.6, 0.46, 0.07]]) {
        ctx.save();
        ctx.translate(W * x, H * y);
        ctx.rotate(t * (x > 0.7 ? 0.8 : -1.2));
        ctx.fillStyle = "#5c6478";
        for (let i = 0; i < 8; i += 1) {
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(W * r * 0.7, -W * r * 0.13, W * r * 0.3, W * r * 0.26);
        }
        ctx.beginPath(); ctx.arc(0, 0, W * r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#2a2e3d";
        ctx.beginPath(); ctx.arc(0, 0, W * r * 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = "#c9a227";
      for (let i = 0; i < 12; i += 1) ctx.fillRect(W * (i * 0.09), H * 0.78, W * 0.045, H * 0.02);
    } else if (bg === "subway") {
      sky(ctx, W, H, "#a9b3bd", "#7d8994");
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 9; i += 1) {
        ctx.beginPath(); ctx.moveTo(0, H * (0.1 + i * 0.08)); ctx.lineTo(W, H * (0.1 + i * 0.08)); ctx.stroke();
      }
      for (let i = 0; i < 9; i += 1) {
        ctx.beginPath(); ctx.moveTo(W * (i * 0.12), 0); ctx.lineTo(W * (i * 0.12), H * 0.74); ctx.stroke();
      }
      ctx.fillStyle = "#cfd8e0";
      rrect(ctx, W * 0.05, H * 0.2, W * 0.9, H * 0.38, 18);
      ctx.fill();
      ctx.fillStyle = "#3d6b8f";
      ctx.fillRect(W * 0.05, H * 0.34, W * 0.9, H * 0.06);
      for (let i = 0; i < 5; i += 1) {
        ctx.fillStyle = t % 2 > 1 ? "#ffe9a8" : "#fff6d6";
        rrect(ctx, W * (0.1 + i * 0.17), H * 0.24, W * 0.12, H * 0.08, 6);
        ctx.fill();
      }
      ctx.fillStyle = "#5a6570";
      ctx.fillRect(0, H * 0.74, W, H * 0.26);
      ctx.fillStyle = "#e8c547";
      ctx.fillRect(0, H * 0.74, W, H * 0.025);
    } else if (bg === "rooftop") {
      sky(ctx, W, H, "#1c2a52", "#6a4a7a");
      moon(ctx, W * 0.78, H * 0.15, H * 0.05, t);
      const rand = rng(seed + 67);
      for (let i = 0; i < 14; i += 1) {
        const bw = W * (0.05 + rand() * 0.06);
        const bh = H * (0.18 + rand() * 0.26);
        const x = rand() * W;
        ctx.fillStyle = i % 2 ? "#222b45" : "#2b3555";
        ctx.fillRect(x, H * 0.74 - bh, bw, bh + H * 0.06);
        ctx.fillStyle = "rgba(255,220,140,0.7)";
        for (let wy = H * 0.74 - bh + 8; wy < H * 0.7; wy += 16) {
          for (let wx = x + 6; wx < x + bw - 8; wx += 12) if (rand() < 0.4) ctx.fillRect(wx, wy, 5, 7);
        }
      }
      ctx.fillStyle = "#3a3f55";
      ctx.fillRect(0, H * 0.8, W, H * 0.2);
      ctx.strokeStyle = "#9aa3b5";
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(0, H * 0.72); ctx.lineTo(W, H * 0.72); ctx.stroke();
      for (let i = 0; i < 9; i += 1) {
        ctx.beginPath(); ctx.moveTo(W * (0.02 + i * 0.12), H * 0.72); ctx.lineTo(W * (0.02 + i * 0.12), H * 0.8); ctx.stroke();
      }
    } else if (bg === "garden") {
      sky(ctx, W, H, "#aee1ff", "#f3ffe6");
      sun(ctx, W * 0.8, H * 0.15, H * 0.05, t);
      hills(ctx, W, H, 0.66, ["#9be59b", "#7fdb8f", "#63cf7d"], t, 0.7);
      flowers(ctx, W, H, t, pal);
      ctx.fillStyle = "#e9d8a6";
      ctx.beginPath();
      ctx.moveTo(W * 0.42, H * 0.8); ctx.quadraticCurveTo(W * 0.5, H * 0.9, W * 0.58, H);
      ctx.lineTo(W * 0.7, H); ctx.quadraticCurveTo(W * 0.56, H * 0.88, W * 0.5, H * 0.8);
      ctx.closePath();
      ctx.fill();
      for (let i = 0; i < 4; i += 1) {
        const bx = W * (0.2 + i * 0.2) + Math.sin(t * 1.5 + i) * W * 0.03;
        const by = H * (0.35 + (i % 2) * 0.12) + Math.cos(t * 2 + i) * H * 0.02;
        ctx.fillStyle = pal[i % pal.length];
        ctx.beginPath(); ctx.ellipse(bx - 6, by, 7, 4, -0.4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(bx + 6, by, 7, 4, 0.4, 0, Math.PI * 2); ctx.fill();
      }
    } else if (bg === "volcano") {
      sky(ctx, W, H, "#2a0f0f", "#7d1f14");
      const glow = ctx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.6, W * 0.7);
      glow.addColorStop(0, "rgba(255,120,40,0.35)");
      glow.addColorStop(1, "rgba(255,120,40,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#3a1a16";
      ctx.beginPath();
      ctx.moveTo(-W * 0.1, H * 0.78); ctx.lineTo(W * 0.45, H * 0.24); ctx.lineTo(W * 0.58, H * 0.3); ctx.lineTo(W * 1.1, H * 0.78);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#ff7b29";
      ctx.beginPath();
      ctx.moveTo(W * 0.465, H * 0.27);
      ctx.lineTo(W * 0.5, H * 0.27);
      ctx.quadraticCurveTo(W * 0.55, H * 0.6, W * 0.62, H * 0.88);
      ctx.lineTo(W * 0.55, H * 0.89);
      ctx.quadraticCurveTo(W * 0.5, H * 0.62, W * 0.475, H * 0.3);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,220,120,0.85)";
      ctx.beginPath();
      ctx.moveTo(W * 0.478, H * 0.28);
      ctx.lineTo(W * 0.492, H * 0.28);
      ctx.quadraticCurveTo(W * 0.52, H * 0.6, W * 0.585, H * 0.87);
      ctx.lineTo(W * 0.56, H * 0.87);
      ctx.quadraticCurveTo(W * 0.5, H * 0.62, W * 0.482, H * 0.3);
      ctx.closePath(); ctx.fill();
      const rand = rng(seed + 71);
      for (let i = 0; i < 14; i += 1) {
        const y = H - ((t * (30 + rand() * 40) + rand() * H) % H);
        ctx.fillStyle = `rgba(255,190,120,${0.4 + rand() * 0.5})`;
        ctx.beginPath(); ctx.arc(rand() * W, y, 2 + rand() * 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#2b1410";
      ctx.fillRect(0, H * 0.88, W, H * 0.12);
    } else if (bg === "ship") {
      sky(ctx, W, H, "#8ed7ff", "#ffe9c9");
      sun(ctx, W * 0.78, H * 0.16, H * 0.05, t);
      ctx.fillStyle = "#3d8ec9";
      ctx.fillRect(0, H * 0.56, W, H * 0.44);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      for (let i = 0; i < 5; i += 1) {
        ctx.beginPath();
        ctx.ellipse(W * (0.1 + i * 0.2) + Math.sin(t * 2 + i) * 8, H * (0.62 + (i % 2) * 0.03), W * 0.09, 6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#b98a5a";
      ctx.beginPath();
      ctx.moveTo(W * 0.04, H * 0.78); ctx.lineTo(W * 0.96, H * 0.78); ctx.lineTo(W * 0.88, H * 0.94); ctx.lineTo(W * 0.12, H * 0.94);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "#8a6238";
      ctx.lineWidth = 4;
      for (let i = 0; i < 5; i += 1) {
        ctx.beginPath(); ctx.moveTo(W * 0.1, H * (0.8 + i * 0.03)); ctx.lineTo(W * 0.9, H * (0.8 + i * 0.03)); ctx.stroke();
      }
      ctx.fillStyle = "#6b4a34";
      ctx.fillRect(W * 0.76, H * 0.18, W * 0.018, H * 0.6);
      ctx.fillStyle = "#fff6e6";
      ctx.beginPath();
      ctx.moveTo(W * 0.77, H * 0.2); ctx.quadraticCurveTo(W * 0.95, H * 0.34, W * 0.78, H * 0.5);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(90,60,40,0.4)";
      ctx.lineWidth = 3;
      ctx.stroke();
    } else if (bg === "mall") {
      sky(ctx, W, H, "#dfe9f5", "#bccbdd");
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.beginPath();
      ctx.moveTo(W * 0.3, 0); ctx.lineTo(W * 0.7, 0); ctx.lineTo(W * 0.62, H * 0.18); ctx.lineTo(W * 0.38, H * 0.18);
      ctx.closePath(); ctx.fill();
      const rand = rng(seed + 73);
      for (let i = 0; i < 4; i += 1) {
        const x = W * (0.02 + i * 0.25);
        ctx.fillStyle = i % 2 ? "#8fa8c8" : "#a58fc8";
        rrect(ctx, x, H * 0.28, W * 0.21, H * 0.42, 10);
        ctx.fill();
        ctx.fillStyle = "rgba(255,240,200,0.85)";
        rrect(ctx, x + 8, H * 0.34, W * 0.17, H * 0.2, 6);
        ctx.fill();
        ctx.fillStyle = pal[i % pal.length];
        rrect(ctx, x + 6, H * 0.29, W * 0.19, H * 0.045, 8);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        for (let k = 0; k < 6; k += 1) ctx.fillRect(x + 10 + rand() * W * 0.15, H * (0.36 + rand() * 0.14), 8, 8);
      }
      ctx.fillStyle = "#e6edf5";
      ctx.fillRect(0, H * 0.7, W, H * 0.3);
      ctx.strokeStyle = "rgba(150,170,190,0.5)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 6; i += 1) {
        ctx.beginPath(); ctx.moveTo(W * (0.08 + i * 0.17), H * 0.7); ctx.lineTo(W * i * 0.22, H); ctx.stroke();
      }
    } else {
      // jungle
      sky(ctx, W, H, "#9be5a0", "#dff9d4");
      const rand = rng(seed + 43);
      for (let i = 0; i < 6; i += 1) {
        const x = W * (0.06 + i * 0.17);
        const h = H * (0.3 + rand() * 0.18);
        ctx.fillStyle = "#2f6b3a";
        ctx.fillRect(x, H * 0.8 - h, W * 0.03, h);
        ctx.fillStyle = i % 2 ? "#2f8f4a" : "#24703b";
        for (let k = 0; k < 3; k += 1) {
          ctx.beginPath();
          ctx.ellipse(x + W * 0.015 + Math.sin(t + k + i) * 8, H * 0.8 - h + k * H * 0.06, W * 0.13, H * 0.05, (k - 1) * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.fillStyle = "#3f8f4f";
      ctx.fillRect(0, H * 0.84, W, H * 0.16);
      ctx.strokeStyle = "#6f9a3d"; ctx.lineWidth = 4;
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath(); ctx.moveTo(W * (0.2 + i * 0.3), 0); ctx.quadraticCurveTo(W * (0.25 + i * 0.3) + Math.sin(t + i) * 20, H * 0.3, W * (0.22 + i * 0.3), H * 0.6); ctx.stroke();
      }
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

  function faceHuman(ctx, h, mood, t, blink, look, eyeOpen = 1) {
    const ex = h * 0.36;
    const ey = -h * 0.02;
    const lid = Math.max(0, Math.min(1, eyeOpen)) * (1 - 0.92 * blink);
    const openY = h * 0.2 * (mood === "surprised" ? 1.25 : 1) * (0.12 + 0.88 * lid);
    const lx = Math.max(-1, Math.min(1, look?.x || 0));
    const ly = Math.max(-1, Math.min(1, look?.y || 0));
    ctx.lineCap = "round";
    // brows
    ctx.strokeStyle = INK;
    ctx.lineWidth = h * 0.07;
    for (const s of [-1, 1]) {
      const browY = -h * 0.32 + (mood === "angry" ? h * 0.02 : 0);
      const tilt = mood === "angry" ? h * 0.1 * s : mood === "sad" ? -h * 0.07 * s : 0;
      ctx.beginPath();
      ctx.moveTo(s * ex - h * 0.13, browY + tilt);
      ctx.quadraticCurveTo(s * ex, browY - h * 0.06, s * ex + h * 0.13, browY - tilt * 0.2);
      ctx.stroke();
    }
    // eyes
    for (const s of [-1, 1]) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(s * ex, ey, h * 0.15, Math.max(h * 0.02, openY), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.7);
      ctx.lineWidth = h * 0.045;
      ctx.stroke();
      if (openY > h * 0.05) {
        ctx.fillStyle = "#2a1a14";
        ctx.beginPath();
        ctx.arc(s * ex + lx * h * 0.05, ey + ly * h * 0.04, h * 0.075, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.beginPath();
        ctx.arc(s * ex + lx * h * 0.05 - h * 0.022, ey - h * 0.025 + ly * h * 0.04, h * 0.023, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // nose
    ctx.strokeStyle = rgba(INK, 0.5);
    ctx.lineWidth = h * 0.045;
    ctx.beginPath();
    ctx.moveTo(h * 0.02, h * 0.06);
    ctx.quadraticCurveTo(h * 0.08, h * 0.2, 0, h * 0.25);
    ctx.stroke();
    // mouth
    ctx.strokeStyle = "#7a3040";
    ctx.lineWidth = h * 0.055;
    if (mood === "surprised") {
      ctx.fillStyle = "#8c1c3a";
      ctx.beginPath();
      ctx.ellipse(0, h * 0.4, h * 0.09, h * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (mood === "sad") {
      ctx.beginPath();
      ctx.arc(0, h * 0.52, h * 0.16, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    } else if (mood === "angry") {
      ctx.beginPath();
      ctx.moveTo(-h * 0.14, h * 0.42);
      ctx.quadraticCurveTo(0, h * 0.36, h * 0.14, h * 0.42);
      ctx.stroke();
    } else if (mood === "excited" || mood === "happy" || mood === "proud" || mood === "silly") {
      ctx.fillStyle = "#8c1c3a";
      ctx.beginPath();
      ctx.moveTo(-h * 0.16, h * 0.36);
      ctx.quadraticCurveTo(0, h * 0.56, h * 0.16, h * 0.36);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-h * 0.16, h * 0.36);
      ctx.quadraticCurveTo(0, h * 0.56, h * 0.16, h * 0.36);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(-h * 0.1, h * 0.4);
      ctx.quadraticCurveTo(0, h * 0.44, h * 0.1, h * 0.4);
      ctx.stroke();
    }
    // cheeks
    ctx.fillStyle = "rgba(255,120,140,0.18)";
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * h * 0.58, h * 0.26, h * 0.12, h * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawHumanBody(ctx, st, story, actor) {
    const r = st.r;
    const h = r * 0.25;
    const pal = story.palette;
    const seed = hash(String(actor?.name || "actor")) + (story.seed || 0);
    const pos = Math.abs(seed);
    const outfit = /^#[0-9a-f]{6}$/i.test(String(actor?.outfit || ""))
      ? actor.outfit
      : (/^#[0-9a-f]{6}$/i.test(String(actor?.color || "")) ? actor.color : pal[2]);
    const outfitDark = shade(outfit, -0.3);
    const skinTones = ["#f2c49b", "#d9a066", "#b97a56", "#8d5a3b", "#6b4226", "#ffd9bd"];
    const skin = st.face ? "#e9b58f" : skinTones[pos % skinTones.length];
    const hairTone = ["#201714", "#3a2418", "#17171d", "#59371f", "#7a4a24"][(pos >>> 2) % 5];
    const pants = "#2f3a4d";
    const shoe = "#1d2129";
    const outline = rgba(INK, 0.85);
    const OW = STYLE === "flat" ? 1.5 : 1;
    const t = st.t || 0;
    const breath = Math.sin(t * 1.9) * h * 0.035;
    const armL = Number.isFinite(st.armL) ? st.armL : 0.55;
    const armR = Number.isFinite(st.armR) ? st.armR : 0.55;
    const legSwing = Number.isFinite(st.legSwing) ? st.legSwing : 0;

    const cap = (x1, y1, x2, y2, w, col, edge) => {
      ctx.lineCap = "round";
      if (edge !== false) {
        ctx.strokeStyle = outline;
        ctx.lineWidth = w + h * 0.085 * OW;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    const joint = (x, y, d, col, edge) => {
      if (edge) {
        ctx.fillStyle = outline;
        ctx.beginPath();
        ctx.arc(x, y, d / 2 + h * 0.04 * OW, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, d / 2, 0, Math.PI * 2);
      ctx.fill();
    };

    // arm: legacy shoulder angle remapped so idle arms hang and raises read as raises
    const mapArm = (a) => {
      const k = 0.6 + 0.7 * Math.max(0, Math.min(1, (0.8 - a) / 1.4));
      return Math.max(-1.35, Math.min(1.5, 1.2 + (a - 0.6) * k));
    };
    const drawArm = (side, raw, foldRaw) => {
      const a = mapArm(Math.max(-2.4, Math.min(2.2, raw)));
      const sx = side * 1.28 * h;
      const sy = 1.42 * h + breath;
      const ex = sx + side * Math.cos(a) * 1.45 * h;
      const ey = sy + Math.sin(a) * 1.45 * h;
      const fold = Number.isFinite(foldRaw) ? foldRaw : 0;
      const bend = lerp(-0.25, 0.35, Math.max(0, Math.min(1, (a + 0.9) / 2.2))) + fold;
      const a2 = a + bend;
      const hx = ex + side * Math.cos(a2) * 1.28 * h;
      const hy = ey + Math.sin(a2) * 1.28 * h;
      cap(sx, sy, ex, ey, h * 0.55, outfit);
      cap(ex, ey, hx, hy, h * 0.38, skin, false);
      joint(ex, ey, h * 0.5, skin);
      joint(hx, hy, h * 0.32, skin);
      joint(sx, sy, h * 0.6, outfit);
    };

    const hipY = 3.55 * h;
    const drawLeg = (side) => {
      const ph = legSwing + (side > 0 ? Math.PI : 0);
      const sw = Math.sin(ph);
      const lift = Math.max(0, sw) * h * 0.5;
      const hx = side * 0.62 * h;
      const kx = hx + side * (0.08 * h + sw * 0.16 * h);
      const ky = hipY + 1.78 * h - lift * 0.25 + breath * 0.5;
      const ax = kx + side * 0.05 * h + sw * 0.08 * h;
      const ay = ky + 1.62 * h - lift * 0.6;
      cap(hx, hipY + breath, kx, ky, h * 0.64, pants);
      cap(kx, ky, ax, ay, h * 0.5, pants, false);
      joint(kx, ky, h * 0.58, pants);
      ctx.fillStyle = shoe;
      ctx.strokeStyle = outline;
      ctx.lineWidth = h * 0.05 * OW;
      ctx.beginPath();
      ctx.ellipse(ax + side * 0.12 * h, ay + h * 0.16, h * 0.4, h * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };

    // far arm first, then legs, then torso, then head, then near arm
    drawArm(-1, armL, st.elbowL);
    drawLeg(-1);
    drawLeg(1);

    // pelvis
    ctx.fillStyle = pants;
    ctx.strokeStyle = outline;
    ctx.lineWidth = h * 0.05 * OW;
    rrect(ctx, -1.02 * h, 3.3 * h, 2.04 * h, 0.6 * h, 0.28 * h);
    ctx.fill();
    ctx.stroke();

    // neck
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.rect(-0.3 * h, 0.72 * h, 0.6 * h, 0.78 * h);
    ctx.fill();
    ctx.strokeStyle = rgba(INK, 0.45);
    ctx.lineWidth = h * 0.035;
    ctx.beginPath();
    ctx.moveTo(-0.3 * h, 0.72 * h);
    ctx.lineTo(-0.3 * h, 1.5 * h);
    ctx.moveTo(0.3 * h, 0.72 * h);
    ctx.lineTo(0.3 * h, 1.5 * h);
    ctx.stroke();

    // torso
    ctx.beginPath();
    ctx.moveTo(-1.34 * h, 1.36 * h + breath);
    ctx.quadraticCurveTo(-1.12 * h, 2.05 * h, -0.94 * h, 2.8 * h);
    ctx.quadraticCurveTo(-1.06 * h, 3.2 * h, -1.02 * h, 3.45 * h);
    ctx.lineTo(1.02 * h, 3.45 * h);
    ctx.quadraticCurveTo(1.06 * h, 3.2 * h, 0.94 * h, 2.8 * h);
    ctx.quadraticCurveTo(1.12 * h, 2.05 * h, 1.34 * h, 1.36 * h + breath);
    ctx.quadraticCurveTo(0, 1.12 * h + breath, -1.34 * h, 1.36 * h + breath);
    ctx.closePath();
    ctx.fillStyle = outfit;
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = h * 0.055 * OW;
    ctx.stroke();
    // collar + hem
    ctx.strokeStyle = outfitDark;
    ctx.lineWidth = h * 0.09;
    ctx.beginPath();
    ctx.moveTo(-0.45 * h, 1.32 * h + breath);
    ctx.quadraticCurveTo(0, 1.62 * h + breath, 0.45 * h, 1.32 * h + breath);
    ctx.stroke();
    ctx.strokeStyle = rgba(INK, 0.28);
    ctx.lineWidth = h * 0.05;
    ctx.beginPath();
    ctx.moveTo(-1.0 * h, 3.22 * h);
    ctx.lineTo(1.0 * h, 3.22 * h);
    ctx.stroke();

    // ears
    ctx.fillStyle = skin;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * 0.99 * h, 0.06 * h, 0.14 * h, 0.2 * h, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // head
    const hairStyle = pos % 4;
    if (hairStyle === 3) {
      ctx.fillStyle = hairTone;
      ctx.beginPath();
      ctx.ellipse(0, 0.5 * h, 1.08 * h, 1.5 * h, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (st.face) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, h, 0, Math.PI * 2);
      ctx.clip();
      const f = st.face;
      const scale = Math.max((2 * h) / f.width, (2 * h) / f.height);
      ctx.drawImage(f, -(f.width * scale) / 2, -(f.height * scale) / 2, f.width * scale, f.height * scale);
      ctx.restore();
      ctx.strokeStyle = outline;
      ctx.lineWidth = h * 0.07 * OW;
      ctx.beginPath();
      ctx.arc(0, 0, h, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(0, 0, h, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = outline;
      ctx.lineWidth = h * 0.06 * OW;
      ctx.stroke();
      faceHuman(ctx, h, st.mood || "happy", t, st.blink || 0, st.look, st.eyeOpen);
    }
    // hair: dome sits on the crown, style adds fringe, bun or long hair
    ctx.fillStyle = hairTone;
    ctx.strokeStyle = outline;
    ctx.lineWidth = h * 0.05 * OW;
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.58, h * 1.04, h * 0.6, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (hairStyle === 1) {
      ctx.beginPath();
      ctx.ellipse(-h * 0.2, -h * 0.62, h * 0.72, h * 0.36, 0.25, 0, Math.PI * 2);
      ctx.fill();
    } else if (hairStyle === 2) {
      ctx.beginPath();
      ctx.arc(0, -h * 1.18, h * 0.42, 0, Math.PI * 2);
      ctx.fill();
    } else if (hairStyle === 3) {
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(s * h * 0.98, h * 0.35, h * 0.3, h * 0.82, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawArm(1, armR, st.elbowR);
  }

  function hero(ctx, st, story, actor) {
    const { x, y, r, rot = 0, armL = 0.5, armR = 0.5, legSwing = 0, eyeOpen = 1, mood = "happy", blink = 0, look } = st;
    const pal = story.palette;
    const kind = actor?.kind || story.hero.kind;
    const fur = actor?.color || story.hero.color;
    const outfit = /^#[0-9a-f]{6}$/i.test(String(actor?.outfit || "")) ? actor.outfit : "";
    const skin = kind === "kid" ? "#ffd8b5" : fur;
    const outline = rgba(INK, 0.82);
    const OW = STYLE === "flat" ? 1.6 : 1;
    ctx.save();
    ctx.translate(x, y);

    if (kind === "human" || kind === "kid") {
      if (rot) {
        // humans tip from the feet, not the skull
        ctx.translate(0, r * 1.72);
        ctx.rotate(rot);
        ctx.translate(0, -r * 1.72);
      }
      drawHumanBody(ctx, st, story, actor);
      ctx.restore();
      return;
    }
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
    ctx.fillStyle = outfit || pal[2];
    rrect(ctx, -r * 0.54, r * 0.55, r * 1.08, r * 1.0, r * 0.42);
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = r * 0.045 * OW;
    ctx.stroke();
    // overalls
    ctx.fillStyle = outfit ? shade(outfit, -0.22) : shade(pal[3], -0.05);
    rrect(ctx, -r * 0.46, r * 1.02, r * 0.92, r * 0.48, r * 0.2);
    ctx.fill();
    ctx.stroke();
    // straps
    ctx.strokeStyle = outfit ? shade(outfit, -0.22) : shade(pal[3], -0.05);
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
    if (st.face) {
      // the attached photo becomes this character's face
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.clip();
      const f = st.face;
      const scale = Math.max((2 * r) / f.width, (2 * r) / f.height);
      ctx.drawImage(f, -(f.width * scale) / 2, -(f.height * scale) / 2, f.width * scale, f.height * scale);
      ctx.restore();
      ctx.strokeStyle = outline;
      ctx.lineWidth = r * 0.06 * OW;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.beginPath();
      ctx.ellipse(-r * 0.32, -r * 0.45, r * 0.34, r * 0.16, -0.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
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
    }
    arm(-1, armL);
    arm(1, armR);

    // bow / cap accessory
    if (!st.face && kind !== "kid" && story.seed % 2 === 0) {
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

  const PROP_KEYWORDS = [
    ["lantern", /(lantern|lamp|torch|glow)/],
    ["umbrella", /(umbrella|rain)/],
    ["wand", /(wand|magic|spell|wizard)/],
    ["guitar", /(guitar|music|banjo|ukulele)/],
    ["camera", /(camera|photo|cam|film)/],
    ["potion", /(potion|elixir|brew|bottle)/],
    ["key", /(key|unlock)/],
    ["map", /(map|scroll|plan)/],
    ["magnifier", /(magnif|detective|clue|lens)/],
    ["trophy", /(trophy|medal|prize|cup)/],
    ["pumpkin", /(pumpkin|halloween)/],
    ["skateboard", /(skate|board)/],
    ["robot", /(robot|droid|android)/],
    ["sword", /(sword|katana|blade|saber)/],
    ["shield", /(shield|armor)/],
    ["balloon", /(balloon)/],
    ["ball", /(ball|basket|soccer)/],
    ["icecream", /(ice ?cream|cone|candy)/],
    ["banana", /(banana|fruit)/],
    ["fish", /(fish)/],
    ["cake", /(cake|cupcake)/],
    ["book", /(book|novel|tome)/],
    ["phone", /(phone|device)/],
    ["rocket", /(rocket|spaceship)/],
    ["crown", /(crown|tiara)/],
    ["hat", /(hat|cap)/],
    ["gem", /(gem|diamond|crystal)/],
    ["treasure", /(treasure|gold|chest|coin)/],
    ["kite", /(kite)/],
    ["star", /(star)/],
  ];

  function propKey(raw) {
    const text = String(raw || "").toLowerCase().replace(/[^a-z0-9 '-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!text || text === "none" || text === "empty" || text === "nothing") return "none";
    for (const [id, re] of PROP_KEYWORDS) if (re.test(text)) return id;
    return "gift";
  }

  function prop(ctx, kind, x, y, s, t, pal) {
    kind = propKey(kind);
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
    } else if (kind === "lantern") {
      const bob = Math.sin(t * 1.8) * s * 0.1;
      ctx.translate(0, bob);
      const glow = ctx.createRadialGradient(0, 0, s * 0.1, 0, 0, s * 1.6);
      glow.addColorStop(0, "rgba(255,210,110,0.6)");
      glow.addColorStop(1, "rgba(255,210,110,0)");
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(0, 0, s * 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#6b4a34";
      ctx.lineWidth = s * 0.06;
      ctx.beginPath(); ctx.arc(0, -s * 0.9, s * 0.16, Math.PI, 0); ctx.stroke();
      ctx.fillStyle = "#ffd66b";
      rrect(ctx, -s * 0.4, -s * 0.62, s * 0.8, s * 1.1, s * 0.16);
      ctx.fill();
      ctx.strokeStyle = "#8a5a2b";
      ctx.lineWidth = s * 0.07;
      ctx.stroke();
      ctx.fillStyle = "#8a5a2b";
      ctx.fillRect(-s * 0.46, -s * 0.7, s * 0.92, s * 0.12);
      ctx.fillRect(-s * 0.46, s * 0.44, s * 0.92, s * 0.12);
    } else if (kind === "umbrella") {
      ctx.rotate(Math.sin(t * 1.4) * 0.08);
      ctx.strokeStyle = "#5c5470";
      ctx.lineWidth = s * 0.08;
      ctx.beginPath(); ctx.moveTo(0, -s * 0.4); ctx.lineTo(0, s * 1.1); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, s * 1.1, s * 0.18, 0, Math.PI); ctx.stroke();
      ctx.fillStyle = pal[0];
      ctx.beginPath();
      ctx.moveTo(-s, -s * 0.4);
      ctx.quadraticCurveTo(0, -s * 1.5, s, -s * 0.4);
      ctx.quadraticCurveTo(s * 0.6, -s * 0.25, s * 0.35, -s * 0.4);
      ctx.quadraticCurveTo(0, -s * 0.22, -s * 0.35, -s * 0.4);
      ctx.quadraticCurveTo(-s * 0.6, -s * 0.25, -s, -s * 0.4);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.4);
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
    } else if (kind === "wand") {
      ctx.rotate(-0.5 + Math.sin(t * 2) * 0.06);
      ctx.fillStyle = "#3b2a4a";
      rrect(ctx, -s * 0.06, -s * 0.1, s * 0.12, s * 1.4, s * 0.06);
      ctx.fill();
      const twinkle = 0.85 + Math.sin(t * 6) * 0.15;
      ctx.fillStyle = pal[1];
      star(ctx, 0, -s * 0.4, s * 0.45 * twinkle);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = s * 0.04;
      ctx.stroke();
      for (let i = 0; i < 4; i += 1) {
        const a = t * 2 + i * 1.7;
        ctx.fillStyle = pal[i % pal.length];
        ctx.beginPath(); ctx.arc(Math.cos(a) * s * 0.8, -s * 0.4 + Math.sin(a) * s * 0.5, s * 0.06, 0, Math.PI * 2); ctx.fill();
      }
    } else if (kind === "guitar") {
      ctx.rotate(-0.6);
      ctx.fillStyle = "#c98a4b";
      ctx.beginPath(); ctx.ellipse(0, s * 0.5, s * 0.5, s * 0.62, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, s * 0.9, s * 0.38, s * 0.42, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.5);
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
      ctx.fillStyle = "#3a2415";
      ctx.beginPath(); ctx.arc(0, s * 0.62, s * 0.14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#6b4a34";
      ctx.fillRect(-s * 0.07, -s * 1.1, s * 0.14, s * 1.6);
      ctx.fillStyle = "#3a2415";
      ctx.fillRect(-s * 0.11, -s * 1.2, s * 0.22, s * 0.16);
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 1.5;
      for (let i = -1; i <= 1; i += 1) {
        ctx.beginPath(); ctx.moveTo(i * s * 0.03, -s * 1.05); ctx.lineTo(i * s * 0.03, s * 0.95); ctx.stroke();
      }
    } else if (kind === "camera") {
      const flash = Math.sin(t * 2.5) > 0.93;
      const bob = Math.sin(t * 1.6) * s * 0.06;
      ctx.translate(0, bob);
      ctx.fillStyle = "#3d4258";
      rrect(ctx, -s * 0.72, -s * 0.42, s * 1.44, s * 0.95, s * 0.18);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.5);
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
      ctx.fillStyle = "#5c6480";
      rrect(ctx, -s * 0.24, -s * 0.62, s * 0.48, s * 0.24, s * 0.08);
      ctx.fill();
      ctx.fillStyle = "#a8c4e6";
      ctx.beginPath(); ctx.arc(0, s * 0.05, s * 0.32, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#2a3550";
      ctx.beginPath(); ctx.arc(0, s * 0.05, s * 0.18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = flash ? "#ffffff" : pal[1];
      ctx.beginPath(); ctx.arc(s * 0.55, -s * 0.26, s * 0.09, 0, Math.PI * 2); ctx.fill();
      if (flash) {
        ctx.fillStyle = "rgba(255,255,255,0.65)";
        ctx.beginPath(); ctx.arc(s * 0.55, -s * 0.26, s * 0.32, 0, Math.PI * 2); ctx.fill();
      }
    } else if (kind === "potion") {
      const bob = Math.sin(t * 2) * s * 0.08;
      ctx.translate(0, bob);
      ctx.fillStyle = "rgba(230,250,255,0.35)";
      rrect(ctx, -s * 0.34, -s * 0.5, s * 0.68, s * 1.1, s * 0.3);
      ctx.fill();
      ctx.fillStyle = pal[1];
      rrect(ctx, -s * 0.3, -s * 0.02, s * 0.6, s * 0.58, s * 0.22);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.45);
      ctx.lineWidth = s * 0.05;
      rrect(ctx, -s * 0.34, -s * 0.5, s * 0.68, s * 1.1, s * 0.3);
      ctx.stroke();
      ctx.fillStyle = "#8a6238";
      rrect(ctx, -s * 0.18, -s * 0.72, s * 0.36, s * 0.26, s * 0.08);
      ctx.fill();
      for (let i = 0; i < 3; i += 1) {
        const a = t * 3 + i * 2.1;
        ctx.fillStyle = rgba(pal[i % pal.length], 0.8);
        ctx.beginPath(); ctx.arc(Math.cos(a) * s * 0.28, -s * 0.3 + Math.sin(a) * s * 0.2, s * 0.045, 0, Math.PI * 2); ctx.fill();
      }
    } else if (kind === "key") {
      ctx.rotate(Math.sin(t * 1.7) * 0.2);
      ctx.fillStyle = "#f2c94c";
      ctx.beginPath(); ctx.arc(0, -s * 0.5, s * 0.32, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#1c1a14";
      ctx.beginPath(); ctx.arc(0, -s * 0.5, s * 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#f2c94c";
      ctx.fillRect(-s * 0.08, -s * 0.2, s * 0.16, s * 0.95);
      ctx.fillRect(s * 0.05, s * 0.45, s * 0.3, s * 0.12);
      ctx.fillRect(s * 0.05, s * 0.68, s * 0.22, s * 0.12);
      ctx.strokeStyle = rgba(INK, 0.4);
      ctx.lineWidth = s * 0.04;
      ctx.stroke();
    } else if (kind === "map") {
      const bob = Math.sin(t * 1.5) * s * 0.06;
      ctx.translate(0, bob);
      ctx.rotate(Math.sin(t * 0.9) * 0.04 - 0.05);
      ctx.fillStyle = "#f1e3c4";
      rrect(ctx, -s * 0.7, -s * 0.5, s * 1.4, s * 1.05, s * 0.1);
      ctx.fill();
      ctx.strokeStyle = "#b99c6f";
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
      ctx.strokeStyle = "#b23a48";
      ctx.lineWidth = s * 0.06;
      ctx.setLineDash([s * 0.08, s * 0.06]);
      ctx.beginPath(); ctx.moveTo(-s * 0.45, s * 0.3); ctx.quadraticCurveTo(0, -s * 0.4, s * 0.45, 0); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#b23a48";
      star(ctx, s * 0.42, s * 0.02, s * 0.14);
      ctx.fill();
    } else if (kind === "magnifier") {
      ctx.rotate(-0.4 + Math.sin(t * 1.6) * 0.05);
      ctx.fillStyle = "rgba(200,240,255,0.4)";
      ctx.beginPath(); ctx.arc(0, -s * 0.25, s * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#5c5470";
      ctx.lineWidth = s * 0.1;
      ctx.stroke();
      ctx.strokeStyle = "#8a5a2b";
      ctx.lineWidth = s * 0.16;
      ctx.beginPath(); ctx.moveTo(s * 0.38, s * 0.15); ctx.lineTo(s * 0.8, s * 0.75); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath(); ctx.ellipse(-s * 0.2, -s * 0.45, s * 0.14, s * 0.07, -0.7, 0, Math.PI * 2); ctx.fill();
    } else if (kind === "trophy") {
      const shine = 0.8 + Math.sin(t * 3) * 0.2;
      ctx.fillStyle = "#f2c94c";
      ctx.beginPath();
      ctx.moveTo(-s * 0.5, -s * 0.55); ctx.lineTo(s * 0.5, -s * 0.55);
      ctx.quadraticCurveTo(s * 0.45, s * 0.2, 0, s * 0.3);
      ctx.quadraticCurveTo(-s * 0.45, s * 0.2, -s * 0.5, -s * 0.55);
      ctx.fill();
      ctx.strokeStyle = "#b9861c";
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
      ctx.strokeStyle = "#f2c94c";
      ctx.lineWidth = s * 0.1;
      ctx.beginPath(); ctx.arc(-s * 0.58, -s * 0.32, s * 0.18, Math.PI * 0.4, Math.PI * 1.2); ctx.stroke();
      ctx.beginPath(); ctx.arc(s * 0.58, -s * 0.32, s * 0.18, Math.PI * 1.8, Math.PI * 0.6); ctx.stroke();
      ctx.fillStyle = "#b9861c";
      ctx.fillRect(-s * 0.08, s * 0.3, s * 0.16, s * 0.28);
      rrect(ctx, -s * 0.36, s * 0.56, s * 0.72, s * 0.2, s * 0.08);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${shine})`;
      star(ctx, 0, -s * 0.1, s * 0.16);
      ctx.fill();
    } else if (kind === "pumpkin") {
      ctx.translate(0, Math.sin(t * 2) * s * 0.06);
      ctx.fillStyle = "#f08c2e";
      for (const dx of [-0.3, 0, 0.3]) {
        ctx.beginPath(); ctx.ellipse(s * dx, 0, s * 0.4, s * 0.52, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = rgba(INK, 0.35);
      ctx.lineWidth = s * 0.04;
      ctx.beginPath(); ctx.ellipse(0, 0, s * 0.68, s * 0.52, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#3f7d3f";
      rrect(ctx, -s * 0.06, -s * 0.66, s * 0.12, s * 0.22, s * 0.05);
      ctx.fill();
      ctx.fillStyle = "#1c1a14";
      ctx.beginPath(); ctx.moveTo(-s * 0.22, -s * 0.08); ctx.lineTo(-s * 0.08, -s * 0.16); ctx.lineTo(-s * 0.12, s * 0.04); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(s * 0.22, -s * 0.08); ctx.lineTo(s * 0.08, -s * 0.16); ctx.lineTo(s * 0.12, s * 0.04); ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-s * 0.18, s * 0.18); ctx.quadraticCurveTo(0, s * 0.32, s * 0.18, s * 0.18);
      ctx.lineTo(s * 0.1, s * 0.24); ctx.lineTo(0, s * 0.2); ctx.lineTo(-s * 0.1, s * 0.24);
      ctx.closePath(); ctx.fill();
    } else if (kind === "skateboard") {
      ctx.rotate(Math.sin(t * 3) * 0.08);
      ctx.fillStyle = pal[0];
      rrect(ctx, -s * 0.95, s * 0.05, s * 1.9, s * 0.34, s * 0.16);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.45);
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
      ctx.fillStyle = "#3d4258";
      for (const dx of [-0.6, 0.6]) {
        ctx.beginPath(); ctx.arc(s * dx, s * 0.46, s * 0.12, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#ffd43b";
      ctx.fillRect(-s * 0.5, s * 0.15, s, s * 0.05);
      ctx.fillRect(-s * 0.5, s * 0.27, s, s * 0.05);
    } else if (kind === "robot") {
      ctx.translate(0, Math.sin(t * 2.4) * s * 0.06);
      ctx.fillStyle = "#9aa7bd";
      rrect(ctx, -s * 0.6, -s * 0.5, s * 1.2, s * 1.05, s * 0.2);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.45);
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
      ctx.fillStyle = "#2a3550";
      rrect(ctx, -s * 0.44, -s * 0.34, s * 0.88, s * 0.5, s * 0.14);
      ctx.fill();
      const lid = Math.sin(t * 4) > -0.2 ? 1 : 0.2;
      ctx.fillStyle = pal[1];
      ctx.beginPath(); ctx.arc(-s * 0.2, -s * 0.14, s * 0.1 * lid, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(s * 0.2, -s * 0.14, s * 0.1 * lid, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = pal[2];
      ctx.lineWidth = s * 0.05;
      ctx.beginPath(); ctx.arc(0, s * 0.02, s * 0.14, 0.2, Math.PI - 0.2); ctx.stroke();
      ctx.strokeStyle = "#5c6478";
      ctx.lineWidth = s * 0.06;
      ctx.beginPath(); ctx.moveTo(0, -s * 0.5); ctx.lineTo(0, -s * 0.78); ctx.stroke();
      ctx.fillStyle = "#ff6b6b";
      ctx.beginPath(); ctx.arc(0, -s * 0.82, s * 0.08, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#5c6478";
      ctx.lineWidth = s * 0.12;
      ctx.beginPath(); ctx.moveTo(-s * 0.62, s * 0.1); ctx.lineTo(-s * 0.85, s * 0.4 + Math.sin(t * 3) * s * 0.08); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s * 0.62, s * 0.1); ctx.lineTo(s * 0.85, s * 0.4 - Math.sin(t * 3) * s * 0.08); ctx.stroke();
    } else if (kind === "gift") {
      ctx.translate(0, Math.sin(t * 2.2) * s * 0.08);
      ctx.fillStyle = pal[0];
      rrect(ctx, -s * 0.62, -s * 0.45, s * 1.24, s * 1.1, s * 0.12);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.4);
      ctx.lineWidth = s * 0.05;
      ctx.stroke();
      ctx.fillStyle = pal[1];
      ctx.fillRect(-s * 0.1, -s * 0.45, s * 0.2, s * 1.1);
      ctx.fillRect(-s * 0.62, -s * 0.12, s * 1.24, s * 0.2);
      ctx.strokeStyle = pal[1];
      ctx.lineWidth = s * 0.09;
      for (const d of [-1, 1]) {
        ctx.beginPath(); ctx.ellipse(d * s * 0.2, -s * 0.56, s * 0.18, s * 0.1, d * 0.5, 0, Math.PI * 2); ctx.stroke();
      }
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
    const seq = Array.isArray(scene.beats) ? scene.beats.filter(Boolean).slice(0, 4) : [];
    if (seq.length > 1) {
      const n = seq.length;
      const segDur = Math.max(0.3, sceneDur / (n - 1));
      const pos = clamp(sceneTime / Math.max(0.1, sceneDur), 0, 0.9999) * (n - 1);
      const i = Math.min(n - 2, Math.floor(pos));
      const f = pos - i;
      const k0 = f < 0.66 ? 0 : (f - 0.66) / 0.34;
      const k = k0 * k0 * (3 - 2 * k0);
      const sub = (action, sd, kk) => {
        const st0 = clamp((sceneTime - kk * segDur) / segDur, 0, 1);
        return pose({ ...scene, beats: null, action, _seg: true }, st0 * segDur, segDur, t, sd, L);
      };
      const a = sub(seq[i], seed, i);
      if (k <= 0) return a;
      const b = sub(seq[i + 1], seed + 7, i + 1);
      return blendPose(a, b, k);
    }
    const rand = rng(seed + hash(scene.caption) % 999);
    const beat = Math.sin(t * 5 + rand() * 2);
    let eyeOpen = 1;
    const bounce = Math.abs(beat) * L.r * 0.08;
    let x = L.heroX + Math.sin(t * 0.9 + rand()) * L.W * 0.012;
    let lift = bounce;
    let rot = Math.sin(t * 2.2 + rand()) * 0.02;
    let armL = 0.6 + Math.sin(t * 2 + rand()) * 0.15;
    let armR = 0.6 + Math.sin(t * 2 + 1 + rand()) * 0.15;
    let legSwing = 0;
    let look = { x: 0, y: 0 };
    let elbowL = 0;
    let elbowR = 0;
    const baseX = x;
    const baseRot = rot;
    const baseArmL = armL;
    const baseArmR = armR;
    // a scene is one performance: repeat a cycle at most a few times, then settle
    const reps = Math.max(1, Math.min(3, Math.round(sceneDur / 2.4)));
    let actionEnd = -1;
    const cyc = (period) => {
      if (scene._seg) return clamp(sceneTime / Math.max(0.01, sceneDur), 0, 1);
      const total = period * reps;
      actionEnd = Math.max(actionEnd, total);
      return sceneTime >= total ? 1 : (sceneTime % period) / period;
    };
    const action = scene.action || "wave";
    if (action === "walk") {
      const eased = easeOutCubic(clamp(sceneTime / Math.max(0.1, sceneDur - 0.5), 0, 1));
      x = L.heroX + (eased - 0.5) * L.W * 0.16 + Math.sin(t * 3) * L.W * 0.01;
      legSwing = t * 7;
      armL = 0.68 + Math.sin(t * 7) * 0.18;
      armR = 0.68 - Math.sin(t * 7) * 0.18;
      look = { x: 1, y: 0 };
    } else if (action === "jump") {
      const jc = cyc(1.15);
      lift = Math.sin(jc * Math.PI) * L.r * 0.75;
      legSwing = jc > 0.4 ? 0.5 : 0;
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
    } else if (action === "run") {
      const eased = easeOutCubic(clamp(sceneTime / Math.max(0.1, sceneDur - 0.4), 0, 1));
      x = L.heroX + (eased - 0.5) * L.W * 0.28;
      legSwing = t * 14;
      armL = 0.72 + Math.sin(t * 14) * 0.3;
      armR = 0.72 - Math.sin(t * 14) * 0.3;
      rot = -0.08;
      look = { x: 1, y: 0 };
    } else if (action === "punch") {
      const th = cyc(0.62);
      const jab = th < 0.45 ? 0 : (th < 0.6 ? easeOutCubic((th - 0.45) / 0.15) : 1 - easeOutCubic((th - 0.6) / 0.4));
      const cock = th < 0.45 ? easeOutCubic(th / 0.45) : 1 - jab;
      armR = lerp(lerp(0.95, 0.8, cock), -0.25, jab);
      elbowR = -3.0 * cock + 2.6 * jab;
      armL = 0.9;
      elbowL = -3.0;
      rot = -0.08;
      x = L.heroX + Math.sin(th * Math.PI) * L.W * 0.03;
      look = { x: 1, y: -0.2 };
    } else if (action === "kick") {
      const th = cyc(0.74);
      legSwing = th < 0.55 ? lerp(0, 1.5, th / 0.55) : lerp(1.5, 0.3, (th - 0.55) / 0.45);
      lift = Math.abs(Math.sin(th * Math.PI)) * L.r * 0.32;
      armL = -0.5;
      armR = -0.5;
      rot = 0.06;
    } else if (action === "hit" || action === "fall") {
      const p = action === "fall" ? clamp(sceneTime / 0.7, 0, 1) : 0.32 + Math.sin(t * 18) * 0.1;
      rot = (action === "fall" ? 1.15 : 0.3) * p;
      x = L.heroX + (action === "fall" ? L.W * 0.035 * p : Math.sin(t * 20) * L.W * 0.012);
      lift = action === "fall" ? 0 : -L.r * 0.04;
      armL = -1.6;
      armR = -1.45;
      elbowL = -0.9;
      elbowR = -1.1;
      eyeOpen = 0.35;
    } else if (action === "throw") {
      const th = cyc(0.85);
      armR = th < 0.45 ? -1.7 : lerp(-0.15, -1.7, (th - 0.45) / 0.55);
      armL = 0.6;
      rot = -0.06;
    } else if (action === "hug") {
      armL = 0.1 + Math.sin(t * 3) * 0.08;
      armR = 0.1 + Math.sin(t * 3 + 1) * 0.08;
      rot = Math.sin(t * 2) * 0.02;
      lift = Math.abs(beat) * L.r * 0.03;
    } else if (action === "fly") {
      lift = L.r * 0.85 + Math.sin(t * 2.4) * L.r * 0.15;
      armL = -2.4;
      armR = -2.4;
      legSwing = 0.55;
      rot = Math.sin(t * 2) * 0.05;
    } else if (action === "sleep") {
      eyeOpen = 0.06;
      rot = 0.14;
      lift = -L.r * 0.3;
      armL = 1.2;
      armR = 1.2;
      legSwing = 0;
    } else if (action === "sneak") {
      lift = -L.r * 0.16;
      legSwing = t * 3;
      armL = 0.95;
      armR = 0.95;
      rot = 0.18;
    } else if (action === "laugh") {
      rot = Math.sin(t * 12) * 0.06;
      armL = 0.9 + Math.sin(t * 12) * 0.25;
      armR = 0.9 - Math.sin(t * 12) * 0.25;
      eyeOpen = 0.5;
      lift = Math.abs(Math.sin(t * 12)) * L.r * 0.05;
    } else if (action === "cry") {
      armL = 0.95;
      armR = 0.85;
      elbowL = -3.5;
      elbowR = -3.7;
      eyeOpen = 0.6;
      rot = 0.05;
    } else if (action === "sit") {
      lift = -L.r * 0.42;
      armL = 1.3;
      armR = 1.3;
      legSwing = 1.4;
    } else if (action === "dodge") {
      const th = cyc(0.9);
      const k = th < 0.45 ? easeOutCubic(th / 0.45) : 1 - easeOutCubic((th - 0.45) / 0.55);
      x = L.heroX - k * L.W * 0.14;
      rot = -0.28 * k;
      armL = -1.1 * k - 0.4;
      armR = 0.5;
      legSwing = 0.9 * k;
      look = { x: -1, y: 0.1 };
    } else if (action === "recoil") {
      const th = cyc(1.1);
      const k = Math.sin(th * Math.PI);
      x = L.heroX + k * L.W * 0.06;
      rot = 0.3 * k;
      armL = -1.6;
      armR = -1.45;
      lift = -L.r * 0.05 * k;
      eyeOpen = 0.55;
      look = { x: 0.6, y: -0.2 };
    } else if (action === "guard") {
      armL = 0.95 + Math.sin(t * 4) * 0.05;
      armR = 0.9 - Math.sin(t * 4) * 0.05;
      elbowL = -3.1;
      elbowR = -3.3;
      rot = 0.07 + Math.sin(t * 2.4) * 0.02;
      lift = -L.r * 0.08;
      x = L.heroX + Math.sin(t * 1.6) * L.W * 0.015;
      look = { x: 0.8, y: -0.1 };
    } else if (action === "grapple") {
      const th = cyc(1.3);
      const k = Math.sin(th * Math.PI);
      armL = 0.05;
      armR = 0.02;
      rot = -0.2 * k - 0.05;
      x = L.heroX + k * L.W * 0.05;
      legSwing = 0.35 + Math.sin(t * 9) * 0.15;
      lift = -L.r * 0.04;
      look = { x: 1, y: 0 };
    } else if (action === "leap") {
      const th = cyc(1.2);
      lift = Math.sin(th * Math.PI) * L.r * 0.95;
      x = L.heroX + (th - 0.5) * L.W * 0.24;
      legSwing = th < 0.4 ? 0.75 : 0.2;
      armL = -1.5;
      armR = -1.5;
      rot = -0.12;
      look = { x: 1, y: -0.3 };
    } else if (action === "windup") {
      const th = cyc(0.9);
      const k = th < 0.7 ? easeOutCubic(th / 0.7) : 1;
      x = L.heroX - k * L.W * 0.03;
      rot = 0.2 * k;
      armR = 0.9;
      elbowR = lerp(-0.5, -3.1, k);
      armL = 0.75;
      elbowL = -3.0;
      legSwing = 0.3 * k;
      look = { x: 1, y: -0.1 };
    } else if (action === "aim") {
      armL = -0.02 + Math.sin(t * 3) * 0.04;
      armR = -0.08 - Math.sin(t * 3) * 0.04;
      rot = -0.05;
      lift = -L.r * 0.03;
      look = { x: 1, y: -0.15 };
    } else if (action === "swing") {
      const th = cyc(0.8);
      const k = th < 0.45 ? th / 0.45 : 1 - (th - 0.45) / 0.55;
      armR = th < 0.45 ? lerp(-2.3, -0.15, th / 0.45) : lerp(-0.15, 1.1, (th - 0.45) / 0.55);
      armL = 0.55 + k * 0.35;
      rot = lerp(-0.22, 0.3, th < 0.45 ? th / 0.45 : 1);
      x = L.heroX + Math.sin(th * Math.PI) * L.W * 0.025;
      legSwing = 0.4 * k;
      look = { x: 1, y: 0.1 };
    } else if (action === "serve") {
      const th = cyc(1.0);
      armR = th < 0.5 ? lerp(0.2, -2.4, th / 0.5) : lerp(-2.4, 0.4, (th - 0.5) / 0.5);
      armL = 0.4;
      lift = th > 0.42 && th < 0.62 ? L.r * 0.18 : 0;
      rot = -0.06;
      legSwing = 0.3;
      look = { x: 0.6, y: -1 };
    } else if (action === "dribble") {
      armR = 1.0 + Math.sin(t * 10) * 0.55;
      armL = 0.8;
      legSwing = t * 4;
      lift = Math.abs(Math.sin(t * 10)) * L.r * 0.06;
      rot = -0.06;
      look = { x: 0.8, y: 0.5 };
    } else if (action === "skate") {
      rot = 0.12 + Math.sin(t * 2) * 0.04;
      x = L.heroX + Math.sin(t * 2.2) * L.W * 0.05;
      armL = -0.55;
      armR = 0.15;
      legSwing = 0.9;
      lift = Math.abs(Math.sin(t * 3)) * L.r * 0.05;
      look = { x: 1, y: 0.1 };
    } else if (action === "brag") {
      armL = 1.25;
      armR = 1.25;
      rot = -0.1 + Math.sin(t * 2) * 0.02;
      lift = L.r * 0.06;
      eyeOpen = 0.85;
      look = { x: 0, y: -0.6 };
    } else if (action === "cower") {
      lift = -L.r * 0.24;
      rot = 0.22;
      armL = 1.05 + Math.sin(t * 7) * 0.03;
      armR = 1.0 - Math.sin(t * 7) * 0.03;
      elbowL = -3.9;
      elbowR = -4.0;
      eyeOpen = 0.45;
      legSwing = 0.5;
      look = { x: 0, y: 0.4 };
    } else if (action === "tremble") {
      x = L.heroX + Math.sin(t * 38) * L.W * 0.005;
      armL = 0.95 + Math.sin(t * 9) * 0.12;
      armR = 0.95 - Math.sin(t * 9) * 0.12;
      rot = 0.05 + Math.sin(t * 30) * 0.01;
      eyeOpen = 0.75;
      look = { x: -0.4, y: 0.2 };
    } else if (action === "bow") {
      const th = cyc(1.6);
      const k = th < 0.5 ? easeOutCubic(th / 0.5) : 1 - easeOutCubic((th - 0.5) / 0.5);
      rot = 0.55 * k;
      armL = 0.9;
      armR = 0.9;
      lift = -L.r * 0.05 * k;
      look = { x: 0, y: 1 };
    } else if (action === "shrug") {
      armL = -0.3 + Math.sin(t * 2.6) * 0.06;
      armR = -0.3 - Math.sin(t * 2.6) * 0.06;
      rot = Math.sin(t * 1.8) * 0.03;
      lift = L.r * 0.02;
      eyeOpen = 0.9;
      look = { x: -0.2, y: -0.1 };
    } else if (action === "spin") {
      const th = cyc(1.2);
      const k = Math.sin(th * Math.PI);
      lift = k * L.r * 0.34;
      rot = Math.sin(th * Math.PI * 2) * 0.2;
      armL = -1.1;
      armR = -1.1;
      legSwing = th * 6;
      look = { x: 0, y: -0.4 };
    } else if (action === "pace") {
      x = L.heroX + Math.sin(sceneTime * 2.2) * L.W * 0.07;
      legSwing = t * 6;
      armL = 0.68 + Math.sin(t * 6) * 0.16;
      armR = 0.5 - Math.sin(t * 6) * 0.3;
      rot = 0.04;
      look = { x: 0, y: 0.3 };
    }
    // settle back to a natural resting stance so a scene never loops the same clip
    if (!scene._seg) {
      const end = actionEnd >= 0 ? actionEnd : sceneDur * 0.78;
      const settle = clamp((sceneTime - end) / 0.7, 0, 1) * 0.85;
      if (settle > 0) {
        if (action !== "walk" && action !== "run" && action !== "pace") x = lerp(x, baseX, settle);
        rot = lerp(rot, baseRot, settle);
        armL = lerp(armL, baseArmL, settle);
        armR = lerp(armR, baseArmR, settle);
        elbowL = lerp(elbowL, 0, settle);
        elbowR = lerp(elbowR, 0, settle);
        legSwing = lerp(legSwing, 0, settle);
        lift = lerp(lift, 0, settle);
        if (action !== "sleep" && action !== "cry") eyeOpen = lerp(eyeOpen, 1, settle);
        look = { x: lerp(look.x, 0, settle), y: lerp(look.y, 0, settle) };
      }
    }
    // blink every ~2.8s
    const phase = (t + (seed % 31) * 0.11) % 2.8;
    const blink = phase < 0.12 ? Math.sin((phase / 0.12) * Math.PI) : 0;
    return {
      x, y: L.heroY - lift, r: L.r, rot, armL, armR, elbowL, elbowR, legSwing,
      blink, look, eyeOpen, mood: scene.mood || "happy", t,
    };
  }

  function blendPose(a, b, k) {
    const m = (x, y) => lerp(x, y, k);
    return {
      x: m(a.x, b.x),
      y: m(a.y, b.y),
      r: m(a.r, b.r),
      rot: m(a.rot, b.rot),
      armL: m(a.armL, b.armL),
      armR: m(a.armR, b.armR),
      elbowL: m(a.elbowL || 0, b.elbowL || 0),
      elbowR: m(a.elbowR || 0, b.elbowR || 0),
      legSwing: m(a.legSwing, b.legSwing),
      blink: k < 0.5 ? a.blink : b.blink,
      look: k < 0.5 ? a.look : b.look,
      eyeOpen: m(a.eyeOpen, b.eyeOpen),
      mood: k < 0.5 ? a.mood : b.mood,
      t: a.t,
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

    // scene dots (a progress track once there are too many scenes to dot)
    const n = story.scenes.length;
    const p = clamp(Number(prog) || 0, 0, 1);
    if (n > 24) {
      const trackW = 340 * scale;
      const trackX = W - pad - trackW;
      const trackY = pad + chipH / 2;
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      rrect(ctx, trackX, trackY - 5 * scale, trackW, 10 * scale, 5 * scale);
      ctx.fill();
      if (p > 0) {
        ctx.fillStyle = story.palette[1];
        rrect(ctx, trackX, trackY - 5 * scale, Math.max(10 * scale, trackW * p), 10 * scale, 5 * scale);
        ctx.fill();
      }
    } else {
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
    }
    // progress bar
    const barY = pad + chipH + 14 * scale;
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    rrect(ctx, pad, barY, W - pad * 2, 6 * scale, 3 * scale);
    ctx.fill();
    if (p > 0) {
      ctx.fillStyle = rgba(story.palette[1], 0.9);
      rrect(ctx, pad, barY, (W - pad * 2) * p, 6 * scale, 3 * scale);
      ctx.fill();
    }
  }

  const IMPACT_ACTIONS = new Set(["punch", "kick", "hit", "fall", "throw", "swing", "grapple", "recoil"]);

  function cameraFor(scene, sceneTime, sceneDur, t, seed) {
    const p = clamp(sceneTime / Math.max(0.1, sceneDur), 0, 1);
    const smooth = p * p * (3 - 2 * p);
    const base = { wide: 1.0, medium: 1.05, close: 1.12, push: 1.0 }[scene.camera] || 1.04;
    const push = scene.camera === "push" ? 0.1 : scene.camera === "close" ? 0.045 : 0.02;
    const dir = hash(String(scene.caption || "")) % 2 ? 1 : -1;
    const handX = Math.sin(t * 0.8 + seed) * 0.0022 + Math.sin(t * 1.7 + seed * 2) * 0.0011;
    const handY = Math.sin(t * 1.1 + seed * 3) * 0.0016;
    let shake = 0;
    if (IMPACT_ACTIONS.has(scene.action)) {
      const hit = clamp((p - 0.42) / 0.1, 0, 1) * (1 - clamp((p - 0.55) / 0.3, 0, 1));
      shake = Math.sin(t * 62) * 0.009 * hit;
    }
    return {
      z: base + push * smooth,
      ox: (smooth - 0.5) * 0.012 * dir + handX + shake,
      oy: handY,
    };
  }

  function drawFrame(ctx, opt) {
    const { W, H, story, t, seconds, img, imgs } = opt;
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
    const cast = (Array.isArray(story.cast) && story.cast.length ? story.cast : [story.hero]).slice(0, 3);
    const faces = Array.isArray(imgs) ? imgs : (img ? [img] : []);
    const duo = cast.length > 1;
    const spots = cast.length === 1
      ? [{ x: L.heroX, mirror: false, scale: 1 }]
      : cast.length === 2
        ? [
          { x: W * (L.vertical ? 0.31 : 0.33), mirror: false, scale: 0.84 },
          { x: W * (L.vertical ? 0.69 : 0.67), mirror: true, scale: 0.84 },
        ]
        : [
          { x: W * 0.2, mirror: false, scale: 0.72 },
          { x: W * 0.8, mirror: true, scale: 0.72 },
          { x: W * 0.5, mirror: false, scale: 0.86 },
        ];
    const propX = duo ? W * 0.5 : L.propX;
    const propY = duo ? H * (L.vertical ? 0.33 : 0.29) : L.propY;
    const propS = duo ? L.r * 0.4 : L.r * 0.55;

    backdrop(ctx, { W, H, bg: scene.bg, t, pal, seed: seed + idx });
    // scene-cut light flash sits on the world, before the cast and captions
    if (idx > 0 && sceneTime < 0.42) {
      const q = sceneTime / 0.42;
      ctx.fillStyle = `rgba(255,255,255,${(1 - q) * 0.3})`;
      ctx.fillRect(0, 0, W, H);
    }

    const cam = cameraFor(scene, sceneTime, sceneDur, t, seed + idx);
    const focusY = H * (L.vertical ? 0.6 : 0.56);
    ctx.save();
    ctx.translate(W / 2, focusY);
    ctx.scale(cam.z, cam.z);
    ctx.translate(-W / 2, -focusY);
    ctx.translate(cam.ox * W, cam.oy * H);

    // prop first when it should sit behind
    prop(ctx, scene.prop, propX, propY, propS, t, pal);
    if (scene.action === "cheer" || scene.mood === "excited") confetti(ctx, W, H, t, pal, 30);

    const drawOne = (spot, i) => {
      const actor = cast[i];
      const AL = Object.assign({}, L, {
        heroX: spot.x,
        r: L.r * spot.scale,
        propX,
        propY,
      });
      const act = i === 0
        ? scene
        : Object.assign({}, scene, {
          action: scene.action2 || "idle",
          mood: scene.mood2 || "happy",
          beats: scene.beats2 || null,
        });
      const poseNow = pose(act, sceneTime, sceneDur, t, seed + idx + i * 7, AL);
      poseNow.face = faces[i] || null;
      const shadowY = Math.min(AL.heroY + AL.r * 1.78, H * 0.97);
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.beginPath();
      ctx.ellipse(spot.x, shadowY, AL.r * (1.1 - (AL.heroY - poseNow.y) / (AL.r * 6)), AL.r * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      if (spot.mirror) {
        ctx.translate(spot.x * 2, 0);
        ctx.scale(-1, 1);
      }
      if (STYLE === "sticker") {
        ctx.save();
        ctx.shadowColor = "rgba(255,255,255,0.95)";
        ctx.shadowBlur = 26;
        hero(ctx, poseNow, story, actor);
        ctx.restore();
      }
      hero(ctx, poseNow, story, actor);
      ctx.restore();
      if (duo && actor?.name) {
        const hum = actor.kind === "human" || actor.kind === "kid";
        const ty = Math.min(AL.heroY - AL.r * (hum ? 0.8 : 1.42), H * 0.52);
        setFont(ctx, W * 0.026);
        const label = String(actor.name).toUpperCase().slice(0, 12);
        const tw = ctx.measureText(label).width;
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(20,12,30,0.55)";
        rrect(ctx, spot.x - tw / 2 - W * 0.016, ty - W * 0.019, tw + W * 0.032, W * 0.038, W * 0.019);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, spot.x, ty + 1);
        ctx.restore();
      }
    };

    const order = cast.length === 3 ? [2, 0, 1] : [0, 1];
    for (const i of order) if (cast[i]) drawOne(spots[i], i);
    if (scene.action === "cheer") confetti(ctx, W, H, t + 0.6, pal, 18);
    ctx.restore();

    // captions in the safe area
    caption(ctx, scene.caption, { W, H, y: L.captionY, age: sceneTime + 0.15, pal, capWidth: W * (L.vertical ? 0.86 : 0.52), cx: L.captionX });

    // global intro title
    if (t < 1.9) {
      const p = clamp(t / 0.5, 0, 1);
      const out = clamp((1.9 - t) / 0.25, 0, 1);
      const sc = 0.6 + 0.4 * easeOutBack(p);
      ctx.save();
      ctx.translate(W * (L.vertical ? 0.5 : 0.31), H * (L.vertical ? 0.17 : 0.27));
      ctx.scale(sc, sc);
      ctx.globalAlpha = Math.min(p * 2, 1) * out;
      const title = String(story.title || "Toon Time").toUpperCase().slice(0, 22);
      setFont(ctx, W * (L.vertical ? 0.085 : 0.05));
      const maxW = W * (L.vertical ? 0.86 : 0.52);
      let size = W * (L.vertical ? 0.085 : 0.05);
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
    if (p > 0) {
      // outro panel
      ctx.save();
      ctx.fillStyle = "rgba(16,8,26,0.42)";
      ctx.fillRect(0, 0, W, H);
      const bob = Math.sin((Date.now() / 1000) * 5) * 8;
      const ox = L.captionX || W / 2;
      const oy = L.vertical ? H * 0.24 : H * 0.42;
      ctx.globalAlpha = p;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      setFont(ctx, W * 0.075);
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(24,12,32,0.9)";
      ctx.lineWidth = W * 0.075 * 0.2;
      ctx.strokeText("FOLLOW FOR", ox, oy - 70 + bob);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("FOLLOW FOR", ox, oy - 70 + bob);
      setFont(ctx, W * 0.115);
      ctx.strokeText("PART 2!", ox, oy + 40 + bob);
      ctx.fillStyle = "#ffe066";
      ctx.fillText("PART 2!", ox, oy + 40 + bob);
      setFont(ctx, W * 0.045);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText("new toon every day", ox, oy + 130 + bob);
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

  function drawThumb(canvas, story, imgs, vertical) {
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

    // cast (up to two on the cover)
    const L = vertical
      ? { r: W * 0.24, heroX: W * 0.5, heroY: H * 0.69, vertical: true, W, H }
      : { r: H * 0.225, heroX: W * 0.72, heroY: H * 0.607, vertical: false, W, H };
    const cast = (Array.isArray(story.cast) && story.cast.length ? story.cast : [story.hero]).slice(0, 2);
    const faces = Array.isArray(imgs) ? imgs : (imgs ? [imgs] : []);
    const spots = cast.length > 1
      ? (vertical
        ? [{ x: W * 0.34, y: H * 0.7, r: W * 0.185, rot: 0.09 }, { x: W * 0.66, y: H * 0.7, r: W * 0.185, rot: -0.09 }]
        : [{ x: W * 0.56, y: H * 0.62, r: H * 0.175, rot: 0.09 }, { x: W * 0.8, y: H * 0.62, r: H * 0.175, rot: -0.09 }])
      : [{ x: L.heroX, y: L.heroY, r: L.r, rot: 0.04 }];
    spots.forEach((s, i) => {
      const hum = cast[i]?.kind === "human" || cast[i]?.kind === "kid";
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + s.r * (hum ? 1.56 : 0.7), s.r * 1.1, s.r * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      hero(ctx, {
        x: s.x, y: s.y - s.r * 0.25, r: s.r, rot: s.rot,
        armL: i === 0 ? 0.55 : 0.7, armR: i === 0 ? 0.7 : 0.55, legSwing: 0.4, blink: 0, look: { x: 0, y: -1 },
        mood: i === 0 ? "surprised" : "happy", t: 1.2 + i,
        face: faces[i] || null,
      }, story, cast[i]);
    });
    const anchor = spots[spots.length - 1];

    if (cast.length === 1 && faces[0]) {
      const size = vertical ? W * 0.26 : H * 0.25;
      photoCard(ctx, faces[0], vertical ? W * 0.08 : W * 0.035, vertical ? H * 0.33 : H * 0.06, size, 0.7, pal[1]);
    }

    // big words
    const text = String(story.thumbText || "WATCH THIS").toUpperCase().replace(/[!?]+$/, "");
    const words = text.split(/\s+/).filter(Boolean).slice(0, 4);
    const maxW = vertical ? W * 0.9 : (cast.length > 1 ? W * 0.42 : W * 0.5);
    let size = vertical ? W * 0.17 : H * 0.16;
    setFont(ctx, size);
    while (ctx.measureText(words.join(" ")).width > maxW && size > 40) {
      size -= 4;
      setFont(ctx, size);
    }
    const lines = wrapLines(ctx, words, maxW);
    const lineH = size * 1.05;
    const cx = vertical ? W / 2 : W * 0.29;
    const startY = vertical ? H * 0.2 : H * 0.5 - (lines.length - 1) * lineH * 0.5;
    let endX = cx;
    let endY = startY;
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
      endX = cx + w / 2;
      endY = startY + li * lineH;
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
    const ax = endX + (vertical ? W * 0.04 : W * 0.03);
    const ay = endY + (vertical ? H * 0.05 : H * 0.09);
    const bx = vertical ? anchor.x + anchor.r * 0.55 : anchor.x - anchor.r * 0.95;
    const by = vertical ? anchor.y - anchor.r * 0.85 : anchor.y - anchor.r * 0.62;
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
      // pad once per bar instead of four overlapping per beat (matters on long cuts)
      for (const note of [root, root + 4, root + 7]) add(bar * 2, 2.0, semis(note - 12), 0.05, 1.4, "soft");
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
    return { wavBuf: data, seconds };
  }

  /* ------------------------------------------------------------ render */

  function blobToBytes(blob) {
    return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
  }

  function bitsFor(seconds) {
    if (seconds <= 60) return 8_000_000;
    if (seconds <= 150) return 6_000_000;
    if (seconds <= 300) return 4_500_000;
    return 3_000_000;
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
    const { story, seconds, aspect, host, imageDataUrl, photoDataUrls, onProgress } = opt;
    const vertical = String(aspect || "vertical") !== "wide";
    const W = vertical ? 1080 : 1920;
    const H = vertical ? 1920 : 1080;
    const dur = clamp(Number(seconds) || 15, 6, 480);
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
    const srcs = (Array.isArray(photoDataUrls) && photoDataUrls.length ? photoDataUrls : (imageDataUrl ? [imageDataUrl] : [])).slice(0, 3);
    const imgs = (await Promise.all(srcs.map((s) => loadImage(s)))).filter(Boolean);
    const draw = (at) => {
      try {
        drawFrame(ctx, { W, H, story, t: at, seconds: dur, imgs });
      } catch (err) {
        console.error("toon frame", err);
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

  function renderThumbs(opt) {
    const { story, imageDataUrl, photoDataUrls } = opt;
    const srcs = (Array.isArray(photoDataUrls) && photoDataUrls.length ? photoDataUrls : (imageDataUrl ? [imageDataUrl] : [])).slice(0, 3);
    return Promise.all(srcs.map((s) => loadImage(s))).then((loaded) => {
      const imgs = loaded.filter(Boolean);
      const specs = [
        { W: 1280, H: 720, suffix: "youtube-wide", vertical: false },
        { W: 1080, H: 1920, suffix: "shorts-cover", vertical: true },
      ];
      const pngs = [];
      for (const spec of specs) {
        const canvas = document.createElement("canvas");
        canvas.width = spec.W;
        canvas.height = spec.H;
        drawThumb(canvas, story, imgs, spec.vertical);
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
