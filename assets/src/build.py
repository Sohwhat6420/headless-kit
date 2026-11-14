"""Builds the README art in assets/: the hero, the terminal shots and the banner SVGs (light and dark).

Build-time only: needs Python 3 and fontTools (`pip install fonttools`). Nothing here runs with the tools.
    python assets/src/build.py
Then render the banner PNGs with `node assets/src/render-png.mjs` (needs Playwright's bundled Chromium).

Every letter is an outlined path (the technique of tools/svglib.py in Sohwhat6420/Sohwhat6420), so the SVGs load no
fonts and fetch nothing: GitHub serves README images as <img>, which cannot load web fonts. Motion is CSS keyframes
only, no script, and `prefers-reduced-motion` shows a still frame.
Fonts (SIL OFL 1.1, licences in fonts/): Instrument Serif, Instrument Sans, JetBrains Mono.

Every number drawn here is copied from a real run: the terminal shots from the capture files beside this script
(*.txt, recorded in a Linux container on 14 Nov 2026), the stats from docs/measurements/2026-11-14.json and npm test.
"""
import json
import os
import re

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.dirname(HERE)
FONT_DIR = os.path.join(HERE, "fonts")


def f(v, nd=2):
    s = ("%." + str(nd) + "f") % v
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ------------------------------------------------------------------------------------------------
# fonts: outlined glyphs shared through <defs>, with GPOS pair kerning
# ------------------------------------------------------------------------------------------------
class Font:
    def __init__(self, key, filename):
        self.key = key
        self.tt = TTFont(os.path.join(FONT_DIR, filename))
        self.gs = self.tt.getGlyphSet()
        self.cmap = self.tt.getBestCmap()
        self.upm = self.tt["head"].unitsPerEm
        self.hmtx = self.tt["hmtx"]
        self._paths, self._pair, self._class = {}, {}, []
        if "GPOS" in self.tt:
            gpos = self.tt["GPOS"].table
            idx = set()
            for fr in gpos.FeatureList.FeatureRecord:
                if fr.FeatureTag == "kern":
                    idx.update(fr.Feature.LookupListIndex)
            for li in sorted(idx):
                lk = gpos.LookupList.Lookup[li]
                for st in lk.SubTable:
                    if lk.LookupType == 9:
                        st = st.ExtSubTable
                    if getattr(st, "LookupType", 2) != 2:
                        continue
                    cov = st.Coverage.glyphs
                    if st.Format == 1:
                        for g1, ps in zip(cov, st.PairSet):
                            for rec in ps.PairValueRecord:
                                v = getattr(rec.Value1, "XAdvance", 0) if rec.Value1 else 0
                                self._pair.setdefault((g1, rec.SecondGlyph), v or 0)
                    elif st.Format == 2:
                        self._class.append((set(cov), st.ClassDef1.classDefs, st.ClassDef2.classDefs, st.Class1Record))

    def kern(self, a, b):
        if (a, b) in self._pair:
            return self._pair[(a, b)]
        for cov, cd1, cd2, recs in self._class:
            if a in cov:
                v = recs[cd1.get(a, 0)].Class2Record[cd2.get(b, 0)].Value1
                return (getattr(v, "XAdvance", 0) or 0) if v else 0
        return 0

    def glyph(self, ch):
        g = self.cmap.get(ord(ch))
        if g is None:
            raise KeyError("glyph missing for %r in %s" % (ch, self.key))
        return g

    def path(self, g):
        if g not in self._paths:
            pen = SVGPathPen(self.gs, ntos=lambda v: f(v, 0))
            self.gs[g].draw(pen)
            self._paths[g] = pen.getCommands()
        return self._paths[g]

    def layout(self, s, size, tracking=0.0):
        gl = [self.glyph(c) for c in s]
        tr = tracking * self.upm
        xs, cur = [], 0.0
        for i, g in enumerate(gl):
            xs.append(cur)
            cur += self.hmtx[g][0] + tr
            if i + 1 < len(gl):
                cur += self.kern(g, gl[i + 1])
        return list(zip(gl, xs)), ((cur - tr) * size / self.upm if gl else 0)


FILES = {"serif": "InstrumentSerif-Regular.ttf", "sans": "InstrumentSans-Regular.ttf", "sansb": "InstrumentSans-Bold.ttf",
         "mono": "JetBrainsMono-Regular.ttf", "monob": "JetBrainsMono-Bold.ttf"}
