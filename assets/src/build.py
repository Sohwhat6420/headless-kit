"""Builds the README art in assets/ (light and dark, desktop and phone width) and the generated parts of README.md.

    header-*.svg       the strip that stands in for the README's H1: the name and the measured pair
    chart-*.svg        the chart at the top of the README: one job read four ways, a square for every 72 tokens
    explainer-*.svg    one question answered two ways, the browser's page poured in a square at a time
    shot-*.svg         three real terminal runs with plain-word notes beside them
    cards/*.svg        one card per tool
    hero-*, banner-*   the round-1 hero and the social banner (kept for the profile README)
    README.md          the kit table, the cards and every figure's <picture> block, between marker comments

Build-time only: needs Python 3 and fontTools (`pip install fonttools`). Nothing here runs with the tools.
    python assets/src/build.py
Then render the banner PNGs with `node assets/src/render-png.mjs` (needs Playwright's bundled Chromium).
To record the terminal runs again, run `bash assets/src/capture.sh` from the repo root first (it needs the network).

Every letter is an outlined path (the technique of tools/svglib.py in Sohwhat6420/Sohwhat6420), so the SVGs load no
fonts and fetch nothing: GitHub serves README images as <img>, which cannot load web fonts. Motion is CSS keyframes
only, no script, and `prefers-reduced-motion` shows a still frame.
Fonts (SIL OFL 1.1, licences in fonts/): Instrument Serif, Instrument Sans, JetBrains Mono.

Every number drawn here is copied from a real run, and the build stops if two sources disagree. The header, the
chart and the explainer read docs/measurements/2026-11-14-browser-vs-kit.json (scripts/compare-browser.mjs, Windows
11); the cost figures multiply those token counts by the list price in docs/measurements/2026-11-14-price.json. The three
shots read shot-*.txt beside this script (capture.sh, Windows 11, 14 Nov 2026). The round-1 hero reads the other
*.txt files (a Linux container, 14 Nov 2026), docs/measurements/2026-11-14.json and npm test.
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


ALTS = {}   # file name -> its description, so the README's alt text is the SVG's own


def write(name, doc):
    ALTS[name] = doc.desc
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
                 key="#a5d6ff", num="#79c0ff", bool="#ffa657", ok="#3fb950", bad="#ff7b72", glow=0.22, edge="#ffffff", edgeo=0.07),
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
# hero: name, promise, three crossed-out icons, measured stats, and a terminal that rotates through real runs
# ------------------------------------------------------------------------------------------------
STATS = json.load(open(os.path.join(ASSETS, "..", "docs", "measurements", "2026-11-14.json"), encoding="utf-8"))
SCENES = [
    # (label, command, output line(s) shown, verdict chip, chip colour key, caption) -- every value from a capture file
    ("reddit-pull", "node reddit-pull.mjs --sub rust ... --out ./out",
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
    """A 40x40 icon at (x, y), scale s, crossed out with an accent slash."""
    st = 'fill="none" stroke="%s" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' % t["muted"]
    if kind == "browser":
        body = ('<circle cx="20" cy="20" r="13" %s/><ellipse cx="20" cy="20" rx="5.5" ry="13" %s/>'
                '<path d="M7 20h26M9 13h22M9 27h22" %s/>' % (st, st, st))
    elif kind == "key":
        body = ('<circle cx="13" cy="20" r="6.5" %s/><path d="M19.5 20h15M29 20v6M34 20v4.5" %s/>' % (st, st))
    else:
        body = ('<rect x="6" y="9" width="28" height="22" rx="3.5" %s/><path d="M6 15h28" %s/>'
                '<path d="M11 21l3.5 2.5L11 26M17 26h6" %s/>' % (st, st, st))
    slash = '<path d="M7 33L33 7" fill="none" stroke="%s" stroke-width="2.6" stroke-linecap="round" pathLength="1"/>' % t["accent"]
    return '<g transform="translate(%s %s) scale(%s)">%s%s</g>' % (f(x), f(y), f(s), body, slash)


HERO_ALT = ("headless-kit: cheap, agent-first tools that need no browser, no API keys and no windows. 20 tools and "
            "hooks, 0 dependencies, all 26 child-process calls hidden, under 50 ms a call (median, measured). A terminal "
            "cycles through four real runs: reddit-pull prints one JSON line while 232,750 bytes go to disk; memory-gate "
            "answers ok with exit 0; lane-model-check catches a model mismatch with exit 1; plan-depth lists the gaps in a "
            "plan without approving it.")


def hero_stats():
    lat = max(c["medianMs"] for c in STATS["timed"] if c["id"] != "node-startup")
    assert lat < 50, lat
    cp = STATS["childProcessCalls"]
    assert cp["withWindowsHide"] == cp["total"]
    return [(str(STATS["items"]["total"]), "tools and hooks"), (str(STATS["dependencies"]["total"]), "dependencies"),
            ("%d/%d" % (cp["withWindowsHide"], cp["total"]), "processes hidden"), ("<50 ms", "a call, median")]


def card(d, t, W, H, rx):
    d.defs.append('<radialGradient id="g1" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(%s %s) scale(%s %s)">'
                  '<stop offset="0" stop-color="%s" stop-opacity="%s"/><stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>'
                  % (f(W * 0.15), f(H * 0.15), f(W * 0.45), f(H * 0.62), t["accent"], f(t["glow"]), t["accent"]))
    d.defs.append('<radialGradient id="g2" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(%s %s) scale(%s %s)">'
                  '<stop offset="0" stop-color="%s" stop-opacity="%s"/><stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>'
                  % (f(W * 0.85), f(H * 0.85), f(W * 0.4), f(H * 0.5), t["accent2"], f(t["glow"] * 0.7), t["accent2"]))
    d.defs.append('<clipPath id="cc"><rect x="1" y="1" width="%d" height="%d" rx="%d"/></clipPath>' % (W - 2, H - 2, rx))
    d.css.append(".drift{animation:drift 14s cubic-bezier(.45,0,.55,1) infinite alternate}"
                 "@keyframes drift{from{transform:translate(0,0)}to{transform:translate(70px,26px)}}"
                 ".drift2{animation:drift2 18s cubic-bezier(.45,0,.55,1) infinite alternate}"
                 "@keyframes drift2{from{transform:translate(0,0)}to{transform:translate(-60px,-20px)}}")
    b = d.body
    b.append('<rect x="1" y="1" width="%d" height="%d" rx="%d" fill="%s"/>' % (W - 2, H - 2, rx, t["card"]))
    b.append('<g clip-path="url(#cc)"><rect class="drift" x="%d" y="%d" width="%d" height="%d" fill="url(#g1)"/>'
             '<rect class="drift2" x="%d" y="%d" width="%d" height="%d" fill="url(#g2)"/></g>'
             % (-200, -200, W, H + 200, W // 3, H // 3, W, H))
    b.append('<rect x="1.5" y="1.5" width="%d" height="%d" rx="%s" fill="none" stroke="%s" stroke-opacity="%s"/>'
             % (W - 3, H - 3, f(rx - 0.5), t["edge"], f(t["edgeo"] * 1.6)))


def hero(theme):
    t = THEMES[theme]
    W, H = 1200, 576
    d = Doc(W, H, "headless-kit", HERO_ALT)
    T, N = 28.0, len(SCENES)
    span = T / N
    FADE = 0.5

    def pct(sec):
        return "%s%%" % f(sec / T * 100, 3)

    css = d.css
    css.append(".blink{animation:blink 1.05s steps(1) infinite}@keyframes blink{50%{opacity:0}}")
    card(d, t, W, H, 28)
    b = d.body

    # left column, 84 to 486
    x0 = 64
    s, _ = d.text("NODE 18+  ·  ZERO DEPENDENCIES  ·  MIT", x0, 104, "sansb", 14, t["accent"], tracking=0.16)
    b.append(s)
    s, _ = d.text("headless-kit", x0 - 4, 196, "serif", 104, t["text"], tracking=-0.01)
    b.append(s)
    s, _ = d.text("Cheap, agent-first tools. Your agent reads", x0, 244, "sans", 22, t["muted"])
    b.append(s)
    s, _ = d.text("one short line; the data stays on disk.", x0, 274, "sans", 22, t["muted"])
    b.append(s)
    ix = x0
    for kind, label in (("browser", "No browser"), ("key", "No API keys"), ("window", "No windows")):
        b.append(icon(kind, ix, 300, 1.0, t))
        s, w = d.text(label, ix + 48, 326, "sansb", 17, t["text"])
        b.append(s)
        ix += 48 + w + 34
    b.append('<line x1="%d" y1="372" x2="580" y2="372" stroke="%s"/>' % (x0, t["line"]))
    sx = x0
    for val, lab in hero_stats():
        s, w = d.text(val, sx, 426, "serif", 40, t["text"])
        b.append(s)
        s, w2 = d.text(lab, sx, 452, "sans", 14.5, t["muted"])
        b.append(s)
        sx += max(w, w2) + 22
    assert sx - 22 <= 580, sx
    s, _ = d.text("Measured 14 Nov 2026 with scripts/measure.mjs: Linux, Node 22, 15 runs per tool.", x0, 486, "sans", 13, t["muted"])
    b.append(s)

    # terminal, vertically centred on the left column
    tx, tw, th = 612, 524, 352
    ty = 285 - th // 2
    d.defs.append('<clipPath id="tc"><rect x="%d" y="%d" width="%d" height="%d" rx="14"/></clipPath>' % (tx, ty, tw, th))
    b.append('<rect x="%d" y="%d" width="%d" height="%d" rx="14" fill="%s" stroke="%s"/>' % (tx, ty, tw, th, t["term"], t["line"]))
    b.append('<g clip-path="url(#tc)"><rect x="%d" y="%d" width="%d" height="36" fill="%s"/>'
             '<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s"/></g>' % (tx, ty, tw, t["bar"], tx, ty + 36, tx + tw, ty + 36, t["line"]))
    for i, c in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        b.append('<circle cx="%d" cy="%d" r="5.5" fill="%s"/>' % (tx + 20 + i * 18, ty + 18, c))
    tab_x, tabs = tx + 88, []
    for sc in SCENES:
        w = d.width(sc[0], "mono", 12.5)
        tabs.append((tab_x, w))
        tab_x += w + 16
    assert tab_x - 16 <= tx + tw - 12, tab_x
    # the meta rule and the footer stay put; only the meta text changes with the scene
    rule_y = ty + th - 64
    b.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s"/>' % (tx + 24, rule_y, tx + tw - 24, rule_y, t["line"]))
    s, _ = d.text("Real runs, Linux container, 14 Nov 2026.  ...  marks a shortened line.", tx + 24, ty + th - 16, "sans", 12, t["muted"])
    b.append(s)

    msize, mlh = 14.5, 23
    still = []
    for i, (label, cmd, outs, chip, ck, cap, meta) in enumerate(SCENES):
        s0 = i * span
        tab_xi, tab_w = tabs[i]
        on = "tab%d" % i
        if i == 0:
            css.append(".%s{opacity:.62;animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:1}%s,100%%{opacity:.62}}"
                       % (on, on, f(T), on, pct(span - FADE), pct(span - 0.01)))
        else:
            css.append(".%s{opacity:.62;animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:.62}%s,%s{opacity:1}%s,100%%{opacity:.62}}"
                       % (on, on, f(T), on, pct(s0 - 0.01), pct(s0), pct(s0 + span - FADE), pct(s0 + span - 0.01)))
        lab_svg, _ = d.text(label, tab_xi, ty + 23, "mono", 12.5, t["muted"])
        b.append('<g class="%s">%s</g>' % (on, lab_svg))
        ul = "ul%d" % i
        css.append(".%s{transform-box:fill-box;transform-origin:0 0;animation:%s %ss linear infinite}"
                   "@keyframes %s{0%%,%s{transform:scaleX(0);opacity:1}%s{transform:scaleX(1);opacity:1}%s,100%%{transform:scaleX(1);opacity:0}}"
                   % (ul, ul, f(T), ul, pct(s0), pct(s0 + span - 0.05), pct(s0 + span)))
        b.append('<rect class="%s" x="%s" y="%d" width="%s" height="2" rx="1" fill="%s"/>' % (ul, f(tab_xi), ty + 33, f(tab_w), t["accent"]))

        cx, cy = tx + 24, ty + 78
        parts = []
        g, cell = mono_run(d, [("$ ", t["accent"]), (cmd, t["text"])], cx, cy, msize)
        parts.append(g)
        type_dur = min(1.6, 0.04 * len(cmd))
        steps_n = len(cmd)
        cmd_w = steps_n * cell
        t0 = s0 + 0.4
        cover = "cv%d" % i
        kf = ["0%{transform:translateX(0)}"]
        for k in range(steps_n + 1):
            kf.append("%s{transform:translateX(%spx)}" % (pct(t0 + type_dur * k / steps_n), f(cmd_w * k / steps_n)))
        css.append(".%s{animation:%s %ss steps(1) infinite}@keyframes %s{%s}" % (cover, cover, f(T), cover, "".join(kf)))
        # the cover hides the command; a caret rides its left edge while it types, then hides
        cr = "cr%d" % i
        css.append(".%s{animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:1}%s,100%%{opacity:0}}"
                   % (cr, cr, f(T), cr, pct(t0 + type_dur + 0.25), pct(t0 + type_dur + 0.26)))
        x_cmd = cx + 2 * cell
        parts.append('<g class="%s"><rect x="%s" y="%s" width="%s" height="24" fill="%s"/>'
                     '<rect class="%s" x="%s" y="%s" width="8.5" height="17" fill="%s"/></g>'
                     % (cover, f(x_cmd), f(cy - 17), f(cmd_w + 6), t["term"], cr, f(x_cmd + 0.5), f(cy - 13.5), t["muted"]))
        oy = cy + 36
        out_svgs = []
        for ln in outs:
            g, _ = mono_run(d, spans(ln, t), cx, oy, msize - 0.5)
            out_svgs.append(g)
            oy += mlh
        oc = "out%d" % i
        t_out = t0 + type_dur + 0.35
        css.append(".%s{animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:0;transform:translateY(6px)}%s,100%%{opacity:1;transform:none}}"
                   % (oc, oc, f(T), oc, pct(t_out), pct(t_out + 0.35)))
        parts.append('<g class="%s">%s</g>' % (oc, "".join(out_svgs)))
        chip_c = t[ck]
        cyy = oy + 18
        s, cw = d.text(chip, cx + 14, cyy + 19, "monob", 13.5, chip_c)
        chip_svg = ('<rect x="%s" y="%s" width="%s" height="30" rx="15" fill="%s" fill-opacity=".12" stroke="%s" stroke-opacity=".55"/>%s'
                    % (f(cx), f(cyy), f(cw + 28), chip_c, chip_c, s))
        s2, cap_w = d.text(cap, cx + cw + 44, cyy + 20, "sans", 15.5, t["text"])
        assert cx + cw + 44 + cap_w <= tx + tw - 16, (cap, cx + cw + 44 + cap_w)
        ch = "ch%d" % i
        t_chip = t_out + 0.5
        css.append(".%s{animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:0;transform:translateY(4px)}%s,100%%{opacity:1;transform:none}}"
                   % (ch, ch, f(T), ch, pct(t_chip), pct(t_chip + 0.3)))
        car_y = cyy + 64
        g, _ = mono_run(d, [("$ ", t["accent"])], cx, car_y, msize)
        parts.append('<g class="%s">%s%s%s<rect class="blink" x="%s" y="%s" width="8.5" height="17" fill="%s"/></g>'
                     % (ch, chip_svg, s2, g, f(cx + 2 * cell + 1), f(car_y - 13.5), t["muted"]))
        g, _ = mono_run(d, [(meta, t["muted"])], cx, rule_y + 26, 12.5)
        parts.append('<g class="%s">%s</g>' % (ch, g))
        sc_c = "sc%d" % i
        if i == 0:
            css.append(".%s{animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:1}%s,100%%{opacity:0}}"
                       % (sc_c, sc_c, f(T), sc_c, pct(s0 + span - FADE), pct(s0 + span)))
        else:
            css.append(".%s{opacity:0;animation:%s %ss linear infinite}@keyframes %s{0%%,%s{opacity:0}%s,%s{opacity:1}%s,100%%{opacity:0}}"
                       % (sc_c, sc_c, f(T), sc_c, pct(s0 - 0.001), pct(s0), pct(s0 + span - FADE), pct(s0 + span)))
        b.append('<g clip-path="url(#tc)"><g class="motion %s">%s</g></g>' % (sc_c, "".join(parts)))
        if i == 0:
            still = parts
    still_svg = "".join(still)
    still_svg = re.sub(r'<g class="cv0">.*?</g>', "", still_svg, count=1)
    still_svg = re.sub(r' class="(out0|ch0|blink)"', "", still_svg)
    b.append('<g class="still">%s</g>' % still_svg)
    css.append(".still{display:none}")
    css.append("@media (prefers-reduced-motion: reduce){*{animation:none!important}.motion{display:none}.still{display:inline!important}}")
    # start 3.6 s in, so the first frame (and any renderer that freezes at time zero) shows a whole scene
    d.css = [c.replace("%ss linear infinite" % f(T), "%ss linear -3.6s infinite" % f(T))
              .replace("%ss steps(1) infinite" % f(T), "%ss steps(1) -3.6s infinite" % f(T)) for c in css]
    write("hero-%s.svg" % theme, d)


def hero_mobile(theme):
    """A portrait hero for phones (picked by <picture> under 768 px): no terminal, sizes that read at about 0.5x."""
    t = THEMES[theme]
    W, H = 720, 830
    d = Doc(W, H, "headless-kit", HERO_ALT.split(" A terminal")[0])
    card(d, t, W, H, 36)
    b = d.body
    x0 = 56
    s, _ = d.text("NODE 18+  ·  ZERO DEPS  ·  MIT", x0, 112, "sansb", 22, t["accent"], tracking=0.14)
    b.append(s)
    s, w = d.text("headless-kit", x0 - 6, 232, "serif", 124, t["text"], tracking=-0.01)
    assert w < W - 2 * x0 + 12, w
    b.append(s)
    for k, line in enumerate(("Cheap, agent-first tools. Your", "agent reads one short line;", "the data stays on disk.")):
        s, w = d.text(line, x0, 298 + k * 44, "sans", 34, t["muted"])
        assert w <= W - 2 * x0, (line, w)
        b.append(s)
    for k, (kind, label) in enumerate((("browser", "No browser"), ("key", "No API keys"), ("window", "No windows"))):
        cx = x0 + k * 206
        b.append(icon(kind, cx, 432, 1.6, t))
        s, _ = d.text(label, cx, 530, "sansb", 26, t["text"])
        b.append(s)
    b.append('<line x1="%d" y1="566" x2="%d" y2="566" stroke="%s"/>' % (x0, W - x0, t["line"]))
    for k, (val, lab) in enumerate(hero_stats()):
        cx, cy = x0 + (k % 2) * 312, 630 + (k // 2) * 124
        s, w = d.text(val, cx, cy, "serif", 60, t["text"])
        b.append(s)
        s, w2 = d.text(lab, cx, cy + 36, "sans", 25, t["muted"])
        assert max(w, w2) < 300, lab
        b.append(s)
    write("hero-m-%s.svg" % theme, d)


# ------------------------------------------------------------------------------------------------
# banner: one claim and the bar behind it, in the human-llm-council chart's manner (GitHub palette, claim as title)
# ------------------------------------------------------------------------------------------------
def banner(theme, W, H, name):
    t = THEMES[theme]
    alt = ("headless-kit. Your agent reads 306 bytes; the data stays on disk: 232,750 bytes in three files, from one live "
           "reddit-pull run on 14 Nov 2026. No browser, no API keys, no windows. 20 tools and hooks, 0 dependencies, "
           "352 offline tests.")
    d = Doc(W, H, "headless-kit", alt)
    k = W / 1280.0
    m = 76 * k
    b = d.body
    d.defs.append('<radialGradient id="g1" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(%s %s) scale(%s %s)">'
                  '<stop offset="0" stop-color="%s" stop-opacity="%s"/><stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>'
                  % (f(W * 0.12), f(H * 0.05), f(W * 0.6), f(H * 0.75), t["accent"], f(t["glow"]), t["accent"]))
    b.append('<rect width="%d" height="%d" fill="%s"/>' % (W, H, t["page"]))
    b.append('<rect width="%d" height="%d" fill="url(#g1)"/>' % (W, H))
    s, _ = d.text("headless-kit", m - 5 * k, 160 * k, "serif", 112 * k, t["text"], tracking=-0.01)
    b.append(s)
    # the promise, as three crossed-out icons on the right
    for i, (kind, label) in enumerate((("browser", "no browser"), ("key", "no API keys"), ("window", "no windows"))):
        cx = W - m - (2 - i) * 132 * k - 52 * k
        b.append(icon(kind, cx - 38 * k, 68 * k, 1.9 * k, t))
        s, _ = d.text(label, cx, 182 * k, "sansb", 20 * k, t["muted"], anchor="middle")
        b.append(s)
    s, _ = d.text("Your agent reads 306 bytes.", m, 262 * k, "sansb", 46 * k, t["text"])
    b.append(s)
    s, _ = d.text("The data stays on disk.", m, 318 * k, "sansb", 46 * k, t["muted"])
    b.append(s)
    # the two bars, to scale
    total, seen = 232750, 306
    bx = m + 214 * k
    bw = W - m - bx - 150 * k
    y = 374 * k
    for lab, v, col, val, op, vcol, vsize in (("Agent reads", seen, t["accent"], "306 B", 1, t["accent"], 30),
                                               ("Written to disk", total, t["num"], "232,750 B", 0.35, t["muted"], 22)):
        s, _ = d.text(lab, m, y + 24 * k, "sans", 22 * k, t["text"])
        b.append(s)
        w = max(bw * v / total, 4 * k)
        b.append('<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s" fill-opacity="%s"/>'
                 % (f(bx), f(y), f(w), f(32 * k), f(4 * k), col, f(op)))
        s, _ = d.text(val, bx + w + 16 * k, y + 25 * k, "monob", vsize * k, vcol)
        b.append(s)
        y += 60 * k
    s, _ = d.text("One live reddit-pull run, 14 Nov 2026: 104 posts and 200 comments.", m, y + 10 * k, "sans", 18 * k, t["muted"])
    b.append(s)
    b.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s"/>' % (f(m), f(H - 104 * k), f(W - m), f(H - 104 * k), t["line"]))
    sx = m
    for val, lab in (("20", "tools and hooks"), ("0", "dependencies"), ("352", "offline tests")):
        s, w = d.text(val, sx, H - 46 * k, "serif", 46 * k, t["text"])
        b.append(s)
        s, w2 = d.text(lab, sx + w + 12 * k, H - 53 * k, "sans", 22 * k, t["muted"])
        b.append(s)
        sx += w + w2 + 64 * k
    write(name, d)


# ------------------------------------------------------------------------------------------------
# the repo README's own art (the hero and banner above are kept for the profile card): a header strip, the measured
# comparison as a chart, an animated explainer, annotated shots of real runs and one card per tool. GitHub's own
# neutrals for page, card and text; colour is kept for the data. Every figure is read from a file in this repo.
# ------------------------------------------------------------------------------------------------
CMP = json.load(open(os.path.join(ASSETS, "..", "docs", "measurements", "2026-11-14-browser-vs-kit.json"), encoding="utf-8"))
R2 = {"dark": dict(rival="#6e7681", kit="#d77fc0", link="#4493f8", tint=0.11, mark=0.34),
      "light": dict(rival="#818b98", kit="#8a2a74", link="#0969da", tint=0.08, mark=0.20)}
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


def th(theme):
    t = dict(THEMES[theme])
    t.update(R2[theme])
    t["hue"], t["ink"] = HUES[theme], INKS[theme]
    t["dark"] = theme == "dark"
    return t


def num(v):
    return "{:,}".format(v)


def case(start):
    for c in CMP["cases"]:
        if c["job"].startswith(start):
            return c
    raise KeyError(start)


def cmp_meta():
    y, m, dd = CMP["measured_at"][:10].split("-")
    node = ".".join(CMP["machine"]["node"].lstrip("v").split(".")[:2])
    chromium = re.search(r"Chromium (\d+)", CMP["browser"]).group(1)
    assert CMP["machine"]["platform"] == "win32" and CMP["machine"]["release"].startswith("10.0.2")
    return dict(date="%d %s %s" % (int(dd), MONTHS[int(m) - 1], y), node=node, chromium=chromium,
                tok=CMP["tokenizer"].split(" ")[0])


def wrap_text(s, key, size, maxw):
    """Greedy word wrap by measured width."""
    lines, cur = [], ""
    for w in s.split(" "):
        trial = (cur + " " + w).strip()
        if not cur or font(key).layout(trial, size)[1] <= maxw:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    return lines + ([cur] if cur else [])


def balance(s, key, size, maxw):
    """One line if it fits, otherwise the two-line break with the shortest longer line (no orphan word)."""
    width = lambda x: font(key).layout(x, size)[1]
    if width(s) <= maxw:
        return [s]
    w = s.split(" ")
    best = min(range(1, len(w)), key=lambda i: max(width(" ".join(w[:i])), width(" ".join(w[i:]))))
    two = [" ".join(w[:best]), " ".join(w[best:])]
    return two if max(map(width, two)) <= maxw else wrap_text(s, key, size, maxw)


def runs(d, parts, x, y, anchor="start"):
    """Runs of [(text, font key, size, fill)] set one after another on one baseline. Returns (svg, width)."""
    widths = [d.width(s, k, sz) for s, k, sz, _ in parts]
    total = sum(widths)
    if anchor == "end":
        x -= total
    out = []
    for (s, k, sz, fill), w in zip(parts, widths):
        out.append(d.text(s, x, y, k, sz, fill)[0])
        x += w
    return "".join(out), total


def panel(W, H, t, rx=12):
    return '<rect x=".5" y=".5" width="%d" height="%d" rx="%d" fill="%s" stroke="%s"/>' % (W - 1, H - 1, rx, t["page"], t["line"])


def blocked_icon(x, y, r, t, sw=2):
    """A barred circle centred on (x, y): the 'blocked' status always carries its word beside it."""
    k = r * 0.7071
    return ('<g fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round"><circle cx="%s" cy="%s" r="%s"/>'
            '<path d="M%s %sL%s %s"/></g>' % (t["bad"], f(sw), f(x), f(y), f(r), f(x - k), f(y - k), f(x + k), f(y + k)))


def tick_icon(x, y, r, t, sw=2):
    return ('<g fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"><circle cx="%s" cy="%s" r="%s"/>'
            '<path d="M%s %sL%s %sL%s %s"/></g>' % (t["ok"], f(sw), f(x), f(y), f(r), f(x - r * 0.42), f(y + r * 0.02),
                                                   f(x - r * 0.08), f(y + r * 0.36), f(x + r * 0.46), f(y - r * 0.3)))


# ------------------------------------------------------------------------------------------------
# colour, cost and motion. One hue per tool or way of reading, the same on its squares, its figure, its card and
# its explainer step. A cost worked out from a published list price. Figures that pour in and then rest finished.
# ------------------------------------------------------------------------------------------------
HUES = {"dark": dict(kit="#e3b341", ptext="#2fd4c4", snap="#58a6ff", html="#8b5cf6", reddit="#e389cf", mem="#3fb950", hook="#b8d04a"),
        "light": dict(kit="#9a6700", ptext="#008469", snap="#0b6bd8", html="#5b21b6", reddit="#a3318a", mem="#1a7f37", hook="#5a7a0a")}
_P = json.load(open(os.path.join(ASSETS, "..", "docs", "measurements", "2026-11-14-price.json"), encoding="utf-8"))
_y, _m, _d = _P["read"].split("-")
PRICE = dict(model=_P["model"], usd_per_mtok=float(_P["usd_per_million_input_tokens"]), url=_P["source"],
             read="%d %s %s" % (int(_d), MONTHS[int(_m) - 1], _y))
assert PRICE["read"] == "14 Nov 2026" and PRICE["usd_per_mtok"] == 4.0


def lum(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    c = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def contrast(a, b):
    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def mix(a, b, k):
    """Colour a moved a share k of the way to colour b."""
    A, B = ([int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in (a, b))
    return "#%02x%02x%02x" % tuple(round(x + (y - x) * k) for x, y in zip(A, B))


def ink_of(hue, theme):
    """The hue as text: itself where it already reads at 4.5:1 on the page and on a card, otherwise the same hue
    moved towards the text colour until it does (dark violet is the only one that needs it)."""
    k = 0.0
    while min(contrast(mix(hue, THEMES[theme]["text"], k), THEMES[theme][bg]) for bg in ("page", "card")) < 4.5:
        k += 0.04
    return mix(hue, THEMES[theme]["text"], k)


INKS = {_th: {_k: ink_of(_h, _th) for _k, _h in HUES[_th].items()} for _th in HUES}
for _th in HUES:                                    # WCAG: 3:1 for a shape, 4.5:1 for text (ink_of sees to the text)
    for _k, _h in HUES[_th].items():
        assert min(contrast(_h, THEMES[_th][_bg]) for _bg in ("page", "card")) >= 3.0, (_th, _k)


def usd(tokens):
    """US dollars for 1,000 checks that each put this many input tokens in front of the priced model."""
    return "$%.2f" % (tokens * PRICE["usd_per_mtok"] / 1e6 * 1000)


def secs(ms):
    return "%.1f s" % (ms / 1000) if ms >= 1000 else "%.2f s" % (ms / 1000)


def chip(x, y, s, fill):
    return '<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s"/>' % (f(x), f(y), f(s), f(s), f(s * 0.25), fill)


def stars_ways():
    """The one job both routes finished, read four ways. n = how many of the kit's answers fit in each."""
    c = case("Has ")
    b, k = c["browser"], c["kit"]
    assert "30 repositories" in b["note"] and k["stars_checked"] == 100 and "snapshot" in b["tool"]
    unit = k["agent_reads"]["tokens"]
    ways = [dict(key="kit", name="headless-kit", what="one line of JSON", **k["agent_reads"]),
            dict(key="ptext", name="Page text", what="the words on the page", **b["page_text"]),
            dict(key="snap", name="Browser snapshot", what="what a browser tool returns", **b["snapshot"]),
            dict(key="html", name="Whole markup", what="no browser tool hands this over", **b["html"])]
    for w in ways:
        w["n"] = round(w["tokens"] / unit)
    assert [w["n"] for w in ways] == [1, 17, 99, 1480], [w["n"] for w in ways]
    assert round(c["ratio"]["by_tokens"]) == 99 and round(c["ratio"]["by_bytes"]) == 101
    return c, ways


