# Cache analysis-resolution gray frames and native tee crops for a clip.
# usage: prep.py video points.txt outprefix
import subprocess, sys, numpy as np, json
vid, ptsf, out = sys.argv[1:4]
AW = 480
pts = []
for ln in open(ptsf):
    t = ln.strip()
    if not t or t.startswith('#'): continue
    f, xy = t.split(':'); x, y = xy.split(','); pts.append((int(f), float(x), float(y)))
pts.sort()
pr = subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0',vid],capture_output=True,text=True).stdout.strip().split(',')
# decoded size (rotation applied by ffmpeg autorotate)
p = subprocess.Popen(['ffmpeg','-nostdin','-v','error','-i',vid,'-frames:v','1','-f','rawvideo','-pix_fmt','gray','-'],stdout=subprocess.PIPE)
first = p.stdout.read(); p.wait()
W0 = int(pr[0]); H0 = int(pr[1])
if W0*H0 != len(first): W0, H0 = H0, W0
AH = int(round(H0 * AW / W0 / 2) * 2)
raw = subprocess.run(['ffmpeg','-nostdin','-v','error','-i',vid,'-fps_mode','passthrough','-vf',f'scale={AW}:{AH}:flags=area','-f','rawvideo','-pix_fmt','gray','-'],capture_output=True).stdout
n = len(raw)//(AW*AH)
open(out+'.frames','wb').write(raw[:n*AW*AH])
# native crops around the tee
C = 128; tx, ty = int(pts[0][1]), int(pts[0][2])
p = subprocess.Popen(['ffmpeg','-nostdin','-v','error','-i',vid,'-fps_mode','passthrough','-f','rawvideo','-pix_fmt','gray','-'],stdout=subprocess.PIPE)
crops = bytearray()
for i in range(n):
    b = p.stdout.read(W0*H0)
    if len(b) < W0*H0: break
    a = np.frombuffer(b, np.uint8).reshape(H0, W0)
    a = np.pad(a, C, mode='edge')
    crops += a[ty+C-C//2:ty+C+C//2, tx+C-C//2:tx+C+C//2].tobytes()
p.stdout.close(); p.wait()
open(out+'.crops','wb').write(bytes(crops))
json.dump({'W0':W0,'H0':H0,'AW':AW,'AH':AH,'n':n,'C':C,'pts':pts},open(out+'.json','w'))
print(out, n, W0, H0)