FONTS = {}


def font(key):
    if key not in FONTS:
        FONTS[key] = Font(key, FILES[key])
    return FONTS[key]


class Doc:
    def __init__(self, w, h, title, desc):
        self.w, self.h, self.title, self.desc = w, h, title, desc
        self.defs, self.css, self.body, self.glyphs = [], [], [], {}

    def gid(self, fnt, g):
        k = (fnt.key, g)
        if k not in self.glyphs:
            self.glyphs[k] = "%s%d" % (fnt.key[0] + fnt.key[-1], len(self.glyphs))
        return self.glyphs[k]

    def text(self, s, x, y, key, size, fill, tracking=0.0, anchor="start", cls=None, opacity=None):
        """Outlined text with its baseline at y. Returns (svg, width)."""
        fnt = font(key)
        gl, width = fnt.layout(s, size, tracking)
        if anchor == "end":
            x -= width
        elif anchor == "middle":
            x -= width / 2
        sc = size / fnt.upm
        uses = "".join('<use href="#%s" x="%s"/>' % (self.gid(fnt, g), f(gx, 0)) for g, gx in gl if fnt.path(g))
        a = ' fill="%s"' % fill if fill else ""
        if cls:
            a += ' class="%s"' % cls
        if opacity is not None:
            a += ' opacity="%s"' % f(opacity)
        return '<g%s><g transform="translate(%s %s) scale(%s %s)">%s</g></g>' % (a, f(x), f(y), f(sc, 5), f(-sc, 5), uses), width

    def width(self, s, key, size, tracking=0.0):
        return font(key).layout(s, size, tracking)[1]

    def render(self, w=None):
        glyph_defs = "".join('<path id="%s" d="%s"/>' % (gid, font(k).path(g)) for (k, g), gid in self.glyphs.items())
        wa = ' width="%d" height="%d"' % (self.w, self.h)
        return "\n".join([
            '<svg xmlns="http://www.w3.org/2000/svg"%s viewBox="0 0 %d %d" role="img" aria-labelledby="t d">' % (wa, self.w, self.h),
            '<title id="t">%s</title><desc id="d">%s</desc>' % (esc(self.title), esc(self.desc)),
            "<style><![CDATA[\n%s\n]]></style>" % "\n".join(self.css),
            "<defs>%s%s</defs>" % (glyph_defs, "".join(self.defs)),
            "".join(self.body), "</svg>"])


def write(name, doc):
    p = os.path.join(ASSETS, name)
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(doc.render())
    print("%-40s %7d bytes" % (name, os.path.getsize(p)))


# ------------------------------------------------------------------------------------------------
# palettes: GitHub's own neutrals, the profile card's headless-kit accent
# ------------------------------------------------------------------------------------------------
THEMES = {
    "dark": dict(page="#0d1117", card="#161b22", card2="#0d1117", term="#0b0f14", bar="#161b22", line="#30363d",
                 text="#e6edf3", muted="#9198a1", faint="#6e7681", accent="#e8b0d9", accent2="#c297d8",
                 key="#a5d6ff", num="#79c0ff", bool="#ffa657", ok="#3fb950", bad="#ff7b72", glow=0.16, edge="#ffffff", edgeo=0.07),
    "light": dict(page="#ffffff", card="#f6f8fa", card2="#ffffff", term="#ffffff", bar="#f6f8fa", line="#d1d9e0",
                  text="#1f2328", muted="#59636e", faint="#818b98", accent="#8a2a74", accent2="#6639ba",
                  key="#0550ae", num="#0a3069", bool="#953800", ok="#1a7f37", bad="#cf222e", glow=0.10, edge="#1f2328", edgeo=0.06),
}

TOKEN = re.compile(r'("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(-?\b\d+(?:\.\d+)?\b)')


def spans(line, t):
    """Colour runs for one terminal line: [(text, colour)]."""
    if line.startswith("$ "):
        return [("$ ", t["accent"]), (line[2:], t["text"])]
    if not line.lstrip().startswith("{"):
        return [(line, t["muted"])]
    out, pos = [], 0
    for m in TOKEN.finditer(line):
        if m.start() > pos:
            out.append((line[pos:m.start()], t["faint"]))
        colour = t["key"] if m.group(1) else t["text"] if m.group(2) else t["bool"] if m.group(3) else t["num"]
        out.append((m.group(0), colour))
        pos = m.end()
    if pos < len(line):
        out.append((line[pos:], t["faint"]))
    return out


