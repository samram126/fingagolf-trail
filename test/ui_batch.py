# End-to-end batch test in headless Chromium: several clips, one tap each,
# trace all, compare to hand-verified tracks, an "end here", export + zip.
# usage: ui_batch.py shotsdir clip.webm:points.txt [...]
import json, math, sys, time, subprocess, os, base64
from playwright.sync_api import sync_playwright

shots = sys.argv[1]
os.makedirs(shots, exist_ok=True)
specs = []
for a in sys.argv[2:]:
    clip, ptsf = a.split(':')
    pts = []
    for ln in open(ptsf):
        t = ln.strip()
        if not t or t.startswith('#'): continue
        f, xy = t.split(':'); x, y = xy.split(','); pts.append((int(f), float(x), float(y)))
    pts.sort()
    specs.append((clip, pts))

srv = subprocess.Popen(['python3', '-m', 'http.server', '8765', '-d', os.path.join(os.path.dirname(__file__), '..', 'docs')],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        vw = [int(v) for v in os.environ.get('VIEW', '1200x900').split('x')]
        pg = b.new_page(viewport={'width': vw[0], 'height': vw[1]}, device_scale_factor=2 if vw[0] < 600 else 1, is_mobile=vw[0] < 600, has_touch=vw[0] < 600)
        logs = []
        pg.on('pageerror', lambda e: logs.append('PAGEERROR ' + str(e)))
        pg.on('console', lambda m: logs.append(m.type + ' ' + m.text) if m.type == 'error' else None)
        pg.goto('http://localhost:8765/')
        pg.set_input_files('#file', [c for c, _ in specs])
        pg.wait_for_function('window.__fg.S.step === "tap"', timeout=120000)
        names = pg.evaluate('__fg.S.clips.map(c => c.name)')
        print('clips in order:', names)
        bynm = {os.path.splitext(os.path.basename(c))[0]: (c, pts) for c, pts in specs}

        def tap(f, x, y):
            pg.evaluate(f'__fg.goto({f})'); pg.wait_for_timeout(300)
            pg.eval_on_selector('#stage', 'e => e.scrollIntoView({block: "center"})'); pg.wait_for_timeout(400)
            for _ in range(2):
                v = pg.evaluate('__fg.viewRect()')
                r = pg.eval_on_selector('#stage', 'e => { const r = e.getBoundingClientRect(); return {l: r.left, t: r.top, w: r.width, h: r.height}; }')
                pg.mouse.click(r['l'] + (x - v['x']) / v['w'] * r['w'], r['t'] + (y - v['y']) / v['h'] * r['h'])
                pg.wait_for_timeout(150)

        for i, nm in enumerate(names):
            _, pts = bynm[nm]
            tee = pts[0]
            tap(0 if os.environ.get('TAP0') else max(0, tee[0] - 8), tee[1], tee[2])
            if i == 0: pg.screenshot(path=f'{shots}/1_tap.png')
            pg.click('#tapNext')
            pg.wait_for_timeout(300)
        t0 = time.time()
        pg.wait_for_function('window.__fg.S.step === "list"', timeout=1800000)
        print('traced %d clips in %.0fs' % (len(names), time.time() - t0))
        pg.screenshot(path=f'{shots}/2_list.png')
        for i, nm in enumerate(names):
            _, pts = bynm[nm]
            tr = pg.evaluate(f'__fg.S.clips[{i}].trail')
            state = pg.evaluate(f'__fg.S.clips[{i}].status')
            by = {q['f']: q for q in tr}
            last = tr[-1]
            errs = sorted(math.hypot((by.get(f) or last)['x'] - x, (by.get(f) or last)['y'] - y) for f, x, y in pts[1:-1] if f <= last['f'])
            print(f'{nm}: {state}  start {tr[0]["f"]} (true {pts[0][0]})  end {last["f"]} (true {pts[-1][0]})  err med {errs[len(errs)//2]:.0f} p90 {errs[int(len(errs)*0.9)]:.0f}')
        print('list text:', pg.inner_text('#clipList').replace('\n', ' | '))
        # open the first clip, end the trail 3 frames early, undo
        pg.click('#clipList li:nth-child(1) .go')
        pg.wait_for_function('window.__fg.S.step === "review"')
        pg.wait_for_timeout(500)
        pg.screenshot(path=f'{shots}/3_review.png')
        endf = pg.evaluate('__fg.S.clips[0].trail.at(-1).f')
        pg.evaluate(f'__fg.goto({endf - 3})'); pg.wait_for_timeout(300)
        pg.click('#endHere')
        print('end here ->', pg.evaluate('__fg.S.clips[0].trail.at(-1).f'), '(asked', endf - 3, ')')
        pg.click('#undoFix')
        print('undo ->', pg.evaluate('__fg.S.clips[0].trail.at(-1).f'))
        pg.click('#reviewDone')
        pg.wait_for_function('window.__fg.S.step === "list"')
        t0 = time.time()
        pg.click('#make')
        pg.wait_for_function('window.__fg.S.step === "done"', timeout=1800000)
        print('exported in %.0fs' % (time.time() - t0))
        pg.screenshot(path=f'{shots}/4_done.png', full_page=True)
        z = pg.evaluate('''async () => { const r = await fetch(document.querySelector('#downloadAll').href); const b = new Uint8Array(await (await r.blob()).arrayBuffer());
            let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); return btoa(s); }''')
        open(f'{shots}/all.zip', 'wb').write(base64.b64decode(z))
        print('zip name:', pg.get_attribute('#downloadAll', 'download'))
        print('errors:', logs[:5])
        b.close()
finally:
    srv.terminate()