def reddit_jobs():
    """The two jobs where the browser was turned away: no ratio, the kit's own figures only."""
    sub, thr = case("What is new"), case("Read one thread")
    for c in (sub, thr):
        assert c["ratio"] is None and c["browser"]["blocked"] and "blocked by network security" in c["browser"]["page_says"]
    assert sub["browser"]["posts_on_the_page_also_in_the_pull"] == 0
    row = lambda c, q, why, got: dict(q=q, why=why, got=got, ms=c["kit"]["ms"], **c["kit"]["agent_reads"])
    return [row(sub, "What is new in r/rust?", "Reddit refused the browser. 0 posts read.",
                "%d posts found and saved to disk" % sub["kit"]["posts"]),
            row(thr, "Read a thread and its %d comments" % thr["kit"]["comments"], "Same block page. The thread never loaded.",
                "the whole thread saved to disk")]


# Every loop opens on the finished figure, clears, pours, then rests finished for the rest of the loop.
POUR = dict(T=18.0, hold=1.5, fade=0.3, start=2.3, dt=0.11)


class Pour:
    """The shared clock of a figure that pours in. Squares and text carry a class for the step they arrive at:
    s<k> fades in at step k (squares), t<k> pops in at step k (finished values), c<k> shows only between step k and
    step k + 1 (a counter's passing value). The finished values are the elements at rest and the passing ones have
    opacity 0 in their attributes, so the first frame, a still, and a reader who asks for no motion all get the
    finished figure."""

    def __init__(self, cols, total, dt=None):
        self.dt = dt or POUR["dt"]
        seq = [v for v in (1, 3, 6, 10, 17, 26, 39, 56, 78, 99) if v < total]    # slow enough to see the short ones end
        v = (seq[-1] // cols + 1) * cols
        while v < total:                                                         # then a row at a time
            seq.append(v)
            v += cols
        self.steps, self.used = seq + [total], set()

    def done(self, n):
        return next(k for k, c in enumerate(self.steps, 1) if c >= n)

    def cls(self, kind, k):
        self.used.add((kind, k))
        return "%s%d" % (kind, k)

    def css(self):
        T, a = POUR["T"], POUR["hold"]
        z = a + POUR["fade"]
        at = lambda k: POUR["start"] + k * self.dt if k else z
        p = lambda s: f(100 * s / T, 4) + "%"
        out = []
        for kind, k in sorted(self.used):
            name = "%s%d" % (kind, k)
            if kind == "c":
                kf = "0%%,%s{opacity:0}%s,%s{opacity:1}%s,to{opacity:0}" % (p(at(k)), p(at(k) + 0.002), p(at(k + 1)), p(at(k + 1) + 0.002))
            else:
                kf = "0%%,%s{opacity:1}%s,%s{opacity:0}%s,to{opacity:1}" % (p(a), p(z), p(at(k)), p(at(k) + (0.09 if kind == "s" else 0.002)))
            # a counter's passing values switch in one instant (step-end), so two of them are never on show together
            out.append("@keyframes %s{%s}.%s{animation:%s %ss %s infinite}" % (name, kf, name, name, f(T), "step-end" if kind == "c" else "linear"))
        out.append(".pu{animation:pu 2.6s ease-in-out infinite alternate}@keyframes pu{from{opacity:.4}}")
        out.append("@media (prefers-reduced-motion: reduce){*{animation:none!important}}")
        return "".join(out)


def own_rate(P, n, cols):
    """A fill for a block too big for the shared sequence to say anything about: whole rows, spread evenly over
    every step of the clock, so its count is its own and never echoes a smaller row's."""
    rows, K = -(-n // cols), len(P.steps)
    return [min(n, cols * -(-(k * rows) // K)) for k in range(1, K + 1)]


def counter(d, P, n, final, x, y, key, size, fill, unit, anchor="end", tail=None, seq=None):
    """A number that counts up while its n squares pour (unit = what one square is worth). At rest it is `final`.
    tail = (text, font key, size, fill) set straight after the number, so a unit word follows it as it grows.
    seq = the squares on show after each step, where that is not the shared sequence (see own_rate)."""
    steps = seq or P.steps
    done = next(k for k, c in enumerate(steps, 1) if c >= n)

    def one(v, cls, opacity=None):
        if not tail:
            return d.text(num(v), x, y, key, size, fill, anchor=anchor, cls=cls, opacity=opacity)[0]
        s, _ = runs(d, [(num(v), key, size, fill), tail], x, y, anchor)
        return '<g class="%s"%s>%s</g>' % (cls, "" if opacity is None else ' opacity="%s"' % f(opacity), s)

    out = [one(final, P.cls("t", done))]
    for k in range(done):
        out.append(one(steps[k - 1] * unit if k else 0, P.cls("c", k), 0))
    return "".join(out)


def squares(d, t, P, key, x, y, cols, pitch, n, seq=None, soft=0.0):
    """n unit squares from (x, y), cols to a row, in the way's own hue, arriving on the shared clock.
    Drawn as runs of colour under a grid of page-coloured gaps: 1,480 squares cost a few dozen rectangles.
    soft = how far the hue is drawn back towards the page, for a block that must not outshout the others."""
    hue = mix(t["hue"][key], t["page"], soft)
    rows = -(-n // cols)
    w, h, gap = min(n, cols) * pitch, rows * pitch, round(pitch * 0.17, 2)
    g0, g1 = (mix(hue, "#ffffff", 0.16), mix(hue, t["page"], 0.16)) if t["dark"] else (mix(hue, "#ffffff", 0.16), mix(hue, "#000000", 0.06))
    d.defs.append('<linearGradient id="g-%s" gradientUnits="userSpaceOnUse" x1="%s" y1="%s" x2="%s" y2="%s">'
                  '<stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient>'
                  % (key, f(x), f(y), f(x + w), f(y + h), g0, g1))
    d.defs.append('<pattern id="q-%s" patternUnits="userSpaceOnUse" x="%s" y="%s" width="%s" height="%s">'
                  '<path d="M%s 0h%sv%sh-%sv-%sh%sz" fill="%s"/></pattern>'
                  % (key, f(x), f(y), f(pitch), f(pitch), f(pitch - gap), f(gap), f(pitch), f(pitch), f(gap), f(pitch - gap), t["page"]))

    def seg(a, e):
        o = []
        while a < e:
            r, c = divmod(a, cols)
            z = min(e, (r + 1) * cols)
            o.append('<rect x="%s" y="%s" width="%s" height="%s"/>' % (f(x + c * pitch), f(y + r * pitch), f((z - a) * pitch), f(pitch)))
            a = z
        return "".join(o)

    out = ['<g fill="%s" opacity="%s">%s</g>' % (t["line"], "0.55" if t["dark"] else "0.6", seg(0, n)), '<g fill="url(#g-%s)">' % key]
    prev = 0
    for k, c in enumerate(seq or P.steps, 1):
        if prev >= n:
            break
        if min(c, n) > prev:
            out.append('<g class="%s">%s</g>' % (P.cls("s", k), seg(prev, min(c, n))))
        prev = min(c, n)
    out.append('</g><rect x="%s" y="%s" width="%s" height="%s" fill="url(#q-%s)"/>' % (f(x), f(y), f(w), f(h), key))
    return "".join(out), h


def chart_alt():
    m = cmp_meta()
    c, ways = stars_ways()
    kit, ptext, snap, html = ways
    sub, thr = reddit_jobs()
    return ("One job read four ways, in the tokens an agent has to read. The job: has antirez starred anything new on GitHub. "
            "headless-kit (github-stars): %s tokens, %s bytes, %s. Page text: %s tokens, %d times the kit. "
            "Browser snapshot: %s tokens, %s bytes, %s, %d times the kit. The page's whole markup, which no browser tool "
            "hands an agent, shown for scale: %s tokens, %s times the kit. "
            "For 1,000 checks at USD %g a million input tokens (the list price of %s on %s): %s with the kit, %s with the browser snapshot. "
            "Two Reddit jobs: the browser was blocked and read nothing; reddit-pull answered in %s tokens (%s) and %s tokens (%s). "
            "Measured %s on Windows 11, Node %s, Playwright's headless Chromium %s, %s tokeniser, one run each."
            % (num(kit["tokens"]), num(kit["bytes"]), secs(c["kit"]["ms"]), num(ptext["tokens"]), ptext["n"],
               num(snap["tokens"]), num(snap["bytes"]), secs(c["browser"]["ms"]), snap["n"], num(html["tokens"]), num(html["n"]),
               PRICE["usd_per_mtok"], PRICE["model"], PRICE["read"], usd(kit["tokens"]), usd(snap["tokens"]),
               num(sub["tokens"]), sub["got"], num(thr["tokens"]), thr["got"], m["date"], m["node"], m["chromium"], m["tok"]))


def chart_notes(c, m):
    return ("Measured %s on Windows 11, Node %s, Playwright's headless Chromium %s; one run each. Tokens counted with OpenAI's %s; "
            "Claude's own count will differ, so bytes are given too. Cost is arithmetic, not a measurement: the tokens at USD %g a "
            "million input tokens, the list price of %s on %s. The comparison is conservative: the browser's page held 30 stars, "
            "the kit checked %d. Browser time runs from opening the page to the last capture, includes the script's fixed "
            "1.5 s pause for the page to settle and leaves out starting the browser; kit time is the whole command."
            % (m["date"], m["node"], m["chromium"], m["tok"], PRICE["usd_per_mtok"], PRICE["model"], PRICE["read"], c["kit"]["stars_checked"]))


def band(d, t, x, y, w, h, glow=None, tint="kit"):
    """A raised card: a soft top-to-bottom fall of light, a hairline of light along its top edge and, where asked,
    a faint glow in one hue behind the figure that matters. glow = (cx, cy, rx, ry)."""
    if not any('id="band"' in s for s in d.defs):
        d.defs.append('<linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient>'
                      % (t["card"], mix(t["card"], t["page"], 0.55)))
    gid = "glow-" + tint
    if not any('id="%s"' % gid in s for s in d.defs):
        d.defs.append('<radialGradient id="%s"><stop offset="0" stop-color="%s" stop-opacity="%s"/><stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient>'
                      % (gid, t["hue"][tint], "0.16" if t["dark"] else "0.10", t["hue"][tint]))
    out = ['<rect x="%s" y="%s" width="%s" height="%s" rx="10" fill="url(#band)" stroke="%s"/>' % (f(x + .5), f(y + .5), f(w - 1), f(h - 1), t["line"])]
    if glow:
        cid = "bc%d" % sum(1 for s in d.defs if s.startswith("<clipPath"))
        d.defs.append('<clipPath id="%s"><rect x="%s" y="%s" width="%s" height="%s" rx="10"/></clipPath>' % (cid, f(x + 1), f(y + 1), f(w - 2), f(h - 2)))
        out.append('<g clip-path="url(#%s)"><ellipse class="pu" cx="%s" cy="%s" rx="%s" ry="%s" fill="url(#%s)"/></g>' % ((cid,) + tuple(f(v) for v in glow) + (gid,)))
    out.append('<path d="M%s %sh%s" stroke="%s" stroke-opacity="%s"/>' % (f(x + 10), f(y + 1.5), f(w - 20), t["edge"], f(t["edgeo"])))
    return "".join(out)


def hero_band(d, t, P, c, ways, x, y, w, h):
    """The headline: the multiplier first and largest, then the two routes side by side on four measures."""
    hue, b = t["hue"], [band(d, t, x, y, w, h, glow=(x + 150, y + 62, 250, 120))]
    kit, snap = ways[0], ways[2]
    nx = x + 30
    w99 = d.width("99", "sansb", 88)
    b.append(counter(d, P, snap["n"], snap["n"], nx + w99, y + 86, "sansb", 88, hue["kit"], 1))
    b.append(d.text("times", nx + w99 + 14, y + 86, "sansb", 44, hue["kit"])[0])
    b.append(d.text("less for your agent to read", nx, y + 123, "sansb", 23, t["text"])[0])
    b.append(d.text("than the page a browser tool hands it", nx, y + 149, "sans", 17, t["muted"])[0])
    lx, right = x + 462, x + w - 28
    cx = [right - 330, right - 226, right - 132, right]
    for xx, head in zip(cx, ("Tokens", "Bytes", "Time", "Per 1,000 checks")):
        b.append(d.text(head, xx, y + 36, "sans", 15, t["muted"], anchor="end")[0])
    rows = ((snap, "Browser snapshot", "snap", t["ink"]["snap"], c["browser"]["ms"], y + 72), (kit, "headless-kit", "kit", t["ink"]["kit"], c["kit"]["ms"], y + 106))
    for way, label, key, ink, ms, yy in rows:
        b.append(chip(lx, yy - 12, 12, hue[key]))
        b.append(d.text(label, lx + 21, yy, "sans", 17, t["text"])[0])
        # the kit's row is whole from the start. The browser's tokens count with the headline, and its other cells
        # arrive with the totals, so a frame caught mid-pour never shows figures that disagree.
        late = P.cls("t", P.done(snap["n"])) if key == "snap" else None
        if late:
            b.append(counter(d, P, way["n"], way["tokens"], cx[0], yy, "sansb", 20, ink, kit["tokens"]))
        else:
            b.append(d.text(num(way["tokens"]), cx[0], yy, "sansb", 20, ink, anchor="end")[0])
        for xx, v in zip(cx[1:], (num(way["bytes"]), secs(ms), usd(way["tokens"]))):
            b.append(d.text(v, xx, yy, "sansb", 20, ink, anchor="end", cls=late)[0])
    b.append('<path d="M%s %sH%s" stroke="%s"/>' % (f(lx), f(y + 123.5), f(right), t["line"]))
    less = ("%d times" % round(c["ratio"]["by_tokens"]), "%d times" % round(c["ratio"]["by_bytes"]),
            secs(c["browser"]["ms"] - c["kit"]["ms"]), "about $%d" % round((snap["tokens"] - kit["tokens"]) * PRICE["usd_per_mtok"] / 1000))
    b.append(d.text("Less with the kit", lx, y + 149, "sans", 16, t["muted"])[0])
    for xx, v in zip(cx, less):
        b.append(d.text(v, xx, y + 149, "sansb", 17, t["text"], anchor="end", cls=P.cls("t", P.done(snap["n"])))[0])
    return "".join(b)


def reddit_cell(d, t, r, x, y, w, h):
    hue, b = t["ink"]["reddit"], [band(d, t, x, y, w, h)]
    b.append(d.text(r["q"], x + 20, y + 33, "sansb", 18, t["text"])[0])
    vx = x + 128
    b.append(d.text("Browser", x + 20, y + 66, "sans", 15.5, t["muted"])[0])
    b.append(blocked_icon(vx + 8, y + 60.5, 7.5, t, 1.8))
    s, bw = d.text("Blocked", vx + 23, y + 66, "sansb", 17, t["bad"])
    b.append(s)
    b.append(d.text(r["why"], vx + 23 + bw + 10, y + 66, "sans", 15.5, t["muted"])[0])
    b.append(d.text("reddit-pull", x + 20, y + 98, "mono", 14.5, hue)[0])
    s, tw = runs(d, [(num(r["tokens"]) + " tokens", "sansb", 18, hue),
                     ("   %s bytes  ·  %s  ·  %s per 1,000 checks" % (num(r["bytes"]), secs(r["ms"]), usd(r["tokens"])), "sans", 15.5, t["muted"])], vx, y + 98)
    assert vx + tw <= x + w - 16, r["q"]
    b.append(s)
    b.append(d.text(r["got"], vx, y + 121, "sans", 15, t["muted"])[0])
    return "".join(b)


def chart(theme):
    """The hero: one job both routes finished, read four ways and drawn in squares of one kit answer, then the two
    Reddit jobs the browser could not do. It rests finished and pours in once a loop."""
    t, m = th(theme), cmp_meta()
    c, ways = stars_ways()
    hue, unit = t["hue"], ways[0]["tokens"]
    W, pad = 1200, 44
    cols, pitch, sx = 70, 10, 456
    P = Pour(cols, ways[-1]["n"])
    d = Doc(W, 0, "One job, read four ways: the tokens an agent has to read", chart_alt())
    b = d.body
    b.append(d.text("One job, read four ways", pad, 61, "sansb", 29, t["text"])[0])
    s, w = d.text("github-stars", W - pad, 58, "mono", 15.5, hue["kit"], anchor="end")
    b.append(s + chip(W - pad - w - 21, 46, 12, hue["kit"]))
    b.append(d.text("The job: has antirez starred anything new on GitHub? The same answer, measured four ways.", pad, 93, "sans", 18, t["muted"])[0])
    b.append(d.text("A token is the unit a model reads and is billed in: a short word, or a piece of a long one.", pad, 118, "sans", 18, t["muted"])[0])
    hy, hh = 140, 172
    b.append(hero_band(d, t, P, c, ways, pad, hy, W - 2 * pad, hh))
    y = hy + hh + 42
    b.append(runs(d, [("Each square is %d tokens:" % unit, "sansb", 17.5, t["text"]),
                      (" one whole answer from the kit. Every row is the same job on the same scale.", "sans", 17.5, t["muted"])], pad, y)[0])
    y += 18
    for i, w_ in enumerate(ways):
        rows_ = -(-w_["n"] // cols)
        rh = max(86, 18 + rows_ * pitch + 22)
        ink = t["ink"][w_["key"]]
        b.append('<path d="M%s %sH%s" stroke="%s" stroke-opacity=".7"/>' % (f(pad), f(y + .5), f(W - pad), t["line"]))
        b.append(chip(pad, y + 15, 12, hue[w_["key"]]))
        s, nw = d.text(w_["name"], pad + 21, y + 27, "sansb", 19, t["text"])
        s2, ww = d.text(w_["what"], pad + 21 + nw + 10, y + 27, "sans", 16, t["muted"])
        assert pad + 21 + nw + 10 + ww <= sx - 14, w_["name"]
        b.append(s + s2)
        seq = own_rate(P, w_["n"], cols) if w_["key"] == "html" else None
        late = None if w_["key"] == "kit" else P.cls("t", next(k for k, v in enumerate(seq or P.steps, 1) if v >= w_["n"]))
        b.append(counter(d, P, w_["n"], w_["tokens"], pad, y + 55, "sansb", 22, ink, unit, anchor="start", tail=(" tokens", "sans", 16, t["muted"]), seq=seq))
        mx = pad + 196
        if w_["key"] == "kit":
            b.append(d.text("one square", mx, y + 55, "sansb", 17, t["text"])[0])
        else:
            b.append(d.text("%s times the kit" % num(w_["n"]), mx, y + 55, "sansb", 17, t["text"], cls=late)[0])
        b.append(d.text("%s bytes  ·  %s per 1,000 checks" % (num(w_["bytes"]), usd(w_["tokens"])), pad, y + 77, "sans", 16, t["muted"], cls=late)[0])
        if w_["key"] == "kit":
            b.append('<circle class="pu" cx="%s" cy="%s" r="34" fill="url(#glow-kit)"/>' % (f(sx + pitch / 2), f(y + 18 + pitch / 2)))
            b.append(d.text("the whole answer", sx + pitch + 12, y + 18 + pitch - 1, "sansb", 16, ink)[0])
        s, sh = squares(d, t, P, w_["key"], sx, y + 18, cols, pitch, w_["n"], seq=seq, soft=0.45 if w_["key"] == "html" else 0.0)
        b.append(s)
        if w_["key"] == "html":
            note = wrap_text("Whichever of the three the browser hands over, the agent still has to compare the list with what it saw "
                             "last time. The kit keeps that record itself.", "sans", 16, sx - pad - 36)
            ny = y + rh - 16 - (len(note) - 1) * 22
            for ln in note:
                b.append(d.text(ln, pad, ny, "sans", 16, t["muted"])[0])
                ny += 22
        y += rh
    b.append('<path d="M%s %sH%s" stroke="%s" stroke-opacity=".7"/>' % (f(pad), f(y + .5), f(W - pad), t["line"]))
    y += 42
    b.append(runs(d, [("Two more jobs, where the browser got nothing.", "sansb", 19, t["text"]),
                      ("  Reddit turned the headless browser away both times.", "sans", 17, t["muted"])], pad, y)[0])
    s, w = d.text("reddit-pull", W - pad, y - 1, "mono", 15.5, hue["reddit"], anchor="end")
    b.append(s + chip(W - pad - w - 21, y - 13, 12, hue["reddit"]))
    y += 20
    cw, ch = (W - 2 * pad - 16) / 2, 138
    for i, r in enumerate(reddit_jobs()):
        b.append(reddit_cell(d, t, r, pad + i * (cw + 16), y, cw, ch))
    y += ch + 34
    for ln in wrap_text(chart_notes(c, m), "sans", 16, W - 2 * pad):
        b.append(d.text(ln, pad, y, "sans", 16, t["muted"])[0])
        y += 23
    d.h = round(y + 4)
    b.insert(0, panel(W, d.h, t))
    d.css.append(P.css())
    write("chart-%s.svg" % theme, d)


MOTION = (".pu{animation:pu 2.6s ease-in-out infinite alternate}@keyframes pu{from{opacity:.4}}"
          ".bl{animation:bl 1.3s steps(1) infinite}@keyframes bl{50%{opacity:0}}"
          "@media (prefers-reduced-motion: reduce){*{animation:none!important}}")


def header(theme, mobile=False):
    """The strip that stands in for the README's H1: the mark, the name and what the kit is. It carries no figures;
    the chart below it owns the numbers."""
    t = th(theme)
    what = "%d small tools and hooks for coding agents" % STATS["items"]["total"]
    W, H = (720, 150) if mobile else (1200, 112)
    d = Doc(W, H, "headless-kit", "headless-kit: %s." % what)
    d.css.append(MOTION)
    b = d.body
    px, tile, ty = (36, 60, 28) if mobile else (32, 52, 30)
    k = tile / 52
    b.append(band(d, t, 0, 0, W, H, glow=(px + tile / 2, ty + tile / 2, 190, 90)))
    b.append('<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s" stroke="%s"/>' % (f(px + .5), f(ty + .5), tile - 1, tile - 1, f(tile * 0.23), t["page"], t["line"]))
    b.append('<path d="M%s %sl%s %sl%s %s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"/>'
             % (f(px + 14 * k), f(ty + 17 * k), f(10 * k), f(9 * k), f(-10 * k), f(9 * k), t["hue"]["kit"], f(3.6 * k)))
    b.append('<rect class="bl" x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s"/>' % (f(px + 28 * k), f(ty + 32.4 * k), f(11 * k), f(3.6 * k), f(1.8 * k), t["hue"]["kit"]))
    if mobile:
        b.append(d.text("headless-kit", px + tile + 18, 74, "monob", 44, t["text"])[0])
        b.append(d.text(what, px, 124, "sans", 22.5, t["muted"])[0])
    else:
        b.append(d.text("headless-kit", px + tile + 18, 62, "monob", 38, t["text"])[0])
        b.append(d.text(what, px + tile + 19, 88, "sans", 17.5, t["muted"])[0])
    write("header-%s%s.svg" % ("m-" if mobile else "", theme), d)


def chart_mobile(theme):
    """The same figure for a phone (picked by <picture> under 768 px): one column, type that reads at half scale."""
    t, m = th(theme), cmp_meta()
    c, ways = stars_ways()
    hue, ink, unit = t["hue"], t["ink"], ways[0]["tokens"]
    kit, snap = ways[0], ways[2]
    W, pad = 720, 36
    inner, cols, pitch = W - 2 * pad, 54, 12
    P = Pour(cols, ways[-1]["n"])
    d = Doc(W, 0, "One job, read four ways: the tokens an agent has to read", chart_alt())
    b = d.body
    rule = lambda yy: '<path d="M%s %sH%s" stroke="%s" stroke-opacity=".7"/>' % (f(pad), f(yy + .5), f(W - pad), t["line"])
    b.append(d.text("One job, read four ways", pad, 82, "sansb", 42, t["text"])[0])
    b.append(chip(pad, 110, 16, hue["kit"]) + d.text("github-stars", pad + 27, 124, "mono", 21, ink["kit"])[0])
    y = 172
    for para in ("The job: has antirez starred anything new on GitHub? The same answer, measured four ways.",
                 "A token is the unit a model reads and is billed in: a short word, or a piece of a long one."):
        for ln in wrap_text(para, "sans", 22.5, inner):
            b.append(d.text(ln, pad, y, "sans", 22.5, t["muted"])[0])
            y += 32
        y += 8
    hy, hh = y + 4, 474
    b.append(band(d, t, pad, hy, inner, hh, glow=(pad + 190, hy + 90, 330, 170)))
    nx = pad + 30
    w99 = d.width("99", "sansb", 124)
    b.append(counter(d, P, snap["n"], snap["n"], nx + w99, hy + 128, "sansb", 124, hue["kit"], 1))
    b.append(d.text("times", nx + w99 + 18, hy + 128, "sansb", 60, hue["kit"])[0])
    b.append(d.text("less for your agent to read", nx, hy + 180, "sansb", 31, t["text"])[0])
    b.append(d.text("than the page a browser tool hands it", nx, hy + 216, "sans", 23, t["muted"])[0])
    ty, right = hy + 268, pad + inner - 30
    cx = [right - 304, right - 154, right]
    for xx, (head, key) in zip(cx, (("Browser", "snap"), ("Kit", "kit"), ("Less", None))):
        s, hw = d.text(head, xx, ty, "sans", 21, t["muted"], anchor="end")
        b.append(s + (chip(xx - hw - 23, ty - 14, 14, hue[key]) if key else ""))
    table = (("Tokens", num(snap["tokens"]), num(kit["tokens"]), "%d times" % round(c["ratio"]["by_tokens"])),
             ("Bytes", num(snap["bytes"]), num(kit["bytes"]), "%d times" % round(c["ratio"]["by_bytes"])),
             ("Time", secs(c["browser"]["ms"]), secs(c["kit"]["ms"]), secs(c["browser"]["ms"] - c["kit"]["ms"])),
             ("Per 1,000 checks", usd(snap["tokens"]), usd(kit["tokens"]),
              "about $%d" % round((snap["tokens"] - kit["tokens"]) * PRICE["usd_per_mtok"] / 1000)))
    for i, (label, bv, kv, lv) in enumerate(table):
        yy = ty + 48 + i * 44
        b.append('<path d="M%s %sH%s" stroke="%s" stroke-opacity=".7"/>' % (f(nx), f(yy - 29.5), f(right), t["line"]))
        b.append(d.text(label, nx, yy, "sans", 22, t["muted"])[0])
        if i == 0:                                     # the browser's tokens count with the headline; the rest arrive with the totals
            b.append(counter(d, P, snap["n"], snap["tokens"], cx[0], yy, "sansb", 25, ink["snap"], unit))
        else:
            b.append(d.text(bv, cx[0], yy, "sansb", 25, ink["snap"], anchor="end", cls=P.cls("t", P.done(snap["n"])))[0])
        b.append(d.text(kv, cx[1], yy, "sansb", 25, ink["kit"], anchor="end")[0])
        b.append(d.text(lv, cx[2], yy, "sansb", 23, t["text"], anchor="end", cls=P.cls("t", P.done(snap["n"])))[0])
    y = hy + hh + 54
    b.append(d.text("Each square is %d tokens" % unit, pad, y, "sansb", 25, t["text"])[0])
    y += 34
    for ln in wrap_text("One whole answer from the kit. Every row is the same job on the same scale.", "sans", 22.5, inner):
        b.append(d.text(ln, pad, y, "sans", 22.5, t["muted"])[0])
        y += 32
    y -= 6
    for w_ in ways:
        rows_ = -(-w_["n"] // cols)
        b.append(rule(y))
        b.append(chip(pad, y + 25, 16, hue[w_["key"]]))
        s, nw = d.text(w_["name"], pad + 27, y + 41, "sansb", 27, t["text"])
        s2, ww = d.text(w_["what"], pad + 27 + nw + 12, y + 41, "sans", 21.5, t["muted"])
        assert pad + 27 + nw + 12 + ww <= W - pad, w_["name"]
        b.append(s + s2)
        seq = own_rate(P, w_["n"], cols) if w_["key"] == "html" else None
        late = None if w_["key"] == "kit" else P.cls("t", next(k for k, v in enumerate(seq or P.steps, 1) if v >= w_["n"]))
        b.append(counter(d, P, w_["n"], w_["tokens"], pad, y + 84, "sansb", 31, ink[w_["key"]], unit, anchor="start", tail=(" tokens", "sans", 22, t["muted"]), seq=seq))
        if w_["key"] == "kit":
            b.append(d.text("one square", W - pad, y + 84, "sansb", 23, t["text"], anchor="end")[0])
        else:
            b.append(d.text("%s times the kit" % num(w_["n"]), W - pad, y + 84, "sansb", 23, t["text"], anchor="end", cls=late)[0])
        b.append(d.text("%s bytes  ·  %s per 1,000 checks" % (num(w_["bytes"]), usd(w_["tokens"])), pad, y + 116, "sans", 21.5, t["muted"], cls=late)[0])
        sy = y + 136
        if w_["key"] == "kit":
            b.append('<circle class="pu" cx="%s" cy="%s" r="42" fill="url(#glow-kit)"/>' % (f(pad + pitch / 2), f(sy + pitch / 2)))
            b.append(d.text("the whole answer", pad + pitch + 14, sy + pitch, "sansb", 21.5, ink["kit"])[0])
        s, sh = squares(d, t, P, w_["key"], pad, sy, cols, pitch, w_["n"], seq=seq, soft=0.45 if w_["key"] == "html" else 0.0)
        b.append(s)
        y = sy + sh + 26
    y += 12
    for ln in wrap_text("Whichever of the three the browser hands over, the agent still has to compare the list with what it saw "
                        "last time. The kit keeps that record itself.", "sans", 21.5, inner):
        b.append(d.text(ln, pad, y, "sans", 21.5, t["muted"])[0])
        y += 30
    y += 4
    b.append(rule(y))
    y += 50
    for ln in wrap_text("Two more jobs, where the browser got nothing", "sansb", 27, inner):
        b.append(d.text(ln, pad, y, "sansb", 27, t["text"])[0])
        y += 36
    for ln in wrap_text("Reddit turned the headless browser away both times.", "sans", 22, inner):
        b.append(d.text(ln, pad, y, "sans", 22, t["muted"])[0])
        y += 31
    b.append(chip(pad, y - 5, 16, hue["reddit"]) + d.text("reddit-pull", pad + 27, y + 9, "mono", 21, ink["reddit"])[0])
    y += 34
    for r in reddit_jobs():
        ch = 250
        b.append(band(d, t, pad, y, inner, ch))
        x, vx = pad, pad + 172
        b.append(d.text(r["q"], x + 24, y + 46, "sansb", 26, t["text"])[0])
        b.append(d.text("Browser", x + 24, y + 92, "sans", 21, t["muted"])[0])
        b.append(blocked_icon(vx + 10, y + 84.5, 10, t, 2.3))
        b.append(d.text("Blocked", vx + 30, y + 92, "sansb", 23, t["bad"])[0])
        s, ww = d.text(r["why"], vx, y + 122, "sans", 20.5, t["muted"])
        assert vx + ww <= W - pad - 16, r["q"]
        b.append(s)
        b.append(d.text("reddit-pull", x + 24, y + 168, "mono", 20, ink["reddit"])[0])
        b.append(d.text(num(r["tokens"]) + " tokens", vx, y + 168, "sansb", 26, ink["reddit"])[0])
        s, ww = d.text("%s bytes  ·  %s  ·  %s per 1,000 checks" % (num(r["bytes"]), secs(r["ms"]), usd(r["tokens"])), vx, y + 198, "sans", 20.5, t["muted"])
        assert vx + ww <= W - pad - 16, r["q"]
        b.append(s)
        b.append(d.text(r["got"], vx, y + 226, "sans", 20.5, t["muted"])[0])
        y += ch + 16
    y += 30
    for ln in wrap_text(chart_notes(c, m), "sans", 20, inner):
        b.append(d.text(ln, pad, y, "sans", 20, t["muted"])[0])
        y += 28
    d.h = round(y + 8)
    b.insert(0, panel(W, d.h, t))
    d.css.append(P.css())
    write("chart-m-%s.svg" % theme, d)


def read_capture(name):
    return open(os.path.join(HERE, name), encoding="utf-8").read().rstrip("\n").split("\n")


def soft_chunks(ln, cols):
    """Where a long line breaks: after a comma in a line of JSON, otherwise after a space, and in the middle of a
    word only when neither is in reach. [(start, end)] character ranges, each at most cols wide."""
    out, a = [], 0
    while len(ln) - a > cols:
        window = ln[a:a + cols]
        cut = window.rfind(",") + 1 if ln.startswith("{") else 0
        if cut < cols * 0.35:
            cut = window.rfind(" ") + 1
        if cut < cols * 0.35 and ln[a + cols] == " ":
            cut = cols + 1                                 # the space hangs one cell past the edge, where it shows nothing
        if cut < cols * 0.35:
            cut = cols
        out.append((a, a + cut))
        a += cut
    return out + [(a, len(ln))]


def term_rows(lines, t, cols, keep=None):
    """Capture lines coloured whole, then wrapped to the terminal width at soft_chunks' breaks. Returns
    ([(runs, source line index)], {source line index: [where each of its rows starts]}).
    keep = {line index: [(start, end)]}: on those lines everything outside the kept ranges is dimmed."""
    rows, starts = [], {}
    for i, ln in enumerate(lines):
        colours = []
        for text, colour in spans(ln, t):
            colours += [colour] * len(text)
        assert len(colours) == len(ln), ln
        if keep and i in keep:
            on = set()
            for a, e in keep[i]:
                on.update(range(a, e))
            colours = [c if j in on else t["faint"] for j, c in enumerate(colours)]
        starts[i] = []
        for a, e in soft_chunks(ln, cols):
            starts[i].append(a)
            row = []
            for j in range(a, e):
                if row and row[-1][1] == colours[j]:
                    row[-1] = (row[-1][0] + ln[j], colours[j])
                else:
                    row.append((ln[j], colours[j]))
            rows.append((row, i))
    return rows, starts


def mono_cell(size):
    return font("mono").hmtx[font("mono").glyph("0")][0] * size / font("mono").upm


def dots(x, y, t):
    """Three plain dots: a terminal's title bar without pretending to be one operating system's."""
    return "".join('<circle cx="%s" cy="%s" r="4.5" fill="%s"/>' % (f(x + i * 15), f(y), t["line"]) for i in range(3))


def arrow_down(x, y1, y2, t):
    return ('<path d="M%s %sV%sM%s %sL%s %sL%s %s" fill="none" stroke="%s" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
            % (f(x), f(y1), f(y2), f(x - 5), f(y2 - 6), f(x), f(y2), f(x + 5), f(y2 - 6), t["faint"]))


# ------------------------------------------------------------------------------------------------
# explainer: one question answered through a browser and through the kit, on the job both of them finished (the
# GitHub stars check of the chart), in the chart's hues: blue for the browser's snapshot, amber for the kit. The
# page pours into the agent's context a square of 72 tokens at a time while the kit's one line is already there.
# CSS keyframes, no script. The loop begins and ends on the finished picture, so a renderer that shows only the
# first frame, and a reader who asks for reduced motion, both get the whole story as a still.
# ------------------------------------------------------------------------------------------------
def explainer_data():
    c, ways = stars_ways()
    cap = read_capture("shot-github-stars.txt")
    cmd, line = cap[2], cap[3]
    obj = json.loads(line)
    assert cmd.startswith("$ ") and obj["seeded"] is False and obj["new"] == [] and obj["read"] == c["kit"]["stars_checked"]
    assert obj["user"] in c["browser"]["url"] and "second poll, nothing new" in c["kit"]["tool"]
    # the same line, broken after a comma four times and otherwise untouched: every field, in order
    cuts = ['"read":%d,' % obj["read"], '"new":[],', '"failed":0},']
    flow, rest = [], line
    for cut in cuts:
        head, rest = rest.split(cut, 1)
        flow.append(head + cut)
    flow.append(rest)
    assert "".join(flow) == line and "\\" not in line
    title = re.match(r"^(.*? / Starred)", c["browser"]["title"]).group(1)
    assert cap[4] == "$ echo $?" and cap[5] == str(c["kit"]["exit"])
    return dict(c=c, kit=ways[0], snap=ways[2], cmd=cmd, line=line, flow=flow, title=title, exit=cap[4:6],
                on_page=int(re.search(r"\((\d+) repositories\)", c["browser"]["note"]).group(1)))


def lane_head(d, t, key, title, sub):
    return (chip(0, 9.5, 14, t["hue"][key]) + d.text(title, 24, 24, "sansb", 21, t["text"])[0] +
            d.text(sub, 0, 50, "sans", 15.5, t["muted"])[0])


def lane_browser(d, t, x, P):
    """The browser route in a 540-wide lane: the page arrives, and all of it lands in the agent's context."""
    c, snap, hue = x["c"], x["snap"], t["hue"]["snap"]
    o = [lane_head(d, t, "snap", "Through a browser", "What a browser tool such as Playwright MCP does for your agent")]
    o.append('<rect x=".5" y="68.5" width="539" height="208" rx="10" fill="%s" stroke="%s"/>' % (t["term"], t["line"]))
    o.append('<line x1=".5" y1="104.5" x2="539.5" y2="104.5" stroke="%s"/>' % t["line"])
    o.append('<rect x="14" y="76" width="512" height="21" rx="10.5" fill="%s"/>' % t["card"])
    o.append(d.text(c["browser"]["url"], 28, 91, "mono", 12.5, t["muted"])[0])
    o.append(d.text(x["title"], 16, 127, "sansb", 13.5, t["text"])[0])
    o.append(d.text("%d repositories on the page" % x["on_page"], 524, 127, "sans", 13, t["muted"], anchor="end")[0])
    # the page itself, drawn as what it is made of (a star, a name, a description for each repository) and not as
    # words nobody recorded: the script kept its sizes, not its text
    n, per = x["on_page"], 15
    for i in range(n):
        col, row = divmod(i, per)
        rx, ry = 16 + col * 258, 141 + row * 8.7
        nw, dw = 54 + (i * 37) % 58, 64 + (i * 53) % 86
        o.append('<g class="%s"><rect x="%s" y="%s" width="5" height="5" rx="1" fill="%s"/><rect x="%s" y="%s" width="%s" height="4" rx="2" fill="%s" opacity=".8"/>'
                 '<rect x="%s" y="%s" width="%s" height="4" rx="2" fill="%s"/></g>'
                 % (P.cls("s", 1 + i * len(P.steps) // n), f(rx), f(ry), t["faint"], f(rx + 11), f(ry + .5), nw, hue, f(rx + 17 + nw), f(ry + .5), dw, t["line"]))
    o.append(arrow_down(22, 285, 309, t) + d.text("what your agent gets back: the whole page, as a snapshot", 40, 303, "sans", 14.5, t["muted"])[0])
    o.append(counter(d, P, snap["n"], snap["tokens"], 0, 348, "sansb", 31, t["ink"]["snap"], x["kit"]["tokens"], anchor="start",
                     tail=(" tokens", "sans", 18, t["muted"])))
    o.append(d.text("%d squares of %d tokens" % (snap["n"], x["kit"]["tokens"]), 540, 348, "sans", 14.5, t["muted"], anchor="end", cls=P.cls("t", P.done(snap["n"])))[0])
    o.append(squares(d, t, P, "snap", 0, 362, 60, 9, snap["n"])[0])
    o.append('<g class="%s">%s</g>' % (P.cls("t", P.done(snap["n"])),
             d.text("And the agent still has to compare all %d with what it saw last time." % x["on_page"], 0, 411, "sans", 16, t["text"])[0]))
    o.append(d.text("%s bytes  ·  %s  ·  %s per 1,000 checks" % (num(snap["bytes"]), secs(c["browser"]["ms"]), usd(snap["tokens"])), 0, 437, "sans", 15, t["muted"])[0])
    return "".join(o), 444


def lane_kit(d, t, x, P):
    c, kit, hue, ink = x["c"], x["kit"], t["hue"]["kit"], t["ink"]["kit"]
    o = [lane_head(d, t, "kit", "Through headless-kit", "One command. github-stars asks GitHub's public API and keeps its own record")]
    size, lh = 12.8, 19
    cols = int((540 - 28) / mono_cell(size))
    cmd = term_rows([x["cmd"]], t, cols)[0]
    out = [(spans("{" + ln, t)[1:] if i else spans(ln, t), i) for i, ln in enumerate(x["flow"])]     # coloured as the JSON it is
    assert all(len(ln) <= cols for ln in x["flow"]) and len(cmd) + len(out) <= 6, (len(cmd), len(out))
    o.append('<rect x=".5" y="68.5" width="539" height="208" rx="10" fill="%s" stroke="%s"/>' % (t["term"], t["line"]))
    o.append('<path d="M10.5 68.5h519a10 10 0 0 1 10 10v16.5h-539v-16.5a10 10 0 0 1 10-10z" fill="%s"/>' % t["bar"])
    o.append('<line x1=".5" y1="95.5" x2="539.5" y2="95.5" stroke="%s"/>' % t["line"] + dots(18, 82, t))
    y = 121
    for r, _ in cmd:
        o.append(mono_run(d, [(s, t["hue"]["kit"] if s == "$ " else col) for s, col in r], 14, y, size)[0])
        y += lh
    y += 6
    js = ['<rect x="1" y="%s" width="538" height="%s" fill="%s" fill-opacity="%s"/>' % (f(y - 15), f(len(out) * lh + 8), hue, f(t["tint"]))]
    js.append('<rect x="1" y="%s" width="3" height="%s" fill="%s"/>' % (f(y - 15), f(len(out) * lh + 8), hue))
    for r, _ in out:
        js.append(mono_run(d, r, 14, y, size)[0])
        y += lh
    y += 7
    for ln in x["exit"]:                                        # the exit code, as the capture has it
        js.append(mono_run(d, [(s, t["hue"]["kit"] if s == "$ " else col) for s, col in spans(ln, t)], 14, y, size)[0])
        y += lh
    assert y - lh <= 268, y
    o.append('<g class="%s">%s</g>' % (P.cls("t", 1), "".join(js)))
    o.append(arrow_down(22, 285, 309, t) + d.text("what your agent gets back: that one line", 40, 303, "sans", 14.5, t["muted"])[0])
    o.append(counter(d, P, kit["n"], kit["tokens"], 0, 348, "sansb", 31, ink, kit["tokens"], anchor="start", tail=(" tokens", "sans", 18, t["muted"])))
    o.append(d.text("one square", 540, 348, "sans", 14.5, t["muted"], anchor="end", cls=P.cls("t", 1))[0])
    o.append('<circle class="pu" cx="4.5" cy="366.5" r="30" fill="url(#glow-kit)"/>')
    o.append(squares(d, t, P, "kit", 0, 362, 60, 9, kit["n"])[0])
    o.append('<g class="%s">%s%s</g>' % (P.cls("t", 1), tick_icon(8, 405.5, 7.5, t, 1.9),
             d.text("Nothing new. It checked %d stars against its own record." % c["kit"]["stars_checked"], 24, 411, "sans", 16, t["text"])[0]))
    o.append(d.text("%s bytes  ·  %s  ·  %s per 1,000 checks" % (num(kit["bytes"]), secs(c["kit"]["ms"]), usd(kit["tokens"])), 0, 437, "sans", 15, t["muted"])[0])
    return "".join(o), 444


EXPLAINER_NOTE = "The line is shown with a short file path (%d bytes). In the measured run it was %d bytes."


def explainer_alt():
    x = explainer_data()
    c, kit, snap = x["c"], x["kit"], x["snap"]
    return ("Two routes to one question, has antirez starred anything new on GitHub, measured on %s. Through a browser: "
            "the page of %d repositories comes back to the agent as a snapshot of %s tokens (%s bytes, %s), and the agent still "
            "has to compare the list with what it saw last time. Through headless-kit: one github-stars command returns one JSON "
            "line of %d tokens (%d bytes, %s) that says nothing is new after checking %d stars against its own record. "
            "That is %d times less to read. The same line, recorded with a shorter file path: %s"
            % (cmp_meta()["date"], x["on_page"], num(snap["tokens"]), num(snap["bytes"]), secs(c["browser"]["ms"]), kit["tokens"],
               kit["bytes"], secs(c["kit"]["ms"]), c["kit"]["stars_checked"], snap["n"], x["line"]))


def explainer(theme, mobile=False):
    t, x = th(theme), explainer_data()
    c, kit, snap = x["c"], x["kit"], x["snap"]
    P = Pour(60, snap["n"], dt=0.3)
    d = Doc(10, 10, "One question, two routes: a browser and headless-kit", explainer_alt())
    band(d, t, 0, 0, 10, 10)                                    # registers the card and glow gradients the lanes use
    left, hl = lane_browser(d, t, x, P)
    right, hr = lane_kit(d, t, x, P)
    lane = lambda svg, ox, oy, k: '<g transform="translate(%s %s) scale(%s)">%s</g>' % (f(ox), f(oy), f(k, 4), svg)
    done = P.cls("t", P.done(snap["n"]))
    assert len(x["line"].encode("utf-8")) < kit["bytes"]
    note = EXPLAINER_NOTE % (len(x["line"].encode("utf-8")), kit["bytes"])
    note_ink = mix(t["muted"], t["text"], 0.5)                  # a step up from muted: this is the caveat, it has to read
    if mobile:
        W, pad, k = 720, 40, 640 / 540.0
        head = [d.text("Your agent needs to know", pad, 62, "sans", 22, t["muted"])[0]]
        y = 112
        for ln in balance("Has antirez starred anything new?", "sansb", 38, W - 2 * pad):
            head.append(d.text(ln, pad, y, "sansb", 38, t["text"])[0])
            y += 46
        head.append(d.text("Measured %s" % cmp_meta()["date"], pad, y - 8, "sans", 20, t["muted"])[0])
        r1 = y + 20
        y1 = r1 + 36
        y2 = y1 + hl * k + 76
        y3 = y2 + hr * k + 36
        rules = ['<line x1="0" y1="%s" x2="%d" y2="%s" stroke="%s"/>' % (f(yy + .5), W, f(yy + .5), t["line"]) for yy in (r1, y2 - 40, y3)]
        lanes = lane(left, pad, y1, k) + lane(right, pad, y2, k)
        w99 = d.width(str(snap["n"]), "sansb", 76)
        foot = [counter(d, P, snap["n"], snap["n"], pad + w99, y3 + 86, "sansb", 76, t["hue"]["kit"], 1),
                d.text("times", pad + w99 + 14, y3 + 86, "sansb", 40, t["hue"]["kit"])[0],
                d.text("less to read, for the same answer", pad, y3 + 130, "sansb", 27, t["text"])[0]]
        y = y3 + 176
        for ln in wrap_text(note, "sans", 20, W - 2 * pad):
            foot.append(d.text(ln, pad, y, "sans", 20, note_ink)[0])
            y += 28
        H = int(y + 14)
    else:
        W, pad = 1200, 44
        head = [d.text("Your agent needs to know", pad, 46, "sans", 16, t["muted"])[0],
                d.text("Has antirez starred anything new on GitHub?", pad, 84, "sansb", 30, t["text"])[0],
                d.text("Measured %s" % cmp_meta()["date"], W - pad, 84, "sans", 15, t["muted"], anchor="end")[0]]
        y3 = 112 + 30 + max(hl, hr) + 22
        rules = ['<line x1="0" y1="112.5" x2="%d" y2="112.5" stroke="%s"/>' % (W, t["line"]),
                 '<line x1="600.5" y1="112.5" x2="600.5" y2="%s" stroke="%s"/>' % (f(y3), t["line"]),
                 '<line x1="0" y1="%s" x2="%d" y2="%s" stroke="%s"/>' % (f(y3 + .5), W, f(y3 + .5), t["line"])]
        lanes = lane(left, pad, 142, 1) + lane(right, 600 + 28, 142, 528 / 540.0)
        w99 = d.width(str(snap["n"]), "sansb", 56)
        foot = [counter(d, P, snap["n"], snap["n"], pad + w99, y3 + 62, "sansb", 56, t["hue"]["kit"], 1),
                d.text("times", pad + w99 + 10, y3 + 62, "sansb", 30, t["hue"]["kit"])[0],
                d.text("less to read,", pad + w99 + 104, y3 + 46, "sansb", 19, t["text"])[0],
                d.text("for the same answer", pad + w99 + 104, y3 + 70, "sansb", 19, t["text"])[0]]
        s, nw = d.text(note, W - pad, y3 + 60, "sans", 16, note_ink, anchor="end")
        assert W - pad - nw >= 496, nw
        foot.append(s)
        H = int(y3 + 104)
    d.w, d.h = W, H
    d.css.append(P.css())
    d.body += [panel(W, H, t)] + head + rules + [lanes] + foot + [
               '<rect x=".5" y=".5" width="%d" height="%d" rx="12" fill="none" stroke="%s"/>' % (W - 1, H - 1, t["line"])]
    write("explainer-%s%s.svg" % ("m-" if mobile else "", theme), d)


# ------------------------------------------------------------------------------------------------
# annotated shots: a capture file drawn verbatim on the left (wrapped like a terminal), and on the right a note
# in plain words for each part that matters, joined to its lines by a leader. Static on purpose.
# ------------------------------------------------------------------------------------------------
def shot(name, capture, title, notes, theme, mobile=False, accent="kit"):
    """notes: [dict(lines=(first, last) capture line indexes, mark=[substrings to tint], head=str, body=str)].
    Desktop: notes in a column on the right, each joined to its lines by a leader. Phone: notes numbered underneath."""
    t = th(theme)
    ac = t["hue"][accent]                             # the tool's own hue: bands, marks, leaders, badges
    lines = read_capture(capture)
    if mobile:
        W, size, lh, pad, top = 720, 19.5, 30, 24, 52
        cell = mono_cell(size)
        cols = int((W - pad * 2 - 40) / cell)          # 40: a gutter on the right for the note numbers
        Wt = W
    else:
        W, size, lh, pad, top, cols = 1040, 14.5, 23, 22, 38, 64
        cell = mono_cell(size)
        Wt = int(pad * 2 + cols * cell + 0.5)
    keep = {}                                          # a note may ask for the fields it does not mention to be dimmed
    for n in notes:
        for sub in n.get("keep", []):
            src = next(i for i in range(n["lines"][0], n["lines"][1] + 1) if sub in lines[i])
            keep.setdefault(src, []).append((lines[src].index(sub), lines[src].index(sub) + len(sub)))
    rows, starts = term_rows(lines, t, cols, keep)
    first, count = {}, {}
    for ri, (_, src) in enumerate(rows):
        first.setdefault(src, ri)
        count[src] = count.get(src, 0) + 1
    body_top = top + (24 if mobile else 18)
    term_h = body_top + len(rows) * lh + (22 if mobile else 16)
    hs, hl, bs, bl = (25, 33, 21.5, 30) if mobile else (17, 23, 15, 21.5)
    x0 = pad + 46 if mobile else Wt + 46
    cw = W - x0 - (pad if mobile else 30)
    d = Doc(W, 10, title, "")
    placed, prev_bottom, alt = [], (term_h + 6 if mobile else 0), []
    for n in notes:
        a, z = n["lines"]
        by, bh = body_top + first[a] * lh - 1, (first[z] + count[z] - first[a]) * lh + 2
        cy = by + lh / 2 + 1                           # the centre of the band's first row
        head = wrap_text(n["head"], "sansb", hs, cw)
        body = wrap_text(n["body"], "sans", bs, cw)
        ty = prev_bottom + 30 if mobile else max(cy - 11, prev_bottom + 22)
        prev_bottom = ty + len(head) * hl + len(body) * bl
        placed.append((n, by, bh, cy, head, body, ty))
        alt.append("%s: %s" % (n["head"], n["body"]))
    H = int(max(term_h, prev_bottom + (30 if mobile else 20)))
    d.h = H
    d.desc = "Terminal, a real run: %s. Notes: %s" % ("; ".join(l[2:] for l in lines if l.startswith("$ ") and l != "$ echo $?"), " ".join(alt))
    b = d.body
    b.append('<rect x=".5" y=".5" width="%d" height="%d" rx="12" fill="%s"/>' % (W - 1, H - 1, t["card"]))
    if mobile:
        b.append('<path d="M12.5 .5H%sa12 12 0 0 1 12 12V%dH.5V12.5a12 12 0 0 1 12 -12z" fill="%s"/>' % (f(W - 12.5), term_h, t["term"]))
        b.append('<path d="M12.5 .5H%sa12 12 0 0 1 12 12V%dH.5V12.5a12 12 0 0 1 12 -12z" fill="%s"/>' % (f(W - 12.5), top - 6, t["bar"]))
        b.append('<line x1=".5" y1="%s" x2="%s" y2="%s" stroke="%s"/>' % (f(term_h + 0.5), f(W - 0.5), f(term_h + 0.5), t["line"]))
    else:
        b.append('<path d="M12.5 .5H%dV%sH12.5a12 12 0 0 1 -12 -12V12.5a12 12 0 0 1 12 -12z" fill="%s"/>' % (Wt, f(H - 0.5), t["term"]))
        b.append('<path d="M12.5 .5H%dV%dH.5V12.5a12 12 0 0 1 12 -12z" fill="%s"/>' % (Wt, top - 6, t["bar"]))
        b.append('<line x1="%s" y1=".5" x2="%s" y2="%s" stroke="%s"/>' % (f(Wt + 0.5), f(Wt + 0.5), f(H - 0.5), t["line"]))
    b.append('<line x1=".5" y1="%s" x2="%s" y2="%s" stroke="%s"/>' % (f(top - 5.5), f(Wt - 0.5), f(top - 5.5), t["line"]))
    b.append(dots(24 if mobile else 20, (top - 6) / 2, t))
    b.append(d.text(title, Wt / 2, (top - 6) / 2 + (6 if mobile else 4.5), "sans", 17 if mobile else 12.5, t["muted"], anchor="middle")[0])

    def badge(x, y, r, k, fs):
        return ('<circle cx="%s" cy="%s" r="%s" fill="%s"/>' % (f(x), f(y), f(r), ac) +
                d.text(str(k), x, y + fs * 0.36, "sansb", fs, t["page"], anchor="middle")[0])

    for k, (n, by, bh, cy, head, body, ty) in enumerate(placed, 1):
        b.append('<rect x="1" y="%s" width="%d" height="%s" fill="%s" fill-opacity="%s"/>' % (f(by), Wt - 2, f(bh), ac, f(t["tint"])))
        a, z = n["lines"]
        for sub in n.get("mark", []):
            src = next(i for i in range(a, z + 1) if sub in lines[i])
            pos = lines[src].index(sub)
            st = starts[src] + [len(lines[src])]
            for ci in range(len(st) - 1):              # a marked run may wrap across terminal rows
                a_, e_ = max(pos, st[ci]), min(pos + len(sub), st[ci + 1])
                if a_ < e_:
                    b.append('<rect x="%s" y="%s" width="%s" height="%d" rx="3" fill="%s" fill-opacity="%s"/>'
                             % (f(pad + (a_ - st[ci]) * cell - 2), f(body_top + (first[src] + ci) * lh + 2), f((e_ - a_) * cell + 4), lh - 4, ac, f(t["mark"])))
        if mobile:
            b.append(badge(W - pad - 12, cy, 13, k, 16))
            b.append(badge(pad + 15, ty + 14, 15, k, 18))
        else:
            hy = ty + 11
            b.append('<path d="M%s %sH%s%sH%s" fill="none" stroke="%s" stroke-width="1.5"/><circle cx="%s" cy="%s" r="4" fill="%s"/>'
                     % (f(Wt + 0.5), f(cy), f(Wt + 22), "" if abs(hy - cy) < 0.5 else "V%s" % f(hy), f(x0 - 12), ac, f(Wt + 0.5), f(cy), ac))
        y = ty + hs
        for ln in head:
            b.append(d.text(ln, x0, y, "sansb", hs, t["text"])[0])
            y += hl
        y += 1
        for ln in body:
            b.append(d.text(ln, x0, y, "sans", bs, t["muted"])[0])
            y += bl
    y = body_top + lh * 0.72
    for r, _ in rows:
        b.append(mono_run(d, r, pad, y, size)[0])
        y += lh
    b.append('<rect x=".5" y=".5" width="%d" height="%d" rx="12" fill="none" stroke="%s"/>' % (W - 1, H - 1, t["line"]))
    write("%s-%s%s.svg" % (name, "m-" if mobile else "", theme), d)


def shots(theme, mobile=False):
    rp = read_capture("shot-reddit-pull.txt")
    line = next(l for l in rp if l.startswith("{"))
    total = int(rp[-1].split()[0])
    titles = int(next(l for l in rp if l.endswith("rust.titles.txt") and not l.startswith("{")).split()[0])
    posts = json.loads(line)["subs"][0]["posts"]
    measured = case("What is new")["kit"]
    # the folder name is written three times in the answer: once as "out" and once in each of the two file paths
    assert line.count('"out":"out"') == 1 and line.count('"out\\\\') == 2
    assert measured["posts"] == posts and measured["stdout"]["bytes"] > len(line)
    shot("shot-reddit-pull", "shot-reddit-pull.txt", "reddit-pull, a real run on Windows 11, 14 Nov 2026", [
        dict(lines=(1, 1), head="Progress, for a person watching",
             body="It goes to a separate stream (stderr). The measurements on this page count it as read all the same."),
        dict(lines=(2, 2), mark=['"posts":%d' % posts, '"failed_requests":0'], head="The answer is this one line",
             body="%d bytes of JSON: the pull worked, %d posts were found, and these files hold them. In the measured run the line was "
                  "%d bytes, because that run wrote to a temporary folder and the longer folder name appears three times."
                  % (len(line.encode("utf-8")), posts, measured["stdout"]["bytes"])),
        dict(lines=(6, 8), mark=[rp[-1].strip()], head="The posts themselves are on disk",
             body="%s bytes the agent did not have to read. It opens the title list (%s bytes), or searches the full file, only when the job needs it."
                  % (num(total), num(titles))),
    ], theme, mobile, accent="reddit")
    mg = read_capture("shot-memory-gate.txt")
    j = json.loads(mg[1])
    code = int(mg[3])
    assert (j["verdict"], code) == ("stop", 4)
    shot("shot-memory-gate", "shot-memory-gate.txt", "memory-gate, a real run on Windows 11, 14 Nov 2026", [
        dict(lines=(1, 1), mark=['"verdict":"%s"' % j["verdict"], '"pct":%s' % j["pct"], '"advice":"start nothing heavy'],
             keep=['"verdict":"%s"' % j["verdict"], '"pct":%s' % j["pct"], '"advice":"%s"' % j["advice"]],
             head="One line instead of a process list",
             body="%d bytes: a verdict, the reading behind it (%s%% of this machine's memory is committed) and advice in plain words."
                  % (len(mg[1].encode("utf-8")), j["pct"])),
        dict(lines=(3, 3), head="Exit code %d means stop" % code,
             body="Your agent branches on the number and never has to parse the text: 0 go ahead, 3 one heavy job at a time, 4 stop, 5 could not tell."),
    ], theme, mobile, accent="mem")
    gs = read_capture("shot-github-stars.txt")
    a, z = json.loads(gs[1]), json.loads(gs[3])
    assert a["seeded"] and not z["seeded"] and z["new"] == []
    shot("shot-github-stars", "shot-github-stars.txt", "github-stars, a real run on Windows 11, 14 Nov 2026", [
        dict(lines=(1, 1), mark=['"read":%d' % a["read"], '"seeded":true'], head="The first run saves the list",
             body="%d stars go into stars.json. Nothing is announced, because nothing is new yet. \"pushed\" counts alerts sent, "
                  "through ntfy (a free service that notifies a phone) or a webhook." % a["read"]),
        dict(lines=(3, 3), mark=['"new":[]'], head="Every later run is a comparison",
             body="Plain code compares GitHub's list with the saved one. Run by an agent, the answer is this line: %d tokens in the "
                  "measured run. Run on a timer with no agent, a check that finds nothing costs none, and your agent is told "
                  "only when a star is new." % case("Has ")["kit"]["agent_reads"]["tokens"]),
    ], theme, mobile, accent="kit")


# ------------------------------------------------------------------------------------------------
# the kit: the 20 tools by the job a reader wants done. One list feeds the README's table, the cards and their
# alt text, so the three cannot drift apart. (name, folder, kind, what it does for you, needs, a fact for the card)
# ------------------------------------------------------------------------------------------------
def kit():
    sub, stars, mem = case("What is new"), case("Has "), case("Is there memory")
    T, H = "command-line tool", "Claude Code hook"
    return [
        ("Find things out without opening a browser", [
            ("reddit-pull", "tools/research/reddit-pull", T, "Your agent reads Reddit with no browser, login or API key. Posts and comments go to files, and one line comes back.",
             "nothing extra", "%d tokens for %d posts" % (sub["kit"]["agent_reads"]["tokens"], sub["kit"]["posts"])),
            ("ig2md", "tools/research/ig2md", T, "Turns a public Instagram post, reel or carousel into Markdown your agent can read, where the page itself is a login wall.",
             "yt-dlp or gallery-dl (optional)", ""),
        ]),
        ("Watch for change with plain code, not a model", [
            ("github-stars", "tools/trackers/github-stars", T, "Tells your agent when an account stars a new repo. Plain code does the comparing, so on a timer a check that finds nothing costs no model call.",
             "nothing extra (token optional)", "%d tokens per agent run" % stars["kit"]["agent_reads"]["tokens"]),
            ("mail-reply", "tools/trackers/mail-reply", T, "Answers email from people you allow with a fixed \"got it\" in the same thread. No model reads the mail.",
             "a mail login", ""),
        ]),
        ("Protect your machine and your files", [
            ("memory-gate", "tools/guards/memory-gate", T, "One question before heavy work: is there memory for this? Your agent gets a verdict and an exit code, not a process list.",
             "nothing extra", "one line, four exit codes"),
            ("app-closer", "tools/guards/app-closer", T, "Frees memory by closing only the idle apps on a list you wrote. It reports first and acts only with --close.",
             "nothing extra", ""),
            ("bin-dump", "tools/guards/bin-dump", T, "Your agent deletes by moving files to a dated bin, with a note of who and why. You can restore any of it.",
             "nothing extra", "--dry-run previews a move"),
            ("detached-run", "tools/guards/detached-run", T, "Starts a Windows job that outlives the session that started it, and never flashes a window on your screen.",
             "Windows", ""),
        ]),
        ("Spend your model allowance well", [
            ("model-router", "tools/routing/model-router", T, "Picks which of your model plans should take the next task: the one about to lose the most unspent allowance.",
             "nothing extra", ""),
            ("anthropic-pool", "tools/routing/anthropic-pool", T, "Spends Anthropic API credit from several keys, soonest to expire first, with hard caps. By default it uses Batch, Anthropic's half-price queue for work that can wait.",
             "API keys", ""),
            ("cli-rotator", "tools/routing/cli-rotator", T, "Runs a task on whichever of your command-line (CLI) agent accounts has quota left, and rests an account that hits its limit.",
             "signed-in CLI accounts", ""),
        ]),
        ("Hear back from background agents, and check what they did", [
            ("lane-mailbox", "tools/trackers/lane-mailbox", T, "A private GitHub repo as a mailbox, so a lane (a background agent session) that cannot message you can still report back.",
             "a GitHub token", ""),
            ("lane-model-check", "tools/guards/lane-model-check", T, "Checks from the transcript that a lane ran on the model you asked for. Exit 1 means it did not.",
             "nothing extra", ""),
            ("token-totals", "tools/research/token-totals", T, "Adds up the tokens in your Claude Code logs per day and per model, counting each reply once.",
             "nothing extra", ""),
        ]),
        ("Habits for long Claude Code sessions (hooks)", [
            ("plan-depth", "hooks/plan-depth", H, "Lists what a plan is missing at the moment Claude presents it. It warns and never approves for you.",
             "Claude Code", ""),
            ("dismissal-watch", "hooks/dismissal-watch", H, "Catches \"that's impossible\" said without a search, and tells Claude to look first.",
             "Claude Code", ""),
            ("instruction-keeper", "hooks/instruction-keeper", H, "Keeps your own words in a ledger and checks, as the work goes on, that nothing you asked for was dropped.",
             "Claude Code", ""),
            ("focus-gate", "hooks/focus-gate", H, "Has Claude turn down side requests until the task you keep putting off has real work on disk.",
             "Claude Code", ""),
            ("presence", "hooks/presence", H, "One switch for every session. At your desk, Claude asks you; away, it works on its best guess and logs each question.",
             "Claude Code", "/away and /back"),
            ("session-card-push", "hooks/session-card-push", H, "When something shows only in the desktop app, Claude is told to notify you and ask in chat instead of waiting.",
             "Claude Code", ""),
        ]),
    ]


FEATURED = ("reddit-pull", "github-stars", "memory-gate", "bin-dump", "plan-depth", "presence")


TOOL_HUE = {"reddit-pull": "reddit", "github-stars": "kit", "memory-gate": "mem", "bin-dump": "mem",
            "plan-depth": "hook", "presence": "hook"}     # the dot is the colour of the tool's group in the table


def card_runs():
    """What each of the six cards shows that the table does not: the command that runs the tool and, only where a
    run was recorded beside this script, what that run said. (command, line under it, was it recorded)"""
    rp, gs, mg = (read_capture("shot-%s.txt" % n) for n in ("reddit-pull", "github-stars", "memory-gate"))
    cmd = lambda cap: next(l for l in cap if l.startswith("$ node "))[2:]
    posts = json.loads(next(l for l in rp if l.startswith("{")))["subs"][0]["posts"]
    stars = json.loads(gs[3])
    gate = json.loads(mg[1])
    assert stars["new"] == [] and gs[-1] == "0" and mg[3] == "4" and gate["advice"].startswith("start nothing heavy")
    return {
        "reddit-pull": (cmd(rp), "%d posts found, %s bytes saved to disk" % (posts, num(int(rp[-1].split()[0]))), True),
        "github-stars": (cmd(gs), "%d stars checked, nothing new, exit %s" % (stars["read"], gs[-1]), True),
        "memory-gate": (cmd(mg), "verdict \"%s\", exit %s: start nothing heavy" % (gate["verdict"], mg[3]), True),
        # the three below are the commands their own READMEs give; no run of them is recorded here, so no result
        "bin-dump": ('node tools/guards/bin-dump/bin-dump.mjs ./old-build --who my-agent --why "stale build output" --dry-run',
                     "--dry-run says what would move and moves nothing", False),
        "plan-depth": ("node hooks/plan-depth/plan-depth.mjs --check plan.md", "lists the gaps in a plan file, as JSON", False),
        "presence": ("/away\n/back", "typed in Claude Code: one when you leave, one when you return", False),
    }


def tool_card(theme, name, kind, text, needs, fact):
    """One tool as a 400 px card: its dot and name, the command that runs it and, where one was recorded, what the
    run said. The table above the cards says what each tool is for; the card does not say it again."""
    t = th(theme)
    W, H, px = 400, 158, 18
    command, under, recorded = card_runs()[name]
    d = Doc(W, H, name, "%s (%s). Run it: %s. %s%s. Needs: %s."
            % (name, kind, command.replace("\n", " and "), "Recorded run: " if recorded else "", under, needs))
    b = d.body
    accent = TOOL_HUE[name]
    b.append('<rect x=".5" y=".5" width="%d" height="%d" rx="8" fill="%s" stroke="%s"/>' % (W - 1, H - 1, t["page"], t["line"]))
    b.append(chip(px, 19.5, 12, t["hue"][accent]))
    b.append(d.text(name, px + 20, 31, "monob", 16, t["link"])[0])
    b.append(d.text(kind, W - px, 30, "sans", 12, t["muted"], anchor="end")[0])
    size, lh = 11.5, 16
    cols = int((W - 2 * px - 22) / mono_cell(size))
    rows = [part[a:e] for part in command.split("\n") for a, e in soft_chunks(part, cols)]
    assert len(rows) <= 3, (name, len(rows))
    bh = 3 * lh + 13                                   # one box size on every card, so the six line up as a grid
    b.append('<rect x="%s" y="44.5" width="%s" height="%s" rx="6" fill="%s" stroke="%s"/>' % (f(px + .5), W - 2 * px - 1, bh, t["term"], t["line"]))
    y = 44 + 18
    for ln in rows:
        b.append(d.text(ln, px + 11, y, "mono", size, t["text"])[0])
        y += lh
    y = 44 + bh + 20
    if recorded:
        s, w = runs(d, [("Recorded run:  ", "sans", 12.5, t["muted"]), (under, "sansb", 12.5, t["ink"][accent])], px, y)
    else:
        s, w = d.text(under, px, y, "sans", 12.5, t["muted"])
    assert px + w <= W - px and y <= H - 30, (name, w, y)
    b.append(s)
    b.append(d.text("Needs: " + needs, px, H - 14, "sans", 12, t["muted"])[0])
    write("cards/%s-%s.svg" % (name, theme), d)


def picture(stem):
    """Light, dark and phone-width sources for one figure, with the alt text the SVG itself carries."""
    return ('<picture>\n'
            '  <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="assets/%s-m-dark.svg">\n'
            '  <source media="(max-width: 767px)" srcset="assets/%s-m-light.svg">\n'
            '  <source media="(prefers-color-scheme: dark)" srcset="assets/%s-dark.svg">\n'
            '  <img src="assets/%s-light.svg" width="100%%" alt="%s">\n'
            '</picture>' % (stem, stem, stem, stem, esc(ALTS["%s-light.svg" % stem])))


def readme_blocks():
    """Rewrites the generated parts of README.md between their marker comments: the figures (so each alt text is
    the one in its SVG), the kit table and the row of cards (both from kit())."""
    groups = kit()
    n = sum(len(g[1]) for g in groups)
    assert n == STATS["items"]["total"], n
    rows = ['<table>', '<thead><tr><th align="left">Tool</th><th align="left">What it does for you</th><th align="left">Needs</th></tr></thead>', '<tbody>']
    cards = []
    for title, items in groups:
        rows.append('<tr><td colspan="3"><b>%s</b></td></tr>' % esc(title))
        for name, path, kind, text, needs, fact in items:
            assert os.path.isdir(os.path.join(ASSETS, "..", path)), path
            code = re.sub(r"(--[a-z]+|/away|/back)", r"<code>\1</code>", esc(text))
            rows.append('<tr><td><a href="%s">%s</a></td><td>%s</td><td>%s</td></tr>' % (path, name, code, esc(needs)))
            if name in FEATURED:
                cards.append((FEATURED.index(name),
                              '<a href="%s"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/cards/%s-dark.svg">'
                              '<img src="assets/cards/%s-light.svg" width="400" alt="%s"></picture></a>'
                              % (path, name, name, esc(ALTS["cards/%s-light.svg" % name]))))
    rows += ['</tbody>', '</table>']
    blocks = [("kit-table", "\n".join(rows)), ("cards", "<p>\n%s\n</p>" % "\n".join(c for _, c in sorted(cards)))]
    blocks += [("fig-" + stem, picture(stem)) for stem in ("chart", "explainer", "shot-reddit-pull", "shot-memory-gate", "shot-github-stars")]
    # the strip is the page's heading: the <h1> holds it and its alt text is the name, for search and screen readers
    blocks.append(("header", "<h1>" + picture("header").replace(esc(ALTS["header-light.svg"]), "headless-kit") + "</h1>"))
    p = os.path.join(ASSETS, "..", "README.md")
    s = open(p, encoding="utf-8").read()
    for key, block in blocks:
        a, z = "<!-- %s:start (written by assets/src/build.py) -->" % key, "<!-- %s:end -->" % key
        if a in s and z in s:
            s = s[:s.index(a) + len(a)] + "\n" + block + "\n" + s[s.index(z):]
        else:
            print("README.md has no %s markers; block not written" % key)
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(s)


def round2():
    os.makedirs(os.path.join(ASSETS, "cards"), exist_ok=True)
    for theme in ("light", "dark"):
        header(theme)
        header(theme, mobile=True)
        chart(theme)
        chart_mobile(theme)
        explainer(theme)
        explainer(theme, mobile=True)
        shots(theme)
        shots(theme, mobile=True)
        for _, items in kit():
            for name, path, kind, text, needs, fact in items:
                if name in FEATURED:
                    tool_card(theme, name, kind, text, needs, fact)
    readme_blocks()


if __name__ == "__main__":
    for th_ in ("light", "dark"):
        hero(th_)
        hero_mobile(th_)
    banner("dark", 1280, 640, "banner-1280x640.svg")
    banner("dark", 1200, 627, "banner-linkedin-1200x627.svg")
    round2()