def mono_run(doc, runs, x, y, size, key="mono"):
    """Monospace runs drawn cell by cell (no kerning), so columns line up like a real terminal."""
    fnt = font(key)
    cell = fnt.hmtx[fnt.glyph("0")][0] * size / fnt.upm
    sc = size / fnt.upm
    parts, cx = [], x
    for text, colour in runs:
        uses = []
        for ch in text:
            g = fnt.glyph(ch)
            if fnt.path(g):
                uses.append('<use href="#%s" x="%s"/>' % (doc.gid(fnt, g), f((cx - x) / sc, 0)))
            cx += cell
        if uses:
            parts.append('<g fill="%s">%s</g>' % (colour, "".join(uses)))
    return '<g transform="translate(%s %s) scale(%s %s)">%s</g>' % (f(x), f(y), f(sc, 5), f(-sc, 5), "".join(parts)), cell


def wrap(line, cols):
    return [line[i:i + cols] for i in range(0, max(len(line), 1), cols)]


# ------------------------------------------------------------------------------------------------
# terminal shots: the capture files, verbatim, wrapped at the terminal width like a real terminal
# ------------------------------------------------------------------------------------------------
def terminal(name, capture, title, alt, theme, cols=104):
    t = THEMES[theme]
    lines = open(os.path.join(HERE, capture), encoding="utf-8").read().rstrip("\n").split("\n")
    size, lh, pad, top = 13.5, 21, 22, 40
    cell = font("mono").hmtx[font("mono").glyph("0")][0] * size / font("mono").upm
    rows = []                      # (runs, source line index): colour the whole line, then wrap it
    for i, ln in enumerate(lines):
        runs = spans(ln, t)
        row, n = [], 0
        for text, colour in runs:
            while text:
                take = text[:cols - n]
                row.append((take, colour))
                n += len(take)
                text = text[len(take):]
                if n == cols:
                    rows.append((row, i))
                    row, n = [], 0
        if row or not ln:
            rows.append((row, i))
    W = int(pad * 2 + cols * cell + 0.5)
    H = top + pad + len(rows) * lh + pad - 6
    d = Doc(W, H, title, alt)
    # static on purpose: a real output shot must read the same in any renderer, even one that freezes at time zero
    b = d.body
    b.append('<rect x=".5" y=".5" width="%d" height="%d" rx="12" fill="%s" stroke="%s"/>' % (W - 1, H - 1, t["term"], t["line"]))
    b.append('<path d="M12.5 .5h%sa12 12 0 0 1 12 12v19.5h-%sv-19.5a12 12 0 0 1 12-12z" fill="%s"/>' % (f(W - 25), f(W - 1), t["bar"]))
    b.append('<line x1=".5" y1="32" x2="%s" y2="32" stroke="%s"/>' % (f(W - 0.5), t["line"]))
    for i, c in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        b.append('<circle cx="%d" cy="16" r="5.5" fill="%s"/>' % (22 + i * 18, c))
    svg, _ = d.text(title, W / 2, 21, "sans", 12.5, t["muted"], anchor="middle")
    b.append(svg)
    y = top + pad + 2
    for runs, src in rows:
        g, _ = mono_run(d, runs, pad, y, size)
        b.append(g)
        y += lh
    write(name, d)


