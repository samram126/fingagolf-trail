# End-to-end test of the page in headless Chromium: load a clip, make the two
# taps by clicking the canvas, trace, compare to the hand-verified track, export.
# usage: ui_test.py clip.webm points.txt shotsdir
import json, math, sys, time, subprocess, os
from playwright.sync_api import sync_playwright

clip, ptsf, shots = sys.argv[1:4]
os.makedirs(shots, exist_ok=True)
pts = []
for ln in open(ptsf):
    t = ln.strip()
    if not t or t.startswith('#'): continue
    f, xy = t.split(':'); x, y = xy.split(','); pts.append((int(f), float(x), float(y)))
pts.sort()
tee, land = pts[0], pts[-1]

srv = subprocess.Popen(['python3', '-m', 'http.server', '8765', '-d', os.path.join(os.path.dirname(__file__), '..', 'site')],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        pg = b.new_page(viewport={'width': 1200, 'height': 900})
        logs = []
        pg.on('console', lambda m: logs.append(m.text))
        pg.on('pageerror', lambda e: logs.append('PAGEERROR ' + str(e)))
        pg.goto('http://localhost:8765/')
        pg.screenshot(path=f'{shots}/0_load.png')
        pg.set_input_files('#file', clip)
        pg.wait_for_function('window.__fg.S.step === "tee"', timeout=60000)
        info = pg.evaluate('({fps: __fg.S.fps, n: __fg.S.n, W: __fg.S.W, H: __fg.S.H})')
        print('loaded', info)

        def tap(f, x, y):
            pg.evaluate(f'__fg.goto({f})')
            pg.wait_for_timeout(300)
            for _ in range(2):
                v = pg.evaluate('__fg.viewRect()')
                r = pg.eval_on_selector('#stage', 'e => { const r = e.getBoundingClientRect(); return {l: r.left, t: r.top, w: r.width, h: r.height}; }')
                cx = r['l'] + (x - v['x']) / v['w'] * r['w']
                cy = r['t'] + (y - v['y']) / v['h'] * r['h']
                pg.mouse.click(cx, cy)
                pg.wait_for_timeout(150)

        tap(max(0, tee[0] - 8), tee[1], tee[2])
        pg.screenshot(path=f'{shots}/1_tee.png')
        pg.click('#toLand')
        tap(land[0], land[1], land[2])
        pg.screenshot(path=f'{shots}/2_land.png')
        t0 = time.time()
        pg.click('#trace')
        pg.wait_for_function('window.__fg.S.step === "review"', timeout=300000)
        print('traced in %.1fs' % (time.time() - t0))
        trail = pg.evaluate('__fg.S.trail')
        by = {q['f']: q for q in trail}
        errs = []
        for f, x, y in pts[1:-1]:
            q = by.get(f)
            if q: errs.append(math.hypot(q['x'] - x, q['y'] - y))
        errs.sort()
        print('strike', trail[0]['f'], 'true', tee[0], 'errors med %.0f p90 %.0f max %.0f' % (
            errs[len(errs)//2], errs[int(len(errs)*0.9)], errs[-1]))
        mid = (trail[0]['f'] + trail[-1]['f']) // 2
        pg.evaluate(f'__fg.goto({mid})'); pg.wait_for_timeout(400)
        pg.screenshot(path=f'{shots}/3_review_mid.png')
        pg.evaluate(f'__fg.goto({trail[-1]["f"]})'); pg.wait_for_timeout(400)
        pg.screenshot(path=f'{shots}/4_review_end.png')
        t0 = time.time()
        pg.click('#make')
        pg.wait_for_function('window.__fg.S.step === "done"', timeout=300000)
        print('exported in %.1fs' % (time.time() - t0))
        res = pg.evaluate('''async () => { const r = await fetch(__fg.S.resultUrl); const b = await r.blob();
            return {size: b.size, type: b.type, name: document.querySelector('#download').download}; }''')
        print('result', res)
        data = pg.evaluate('''async () => { const r = await fetch(__fg.S.resultUrl); const b = new Uint8Array(await (await r.blob()).arrayBuffer());
            let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return btoa(s); }''')
        import base64
        ext = 'mp4' if 'mp4' in res['type'] else 'webm'
        open(f'{shots}/result.{ext}', 'wb').write(base64.b64decode(data))
        pg.screenshot(path=f'{shots}/5_done.png')
        errs_log = [l for l in logs if 'PAGEERROR' in l or 'rror' in l]
        print('console errors:', errs_log[:5])
        b.close()
finally:
    srv.terminate()