# ------------------------------------------------------------------------------------------------
# hero: name, promise, three crossed-out icons, measured stats, and a terminal that rotates through real runs
# ------------------------------------------------------------------------------------------------
STATS = json.load(open(os.path.join(ASSETS, "..", "docs", "measurements", "2026-11-14.json"), encoding="utf-8"))
SCENES = [
    # (label, command, output line(s) shown, verdict chip, chip colour key, caption) -- every value from a capture file
    ("reddit-pull", "node reddit-pull.mjs --sub rust --after 2026-11-12 ...",
     ['{"ok":true,...,"subs":[{"sub":"rust","posts":104,', '"comments":200,"files":[...]}],"failed_requests":0}'],
     "exit 0", "ok", "The agent reads 306 bytes; 232,750 go to disk.",
     "stdout 189 B  ·  stderr 117 B  ·  3 files 232,750 B"),
    ("memory-gate", "node memory-gate.mjs",
     ['{"verdict":"ok","pct":3.4,...,"limitGB":15.71,', '"advice":"headroom: heavy work may start",...}'],
     "exit 0", "ok", "One verdict, one exit code to branch on.",
     "stdout 324 B  ·  median 31.4 ms over 15 runs"),
    ("lane-model-check", "node lane-model-check.mjs ... --expect model-large",
     ['{"ok":false,"verdict":"mismatch","expected":', '"model-large",...,"actual":"model-small-20261001",...}'],
     "exit 1", "bad", "The wrong model is caught from the transcript.",
     "stdout 230 B  ·  exit 1 means mismatch"),
    ("plan-depth", "node plan-depth.mjs < exit-plan-thin.json",
     ['{"systemMessage":"Plan-depth: 8 gaps: How (numbered', 'build steps) for: Data import; ..."}'],
     "warns", "accent", "Lists what a plan is missing. Never approves it.",
     "stdout 855 B  ·  median 35 ms over 15 runs"),
]


def icon(kind, x, y, s, t):
    """A 40x40 icon at (x, y), scale s, with a slash drawn over it (class slash for the draw-in)."""
    st = 'fill="none" stroke="%s" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' % t["muted"]
    if kind == "browser":
        body = ('<circle cx="20" cy="20" r="13" %s/><ellipse cx="20" cy="20" rx="5.5" ry="13" %s/>'
                '<path d="M7 20h26M9 13h22M9 27h22" %s/>' % (st, st, st))
    elif kind == "key":
        body = ('<circle cx="13" cy="20" r="6.5" %s/><path d="M19.5 20h15M29 20v6M34 20v4.5" %s/>' % (st, st))
    else:
        body = ('<rect x="6" y="9" width="28" height="22" rx="3.5" %s/><path d="M6 15h28" %s/>'
                '<path d="M11 21l3.5 2.5L11 26M17 26h6" %s/>' % (st, st, st))
    slash = '<path class="slash" d="M7 33L33 7" fill="none" stroke="%s" stroke-width="2.6" stroke-linecap="round" pathLength="1"/>' % t["accent"]
    return '<g transform="translate(%s %s) scale(%s)">%s%s</g>' % (f(x), f(y), f(s), body, slash)


def hero(theme):
    t = THEMES[theme]
    W, H = 1200, 600
    alt = ("headless-kit: cheap, agent-first tools that need no browser, no API keys and no windows. 20 tools, "
           "0 dependencies, every child process started with windowsHide, under 50 ms a call (median, measured). "
           "A terminal cycles through four real runs: reddit-pull prints one JSON line while 232,750 bytes go to disk; "
           "memory-gate answers ok with exit 0; lane-model-check catches a model mismatch with exit 1; plan-depth "
           "lists the gaps in a plan without approving it.")
    d = Doc(W, H, "headless-kit", alt)
    T, N = 22.0, len(SCENES)
    span = T / N

    def pct(sec):
        return "%s%%" % f(sec / T * 100, 3)

    css = d.css
    css.append(".drift{animation:drift 14s cubic-bezier(.45,0,.55,1) infinite alternate}"
               "@keyframes drift{from{transform:translate(0,0)}to{transform:translate(70px,26px)}}")
    css.append(".drift2{animation:drift2 18s cubic-bezier(.45,0,.55,1) infinite alternate}"
               "@keyframes drift2{from{transform:translate(0,0)}to{transform:translate(-60px,-20px)}}")
    css.append(".slash{stroke-dasharray:1;stroke-dashoffset:1;animation:slash .7s cubic-bezier(.65,0,.35,1) forwards}"
               "@keyframes slash{to{stroke-dashoffset:0}}")
    css.append(".caret{animation:caret 1.05s steps(1) infinite}@keyframes caret{50%{opacity:0}}")
    css.append(".dot{animation:dot %ss linear infinite}" % f(T))

    # card
    d.defs.append('<radialGradient id="g1" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(180 90) scale(520 360)">'
                  '<stop offset="0" stop-color="%s" stop-opacity="%s"/><stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>'
                  % (t["accent"], f(t["glow"]), t["accent"]))
    d.defs.append('<radialGradient id="g2" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1020 520) scale(460 300)">'
                  '<stop offset="0" stop-color="%s" stop-opacity="%s"/><stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>'
                  % (t["accent2"], f(t["glow"] * 0.7), t["accent2"]))
    d.defs.append('<clipPath id="cc"><rect x="1" y="1" width="%d" height="%d" rx="28"/></clipPath>' % (W - 2, H - 2))
    d.defs.append('<clipPath id="tc"><rect x="636" y="96" width="512" height="408" rx="14"/></clipPath>')
    b = d.body
    b.append('<rect x="1" y="1" width="%d" height="%d" rx="28" fill="%s"/>' % (W - 2, H - 2, t["card"]))
    b.append('<g clip-path="url(#cc)"><rect class="drift" x="-200" y="-200" width="1000" height="800" fill="url(#g1)"/>'
             '<rect class="drift2" x="500" y="200" width="900" height="600" fill="url(#g2)"/></g>')
    b.append('<rect x="1.5" y="1.5" width="%d" height="%d" rx="27.5" fill="none" stroke="%s" stroke-opacity="%s"/>' % (W - 3, H - 3, t["edge"], f(t["edgeo"] * 1.6)))

    # left column
    x0 = 64
    s, _ = d.text("NODE 18+  ·  ZERO DEPENDENCIES  ·  MIT", x0, 110, "sansb", 14, t["accent"], tracking=0.16)
    b.append(s)
    s, _ = d.text("headless-kit", x0 - 4, 206, "serif", 104, t["text"], tracking=-0.01)
    b.append(s)
    s, _ = d.text("Cheap, agent-first tools. An agent calls one, reads", x0, 258, "sans", 22, t["muted"])
    b.append(s)
    s, _ = d.text("one JSON line and an exit code, and moves on.", x0, 290, "sans", 22, t["muted"])
    b.append(s)

    # three crossed-out icons
    items = [("browser", "No browser"), ("key", "No API keys"), ("window", "No windows")]
    ix = x0
    for i, (kind, label) in enumerate(items):
        g = icon(kind, ix, 322, 1.0, t)
        g = g.replace('class="slash"', 'class="slash" style="animation-delay:%ss"' % f(0.5 + i * 0.35))
        b.append(g)
        s, w = d.text(label, ix + 48, 348, "sansb", 17, t["text"])
        b.append(s)
        ix += 48 + w + 34

    # measured stats
    lat = max(c["medianMs"] for c in STATS["timed"] if c["id"] != "node-startup")
    assert lat < 50, lat
    cp = STATS["childProcessCalls"]
    stats = [(str(STATS["items"]["total"]), "tools and hooks"), (str(STATS["dependencies"]["total"]), "dependencies"),
             ("%d/%d" % (cp["withWindowsHide"], cp["total"]), "spawns hide windows"), ("<50 ms", "a call, median")]
    b.append('<line x1="%d" y1="400" x2="%d" y2="400" stroke="%s"/>' % (x0, 580, t["line"]))
    sx = x0
    for val, lab in stats:
        s, w = d.text(val, sx, 462, "serif", 44, t["text"])
        b.append(s)
        s, w2 = d.text(lab, sx, 490, "sans", 14.5, t["muted"])
        b.append(s)
        sx += max(w, w2) + 26
    s, _ = d.text("Measured 14 Nov 2026 with scripts/measure.mjs: Linux, Node 22, 15 runs per tool.", x0, 540, "sans", 13, t["faint"])
    b.append(s)

    # terminal
    tx, ty, tw, th = 636, 96, 512, 408
    b.append('<rect x="%d" y="%d" width="%d" height="%d" rx="14" fill="%s" stroke="%s"/>' % (tx, ty, tw, th, t["term"], t["line"]))
    b.append('<g clip-path="url(#tc)"><rect x="%d" y="%d" width="%d" height="34" fill="%s"/>'
             '<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s"/></g>' % (tx, ty, tw, t["bar"], tx, ty + 34, tx + tw, ty + 34, t["line"]))
    for i, c in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        b.append('<circle cx="%d" cy="%d" r="5.5" fill="%s"/>' % (tx + 20 + i * 18, ty + 17, c))
    # scene tabs in the title bar, with a progress underline per scene
    tab_x = tx + 92
    tabs = []
    for i, sc in enumerate(SCENES):
        w = d.width(sc[0], "mono", 11.5)
        tabs.append((tab_x, w))
        tab_x += w + 16
    msize, mlh = 13, 21
    still = []
    for i, (label, cmd, outs, chip, ck, cap, meta) in enumerate(SCENES):
        s0 = i * span
        tab_xi, tab_w = tabs[i]
        on = "tab%d" % i
        css.append(".%s{animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:.45}%s,%s{opacity:1}%s,100%%{opacity:.45}}"
                   % (on, on, f(T), on, pct(max(s0 - 0.001, 0)) if i else "0%", pct(s0 + 0.01) if i else "0.01%", pct(s0 + span - 0.3), pct(s0 + span - 0.01)))
        if i == 0:
            css[-1] = ".%s{animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:1}%s,100%%{opacity:.45}}" % (on, on, f(T), on, pct(span - 0.3), pct(span - 0.01))
        lab_svg, _ = d.text(label, tab_xi, ty + 21, "mono", 11.5, t["muted"])
        b.append('<g class="%s">%s</g>' % (on, lab_svg))
        ul = "ul%d" % i
        css.append(".%s{transform-box:fill-box;transform-origin:0 0;animation:%s %ss linear infinite}"
                   "@keyframes %s{0%%,%s{transform:scaleX(0);opacity:1}%s{transform:scaleX(1);opacity:1}%s,100%%{transform:scaleX(1);opacity:0}}"
                   % (ul, ul, f(T), ul, pct(s0), pct(s0 + span - 0.05), pct(s0 + span)))
        b.append('<rect class="%s" x="%s" y="%d" width="%s" height="2" rx="1" fill="%s"/>' % (ul, f(tab_xi), ty + 30, f(tab_w), t["accent"]))

        # the scene itself
        cx, cy = tx + 24, ty + 76
        parts = []
        g, cell = mono_run(d, [("$ ", t["accent"]), (cmd, t["text"])], cx, cy, msize)
        type_dur = min(1.4, 0.035 * len(cmd))
        cover = "cv%d" % i
        cmd_w = (len(cmd) + 2) * cell
        css.append(".%s{animation:%s %ss steps(1) infinite}" % (cover, cover, f(T)))
        # typing: a cover in the terminal colour slides right one character at a time
        kf = ["0%%{transform:translateX(0)}"]
        steps_n = len(cmd) + 2
        for k in range(steps_n + 1):
            kf.append("%s{transform:translateX(%spx)}" % (pct(s0 + 0.35 + type_dur * k / steps_n), f(cmd_w * k / steps_n)))
        kf.append("%s{transform:translateX(%spx)}" % (pct(s0 + span), f(cmd_w)))
        css.append("@keyframes %s{%s}" % (cover, "".join(kf)))
        parts.append(g)
        parts.append('<rect class="%s" x="%s" y="%s" width="%s" height="%d" fill="%s"/>' % (cover, f(cx - 1), f(cy - 16), f(cmd_w + 4), 22, t["term"]))
        oy = cy + 34
        out_svgs = []
        for ln in outs:
            g, _ = mono_run(d, spans(ln, t), cx, oy, msize - 0.5)
            out_svgs.append(g)
            oy += mlh
        oc = "out%d" % i
        t_out = s0 + 0.35 + type_dur + 0.35
        css.append(".%s{animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:0;transform:translateY(6px)}%s,100%%{opacity:1;transform:none}}"
                   % (oc, oc, f(T), oc, pct(t_out), pct(t_out + 0.35)))
        parts.append('<g class="%s">%s</g>' % (oc, "".join(out_svgs)))
        # verdict chip + caption
        chip_c = t[ck]
        cyy = oy + 26
        s, cw = d.text(chip, cx + 14, cyy + 18, "monob", 13, chip_c)
        chip_svg = ('<rect x="%s" y="%s" width="%s" height="28" rx="14" fill="%s" fill-opacity=".12" stroke="%s" stroke-opacity=".55"/>%s'
                    % (f(cx), f(cyy), f(cw + 28), chip_c, chip_c, s))
        s2, _ = d.text(cap, cx + cw + 44, cyy + 19, "sans", 15, t["text"])
        ch = "ch%d" % i
        t_chip = t_out + 0.5
        css.append(".%s{transform-box:fill-box;transform-origin:left center;animation:%s %ss linear infinite}"
                   "@keyframes %s{0%%,%s{opacity:0;transform:scale(.92)}%s,100%%{opacity:1;transform:none}}"
                   % (ch, ch, f(T), ch, pct(t_chip), pct(t_chip + 0.3)))
        parts.append('<g class="%s">%s%s</g>' % (ch, chip_svg, s2))
        # caret after the output while the scene holds
        car_y = cyy + 62
        g, _ = mono_run(d, [("$ ", t["accent"])], cx, car_y, msize)
        parts.append('<g class="%s">%s<rect class="caret" x="%s" y="%s" width="8" height="16" fill="%s"/></g>'
                     % (ch, g, f(cx + 2 * cell + 1), f(car_y - 13), t["muted"]))
        mx = tx + 24
        b_meta = '<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s"/>' % (f(mx), f(ty + th - 92), f(tx + tw - 24), f(ty + th - 92), t["line"])
        g, _ = mono_run(d, [(meta, t["muted"])], mx, ty + th - 62, 12)
        parts.append('<g class="%s">%s%s</g>' % (ch, b_meta, g))
        # scene visibility
        sc_c = "sc%d" % i
        a_in, a_out = s0, s0 + span - 0.35
        if i == 0:
            css.append(".%s{animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:1}%s,100%%{opacity:0}}" % (sc_c, sc_c, f(T), sc_c, pct(a_out), pct(s0 + span)))
        else:
            css.append(".%s{animation:%s %ss linear infinite;opacity:0}@keyframes %s{0%%,%s{opacity:0}%s,%s{opacity:1}%s,100%%{opacity:0}}"
                       % (sc_c, sc_c, f(T), sc_c, pct(a_in - 0.001), pct(a_in), pct(a_out), pct(s0 + span)))
        b.append('<g clip-path="url(#tc)"><g class="motion %s">%s</g></g>' % (sc_c, "".join(parts)))
        if i == 0:
            still = [p for p in parts]
    # a still frame of the first scene, for reduced motion
    still_svg = "".join(still)
    b.append('<g class="still">%s</g>' % re.sub(r' class="(cv0|out0|ch0|caret)"', "", re.sub(r'<rect class="cv0"[^>]*/>', "", still_svg)))
    # footer line in the terminal
    s, _ = d.text("Real runs in a Linux container, 14 Nov 2026. Lines shortened where you see ...", tx + 24, ty + th - 22, "sans", 12, t["faint"])
    b.append(s)
    css.append("@media (prefers-reduced-motion: reduce){*{animation:none!important}.motion{display:none}.still{display:inline!important}"
               ".slash{stroke-dashoffset:0}}")
    css.append(".still{display:none}")
    # start the cycle 3.2 s in, so the very first frame (and any renderer that freezes at time zero) shows a whole scene
    d.css = [c.replace("%ss linear infinite" % f(T), "%ss linear -3.2s infinite" % f(T))
              .replace("%ss steps(1) infinite" % f(T), "%ss steps(1) -3.2s infinite" % f(T)) for c in css]
    write("hero-%s.svg" % theme, d)


# ------------------------------------------------------------------------------------------------
# banner: one claim and the bar behind it, in the human-llm-council chart's manner (GitHub palette, claim as title)
# ------------------------------------------------------------------------------------------------
def banner(theme, W, H, name):
    t = THEMES[theme]
    alt = ("headless-kit. Your agent reads 306 bytes; the 232,750 bytes of data stay on disk. reddit-pull, one live "
           "run, 14 Nov 2026. No browser, no API keys, no windows. 20 tools, 0 dependencies.")
    d = Doc(W, H, "headless-kit", alt)
    k = W / 1280.0
    m = 72 * k
    b = d.body
    d.defs.append('<radialGradient id="g1" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(%s %s) scale(%s %s)">'
                  '<stop offset="0" stop-color="%s" stop-opacity="%s"/><stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>'
                  % (f(W * 0.12), f(H * 0.05), f(W * 0.55), f(H * 0.7), t["accent"], f(t["glow"]), t["accent"]))
    b.append('<rect width="%d" height="%d" fill="%s"/>' % (W, H, t["page"]))
    b.append('<rect width="%d" height="%d" fill="url(#g1)"/>' % (W, H))
    s, _ = d.text("NODE 18+  ·  ZERO DEPENDENCIES  ·  MIT", m, 92 * k, "sansb", 15 * k, t["accent"], tracking=0.16)
    b.append(s)
    s, _ = d.text("headless-kit", m - 4 * k, 182 * k, "serif", 100 * k, t["text"], tracking=-0.01)
    b.append(s)
    s, _ = d.text("Your agent reads 306 bytes. The data stays on disk.", m, 246 * k, "sansb", 34 * k, t["text"])
    b.append(s)
    s, _ = d.text("Cheap, agent-first tools: no browser, no API keys, no windows.", m, 284 * k, "sans", 22 * k, t["muted"])
    b.append(s)
    # the promise, as three crossed-out icons on the right
    ix = W - m - 3 * 112 * k + 24 * k
    for i, (kind, label) in enumerate((("browser", "browser"), ("key", "API keys"), ("window", "windows"))):
        b.append(icon(kind, ix + i * 112 * k, 112 * k, 1.9 * k, t).replace('class="slash" ', ''))
        s, _ = d.text(label, ix + i * 112 * k + 38 * k, 112 * k + 106 * k, "sansb", 16 * k, t["muted"], anchor="middle")
        b.append(s)
    # the two bars, to scale
    total = 232750
    seen = 306
    bx, bw = m + 210 * k, W - 2 * m - 210 * k - 150 * k
    rows = [("Agent reads", seen, t["accent"], "306 B"), ("Written to disk", total, t["num"], "232,750 B")]
    y = 352 * k
    for lab, v, col, val in rows:
        s, _ = d.text(lab, m, y + 22 * k, "sans", 19 * k, t["text"])
        b.append(s)
        w = max(bw * v / total, 3 * k)
        b.append('<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s"/>' % (f(bx), f(y), f(w), f(30 * k), f(4 * k), col))
        s, _ = d.text(val, bx + w + 14 * k, y + 22 * k, "monob", 18 * k, t["text"])
        b.append(s)
        y += 56 * k
    s, _ = d.text("reddit-pull, one live run (r/rust, 104 posts and 200 comments): the whole terminal output vs the three files it wrote.",
                  m, y + 8 * k, "sans", 15 * k, t["faint"])
    b.append(s)
    # stat strip
    b.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s"/>' % (f(m), f(H - 104 * k), f(W - m), f(H - 104 * k), t["line"]))
    sx = m
    for val, lab in (("20", "tools and hooks"), ("0", "dependencies"), ("26/26", "spawns hide windows"), ("352", "offline tests")):
        s, w = d.text(val, sx, H - 52 * k, "serif", 40 * k, t["text"])
        b.append(s)
        s, w2 = d.text(lab, sx + w + 10 * k, H - 58 * k, "sans", 16 * k, t["muted"])
        b.append(s)
        sx += w + w2 + 44 * k
    s, _ = d.text("github.com/Sohwhat6420/headless-kit", W - m, H - 58 * k, "mono", 15 * k, t["muted"], anchor="end")
    b.append(s)
    write(name, d)


if __name__ == "__main__":
    for th in ("light", "dark"):
        hero(th)
        terminal("shot-reddit-pull-%s.svg" % th, "reddit-pull.txt", "reddit-pull · live run · 14 Nov 2026",
                 "Terminal, a real run on 14 Nov 2026: reddit-pull pulls r/rust from 12 November, prints three progress lines "
                 "and one JSON line (104 posts, 200 comments, 0 failed requests), exits 0, and the three files it wrote "
                 "total 232,750 bytes.", th)
        terminal("shot-exit-codes-%s.svg" % th, "exit-codes.txt", "memory-gate and lane-model-check · 14 Nov 2026",
                 "Terminal, real runs on 14 Nov 2026: memory-gate reads this machine at 3.4 percent and says ok with exit 0; "
                 "lane-model-check finds the example transcript ran model-small-20261001 where model-large was expected "
                 "and exits 1.", th)
        terminal("shot-measure-%s.svg" % th, "measure.txt", "scripts/measure.mjs · 14 Nov 2026",
                 "Terminal, a real run on 14 Nov 2026: scripts/measure.mjs counts 14 tools and 6 hooks, 0 dependencies "
                 "across 21 package.json files, 26 of 26 child-process calls with windowsHide, and times six cases over "
                 "15 runs each: Node alone 24.5 ms median, the tools 33.5 to 47.7 ms.", th, cols=96)
    banner("dark", 1280, 640, "banner-1280x640.svg")
    banner("dark", 1200, 627, "banner-linkedin-1200x627.svg")
